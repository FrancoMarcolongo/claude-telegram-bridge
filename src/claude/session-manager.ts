import { v4 as uuidv4 } from "uuid";
import type { Session, BridgeConfig, ProjectConfig } from "../types.js";
import { saveState, loadState } from "../store/persistence.js";
import { logger } from "../utils/logger.js";

export class SessionManager {
  private sessions = new Map<string, Session>();
  private activeSessions = new Map<number, string>(); // chatId -> sessionId
  private saveTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private config: BridgeConfig) {
    // Restore state from disk
    const restored = loadState();
    if (restored) {
      this.sessions = restored.sessions;
      this.activeSessions = restored.activeSessions;
    }

    // Auto-save every 30 seconds
    this.saveTimer = setInterval(() => this.persist(), 30_000);
  }

  persist(): void {
    saveState(this.sessions, this.activeSessions);
  }

  stopAutoSave(): void {
    if (this.saveTimer) {
      clearInterval(this.saveTimer);
      this.saveTimer = null;
    }
    this.persist(); // Final save
  }

  createSession(chatId: number, projectKey?: string, name?: string): Session {
    const effectiveProjectKey = projectKey || this.config.defaults.defaultProject;
    const project = effectiveProjectKey ? this.config.projects[effectiveProjectKey] : undefined;
    const sessionId = uuidv4();

    const session: Session = {
      id: sessionId,
      chatId,
      name: name || (effectiveProjectKey ? `${effectiveProjectKey}-${Date.now()}` : `session-${Date.now()}`),
      projectKey: effectiveProjectKey || null,
      workingDir: project?.path || this.config.defaults.workingDir,
      model: project?.model || this.config.claude.defaultModel,
      effort: project?.effort || this.config.claude.defaultEffort,
      createdAt: new Date(),
      lastMessageAt: new Date(),
      messageCount: 0,
      totalCostUsd: 0,
      isFirstMessage: true,
    };

    this.sessions.set(sessionId, session);
    this.activeSessions.set(chatId, sessionId);

    logger.info({ sessionId, chatId, projectKey, workingDir: session.workingDir }, "Session created");
    return session;
  }

  getActiveSession(chatId: number): Session | null {
    const sessionId = this.activeSessions.get(chatId);
    if (!sessionId) return null;
    return this.sessions.get(sessionId) || null;
  }

  getOrCreateSession(chatId: number): Session {
    const existing = this.getActiveSession(chatId);
    if (existing) return existing;
    return this.createSession(chatId);
  }

  switchSession(chatId: number, sessionId: string): Session | null {
    const session = this.sessions.get(sessionId);
    if (!session || session.chatId !== chatId) return null;
    this.activeSessions.set(chatId, sessionId);
    return session;
  }

  listSessions(chatId: number): Session[] {
    return Array.from(this.sessions.values())
      .filter((s) => s.chatId === chatId)
      .sort((a, b) => b.lastMessageAt.getTime() - a.lastMessageAt.getTime());
  }

  markMessageSent(sessionId: string, costUsd: number): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.isFirstMessage = false;
    session.messageCount++;
    session.totalCostUsd += costUsd;
    session.lastMessageAt = new Date();
  }

  updateSessionProject(sessionId: string, projectKey: string): boolean {
    const session = this.sessions.get(sessionId);
    const project = this.config.projects[projectKey];
    if (!session || !project) return false;

    session.projectKey = projectKey;
    session.workingDir = project.path;
    if (project.model) session.model = project.model;
    if (project.effort) session.effort = project.effort;
    return true;
  }

  updateSessionModel(sessionId: string, model: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.model = model;
    return true;
  }

  updateSessionEffort(sessionId: string, effort: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.effort = effort;
    return true;
  }

  getProjectConfig(session: Session): ProjectConfig | undefined {
    if (!session.projectKey) return undefined;
    return this.config.projects[session.projectKey];
  }

  getEffectiveTools(session: Session): string[] {
    const project = this.getProjectConfig(session);
    return project?.allowedTools || this.config.claude.defaultTools;
  }

  getEffectiveBudget(session: Session): number {
    const project = this.getProjectConfig(session);
    return project?.maxBudgetUsd || this.config.claude.maxBudgetUsd;
  }

  getEffectivePermissionMode(session: Session): string {
    const project = this.getProjectConfig(session);
    return project?.permissionMode || this.config.claude.defaultPermissionMode;
  }

  deleteSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    // If this is the active session, clear it
    if (this.activeSessions.get(session.chatId) === sessionId) {
      this.activeSessions.delete(session.chatId);
    }
    this.sessions.delete(sessionId);
    return true;
  }

  getTotalCost(): number {
    let total = 0;
    for (const session of this.sessions.values()) {
      total += session.totalCostUsd;
    }
    return total;
  }
}
