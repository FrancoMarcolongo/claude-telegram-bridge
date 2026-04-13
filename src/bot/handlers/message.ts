import type { Context } from "grammy";
import type { BridgeConfig } from "../../types.js";
import { sendInteractiveMessage, killInteractiveProcess, killAllInteractiveProcesses, getProcessAbortController } from "../../claude/executor.js";
import { SessionManager } from "../../claude/session-manager.js";
import { MessageQueue } from "../../claude/queue.js";
import { formatForTelegram, formatCostFooter, splitMessage, shouldSendAsFile, escapeHtml } from "../formatter.js";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { InputFile } from "grammy";
import { logger } from "../../utils/logger.js";

// Shared instances — initialized via createMessageHandler
let sessionManager: SessionManager;
let messageQueue: MessageQueue;
let config: BridgeConfig;

export function getSessionManager(): SessionManager {
  return sessionManager;
}

export { killInteractiveProcess, killAllInteractiveProcesses, getProcessAbortController };

export function createMessageHandler(
  cfg: BridgeConfig,
  sm: SessionManager,
  mq: MessageQueue
) {
  config = cfg;
  sessionManager = sm;
  messageQueue = mq;

  return async (ctx: Context) => {
    let text = ctx.message?.text;
    if (!text) return;

    // ">" prefix forces the message to Claude (bypasses bot commands)
    // e.g., "> /status" sends "/status" to Claude instead of the bot's /status
    if (text.startsWith("> ")) {
      text = text.slice(2);
    }

    const chatId = ctx.chat!.id;

    // Check if Claude is busy — queue if so
    if (messageQueue.isProcessing(chatId)) {
      const { position } = await messageQueue.enqueue(chatId, () => processMessage(ctx, text!));
      await ctx.reply(`Queued (position ${position}). Previous request still processing.`);
      return;
    }

    await messageQueue.enqueue(chatId, () => processMessage(ctx, text!));
  };
}

