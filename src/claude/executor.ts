import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import type { ExecuteOptions, StreamCallbacks, ClaudeResult } from "../types.js";
import { logger } from "../utils/logger.js";

// ============================================================
// One-shot executor (original — used as fallback)
// ============================================================

export async function executeClaudeStream(
  options: ExecuteOptions,
  callbacks: StreamCallbacks,
  cliPath: string = "claude"
): Promise<ClaudeResult> {
  const args = buildArgs(options, false);

  logger.info({ args: [cliPath, ...args].join(" "), cwd: options.workingDir }, "Spawning claude (one-shot)");

  return new Promise((resolve, reject) => {
    const child = spawn(cliPath, args, {
      cwd: options.workingDir,
      signal: options.abortSignal,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    child.stdin.write(options.message);
    child.stdin.end();

    const result = collectStreamResult(child, options.sessionId, callbacks);

    child.on("error", (err) => {
      if (err.name === "AbortError") {
        const r: ClaudeResult = { text: "[Aborted by user]", sessionId: options.sessionId, costUsd: 0, durationMs: 0, numTurns: 0, isError: true };
        callbacks.onResult(r);
        resolve(r);
      } else {
        callbacks.onError(err);
        reject(err);
      }
    });

    child.on("close", async (code) => {
      const r = await result;
      if (code !== 0 && code !== null && !r.text) {
        r.text = r.text || `Claude exited with code ${code}`;
        r.isError = true;
      }
      callbacks.onResult(r);
      resolve(r);
    });
  });
}

// ============================================================
// Persistent interactive process manager
// ============================================================

interface LiveProcess {
  child: ChildProcess;
  rl: ReadlineInterface;
  sessionId: string;
  abortController: AbortController;
  idleTimer: ReturnType<typeof setTimeout> | null;
  // Resolve the current pending message
  pendingResolve: ((result: ClaudeResult) => void) | null;
  pendingCallbacks: StreamCallbacks | null;
  accumulated: string;
  lastCostUsd: number;
  lastDurationMs: number;
  lastNumTurns: number;
}

const liveProcesses = new Map<string, LiveProcess>(); // sessionId -> process

const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // Kill process after 30 min of inactivity

/**
 * Send a message to an interactive Claude process.
 * Spawns the process on first call, reuses it for subsequent messages.
 * The process stays alive between messages so Claude maintains full context
 * — enabling interactive skills, follow-up questions, multi-step workflows.
 */
export async function sendInteractiveMessage(
  options: ExecuteOptions,
  callbacks: StreamCallbacks,
  cliPath: string = "claude"
): Promise<ClaudeResult> {
  let proc = liveProcesses.get(options.sessionId);

  // If no live process, spawn one
  if (!proc || proc.child.killed || proc.child.exitCode !== null) {
    proc = spawnInteractive(options, cliPath);
    liveProcesses.set(options.sessionId, proc);
  }

  // Reset idle timer
  resetIdleTimer(proc);

  // Set up callbacks for this message
  proc.pendingCallbacks = callbacks;
  proc.accumulated = "";

  // Send message as stream-json input
  const inputMsg = JSON.stringify({
    type: "user",
    message: { role: "user", content: options.message },
  });

  logger.info({ sessionId: options.sessionId, msgLength: options.message.length }, "Sending interactive message");

  return new Promise<ClaudeResult>((resolve) => {
    proc!.pendingResolve = resolve;
    proc!.child.stdin!.write(inputMsg + "\n");
  });
}

function spawnInteractive(options: ExecuteOptions, cliPath: string): LiveProcess {
  const args = buildArgs(options, true);
  const abortController = new AbortController();

  logger.info({ args: [cliPath, ...args].join(" "), cwd: options.workingDir }, "Spawning claude (interactive)");

  const child = spawn(cliPath, args, {
    cwd: options.workingDir,
    signal: abortController.signal,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });

  const rl = createInterface({ input: child.stdout! });

  const proc: LiveProcess = {
    child,
    rl,
    sessionId: options.sessionId,
    abortController,
    idleTimer: null,
    pendingResolve: null,
    pendingCallbacks: null,
    accumulated: "",
    lastCostUsd: 0,
    lastDurationMs: 0,
    lastNumTurns: 0,
  };

  // Parse stdout line by line
  rl.on("line", (line) => {
    if (!line.trim()) return;
    try {
      const event = JSON.parse(line);
      handleInteractiveEvent(proc, event);
    } catch {
      logger.debug({ line }, "Non-JSON stdout line (interactive)");
    }
  });

  // Handle stderr
  child.stderr?.on("data", (chunk: Buffer) => {
    logger.debug({ stderr: chunk.toString() }, "Claude stderr");
  });

  // Handle process exit
  child.on("close", (code) => {
    logger.info({ sessionId: options.sessionId, code }, "Interactive process exited");
    liveProcesses.delete(options.sessionId);

    // Resolve any pending message
    if (proc.pendingResolve) {
      const result: ClaudeResult = {
        text: proc.accumulated || `[Process exited with code ${code}]`,
        sessionId: options.sessionId,
        costUsd: proc.lastCostUsd,
        durationMs: proc.lastDurationMs,
        numTurns: proc.lastNumTurns,
        isError: code !== 0 && code !== null,
      };
      proc.pendingCallbacks?.onResult(result);
      proc.pendingResolve(result);
      proc.pendingResolve = null;
    }
  });

  child.on("error", (err) => {
    logger.error({ err, sessionId: options.sessionId }, "Interactive process error");
    liveProcesses.delete(options.sessionId);

    if (proc.pendingResolve) {
      const result: ClaudeResult = {
        text: `[Error: ${err.message}]`,
        sessionId: options.sessionId,
        costUsd: 0,
        durationMs: 0,
        numTurns: 0,
        isError: true,
      };
      proc.pendingCallbacks?.onError(err);
      proc.pendingResolve(result);
      proc.pendingResolve = null;
    }
  });

  return proc;
}

function handleInteractiveEvent(proc: LiveProcess, event: Record<string, unknown>) {
  const type = event.type as string;

  // Stream deltas → accumulate + notify
  if (type === "stream_event") {
    const inner = event.event as Record<string, unknown> | undefined;
    if (!inner) return;

    if (inner.type === "content_block_delta") {
      const delta = inner.delta as Record<string, unknown> | undefined;
      if (delta && delta.type === "text_delta" && typeof delta.text === "string") {
        proc.accumulated += delta.text;
        proc.pendingCallbacks?.onTextDelta(delta.text);
      }
    }
  }

  // Full assistant message → detect tool use
  if (type === "assistant") {
    const content = event.message && (event.message as Record<string, unknown>).content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "tool_use") {
          proc.pendingCallbacks?.onToolUse(block.name as string, undefined);
        }
      }
    }
  }

  // Result event → this message turn is complete, resolve the promise
  if (type === "result") {
    proc.lastCostUsd = (event.total_cost_usd as number) || 0;
    proc.lastDurationMs = (event.duration_ms as number) || 0;
    proc.lastNumTurns = (event.num_turns as number) || 0;
    const isError = (event.is_error as boolean) || false;
    const resultText = (event.result as string) || proc.accumulated;

    if (proc.pendingResolve) {
      const result: ClaudeResult = {
        text: resultText,
        sessionId: (event.session_id as string) || proc.sessionId,
        costUsd: proc.lastCostUsd,
        durationMs: proc.lastDurationMs,
        numTurns: proc.lastNumTurns,
        isError,
      };
      proc.pendingCallbacks?.onResult(result);
      proc.pendingResolve(result);
      proc.pendingResolve = null;
      proc.pendingCallbacks = null;
    }
  }
}

