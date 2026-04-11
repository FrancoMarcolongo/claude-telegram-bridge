import { createInterface } from "node:readline";
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { stringify as toYaml } from "yaml";

const rl = createInterface({ input: process.stdin, output: process.stdout });

function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

async function main() {
  console.log("\n  Claude Telegram Bridge — Setup\n");
  console.log("  This wizard will help you configure the bridge.\n");

  // Step 1: Bot token
  console.log("  STEP 1: Telegram Bot Token\n");
  console.log("  1. Open Telegram and message @BotFather");
  console.log("  2. Send /newbot and follow the prompts");
  console.log("  3. Copy the bot token\n");

  let botToken = "";
  while (!botToken) {
    botToken = await ask("  Paste your bot token: ");
    if (!botToken.includes(":")) {
      console.log("  That doesn't look like a valid token. It should contain a colon (:).\n");
      botToken = "";
    }
  }

  // Step 2: User ID
  console.log("\n  STEP 2: Your Telegram User ID\n");
  console.log("  1. Open Telegram and message @userinfobot");
  console.log("  2. It will reply with your numeric user ID\n");

  let userId = 0;
  while (!userId) {
    const input = await ask("  Enter your Telegram user ID: ");
    userId = parseInt(input, 10);
    if (isNaN(userId) || userId <= 0) {
      console.log("  That doesn't look like a valid user ID. It should be a number.\n");
      userId = 0;
    }
  }

  // Step 3: PIN (optional)
  console.log("\n  STEP 3: Security PIN (optional)\n");
  console.log("  A PIN adds an extra layer of security. You'll need to enter it");
  console.log("  the first time you message the bot each session.\n");

  const pin = await ask("  Set a PIN (leave blank to skip): ");

  // Step 4: Projects
  console.log("\n  STEP 4: Projects\n");
  console.log("  Add your project directories so you can quickly switch between them.\n");

  const projects: Record<string, { path: string }> = {};
  let addMore = true;

  while (addMore) {
    const name = await ask("  Project name (e.g., my-app) or blank to finish: ");
    if (!name) {
      addMore = false;
      break;
    }

    const path = await ask("  Project path (absolute): ");
    if (path) {
      if (!existsSync(path)) {
        console.log(`  Warning: ${path} does not exist. Adding anyway.\n`);
      }
      projects[name] = { path };
      console.log(`  Added project '${name}' -> ${path}\n`);
    }
  }

  // Step 5: Verify Claude CLI
  console.log("\n  STEP 5: Verifying Claude CLI...\n");
  try {
    const version = execSync("claude --version 2>/dev/null", { encoding: "utf-8" }).trim();
    console.log(`  Claude CLI found: ${version}\n`);
  } catch {
    console.log("  WARNING: 'claude' command not found in PATH.");
    console.log("  Install it with: npm install -g @anthropic-ai/claude-code\n");
  }

  // Step 6: Voice message support
  console.log("\n  STEP 6: Voice Messages (optional)\n");
  console.log("  Voice messages let you speak into Telegram and have it");
  console.log("  transcribed locally using Whisper (free, any language).\n");

  let voiceEnabled = false;
  let hasWhisper = false;
  let hasFfmpeg = false;

  try {
    execSync("whisper --help 2>&1", { timeout: 5000 });
    hasWhisper = true;
  } catch { /* not installed */ }

  try {
    execSync("ffmpeg -version 2>/dev/null", { timeout: 5000 });
    hasFfmpeg = true;
  } catch { /* not installed */ }

  if (hasWhisper && hasFfmpeg) {
    console.log("  Whisper and ffmpeg are already installed!\n");
    voiceEnabled = true;
  } else {
    if (!hasFfmpeg) console.log("  ffmpeg: NOT FOUND — install with: brew install ffmpeg");
    if (!hasWhisper) console.log("  whisper: NOT FOUND — install with: pip install openai-whisper");
    console.log("");
    const installVoice = await ask("  Install voice dependencies now? (y/n): ");
    if (installVoice.toLowerCase() === "y") {
      console.log("");
      if (!hasFfmpeg) {
        console.log("  Run: brew install ffmpeg");
      }
      if (!hasWhisper) {
        console.log("  Run: pip install openai-whisper");
      }
      console.log("\n  Install those manually, then voice will work automatically.\n");
    }
    voiceEnabled = hasWhisper && hasFfmpeg;
  }

  // Write .env
  const envPath = resolve(process.cwd(), ".env");
  const envContent = [
    `TELEGRAM_BOT_TOKEN=${botToken}`,
    pin ? `BRIDGE_PIN=${pin}` : "BRIDGE_PIN=",
  ].join("\n") + "\n";

  writeFileSync(envPath, envContent);
  console.log(`  Written: .env`);

  // Write config.yaml
  const configPath = resolve(process.cwd(), "config.yaml");
  const config = {
    telegram: {
      allowedUserIds: [userId],
      rateLimitPerMinute: 10,
    },
    security: {
      requirePin: !!pin,
      maxConcurrentSessions: 3,
    },
    claude: {
      defaultModel: "sonnet",
      defaultEffort: "high",
      maxBudgetUsd: 5.0,
      defaultTools: ["Bash", "Edit", "Read", "Write", "Glob", "Grep"],
      processTimeoutMs: 300000,
    },
    projects: Object.keys(projects).length > 0 ? projects : undefined,
    voice: {
      enabled: voiceEnabled,
      whisperModel: "base",
      language: "auto",
    },
    defaults: {
      workingDir: "~",
      streamUpdateIntervalMs: 2000,
    },
  };

  writeFileSync(configPath, toYaml(config, { indent: 2 }));
  console.log(`  Written: config.yaml`);

  // Step 7: Test bot connection
  console.log("\n  STEP 7: Testing bot connection...\n");
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
    const data = (await res.json()) as { ok: boolean; result?: { username: string } };
    if (data.ok && data.result) {
      console.log(`  Bot connected: @${data.result.username}\n`);
    } else {
      console.log("  WARNING: Bot token may be invalid. Check with @BotFather.\n");
    }
  } catch {
    console.log("  WARNING: Could not connect to Telegram API. Check your network.\n");
  }

  console.log("  Setup complete! Start the bridge with:\n");
  console.log("    npm run dev\n");
  console.log("  Then message your bot on Telegram.\n");

  rl.close();
}

main().catch((err) => {
  console.error("Setup failed:", err);
  rl.close();
  process.exit(1);
});
