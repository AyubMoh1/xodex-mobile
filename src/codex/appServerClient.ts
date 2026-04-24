import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import readline from "node:readline";
import type { CompanionState } from "./state.js";
import type {
  CodexItem,
  CodexThread,
  JsonObject,
  JsonRpcMessage,
  JsonRpcRequest,
  JsonRpcResponse,
  PendingServerRequest,
} from "./types.js";

type PendingCall = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

export type ApprovalResponseInput = {
  decision?: string;
  action?: string;
  answers?: Record<string, unknown>;
};

export class CodexAppServerClient extends EventEmitter {
  private process: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<string, PendingCall>();
  private readyPromise: Promise<void> | null = null;

  constructor(
    private readonly codexBin: string,
    private readonly state: CompanionState,
  ) {
    super();
  }

  start() {
    if (this.readyPromise) {
      return this.readyPromise;
    }

    this.state.setStatus({ codex: "starting", message: "Starting codex app-server" });
    this.process = spawn(this.codexBin, ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const rl = readline.createInterface({ input: this.process.stdout });
    rl.on("line", (line) => this.handleLine(line));

    this.process.stderr.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        const message = parseCodexLogMessage(line);
        if (!message) continue;

        if (this.state.getStatus().codex !== "ready" || message.level === "ERROR") {
          this.state.setStatus({ message: message.text });
        }
      }
    });

    this.process.on("error", (error) => {
      this.failAll(error);
      this.state.setStatus({ codex: "error", message: error.message });
    });

    this.process.on("exit", (code, signal) => {
      const message = `codex app-server exited${code === null ? "" : ` with ${code}`}${
        signal ? ` (${signal})` : ""
      }`;
      this.failAll(new Error(message));
      this.state.setStatus({ codex: code === 0 ? "stopped" : "error", message });
      this.readyPromise = null;
      this.process = null;
    });

    this.readyPromise = this.initialize();
    return this.readyPromise;
  }

  stop() {
    this.process?.kill("SIGTERM");
  }

  async listThreads(params: JsonObject = {}) {
    await this.start();
    const response = await this.request("thread/list", {
      limit: 50,
      sortKey: "updated_at",
      sortDirection: "desc",
      ...params,
    });
    const threads = getDataArray<CodexThread>(response);
    this.state.setThreads(threads);
    await this.listLoadedThreads();
    return response;
  }

  async listLoadedThreads() {
    await this.start();
    const response = await this.request("thread/loaded/list", { limit: 100 });
    const threadIds = getDataArray<string>(response).filter((threadId) => typeof threadId === "string");
    this.state.setLoadedThreadIds(threadIds);

    for (const threadId of threadIds) {
      const runtime = this.state.getThread(threadId);
      if (!runtime?.thread.preview && !runtime?.thread.cwd) {
        await this.readThread(threadId);
      }
    }

    return response;
  }

  async readThread(threadId: string) {
    await this.start();
    const response = (await this.request("thread/read", { threadId, includeTurns: true })) as {
      thread?: CodexThread;
    };
    if (response.thread) {
      this.state.upsertThread(response.thread);
    }
    return response;
  }

  async startThread(params: JsonObject = {}) {
    await this.start();
    const response = (await this.request("thread/start", {
      experimentalRawEvents: false,
      persistExtendedHistory: true,
      ...params,
    })) as { thread?: CodexThread };
    if (response.thread) {
      this.state.upsertThread(response.thread);
    }
    return response;
  }

  async resumeThread(threadId: string, params: JsonObject = {}) {
    await this.start();
    const response = (await this.request("thread/resume", {
      threadId,
      persistExtendedHistory: true,
      ...params,
    })) as { thread?: CodexThread };
    if (response.thread) {
      this.state.upsertThread(response.thread);
    }
    return response;
  }

  async startTurn(threadId: string, text: string, params: JsonObject = {}) {
    await this.start();
    return this.request("turn/start", {
      threadId,
      input: [{ type: "text", text, text_elements: [] }],
      ...params,
    });
  }

  async steerTurn(threadId: string, turnId: string, text: string) {
    await this.start();
    return this.request("turn/steer", {
      threadId,
      expectedTurnId: turnId,
      input: [{ type: "text", text, text_elements: [] }],
    });
  }

  async interruptTurn(threadId: string, turnId: string) {
    await this.start();
    return this.request("turn/interrupt", { threadId, turnId });
  }

  async compactThread(threadId: string) {
    await this.start();
    return this.request("thread/compact/start", { threadId });
  }

  async runShellCommand(threadId: string, command: string) {
    await this.start();
    return this.request("thread/shellCommand", { threadId, command });
  }

  async respondToServerRequest(requestId: string | number, input: ApprovalResponseInput) {
    const pending = this.state.getPendingRequest(requestId);
    if (!pending) {
      throw new Error(`No pending server request ${requestId}`);
    }

    this.respond(requestId, buildServerRequestResponse(pending, input));
    this.state.removePendingRequest(requestId);
  }

  private async initialize() {
    const result = (await this.request("initialize", {
      clientInfo: {
        name: "xodex-mobile",
        title: "Xodex Mobile",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    })) as JsonObject;

    this.notify("initialized", {});
    this.state.setStatus({
      codex: "ready",
      message: null,
      codexUserAgent: typeof result.userAgent === "string" ? result.userAgent : null,
    });
  }

  private request(method: string, params?: unknown, timeoutMs = 60_000) {
    const id = this.nextId++;
    const message = params === undefined ? { id, method } : { id, method, params };

    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new Error(`${method} timed out`));
      }, timeoutMs);

      this.pending.set(String(id), { resolve, reject, timeout });
      this.write(message);
    });
  }

  private notify(method: string, params?: unknown) {
    this.write(params === undefined ? { method } : { method, params });
  }

  private respond(id: string | number, result: unknown) {
    this.write({ id, result });
  }

  private write(message: unknown) {
    if (!this.process?.stdin.writable) {
      throw new Error("codex app-server is not running");
    }

    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string) {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      this.state.setStatus({ codex: "error", message: `Invalid app-server JSON: ${line}` });
      return;
    }

    if (isResponse(message)) {
      this.handleResponse(message);
      return;
    }

    if (isServerRequest(message)) {
      this.handleServerRequest(message);
      return;
    }

    if ("method" in message) {
      this.handleNotification(message.method, message.params);
    }
  }

  private handleResponse(message: JsonRpcResponse) {
    const pending = this.pending.get(String(message.id));
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pending.delete(String(message.id));

    if (message.error) {
      pending.reject(new Error(message.error.message));
    } else {
      pending.resolve(message.result);
    }
  }

  private handleServerRequest(request: JsonRpcRequest) {
    const pending: PendingServerRequest = {
      id: request.id,
      method: request.method,
      params: request.params,
      createdAt: new Date().toISOString(),
    };

    if (isSupportedServerRequest(request.method)) {
      this.state.addPendingRequest(pending);
      return;
    }

    this.respond(request.id, buildUnsupportedResponse(request.method));
  }

  private handleNotification(method: string, params: unknown) {
    this.emit("notification", { method, params });
    this.emit("event", { method, params });

    if (!params || typeof params !== "object") {
      return;
    }

    const payload = params as JsonObject;
    const threadId = typeof payload.threadId === "string" ? payload.threadId : null;

    switch (method) {
      case "thread/started":
        if (isThread(payload.thread)) this.state.upsertThread(payload.thread);
        break;
      case "thread/status/changed":
        if (threadId) this.state.updateThreadStatus(threadId, payload.status);
        break;
      case "thread/name/updated":
        if (threadId) this.state.updateThreadName(threadId, String(payload.threadName ?? ""));
        break;
      case "turn/started":
        if (threadId && isTurn(payload.turn)) this.state.turnStarted(threadId, payload.turn);
        break;
      case "turn/completed":
        if (threadId && isTurn(payload.turn)) this.state.turnCompleted(threadId, payload.turn);
        break;
      case "turn/diff/updated":
        if (threadId && typeof payload.diff === "string") this.state.setDiff(threadId, payload.diff);
        break;
      case "item/started":
      case "item/completed":
        if (threadId && isItem(payload.item)) this.state.upsertItem(threadId, payload.item);
        break;
      case "item/agentMessage/delta":
      case "item/plan/delta":
        if (threadId && typeof payload.itemId === "string" && typeof payload.delta === "string") {
          this.state.appendItemText(threadId, payload.itemId, "text", payload.delta);
        }
        break;
      case "item/commandExecution/outputDelta":
      case "command/exec/outputDelta":
      case "item/fileChange/outputDelta":
        if (threadId && typeof payload.itemId === "string" && typeof payload.delta === "string") {
          this.state.appendItemText(threadId, payload.itemId, "aggregatedOutput", payload.delta);
        }
        break;
      case "item/reasoning/summaryTextDelta":
        if (threadId && typeof payload.itemId === "string" && typeof payload.delta === "string") {
          this.state.appendReasoningSummary(threadId, payload.itemId, payload.delta);
        }
        break;
      case "item/fileChange/patchUpdated":
        if (threadId && typeof payload.itemId === "string" && Array.isArray(payload.changes)) {
          this.state.setPatchChanges(threadId, payload.itemId, payload.changes);
        }
        break;
      case "serverRequest/resolved":
        if (typeof payload.requestId === "string" || typeof payload.requestId === "number") {
          this.state.removePendingRequest(payload.requestId);
        }
        break;
    }
  }

  private failAll(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function isResponse(message: JsonRpcMessage): message is JsonRpcResponse {
  return "id" in message && ("result" in message || "error" in message) && !("method" in message);
}

function parseCodexLogMessage(line: string) {
  const trimmed = line.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed) as JsonObject;
    const fields = parsed.fields && typeof parsed.fields === "object" ? parsed.fields : {};
    const message = (fields as JsonObject).message;
    return {
      level: typeof parsed.level === "string" ? parsed.level : "INFO",
      text: typeof message === "string" ? message : trimmed,
    };
  } catch {
    return { level: "INFO", text: trimmed };
  }
}

function isServerRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  return "id" in message && "method" in message;
}

function isSupportedServerRequest(method: string) {
  return [
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/permissions/requestApproval",
    "item/tool/requestUserInput",
    "mcpServer/elicitation/request",
    "applyPatchApproval",
    "execCommandApproval",
  ].includes(method);
}

function buildServerRequestResponse(request: PendingServerRequest, input: ApprovalResponseInput) {
  const decision = input.decision ?? input.action ?? "decline";

  switch (request.method) {
    case "item/commandExecution/requestApproval":
      return { decision };
    case "item/fileChange/requestApproval":
      return { decision };
    case "item/permissions/requestApproval":
      return {
        permissions: decision === "accept" ? requestedPermissions(request.params) : {},
        scope: "turn",
      };
    case "item/tool/requestUserInput":
      return { answers: input.answers ?? {} };
    case "mcpServer/elicitation/request":
      return {
        action: input.action ?? decision,
        content: input.answers ?? null,
        _meta: null,
      };
    case "applyPatchApproval":
    case "execCommandApproval":
      return { decision: legacyDecision(decision) };
    default:
      return buildUnsupportedResponse(request.method);
  }
}

function buildUnsupportedResponse(method: string) {
  if (method.includes("Approval")) return { decision: "decline" };
  return {};
}

function requestedPermissions(params: unknown) {
  if (!params || typeof params !== "object") return {};
  const permissions = (params as JsonObject).permissions;
  if (!permissions || typeof permissions !== "object") return {};

  const granted: JsonObject = {};
  const network = (permissions as JsonObject).network;
  const fileSystem = (permissions as JsonObject).fileSystem;
  if (network) granted.network = network;
  if (fileSystem) granted.fileSystem = fileSystem;
  return granted;
}

function legacyDecision(decision: string) {
  if (decision === "accept") return "approved";
  if (decision === "acceptForSession") return "approved_for_session";
  if (decision === "cancel") return "abort";
  return "denied";
}

function getDataArray<T>(value: unknown) {
  if (!value || typeof value !== "object") {
    return [];
  }
  const data = (value as { data?: unknown }).data;
  return Array.isArray(data) ? (data as T[]) : [];
}

function isThread(value: unknown): value is CodexThread {
  return Boolean(value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string");
}

function isTurn(value: unknown): value is { id: string; items?: CodexItem[] } {
  return Boolean(value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string");
}

function isItem(value: unknown): value is CodexItem {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as { id?: unknown }).id === "string" &&
      typeof (value as { type?: unknown }).type === "string",
  );
}
