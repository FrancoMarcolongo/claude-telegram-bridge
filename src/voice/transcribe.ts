import { execSync, execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { BridgeConfig } from "../types.js";
import { logger } from "../utils/logger.js";

/**
 * Transcribe an audio file using local Whisper.
 * Downloads the Telegram voice message (OGG/OPUS), runs whisper CLI,
 * returns the transcription text.
 *
 * Requires: `pip install openai-whisper` and `brew install ffmpeg`
 */
export async function transcribeAudio(
  oggBuffer: Buffer,
  config: BridgeConfig
): Promise<string> {
  const tmpDir = process.env.TMPDIR || "/tmp";
  const id = Date.now();
  const oggPath = join(tmpDir, `voice_${id}.ogg`);
  const txtPath = join(tmpDir, `voice_${id}.txt`);

  try {
    // Write OGG file to disk
    writeFileSync(oggPath, oggBuffer);

    const { whisperModel, language, whisperCommand } = config.voice;

    // Build whisper command args
    const args: string[] = [
      oggPath,
      "--model", whisperModel,
      "--output_format", "txt",
      "--output_dir", tmpDir,
    ];

    if (language !== "auto") {
      args.push("--language", language);
    }

    logger.info({ model: whisperModel, language, file: oggPath }, "Transcribing voice message");

    // Run whisper
    execFileSync(whisperCommand, args, {
      timeout: 120_000, // 2 min max
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Whisper outputs: /tmp/voice_123.txt
    if (!existsSync(txtPath)) {
      throw new Error("Whisper did not produce output file");
    }

    const text = readFileSync(txtPath, "utf-8").trim();

    if (!text) {
      throw new Error("Whisper returned empty transcription");
    }

    logger.info({ chars: text.length }, "Transcription complete");
    return text;
  } finally {
    // Cleanup temp files
    for (const f of [oggPath, txtPath]) {
      try { unlinkSync(f); } catch { /* ignore */ }
    }
  }
}

/**
 * Check if whisper is available on the system.
 * Returns the version string or null if not found.
 */
export function checkWhisperAvailable(command: string = "whisper"): string | null {
  try {
    const output = execSync(`${command} --help 2>&1`, {
      encoding: "utf-8",
      timeout: 5000,
    });
    // whisper --help outputs usage info if installed
    return output.includes("whisper") || output.includes("Whisper") ? "installed" : null;
  } catch {
    return null;
  }
}

/**
 * Check if ffmpeg is available (required by whisper).
 */
export function checkFfmpegAvailable(): boolean {
  try {
    execSync("ffmpeg -version 2>/dev/null", { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}
