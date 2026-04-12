import type { Context } from "grammy";
import type { BridgeConfig } from "../../types.js";
import { SessionManager } from "../../claude/session-manager.js";
import { MessageQueue } from "../../claude/queue.js";
import { killInteractiveProcess, getProcessAbortController } from "./message.js";
import { escapeHtml } from "../formatter.js";

let config: BridgeConfig;
let sessionManager: SessionManager;
let messageQueue: MessageQueue;

export function initCommands(cfg: BridgeConfig, sm: SessionManager, mq: MessageQueue) {
  config = cfg;
  sessionManager = sm;
  messageQueue = mq;
}

export async function handleStart(ctx: Context) {
  await ctx.reply(
    "<b>Claude Telegram Bridge</b>\n\n" +
    "Send me a message and I'll forward it to Claude Code on your machine.\n\n" +
    "<b>Commands:</b>\n" +
    "/new [project] [name] — New session\n" +
    "/sessions — List sessions\n" +
    "/switch &lt;id&gt; — Switch session\n" +
    "/status — Current session info\n" +
    "/project &lt;name&gt; — Switch project\n" +
    "/projects — List projects\n" +
    "/model &lt;name&gt; — Change model\n" +
    "/effort &lt;level&gt; — Change effort\n" +
    "/cost — Cost summary\n" +
    "/kill — Stop current request\n" +
    "/help — Show this message",
    { parse_mode: "HTML" }
  );
}

export async function handleNew(ctx: Context) {
  const chatId = ctx.chat!.id;
  const args = (ctx.message?.text || "").split(/\s+/).slice(1);
  const projectKey = args[0];
  const name = args.slice(1).join(" ") || undefined;

  if (projectKey && !config.projects[projectKey]) {
    const available = Object.keys(config.projects).join(", ");
    await ctx.reply(
      `Unknown project: <code>${escapeHtml(projectKey)}</code>\nAvailable: ${available || "none configured"}`,
      { parse_mode: "HTML" }
    );
    return;
  }

  // Default to the current session's project when no project is specified
  const effectiveProject = projectKey || sessionManager.getActiveSession(chatId)?.projectKey || undefined;

  const session = sessionManager.createSession(chatId, effectiveProject, name);

  await ctx.reply(
    `<b>New session created</b>\n` +
    `ID: <code>${session.id.slice(0, 8)}</code>\n` +
    `Project: ${session.projectKey || "none"}\n` +
    `Dir: <code>${escapeHtml(session.workingDir)}</code>\n` +
    `Model: ${session.model} · Effort: ${session.effort}`,
    { parse_mode: "HTML" }
  );
}

export async function handleSessions(ctx: Context) {
  const chatId = ctx.chat!.id;
  const sessions = sessionManager.listSessions(chatId);

  if (sessions.length === 0) {
    await ctx.reply("No sessions. Send a message to create one.");
    return;
  }

  const active = sessionManager.getActiveSession(chatId);
  const lines = sessions.map((s) => {
    const marker = s.id === active?.id ? " ✓" : "";
    const age = formatAge(s.lastMessageAt);
    return (
      `${marker ? "<b>" : ""}• ${escapeHtml(s.name)}${marker}${marker ? "</b>" : ""}\n` +
      `  <code>${s.id.slice(0, 8)}</code> · ${s.messageCount} msgs · $${s.totalCostUsd.toFixed(3)} · ${age}`
    );
  });

  await ctx.reply(
    `<b>Sessions</b> (${sessions.length})\n\n` + lines.join("\n\n") +
    "\n\nUse /switch &lt;id&gt; to switch",
    { parse_mode: "HTML" }
  );
}

export async function handleSwitch(ctx: Context) {
  const chatId = ctx.chat!.id;
  const args = (ctx.message?.text || "").split(/\s+/).slice(1);
  const prefix = args[0];

  if (!prefix) {
    await ctx.reply("Usage: /switch &lt;session-id-prefix&gt;", { parse_mode: "HTML" });
    return;
  }

  // Find session by prefix match
  const sessions = sessionManager.listSessions(chatId);
  const match = sessions.find((s) => s.id.startsWith(prefix));

  if (!match) {
    await ctx.reply(`No session found matching <code>${escapeHtml(prefix)}</code>`, { parse_mode: "HTML" });
    return;
  }

  sessionManager.switchSession(chatId, match.id);
  await ctx.reply(
    `Switched to <b>${escapeHtml(match.name)}</b> (<code>${match.id.slice(0, 8)}</code>)`,
    { parse_mode: "HTML" }
  );
}