function resetIdleTimer(proc: LiveProcess) {
  if (proc.idleTimer) clearTimeout(proc.idleTimer);
  proc.idleTimer = setTimeout(() => {
    logger.info({ sessionId: proc.sessionId }, "Idle timeout — killing interactive process");
    killInteractiveProcess(proc.sessionId);
  }, IDLE_TIMEOUT_MS);
}

/** Kill a live interactive process by session ID */
export function killInteractiveProcess(sessionId: string): boolean {
  const proc = liveProcesses.get(sessionId);
  if (!proc) return false;

  if (proc.idleTimer) clearTimeout(proc.idleTimer);
  proc.abortController.abort();
  liveProcesses.delete(sessionId);
  return true;
}

/** Kill all live interactive processes */
export function killAllInteractiveProcesses(): number {
  let count = 0;
  for (const [sessionId] of liveProcesses) {
    if (killInteractiveProcess(sessionId)) count++;
  }
  return count;
}

/** Check if a session has a live interactive process */
export function hasLiveProcess(sessionId: string): boolean {
  const proc = liveProcesses.get(sessionId);
  return !!proc && !proc.child.killed && proc.child.exitCode === null;
}

/** Get the abort controller for a session (for /kill command) */
export function getProcessAbortController(sessionId: string): AbortController | null {
  return liveProcesses.get(sessionId)?.abortController || null;
}

