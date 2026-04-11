import type { Context } from "grammy";
import type { BridgeConfig } from "../../types.js";
import { SessionManager } from "../../claude/session-manager.js";
import { MessageQueue } from "../../claude/queue.js";
import { transcribeAudio } from "../../voice/transcribe.js";
import { processMessage } from "./message.js";
import { escapeHtml } from "../formatter.js";
import { logger } from "../../utils/logger.js";

let config: BridgeConfig;
let sessionManager: SessionManager;
let messageQueue: MessageQueue;

export function initVoiceHandler(
  cfg: BridgeConfig,
  sm: SessionManager,
  mq: MessageQueue
) {
  config = cfg;
  sessionManager = sm;
  messageQueue = mq;
}

export async function handleVoice(ctx: Context) {
  const chatId = ctx.chat!.id;
  const voice = ctx.message?.voice;

  if (!voice) return;

  if (!config.voice.enabled) {
    await ctx.reply("Voice messages are disabled. Enable them in config.yaml.");
    return;
  }

  // Show transcribing status
  await ctx.api.sendChatAction(chatId, "typing");
  const statusMsg = await ctx.reply("Transcribing voice message...");

  try {
    // Download the voice file from Telegram
    const file = await ctx.api.getFile(voice.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;

    const response = await fetch(fileUrl);
    if (!response.ok || !response.body) {
      throw new Error(`Failed to download voice file: ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    logger.info({ duration: voice.duration, fileSize: voice.file_size, chatId }, "Voice message received");

    // Transcribe
    const transcription = await transcribeAudio(buffer, config);

    // Show the transcription to the user so they can verify
    try {
      await ctx.api.editMessageText(
        chatId,
        statusMsg.message_id,
        `<i>Voice:</i> ${escapeHtml(transcription)}`,
        { parse_mode: "HTML" }
      );
    } catch {
      await ctx.reply(`<i>Voice:</i> ${escapeHtml(transcription)}`, { parse_mode: "HTML" });
    }

    // Forward to Claude as a regular message
    await messageQueue.enqueue(chatId, () => processMessage(ctx, transcription));
  } catch (err) {
    logger.error({ err, chatId }, "Voice transcription failed");

    const errorMsg = err instanceof Error ? err.message : "Unknown error";
    try {
      await ctx.api.editMessageText(
        chatId,
        statusMsg.message_id,
        `Voice transcription failed: ${errorMsg}\n\nMake sure whisper is installed: pip install openai-whisper`
      );
    } catch {
      await ctx.reply(`Voice transcription failed: ${errorMsg}`);
    }
  }
}
