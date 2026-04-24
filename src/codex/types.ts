export type JsonObject = Record<string, unknown>;

export type JsonRpcRequest = {
  id: string | number;
  method: string;
  params?: unknown;
};

export type JsonRpcResponse = {
  id: string | number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
};

export type JsonRpcNotification = {
  method: string;
  params?: unknown;
};

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

export type CodexThread = JsonObject & {
  id: string;
  preview?: string;
  name?: string | null;
  cwd?: string;
  status?: JsonObject;
  turns?: CodexTurn[];
  createdAt?: number;
  updatedAt?: number;
};

export type CodexTurn = JsonObject & {
  id: string;
  items?: CodexItem[];
  status?: string;
};

export type CodexItem = JsonObject & {
  id: string;
  type: string;
};

export type PendingServerRequest = {
  id: string | number;
  method: string;
  params: unknown;
  createdAt: string;
};

export type CompanionStatus = {
  codex: "starting" | "ready" | "stopped" | "error";
  message: string | null;
  codexUserAgent: string | null;
};

export type ThreadRuntime = {
  thread: CodexThread;
  activeTurnId: string | null;
  items: CodexItem[];
  latestOutput: string;
  latestDiff: string;
  changedFiles: string[];
  pendingApprovals: PendingServerRequest[];
};

export type CompanionSnapshot = {
  status: CompanionStatus;
  threads: ThreadRuntime[];
  pendingApprovals: PendingServerRequest[];
};
