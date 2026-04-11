import type { Context } from "grammy";
import type { BridgeConfig } from "../../types.js";
import { SessionManager } from "../../claude/session-manager.js";
import { MessageQueue } from "../../claude/queue.js";
import { killInteractiveProcess } from "./message.js";
import { escapeHtml } from "../formatter.js";
import { projectKeyboard, modelKeyboard, effortKeyboard } from "../keyboards.js";

let config: BridgeConfig;
let sessionManager: SessionManager;
let messageQueue: MessageQueue;

export function initCallbacks(cfg: BridgeConfig, sm: SessionManager, mq: MessageQueue) {
  config = cfg;
  sessionManager = sm;
  messageQueue = mq;
}

export async function handleCallback(ctx: Context) {
  const data = ctx.callbackQuery?.data;
  if (!data) return;

  await ctx.answerCallbackQuery();

  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const [action, param] = data.split(":");

  switch (action) {
    case "action":
      await handleAction(ctx, chatId, param);
      break;
    case "project":
      await handleProjectSelect(ctx, chatId, param);
      break;
    case "model":
      await handleModelSelect(ctx, chatId, param);
      break;
    case "effort":
      await handleEffortSelect(ctx, chatId, param);
      break;
    case "session":
      await handleSessionSelect(ctx, chatId, param);
      break;
  }
}

async function handleAction(ctx: Context, chatId: number, action: string) {
  switch (action) {
    case "new": {
      const session = sessionManager.createSession(chatId);
      await ctx.editMessageText(
        `<b>New session</b>: <code>${session.id.slice(0, 8)}</code>\nDir: <code>${escapeHtml(session.workingDir)}</code>`,
        { parse_mode: "HTML" }
      );
      break;
    }
    case "sessions": {
      const sessions = sessionManager.listSessions(chatId);
      const active = sessionManager.getActiveSession(chatId);
      if (sessions.length === 0) {
        await ctx.editMessageText("No sessions yet.");
        return;
      }
      const lines = sessions.map((s) => {
        const marker = s.id === active?.id ? " *" : "";
        return `${escapeHtml(s.name)}${marker} — ${s.messageCount} msgs, $${s.totalCostUsd.toFixed(3)}`;
      });
      await ctx.editMessageText(
        `<b>Sessions</b>\n\n` + lines.join("\n"),
        { parse_mode: "HTML" }
      );
      break;
    }
    case "status": {
      const session = sessionManager.getActiveSession(chatId);
      if (!session) {
        await ctx.editMessageText("No active session.");
        return;
      }
      await ctx.editMessageText(
        `<b>${escapeHtml(session.name)}</b>\n` +
        `Project: ${session.projectKey || "none"}\n` +
        `Model: ${session.model} | Effort: ${session.effort}\n` +
        `Msgs: ${session.messageCount} | Cost: $${session.totalCostUsd.toFixed(3)}`,
        { parse_mode: "HTML" }
      );
      break;
    }
    case "projects": {
      const keys = Object.keys(config.projects);
      if (keys.length === 0) {
        await ctx.editMessageText("No projects configured.");
        return;
      }
      await ctx.editMessageText("Select a project:", {
        reply_markup: projectKeyboard(config),
      });
      break;
    }
    case "cost": {
      const total = sessionManager.getTotalCost();
      await ctx.editMessageText(`<b>Total cost:</b> $${total.toFixed(3)}`, { parse_mode: "HTML" });
      break;
    }
    case "help": {
      await ctx.editMessageText(
        "<b>Commands</b>\n\n" +
        "/new [project] — New session\n" +
        "/sessions — List sessions\n" +
        "/status — Current info\n" +
        "/project — Switch project\n" +
        "/model — Change model\n" +
        "/effort — Change effort\n" +
        "/cost — Cost summary\n" +
        "/kill — Stop request",
        { parse_mode: "HTML" }
      );
      break;
    }
    case "kill": {
      const session = sessionManager.getActiveSession(chatId);
      if (session && killInteractiveProcess(session.id)) {
        await ctx.editMessageText("Process killed.");
      } else {
        await ctx.editMessageText("Nothing running.");
      }
      break;
    }
    case "dismiss": {
      try {
        await ctx.deleteMessage();
      } catch {
        await ctx.editMessageText("OK");
      }
      break;
    }
  }
}

async function handleProjectSelect(ctx: Context, chatId: number, projectKey: string) {
  if (!config.projects[projectKey]) {
    await ctx.editMessageText("Project not found.");
    return;
  }

  const session = sessionManager.getOrCreateSession(chatId);
  sessionManager.updateSessionProject(session.id, projectKey);

  const project = config.projects[projectKey];
  await ctx.editMessageText(
    `Switched to <b>${escapeHtml(projectKey)}</b>\n<code>${escapeHtml(project.path)}</code>`,
    { parse_mode: "HTML" }
  );
}

async function handleModelSelect(ctx: Context, chatId: number, model: string) {
  const session = sessionManager.getOrCreateSession(chatId);
  sessionManager.updateSessionModel(session.id, model);
  await ctx.editMessageText(`Model: <b>${escapeHtml(model)}</b>`, { parse_mode: "HTML" });
}

async function handleEffortSelect(ctx: Context, chatId: number, effort: string) {
  const session = sessionManager.getOrCreateSession(chatId);
  sessionManager.updateSessionEffort(session.id, effort);
  await ctx.editMessageText(`Effort: <b>${effort}</b>`, { parse_mode: "HTML" });
}

async function handleSessionSelect(ctx: Context, chatId: number, prefix: string) {
  const sessions = sessionManager.listSessions(chatId);
  const match = sessions.find((s) => s.id.startsWith(prefix));
  if (!match) {
    await ctx.editMessageText("Session not found.");
    return;
  }
  sessionManager.switchSession(chatId, match.id);
  await ctx.editMessageText(
    `Switched to <b>${escapeHtml(match.name)}</b>`,
    { parse_mode: "HTML" }
  );
}