export async function processMessage(ctx: Context, text: string): Promise<void> {
  const chatId = ctx.chat!.id;
  const session = sessionManager.getOrCreateSession(chatId);

  // Typing indicator loop
  let typingActive = true;
  const typingInterval = setInterval(async () => {
    if (typingActive) {
      try {
        await ctx.api.sendChatAction(chatId, "typing");
      } catch { /* ignore */ }
    }
  }, 4000);

  // Send initial typing action
  try {
    await ctx.api.sendChatAction(chatId, "typing");
  } catch { /* ignore */ }

  // Send placeholder
  const placeholder = await ctx.reply("Thinking...");

  // Accumulate streamed text for periodic edits
  let accumulated = "";
  let toolStatus = "";
  let lastEditTime = 0;
  const editInterval = config.defaults.streamUpdateIntervalMs;
  let editCount = 0;
  const maxEdits = 15;

  try {
    const result = await sendInteractiveMessage(
      {
        message: text,
        sessionId: session.id,
        isNewSession: session.isFirstMessage,
        workingDir: session.workingDir,
        model: session.model,
        effort: session.effort,
        permissionMode: sessionManager.getEffectivePermissionMode(session),
        allowedTools: sessionManager.getEffectiveTools(session),
        maxBudgetUsd: sessionManager.getEffectiveBudget(session),
        sessionName: session.name,
      },
      {
        onTextDelta: (delta) => {
          accumulated += delta;
          const now = Date.now();
          if (now - lastEditTime >= editInterval && editCount < maxEdits) {
            lastEditTime = now;
            editCount++;
            editPlaceholder(ctx, chatId, placeholder.message_id, accumulated, toolStatus).catch(() => {});
          }
        },
        onToolUse: (toolName) => {
          toolStatus = `[Using ${toolName}...]`;
          logger.info({ toolName, sessionId: session.id }, "Claude using tool");
          if (editCount < maxEdits) {
            editCount++;
            editPlaceholder(ctx, chatId, placeholder.message_id, accumulated, toolStatus).catch(() => {});
          }
        },
        onResult: () => {
          // Handled below after await
        },
        onError: (err) => {
          logger.error({ err, sessionId: session.id }, "Claude execution error");
        },
      },
      config.claude.cliPath
    );

    // Stop typing
    typingActive = false;
    clearInterval(typingInterval);

    // Update session tracking
    sessionManager.markMessageSent(session.id, result.costUsd);

    // Format final response
    const responseText = result.text || "[Empty response]";
    const footer = formatCostFooter(result.costUsd, result.durationMs, session.model);

    // Very long responses → send as file
    if (shouldSendAsFile(responseText)) {
      try {
        await ctx.api.deleteMessage(chatId, placeholder.message_id);
      } catch { /* ignore */ }

      const tmpPath = join(process.env.TMPDIR || "/tmp", `claude-response-${Date.now()}.txt`);
      writeFileSync(tmpPath, responseText, "utf-8");
      try {
        await ctx.replyWithDocument(new InputFile(tmpPath, "response.txt"), {
          caption: `Response too long for messages (${responseText.length} chars)${footer}`,
          parse_mode: "HTML",
        });
      } finally {
        try { unlinkSync(tmpPath); } catch { /* ignore */ }
      }
    } else {
      const fullResponse = formatForTelegram(responseText) + footer;
      const chunks = splitMessage(fullResponse);

      if (chunks.length === 1) {
        try {
          await ctx.api.editMessageText(chatId, placeholder.message_id, chunks[0], {
            parse_mode: "HTML",
          });
        } catch {
          // If HTML fails, try plain text
          try {
            await ctx.api.editMessageText(chatId, placeholder.message_id, responseText + footer.replace(/<\/?i>/g, ""));
          } catch {
            await ctx.reply(responseText);
          }
        }
      } else {
        try {
          await ctx.api.deleteMessage(chatId, placeholder.message_id);
        } catch { /* ignore */ }

        for (let i = 0; i < chunks.length; i++) {
          const suffix = chunks.length > 1 ? `\n<i>(${i + 1}/${chunks.length})</i>` : "";
          try {
            await ctx.reply(chunks[i] + suffix, { parse_mode: "HTML" });
          } catch {
            await ctx.reply(stripHtml(chunks[i]));
          }
        }
      }
    }
  } catch (err) {
    typingActive = false;
    clearInterval(typingInterval);

    logger.error({ err, chatId }, "Error processing message");

    try {
      await ctx.api.editMessageText(
        chatId,
        placeholder.message_id,
        `❌ Error: ${err instanceof Error ? err.message : "Unknown error"}`
      );
    } catch {
      await ctx.reply(`❌ Error: ${err instanceof Error ? err.message : "Unknown error"}`);
    }
  }
}

async function editPlaceholder(
  ctx: Context,
  chatId: number,
  messageId: number,
  text: string,
  toolStatus: string = ""
): Promise<void> {
  const suffix = toolStatus
    ? `\n\n<i>${escapeHtml(toolStatus)}</i>`
    : "\n\n<i>streaming...</i>";

  // Try HTML formatted first
  try {
    const formatted = formatForTelegram(text);
    const truncated = formatted.length > 4000
      ? formatted.slice(0, 4000) + "\n\n<i>... truncated (streaming)</i>"
      : formatted + suffix;

    await ctx.api.editMessageText(chatId, messageId, truncated, {
      parse_mode: "HTML",
    });
  } catch {
    // Fallback: plain text if HTML formatting is broken mid-stream
    try {
      const plain = text.length > 4000
        ? text.slice(0, 4000) + "\n\n... streaming"
        : text + "\n\nstreaming...";
      await ctx.api.editMessageText(chatId, messageId, plain);
    } catch {
      // Telegram errors on identical content or rate limits — ignore
    }
  }
}

function stripHtml(text: string): string {
  return text.replace(/<[^>]+>/g, "");
}
