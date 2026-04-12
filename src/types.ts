export interface BridgeConfig {
  telegram: {
    allowedUserIds: number[];
    rateLimitPerMinute: number;
  };
  security: {
    requirePin: boolean;
    maxConcurrentSessions: number;
  };
  claude: {
    cliPath: string;
    defaultModel: string;
    defaultEffort: string;
    defaultPermissionMode: string;
    maxBudgetUsd: number;
    defaultTools: string[];
    processTimeoutMs: number;
  };
  projects: Record<string, ProjectConfig>;
  voice: {
    enabled: boolean;
    whisperModel: string;
    language: string;
    whisperCommand: string;
  };
  defaults: {
    defaultProject?: string;
    workingDir: string;
    streamUpdateIntervalMs: number;
  };
}

export interface ProjectConfig {
  path: string;
  allowedTools?: string[];
  model?: string;
  effort?: string;
  maxBudgetUsd?: number;
  permissionMode?: string;
}

export interface Session {
  id: string;
  chatId: number;
  name: string;
  projectKey: string | null;
  workingDir: string;
  model: string;
  effort: string;
  createdAt: Date;
  lastMessageAt: Date;
  messageCount: number;
  totalCostUsd: number;
  isFirstMessage: boolean;
}

export interface ExecuteOptions {
  message: string;
  sessionId: string;
  isNewSession: boolean;
  workingDir: string;
  model?: string;
  effort?: string;
  permissionMode?: string;
  allowedTools?: string[];
  maxBudgetUsd?: number;
  sessionName?: string;
  abortSignal?: AbortSignal;
}

export interface StreamCallbacks {
  onTextDelta: (text: string) => void;
  onToolUse: (toolName: string, input?: string) => void;
  onResult: (result: ClaudeResult) => void;
  onError: (error: Error) => void;
}

export interface ClaudeResult {
  text: string;
  sessionId: string;
  costUsd: number;
  durationMs: number;
  numTurns: number;
  isError: boolean;
}
