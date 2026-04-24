import { EventEmitter } from "node:events";
import type {
  CodexItem,
  CodexThread,
  CodexTurn,
  CompanionSnapshot,
  CompanionStatus,
  PendingServerRequest,
  ThreadRuntime,
} from "./types.js";

type ThreadMutableRuntime = ThreadRuntime & {
  itemMap: Map<string, CodexItem>;
};

const emptyStatus: CompanionStatus = {
  codex: "starting",
  message: null,
  codexUserAgent: null,
};

export class CompanionState extends EventEmitter {
  private readonly threads = new Map<string, ThreadMutableRuntime>();
  private readonly pendingRequests = new Map<string, PendingServerRequest>();
  private status: CompanionStatus = { ...emptyStatus };

  setStatus(status: Partial<CompanionStatus>) {
    this.status = { ...this.status, ...status };
    this.emitChange("status", this.status);
  }

  getStatus() {
    return this.status;
  }

  upsertThread(thread: CodexThread) {
    const runtime = this.ensureThread(thread.id);
    runtime.thread = {
      ...runtime.thread,
      ...thread,
      turns: thread.turns ?? runtime.thread.turns ?? [],
    };

    const items = collectItems(runtime.thread.turns ?? []);
    if (items.length > 0) {
      runtime.items = items;
      runtime.itemMap = new Map(items.map((item) => [item.id, item]));
      runtime.latestOutput = deriveLatestOutput(items);
    }

    this.emitChange("thread", this.toRuntime(runtime));
    return this.toRuntime(runtime);
  }

  setThreads(threads: CodexThread[]) {
    for (const thread of threads) {
      this.upsertThread(thread);
    }
  }

  updateThreadStatus(threadId: string, status: unknown) {
    const runtime = this.ensureThread(threadId);
    runtime.thread.status = status as CodexThread["status"];
    this.emitChange("thread", this.toRuntime(runtime));
  }

  updateThreadName(threadId: string, name: string | null) {
    const runtime = this.ensureThread(threadId);
    runtime.thread.name = name;
    this.emitChange("thread", this.toRuntime(runtime));
  }

  turnStarted(threadId: string, turn: CodexTurn) {
    const runtime = this.ensureThread(threadId);
    runtime.activeTurnId = turn.id;
    runtime.thread.status = { type: "active", activeFlags: [] };
    mergeTurn(runtime.thread, turn);
    this.emitChange("thread", this.toRuntime(runtime));
  }

  turnCompleted(threadId: string, turn: CodexTurn) {
    const runtime = this.ensureThread(threadId);
    if (runtime.activeTurnId === turn.id) {
      runtime.activeTurnId = null;
    }
    mergeTurn(runtime.thread, turn);
    runtime.thread.status = { type: "idle" };
    this.emitChange("thread", this.toRuntime(runtime));
  }

  upsertItem(threadId: string, item: CodexItem) {
    const runtime = this.ensureThread(threadId);
    runtime.itemMap.set(item.id, item);
    runtime.items = Array.from(runtime.itemMap.values());
    runtime.latestOutput = deriveLatestOutput(runtime.items);
    this.emitChange("thread", this.toRuntime(runtime));
  }

  appendItemText(threadId: string, itemId: string, field: "text" | "aggregatedOutput", delta: string) {
    const runtime = this.ensureThread(threadId);
    const item = runtime.itemMap.get(itemId) ?? ({ id: itemId, type: "agentMessage" } as CodexItem);
    const current = typeof item[field] === "string" ? item[field] : "";
    item[field] = `${current}${delta}`;
    runtime.itemMap.set(itemId, item);
    runtime.items = Array.from(runtime.itemMap.values());
    runtime.latestOutput = deriveLatestOutput(runtime.items);
    this.emitChange("thread", this.toRuntime(runtime));
  }

  appendReasoningSummary(threadId: string, itemId: string, delta: string) {
    const runtime = this.ensureThread(threadId);
    const item = runtime.itemMap.get(itemId) ?? ({ id: itemId, type: "reasoning" } as CodexItem);
    const summary = Array.isArray(item.summary) ? item.summary : [""];
    summary[summary.length - 1] = `${summary[summary.length - 1] ?? ""}${delta}`;
    item.summary = summary;
    runtime.itemMap.set(itemId, item);
    runtime.items = Array.from(runtime.itemMap.values());
    this.emitChange("thread", this.toRuntime(runtime));
  }

  setDiff(threadId: string, diff: string) {
    const runtime = this.ensureThread(threadId);
    runtime.latestDiff = diff;
    runtime.changedFiles = extractChangedFiles(diff);
    this.emitChange("thread", this.toRuntime(runtime));
  }

  setPatchChanges(threadId: string, itemId: string, changes: unknown[]) {
    const runtime = this.ensureThread(threadId);
    const item = runtime.itemMap.get(itemId) ?? ({ id: itemId, type: "fileChange" } as CodexItem);
    item.changes = changes;
    runtime.itemMap.set(itemId, item);
    runtime.items = Array.from(runtime.itemMap.values());
    runtime.changedFiles = Array.from(new Set([...runtime.changedFiles, ...extractFilesFromChanges(changes)]));
    this.emitChange("thread", this.toRuntime(runtime));
  }

