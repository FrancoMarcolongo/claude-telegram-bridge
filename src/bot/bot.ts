import { Bot } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import type { BridgeConfig } from "../types.js";
import { SessionManager } from "../claude/session-manager.js";
import { MessageQueue } from "../claude/queue.js";
import { createAuthMiddleware } from "./middleware/auth.js";
import { createPinMiddleware } from "./middleware/pin.js";
import { createRateLimitMiddleware } from "./middleware/rate-limit.js";
import { createMessageHandler, processMessage } from "./handlers/message.js";
import {
  initCommands,
  handleStart,
  handleNew,
  handleSessions,
  handleSwitch,
  handleStatus,
  handleProject,
  handleProjects,
  handleModel,
  handleEffort,
  handleCost,
  handleKill,
  handleHelp,
} from "./handlers/commands.js";
import { initCallbacks, handleCallback } from "./handlers/callbacks.js";
import { initFileHandler, handleFile } from "./handlers/file.js";
import { initVoiceHandler, handleVoice } from "./handlers/voice.js";
import { mainKeyboard } from "./keyboards.js";
import { checkWhisperAvailable, checkFfmpegAvailable } from "../voice/transcribe.js";
import { logger } from "../utils/logger.js";

// Global kill switch state
let killSwitchActive = false;

export function createBot(token: string, config: BridgeConfig) {
  const bot = new Bot(token);

  // Auto-retry on rate limits
  bot.api.config.use(autoRetry());

  // Shared state
  const sessionManager = new SessionManager(config);
  const messageQueue = new MessageQueue();

  // Initialize handler modules
  initCommands(config, sessionManager, messageQueue);
  initCallbacks(config, sessionManager, messageQueue);
  initFileHandler(config, sessionManager, messageQueue, processMessage);
  initVoiceHandler(config, sessionManager, messageQueue);

  // Check voice dependencies
  if (config.voice.enabled) {
    const whisperOk = checkWhisperAvailable(config.voice.whisperCommand);
    const ffmpegOk = checkFfmpegAvailable();
    if (whisperOk && ffmpegOk) {
      logger.info({ model: config.voice.whisperModel, language: config.voice.language }, "Voice transcription ready");
    } else {
      if (!whisperOk) logger.warn("Whisper not found. Voice messages won't work. Install: pip install openai-whisper");
      if (!ffmpegOk) logger.warn("ffmpeg not found. Voice messages won't work. Install: brew install ffmpeg");
    }
  }

  // === Middleware chain (order matters) ===

  // 1. Auth — user ID whitelist
  bot.use(createAuthMiddleware(config));

  // 2. Kill switch check
  bot.use(async (ctx, next) => {
    if (killSwitchActive) {
      const text = ctx.message?.text?.trim();
      if (text === "/enable") {
        killSwitchActive = false;
        logger.info("Kill switch deactivated");
        await ctx.reply("Bridge re-enabled.");
        return;
      }
      await ctx.reply("Bridge is disabled. Use /enable to re-activate.");
      return;
    }
    await next();
  });

  // 3. PIN challenge (if configured)
  bot.use(createPinMiddleware(config));

  // 4. Rate limiting
  bot.use(createRateLimitMiddleware(config));

  // === Command handlers ===
  bot.command("start", async (ctx) => {
    await handleStart(ctx);
    await ctx.reply("Quick actions:", { reply_markup: mainKeyboard() });
  });
  bot.command("new", handleNew);
  bot.command("sessions", handleSessions);
  bot.command("switch", handleSwitch);
  bot.command("status", handleStatus);
  bot.command("project", handleProject);
  bot.command("projects", handleProjects);
  bot.command("model", handleModel);
  bot.command("effort", handleEffort);
  bot.command("cost", handleCost);
  bot.command("kill", handleKill);
  bot.command("help", handleHelp);

  // Kill all + enable
  bot.command("killall", async (ctx) => {
    killSwitchActive = true;
    const { killAllInteractiveProcesses } = await import("./handlers/message.js");
    const killed = killAllInteractiveProcesses();
    logger.warn({ killed }, "Kill switch activated — all processing stopped");
    await ctx.reply(`Bridge DISABLED. ${killed} process(es) killed. Use /enable to re-activate.`);
  });
  bot.command("enable", async (ctx) => {
    killSwitchActive = false;
    logger.info("Kill switch deactivated");
    await ctx.reply("Bridge re-enabled.");
  });

  // === Callback query handler (inline keyboards) ===
  bot.on("callback_query:data", handleCallback);

  // === File handlers ===
  bot.on("message:photo", handleFile);
  bot.on("message:document", handleFile);
  bot.on("message:voice", handleVoice);

  // === Text message handler (must be last) ===
  const messageHandler = createMessageHandler(config, sessionManager, messageQueue);
  bot.on("message:text", messageHandler);

  // Error handler
  bot.catch((err) => {
    logger.error({ err: err.error, ctx: err.ctx?.update?.update_id }, "Bot error");
  });

  // Set bot commands for Telegram UI
  bot.api.setMyCommands([
    { command: "new", description: "New session [project] [name]" },
    { command: "sessions", description: "List sessions" },
    { command: "switch", description: "Switch session" },
    { command: "status", description: "Current session info" },
    { command: "project", description: "Switch project" },
    { command: "projects", description: "List configured projects" },
    { command: "model", description: "Change model (haiku/sonnet/opus)" },
    { command: "effort", description: "Change effort level" },
    { command: "cost", description: "Cost summary" },
    { command: "kill", description: "Stop current request" },
    { command: "killall", description: "Disable all processing" },
    { command: "enable", description: "Re-enable after killall" },
    { command: "help", description: "Show help" },
  ]).catch((err) => {
    logger.warn({ err }, "Failed to set bot commands");
  });

  return { bot, sessionManager, messageQueue };
}