export async function handleStatus(ctx: Context) {
  const chatId = ctx.chat!.id;
  const session = sessionManager.getActiveSession(chatId);

  if (!session) {
    await ctx.reply("No active session. Send a message to start one.");
    return;
  }

  const isProcessing = messageQueue.isProcessing(chatId);
  const queueLen = messageQueue.getQueueLength(chatId);

  await ctx.reply(
    `<b>Current Session</b>\n\n` +
    `Name: <b>${escapeHtml(session.name)}</b>\n` +
    `ID: <code>${session.id.slice(0, 8)}</code>\n` +
    `Project: ${session.projectKey || "none"}\n` +
    `Dir: <code>${escapeHtml(session.workingDir)}</code>\n` +
    `Model: ${session.model} · Effort: ${session.effort}\n` +
    `Messages: ${session.messageCount}\n` +
    `Cost: $${session.totalCostUsd.toFixed(3)}\n` +
    `Status: ${isProcessing ? "⏳ Processing" : "Idle"}` +
    (queueLen > 0 ? ` (${queueLen} queued)` : "") +
    `\nCreated: ${formatAge(session.createdAt)}`,
    { parse_mode: "HTML" }
  );
}

export async function handleProject(ctx: Context) {
  const chatId = ctx.chat!.id;
  const args = (ctx.message?.text || "").split(/\s+/).slice(1);
  const projectKey = args[0];

  if (!projectKey) {
    await ctx.reply("Usage: /project &lt;name&gt;\nSee /projects for available projects.", { parse_mode: "HTML" });
    return;
  }

  if (!config.projects[projectKey]) {
    const available = Object.keys(config.projects).join(", ");
    await ctx.reply(
      `Unknown project: <code>${escapeHtml(projectKey)}</code>\nAvailable: ${available || "none configured"}`,
      { parse_mode: "HTML" }
    );
    return;
  }

  const session = sessionManager.getOrCreateSession(chatId);
  sessionManager.updateSessionProject(session.id, projectKey);

  const project = config.projects[projectKey];
  await ctx.reply(
    `Switched to project <b>${escapeHtml(projectKey)}</b>\n` +
    `Dir: <code>${escapeHtml(project.path)}</code>`,
    { parse_mode: "HTML" }
  );
}

export async function handleProjects(ctx: Context) {
  const entries = Object.entries(config.projects);

  if (entries.length === 0) {
    await ctx.reply("No projects configured. Edit config.yaml to add projects.");
    return;
  }

  const lines = entries.map(([key, proj]) => {
    const tools = proj.allowedTools ? `[${proj.allowedTools.join(", ")}]` : "default";
    return `• <b>${escapeHtml(key)}</b>\n  <code>${escapeHtml(proj.path)}</code>\n  Model: ${proj.model || "default"} · Tools: ${tools}`;
  });

  await ctx.reply(
    `<b>Projects</b>\n\n` + lines.join("\n\n") + "\n\nUse /project &lt;name&gt; to switch",
    { parse_mode: "HTML" }
  );
}

export async function handleModel(ctx: Context) {
  const chatId = ctx.chat!.id;
  const args = (ctx.message?.text || "").split(/\s+/).slice(1);
  const model = args[0];

  if (!model) {
    await ctx.reply("Usage: /model &lt;haiku|sonnet|opus&gt;", { parse_mode: "HTML" });
    return;
  }

  const session = sessionManager.getOrCreateSession(chatId);
  sessionManager.updateSessionModel(session.id, model);
  await ctx.reply(`Model set to <b>${escapeHtml(model)}</b>`, { parse_mode: "HTML" });
}

export async function handleEffort(ctx: Context) {
  const chatId = ctx.chat!.id;
  const args = (ctx.message?.text || "").split(/\s+/).slice(1);
  const effort = args[0];

  const valid = ["low", "medium", "high", "max"];
  if (!effort || !valid.includes(effort)) {
    await ctx.reply("Usage: /effort &lt;low|medium|high|max&gt;", { parse_mode: "HTML" });
    return;
  }

  const session = sessionManager.getOrCreateSession(chatId);
  sessionManager.updateSessionEffort(session.id, effort);
  await ctx.reply(`Effort set to <b>${effort}</b>`, { parse_mode: "HTML" });
}

export async function handleCost(ctx: Context) {
  const chatId = ctx.chat!.id;
  const sessions = sessionManager.listSessions(chatId);

  if (sessions.length === 0) {
    await ctx.reply("No sessions yet.");
    return;
  }

  const lines = sessions
    .filter((s) => s.totalCostUsd > 0)
    .map((s) => `• ${escapeHtml(s.name)}: $${s.totalCostUsd.toFixed(3)} (${s.messageCount} msgs)`);

  const total = sessionManager.getTotalCost();

  await ctx.reply(
    `<b>Cost Summary</b>\n\n` +
    (lines.length > 0 ? lines.join("\n") : "No costs recorded yet.") +
    `\n\n<b>Total: $${total.toFixed(3)}</b>`,
    { parse_mode: "HTML" }
  );
}

export async function handleKill(ctx: Context) {
  const chatId = ctx.chat!.id;
  const session = sessionManager.getActiveSession(chatId);

  if (!session) {
    await ctx.reply("No active session.");
    return;
  }

  const killed = killInteractiveProcess(session.id);
  if (killed) {
    await ctx.reply("Claude process killed. Next message will start a fresh process.");
  } else {
    await ctx.reply("No running process to kill.");
  }
}

export async function handleHelp(ctx: Context) {
  await handleStart(ctx);
}

function formatAge(date: Date): string {
  const ms = Date.now() - date.getTime();
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
