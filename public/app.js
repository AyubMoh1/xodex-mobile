const state = {
  snapshot: null,
  selectedThreadId: null,
  token: localStorage.getItem("xodex-token") || "",
  events: null,
};

const els = {
  workspace: document.querySelector("#workspace"),
  backButton: document.querySelector("#backButton"),
  refreshButton: document.querySelector("#refreshButton"),
  statusText: document.querySelector("#statusText"),
  newThreadButton: document.querySelector("#newThreadButton"),
  cwdInput: document.querySelector("#cwdInput"),
  threadList: document.querySelector("#threadList"),
  emptyState: document.querySelector("#emptyState"),
  threadView: document.querySelector("#threadView"),
  threadTitle: document.querySelector("#threadTitle"),
  threadCwd: document.querySelector("#threadCwd"),
  threadStatus: document.querySelector("#threadStatus"),
  stopButton: document.querySelector("#stopButton"),
  approvalStack: document.querySelector("#approvalStack"),
  changedFiles: document.querySelector("#changedFiles"),
  latestOutput: document.querySelector("#latestOutput"),
  itemStream: document.querySelector("#itemStream"),
  composer: document.querySelector("#composer"),
  composerHint: document.querySelector("#composerHint"),
  messageInput: document.querySelector("#messageInput"),
  tokenDialog: document.querySelector("#tokenDialog"),
  tokenForm: document.querySelector("#tokenForm"),
  tokenInput: document.querySelector("#tokenInput"),
};

els.cwdInput.value = localStorage.getItem("xodex-cwd") || "";

els.refreshButton.addEventListener("click", () => refresh());
els.backButton.addEventListener("click", () => showThreads());
els.newThreadButton.addEventListener("click", () => newThread());
els.cwdInput.addEventListener("change", () => {
  localStorage.setItem("xodex-cwd", els.cwdInput.value.trim());
});
els.stopButton.addEventListener("click", () => stopActiveTurn());
els.composer.addEventListener("submit", (event) => {
  event.preventDefault();
  sendMessage();
});
els.tokenForm.addEventListener("submit", () => {
  state.token = els.tokenInput.value.trim();
  localStorage.setItem("xodex-token", state.token);
  refresh();
});

refresh();

async function refresh() {
  try {
    setStatus("Connecting");
    await api("/api/threads");
    state.snapshot = await api("/api/snapshot");
    if (!state.selectedThreadId && state.snapshot.threads[0]) {
      state.selectedThreadId = state.snapshot.threads[0].thread.id;
    }
    connectEvents();
    render();
  } catch (error) {
    if (error.status === 401) {
      askForToken();
      return;
    }
    setStatus(error.message || "Offline");
  }
}

function connectEvents() {
  if (state.events) return;

  const url = state.token
    ? `/api/events?token=${encodeURIComponent(state.token)}`
    : "/api/events";
  state.events = new EventSource(url);
  state.events.addEventListener("snapshot", (event) => {
    state.snapshot = JSON.parse(event.data);
    render();
  });
  state.events.addEventListener("xodex", (event) => {
    const payload = JSON.parse(event.data);
    state.snapshot = payload.snapshot;
    render();
  });
  state.events.addEventListener("error", () => {
    state.events?.close();
    state.events = null;
    setTimeout(() => connectEvents(), 2000);
  });
}

async function selectThread(threadId) {
  state.selectedThreadId = threadId;
  showThread();
  render();
  await api(`/api/threads/${encodeURIComponent(threadId)}`);
  await api(`/api/threads/${encodeURIComponent(threadId)}/resume`, {
    method: "POST",
    body: bodyWithCwd({}),
  });
  state.snapshot = await api("/api/snapshot");
  render();
}

async function newThread() {
  const response = await api("/api/threads", {
    method: "POST",
    body: bodyWithCwd({}),
  });
  const threadId = response.thread?.id;
  if (threadId) {
    state.selectedThreadId = threadId;
    showThread();
    state.snapshot = await api("/api/snapshot");
    render();
  }
}

