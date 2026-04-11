import { execSync } from "node:child_process";
import { loadConfig, getBotToken } from "./config.js";
import { createBot } from "./bot/bot.js";
import { logger } from "./utils/logger.js";

async function main() {
  logger.info("Starting Claude Telegram Bridge...");

  // Load config
  const config = loadConfig();
  const botToken = getBotToken();

  logger.info(
    {
      allowedUsers: config.telegram.allowedUserIds.length,
      projects: Object.keys(config.projects).length,
      model: config.claude.defaultModel,
    },
    "Config loaded"
  );

  // Verify claude CLI is available
  try {
    const version = execSync(`${config.claude.cliPath} --version 2>/dev/null`, {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
    logger.info({ version }, "Claude CLI found");
  } catch {
    logger.error(
      { cliPath: config.claude.cliPath },
      "Claude CLI not found. Make sure it's installed and in your PATH."
    );
    process.exit(1);
  }

  // Create and start bot
  const { bot, sessionManager } = createBot(botToken, config);

  // Graceful shutdown
  const shutdown = () => {
    logger.info("Shutting down...");
    sessionManager.stopAutoSave();
    bot.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Start long polling
  logger.info("Bot starting... (long polling)");
  await bot.start({
    onStart: (info) => {
      logger.info({ username: info.username }, "Bot is running! Send a message on Telegram.");
    },
  });
}

main().catch((err) => {
  logger.error({ err }, "Fatal error");
  process.exit(1);
});