// ============================================================
// Shared helpers
// ============================================================

function buildArgs(options: ExecuteOptions, interactive: boolean): string[] {
  const args: string[] = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
  ];

  if (interactive) {
    args.push("--input-format", "stream-json");
  }

  if (options.isNewSession) {
    args.push("--session-id", options.sessionId);
  } else {
    args.push("--resume", options.sessionId);
  }

  if (options.permissionMode) {
    args.push("--permission-mode", options.permissionMode);
  }

  if (options.allowedTools && options.allowedTools.length > 0) {
    args.push("--allowedTools", options.allowedTools.join(","));
  }

  if (options.model) {
    args.push("--model", options.model);
  }

  if (options.effort) {
    args.push("--effort", options.effort);
  }

  if (options.maxBudgetUsd) {
    args.push("--max-budget-usd", String(options.maxBudgetUsd));
  }

  if (options.sessionName) {
    args.push("--name", options.sessionName);
  }

  args.push(
    "--append-system-prompt",
    "You are running through a Telegram bridge. The user cannot approve permission prompts or interact with interactive CLI tools. Avoid actions that require interactive approval. Do not run bash commands that require user input. Prefer reading/writing files directly over shell commands when possible.",
  );

  return args;
}

async function collectStreamResult(
  child: ChildProcess,
  sessionId: string,
  callbacks: StreamCallbacks,
): Promise<ClaudeResult> {
  let fullText = "";
  let sid = sessionId;
  let costUsd = 0;
  let durationMs = 0;
  let numTurns = 0;
  let isError = false;
  let stderrBuf = "";

  const rl = createInterface({ input: child.stdout! });

  rl.on("line", (line) => {
    if (!line.trim()) return;
    try {
      const event = JSON.parse(line);
      const type = event.type as string;

      if (type === "stream_event") {
        const inner = event.event as Record<string, unknown> | undefined;
        if (inner?.type === "content_block_delta") {
          const delta = inner.delta as Record<string, unknown> | undefined;
          if (delta?.type === "text_delta" && typeof delta.text === "string") {
            fullText += delta.text;
            callbacks.onTextDelta(delta.text);
          }
        }
      }

      if (type === "assistant") {
        const content = event.message && (event.message as Record<string, unknown>).content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "tool_use") {
              callbacks.onToolUse(block.name as string, undefined);
            }
          }
        }
      }

      if (type === "result") {
        sid = event.session_id || sid;
        costUsd = event.total_cost_usd || 0;
        durationMs = event.duration_ms || 0;
        numTurns = event.num_turns || 0;
        isError = event.is_error || false;
        if (event.result) fullText = event.result;
      }
    } catch {
      // ignore
    }
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    stderrBuf += chunk.toString();
  });

  // Return a promise that resolves when the process finishes parsing
  return new Promise((resolve) => {
    rl.on("close", () => {
      resolve({
        text: fullText || stderrBuf || "[No response]",
        sessionId: sid,
        costUsd,
        durationMs,
        numTurns,
        isError,
      });
    });
  });
}