  addPendingRequest(request: PendingServerRequest) {
    const key = String(request.id);
    this.pendingRequests.set(key, request);
    const threadId = getThreadId(request.params);

    if (threadId) {
      const runtime = this.ensureThread(threadId);
      runtime.pendingApprovals = this.pendingForThread(threadId);
      this.emitChange("thread", this.toRuntime(runtime));
    }

    this.emitChange("approval", request);
  }

  removePendingRequest(requestId: string | number) {
    const request = this.pendingRequests.get(String(requestId));
    this.pendingRequests.delete(String(requestId));
    const threadId = request ? getThreadId(request.params) : null;

    if (threadId) {
      const runtime = this.ensureThread(threadId);
      runtime.pendingApprovals = this.pendingForThread(threadId);
      this.emitChange("thread", this.toRuntime(runtime));
    }

    this.emitChange("approvalResolved", { id: requestId });
  }

  getPendingRequest(requestId: string | number) {
    return this.pendingRequests.get(String(requestId)) ?? null;
  }

  getThread(threadId: string) {
    const runtime = this.threads.get(threadId);
    return runtime ? this.toRuntime(runtime) : null;
  }

  listThreads() {
    return Array.from(this.threads.values())
      .map((runtime) => this.toRuntime(runtime))
      .sort((a, b) => Number(b.thread.updatedAt ?? 0) - Number(a.thread.updatedAt ?? 0));
  }

  snapshot(): CompanionSnapshot {
    return {
      status: this.status,
      threads: this.listThreads(),
      pendingApprovals: Array.from(this.pendingRequests.values()),
    };
  }

  private ensureThread(threadId: string) {
    const current = this.threads.get(threadId);

    if (current) {
      return current;
    }

    const created: ThreadMutableRuntime = {
      thread: { id: threadId, preview: "", turns: [] },
      activeTurnId: null,
      items: [],
      itemMap: new Map(),
      latestOutput: "",
      latestDiff: "",
      changedFiles: [],
      pendingApprovals: [],
    };

    this.threads.set(threadId, created);
    return created;
  }

  private pendingForThread(threadId: string) {
    return Array.from(this.pendingRequests.values()).filter(
      (request) => getThreadId(request.params) === threadId,
    );
  }

  private toRuntime(runtime: ThreadMutableRuntime): ThreadRuntime {
    return {
      thread: runtime.thread,
      activeTurnId: runtime.activeTurnId,
      items: runtime.items,
      latestOutput: runtime.latestOutput,
      latestDiff: runtime.latestDiff,
      changedFiles: runtime.changedFiles,
      pendingApprovals: this.pendingForThread(runtime.thread.id),
    };
  }

  private emitChange(kind: string, payload: unknown) {
    this.emit("change", { kind, payload, snapshot: this.snapshot() });
  }
}

function collectItems(turns: CodexTurn[]) {
  return turns.flatMap((turn) => turn.items ?? []);
}

function mergeTurn(thread: CodexThread, turn: CodexTurn) {
  const turns = thread.turns ?? [];
  const index = turns.findIndex((candidate) => candidate.id === turn.id);

  if (index >= 0) {
    turns[index] = { ...turns[index], ...turn };
  } else {
    turns.push(turn);
  }

  thread.turns = turns;
}

function deriveLatestOutput(items: CodexItem[]) {
  const interesting = [...items].reverse().find((item) => {
    return (
      (item.type === "agentMessage" && typeof item.text === "string" && item.text.length > 0) ||
      (item.type === "commandExecution" &&
        typeof item.aggregatedOutput === "string" &&
        item.aggregatedOutput.length > 0)
    );
  });

  if (!interesting) {
    return "";
  }

  return String(interesting.text ?? interesting.aggregatedOutput ?? "");
}

function extractChangedFiles(diff: string) {
  const files = new Set<string>();

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const parts = line.split(" ");
      const file = parts[3]?.replace(/^b\//, "");
      if (file) files.add(file);
    }
  }

  return Array.from(files);
}

function extractFilesFromChanges(changes: unknown[]) {
  const files = new Set<string>();

  for (const change of changes) {
    if (!change || typeof change !== "object") continue;
    for (const key of ["path", "file", "filePath", "absolutePath"]) {
      const value = (change as Record<string, unknown>)[key];
      if (typeof value === "string") files.add(value);
    }
  }

  return Array.from(files);
}

function getThreadId(params: unknown) {
  if (!params || typeof params !== "object") {
    return null;
  }

  const direct = (params as Record<string, unknown>).threadId;
  if (typeof direct === "string") {
    return direct;
  }

  const conversationId = (params as Record<string, unknown>).conversationId;
  return typeof conversationId === "string" ? conversationId : null;
}
