import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { config as loadEnv } from "dotenv";
import type { BridgeConfig } from "./types.js";

const projectSchema = z.object({
  path: z.string(),
  allowedTools: z.array(z.string()).optional(),
  model: z.string().optional(),
  effort: z.string().optional(),
  maxBudgetUsd: z.number().positive().optional(),
  permissionMode: z.string().optional(),
});

const configSchema = z.object({
  telegram: z.object({
    allowedUserIds: z.array(z.number()).min(1, "At least one allowed user ID is required"),
    rateLimitPerMinute: z.number().positive().default(10),
  }),
  security: z.object({
    requirePin: z.boolean().default(false),
    maxConcurrentSessions: z.number().positive().default(3),
  }),
  claude: z.object({
    cliPath: z.string().default("claude"),
    defaultModel: z.string().default("sonnet"),
    defaultEffort: z.string().default("high"),
    defaultPermissionMode: z.string().default("auto"),
    maxBudgetUsd: z.number().positive().default(5.0),
    defaultTools: z.array(z.string()).default(["Bash", "Edit", "Read", "Write", "Glob", "Grep"]),
    processTimeoutMs: z.number().positive().default(300_000),
  }),
  projects: z.record(z.string(), projectSchema).default({}),
  voice: z.object({
    enabled: z.boolean().default(true),
    whisperModel: z.string().default("base"),
    language: z.string().default("auto"),
    whisperCommand: z.string().default("whisper"),
  }).default({}),
  defaults: z.object({
    workingDir: z.string().default("~"),
    streamUpdateIntervalMs: z.number().positive().default(2000),
  }),
});

export function loadConfig(): BridgeConfig {
  const root = process.cwd();

  // Load .env
  const envPath = resolve(root, ".env");
  if (existsSync(envPath)) {
    loadEnv({ path: envPath });
  }

  // Load config.yaml
  const configPath = resolve(root, "config.yaml");
  if (!existsSync(configPath)) {
    throw new Error(
      `config.yaml not found at ${configPath}. Copy config.example.yaml to config.yaml and edit it.`
    );
  }

  const raw = readFileSync(configPath, "utf-8");
  const parsed = parseYaml(raw);

  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid config.yaml:\n${issues}`);
  }

  // Validate bot token from env
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken || botToken === "your-bot-token-here") {
    throw new Error(
      "TELEGRAM_BOT_TOKEN not set. Add it to your .env file."
    );
  }

  // Resolve ~ in working directories
  const home = process.env.HOME || "/tmp";
  const config = result.data;
  if (config.defaults.workingDir.startsWith("~")) {
    config.defaults.workingDir = config.defaults.workingDir.replace("~", home);
  }
  for (const project of Object.values(config.projects)) {
    if (project.path.startsWith("~")) {
      project.path = project.path.replace("~", home);
    }
  }

  return config as BridgeConfig;
}

export function getBotToken(): string {
  return process.env.TELEGRAM_BOT_TOKEN!;
}

export function getBridgePin(): string | undefined {
  const pin = process.env.BRIDGE_PIN;
  return pin && pin.length > 0 ? pin : undefined;
}