async function sendMessage() {
  const text = els.messageInput.value.trim();
  if (!text) return;

  if (!state.selectedThreadId) {
    await newThread();
  }

  const runtime = selectedRuntime();
  if (!runtime) return;

  els.messageInput.value = "";
  const endpoint = runtime.activeTurnId
    ? `/api/threads/${encodeURIComponent(runtime.thread.id)}/steer`
    : `/api/threads/${encodeURIComponent(runtime.thread.id)}/send`;
  const body = runtime.activeTurnId
    ? { text, turnId: runtime.activeTurnId }
    : bodyWithCwd({ text });

  await api(endpoint, { method: "POST", body });
  els.composerHint.textContent = runtime.activeTurnId ? "Steered active turn" : "Turn started";
}

async function stopActiveTurn() {
  const runtime = selectedRuntime();
  if (!runtime?.activeTurnId) return;
  await api(`/api/threads/${encodeURIComponent(runtime.thread.id)}/interrupt`, {
    method: "POST",
    body: { turnId: runtime.activeTurnId },
  });
}

async function answerApproval(id, decision) {
  await api(`/api/approvals/${encodeURIComponent(id)}/respond`, {
    method: "POST",
    body: { decision, action: decision },
  });
}

function render() {
  if (!state.snapshot) return;

  const status = state.snapshot.status;
  const statusLine = status.codex === "ready" ? "Ready" : titleCase(status.codex);
  setStatus(status.message ? `${statusLine}: ${truncate(status.message, 80)}` : statusLine);
  renderThreads();
  renderSelectedThread();
}

function renderThreads() {
  const threads = state.snapshot?.threads ?? [];
  els.threadList.replaceChildren();

  if (threads.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No Codex threads yet.";
    els.threadList.append(empty);
    return;
  }

  for (const runtime of threads) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `thread-card${runtime.thread.id === state.selectedThreadId ? " active" : ""}`;
    button.addEventListener("click", () => selectThread(runtime.thread.id));

    const title = document.createElement("strong");
    title.textContent = threadTitle(runtime.thread);

    const meta = document.createElement("span");
    meta.textContent = `${formatThreadStatus(runtime)} · ${formatDate(runtime.thread.updatedAt)}`;

    const cwd = document.createElement("span");
    cwd.textContent = runtime.thread.cwd || "No cwd";

    button.append(title, meta, cwd);
    els.threadList.append(button);
  }
}

function renderSelectedThread() {
  const runtime = selectedRuntime();
  els.emptyState.hidden = Boolean(runtime);
  els.threadView.hidden = !runtime;

  if (!runtime) {
    els.workspace.classList.remove("show-thread");
    return;
  }

  els.threadTitle.textContent = threadTitle(runtime.thread);
  els.threadCwd.textContent = runtime.thread.cwd || "Project";
  els.threadStatus.textContent = formatThreadStatus(runtime);
  els.stopButton.disabled = !runtime.activeTurnId;
  els.composerHint.textContent = runtime.activeTurnId ? "Steer active turn" : "Start next turn";
  renderApprovals(runtime.pendingApprovals);
  renderChangedFiles(runtime.changedFiles);
  els.latestOutput.textContent = runtime.latestOutput || "No output yet.";
  renderItems(runtime.items);
}

function renderApprovals(approvals) {
  els.approvalStack.replaceChildren();

  for (const approval of approvals) {
    const card = document.createElement("section");
    card.className = "approval-card";

    const title = document.createElement("h3");
    title.textContent = approvalTitle(approval);

    const details = document.createElement("pre");
    details.textContent = approvalText(approval);

    const actions = document.createElement("div");
    actions.className = "approval-actions";

    const accept = document.createElement("button");
    accept.className = "send-button";
    accept.type = "button";
    accept.textContent = "Approve";
    accept.addEventListener("click", () => answerApproval(approval.id, "accept"));

    const session = document.createElement("button");
    session.className = "plain-button";
    session.type = "button";
    session.textContent = "Approve session";
    session.addEventListener("click", () => answerApproval(approval.id, "acceptForSession"));

    const reject = document.createElement("button");
    reject.className = "danger-button";
    reject.type = "button";
    reject.textContent = "Reject";
    reject.addEventListener("click", () => answerApproval(approval.id, "decline"));

    actions.append(accept, session, reject);
    card.append(title, details, actions);
    els.approvalStack.append(card);
  }
}

