import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Session } from "../types.js";
import { logger } from "../utils/logger.js";

const STATE_FILE = resolve(process.cwd(), "state.json");

interface PersistedState {
  sessions: SerializedSession[];
  activeSessions: Record<string, string>; // chatId (string) -> sessionId
  savedAt: string;
}

interface SerializedSession extends Omit<Session, "createdAt" | "lastMessageAt"> {
  createdAt: string;
  lastMessageAt: string;
}

export function saveState(
  sessions: Map<string, Session>,
  activeSessions: Map<number, string>
): void {
  const serialized: SerializedSession[] = [];
  for (const session of sessions.values()) {
    serialized.push({
      ...session,
      createdAt: session.createdAt.toISOString(),
      lastMessageAt: session.lastMessageAt.toISOString(),
    });
  }

  const activeMap: Record<string, string> = {};
  for (const [chatId, sessionId] of activeSessions) {
    activeMap[String(chatId)] = sessionId;
  }

  const state: PersistedState = {
    sessions: serialized,
    activeSessions: activeMap,
    savedAt: new Date().toISOString(),
  };

  try {
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    logger.debug({ count: serialized.length }, "State saved");
  } catch (err) {
    logger.error({ err }, "Failed to save state");
  }
}

export function loadState(): {
  sessions: Map<string, Session>;
  activeSessions: Map<number, string>;
} | null {
  if (!existsSync(STATE_FILE)) return null;

  try {
    const raw = readFileSync(STATE_FILE, "utf-8");
    const state: PersistedState = JSON.parse(raw);

    const sessions = new Map<string, Session>();
    for (const s of state.sessions) {
      sessions.set(s.id, {
        ...s,
        createdAt: new Date(s.createdAt),
        lastMessageAt: new Date(s.lastMessageAt),
        // Resumed sessions are never "first message"
        isFirstMessage: false,
      });
    }

    const activeSessions = new Map<number, string>();
    for (const [chatIdStr, sessionId] of Object.entries(state.activeSessions)) {
      activeSessions.set(Number(chatIdStr), sessionId);
    }

    logger.info({ sessions: sessions.size, savedAt: state.savedAt }, "State restored");
    return { sessions, activeSessions };
  } catch (err) {
    logger.error({ err }, "Failed to load state");
    return null;
  }
}
