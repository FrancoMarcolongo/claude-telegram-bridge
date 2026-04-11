import type { Context } from "grammy";
import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import type { BridgeConfig } from "../../types.js";
import { SessionManager } from "../../claude/session-manager.js";
import { MessageQueue } from "../../claude/queue.js";
import { logger } from "../../utils/logger.js";

let config: BridgeConfig;
let sessionManager: SessionManager;
let messageQueue: MessageQueue;
let processMessageFn: (ctx: Context, text: string) => Promise<void>;

export function initFileHandler(
  cfg: BridgeConfig,
  sm: SessionManager,
  mq: MessageQueue,
  processMsg: (ctx: Context, text: string) => Promise<void>
) {
  config = cfg;
  sessionManager = sm;
  messageQueue = mq;
  processMessageFn = processMsg;
}

export async function handleFile(ctx: Context) {
  const chatId = ctx.chat!.id;
  const session = sessionManager.getOrCreateSession(chatId);

  // Get file info from photo or document
  let fileId: string | undefined;
  let fileName: string = "upload";

  if (ctx.message?.photo) {
    // Photos come as an array of sizes — take the largest
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    fileId = photo.file_id;
    fileName = `photo_${Date.now()}.jpg`;
  } else if (ctx.message?.document) {
    fileId = ctx.message.document.file_id;
    fileName = ctx.message.document.file_name || `document_${Date.now()}`;
  }

  if (!fileId) {
    await ctx.reply("Unsupported file type.");
    return;
  }

  try {
    // Create uploads directory in the session's working dir
    const uploadsDir = join(session.workingDir, ".claude-bridge-uploads");
    mkdirSync(uploadsDir, { recursive: true });

    const destPath = join(uploadsDir, fileName);

    // Download file from Telegram
    const file = await ctx.api.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;

    const response = await fetch(fileUrl);
    if (!response.ok || !response.body) {
      throw new Error(`Download failed: ${response.status}`);
    }

    const writeStream = createWriteStream(destPath);
    await pipeline(Readable.fromWeb(response.body as never), writeStream);

    logger.info({ fileName, destPath, chatId }, "File uploaded");

    // Build the message to send to Claude
    const caption = ctx.message?.caption || "";
    const message = caption
      ? `The user uploaded a file at \`${destPath}\`. Their message: ${caption}`
      : `The user uploaded a file at \`${destPath}\`. Please acknowledge receipt and describe what you see if it's an image.`;

    await ctx.reply(`File saved to <code>${destPath}</code>. Forwarding to Claude...`, {
      parse_mode: "HTML",
    });

    // Forward to Claude as a regular message
    // Re-use the message handler's processMessage via the queue
    await messageQueue.enqueue(chatId, () => processMessageFn(ctx, message));
  } catch (err) {
    logger.error({ err, chatId, fileName }, "File upload failed");
    await ctx.reply(`File upload failed: ${err instanceof Error ? err.message : "Unknown error"}`);
  }
}