function renderChangedFiles(files) {
  els.changedFiles.replaceChildren();

  if (!files.length) {
    const item = document.createElement("li");
    item.textContent = "No file changes yet.";
    els.changedFiles.append(item);
    return;
  }

  for (const file of files) {
    const item = document.createElement("li");
    item.textContent = file;
    els.changedFiles.append(item);
  }
}

function renderItems(items) {
  els.itemStream.replaceChildren();
  const visible = items.slice(-30);

  for (const item of visible) {
    const card = document.createElement("section");
    card.className = "item-card";
    card.dataset.type = item.type;

    const meta = document.createElement("div");
    meta.className = "item-meta";
    meta.textContent = item.type;

    const body = document.createElement("pre");
    body.textContent = itemText(item);

    card.append(meta, body);
    els.itemStream.append(card);
  }
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (state.token) headers.set("x-xodex-token", state.token);

  const request = { ...options, headers };
  if (options.body && typeof options.body !== "string") {
    headers.set("content-type", "application/json");
    request.body = JSON.stringify(options.body);
  }

  const response = await fetch(path, request);
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(data.error || response.statusText);
    error.status = response.status;
    throw error;
  }

  return data;
}

function bodyWithCwd(body) {
  const cwd = els.cwdInput.value.trim();
  if (cwd) return { ...body, cwd };
  return body;
}

function selectedRuntime() {
  return (state.snapshot?.threads ?? []).find((runtime) => runtime.thread.id === state.selectedThreadId);
}

function showThread() {
  els.workspace.classList.add("show-thread");
  els.backButton.hidden = false;
}

function showThreads() {
  els.workspace.classList.remove("show-thread");
  els.backButton.hidden = true;
}

function askForToken() {
  els.tokenInput.value = state.token;
  if (!els.tokenDialog.open) els.tokenDialog.showModal();
}

function setStatus(text) {
  els.statusText.textContent = text;
}

function threadTitle(thread) {
  return thread.name || truncate(thread.preview || thread.id, 72);
}

function formatThreadStatus(runtime) {
  const status = runtime.thread.status;
  if (runtime.pendingApprovals.length > 0) return "waiting approval";
  if (runtime.activeTurnId) return "running";
  if (!status || typeof status !== "object") return "idle";
  const type = status.type || "idle";
  const flags = Array.isArray(status.activeFlags) ? status.activeFlags : [];
  return flags.length ? `${type}: ${flags.join(", ")}` : String(type);
}

function formatDate(seconds) {
  if (!seconds) return "unknown";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(seconds * 1000));
}

function approvalTitle(approval) {
  if (approval.method.includes("commandExecution") || approval.method === "execCommandApproval") {
    return "Command approval";
  }
  if (approval.method.includes("fileChange") || approval.method === "applyPatchApproval") {
    return "File change approval";
  }
  if (approval.method.includes("permissions")) {
    return "Permission approval";
  }
  return "User input requested";
}

function approvalText(approval) {
  const params = approval.params || {};
  if (params.command) return `${params.cwd || ""}\n${params.command}`.trim();
  if (Array.isArray(params.command)) return `${params.cwd || ""}\n${params.command.join(" ")}`.trim();
  if (params.reason) return params.reason;
  return JSON.stringify(params, null, 2);
}

function itemText(item) {
  if (item.type === "userMessage") {
    return (item.content || []).map((part) => part.text || part.path || part.name || "").join("\n");
  }
  if (item.type === "agentMessage" || item.type === "plan") return item.text || "";
  if (item.type === "reasoning") return (item.summary || item.content || []).join("\n");
  if (item.type === "commandExecution") {
    const output = item.aggregatedOutput ? `\n\n${item.aggregatedOutput}` : "";
    return `${item.command || ""}${output}`;
  }
  if (item.type === "fileChange") return JSON.stringify(item.changes || [], null, 2);
  return JSON.stringify(item, null, 2);
}

function truncate(text, length) {
  if (!text || text.length <= length) return text || "";
  return `${text.slice(0, length - 1)}...`;
}

function titleCase(text) {
  return `${text.slice(0, 1).toUpperCase()}${text.slice(1)}`;
}
