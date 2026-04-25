const state = {
  snapshot: null,
  selectedThreadId: null,
  token: localStorage.getItem("xodex-token") || "",
  events: null,
};

const APP_MARKER = "mobile-v6";

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
  const threadCount = state.snapshot.threads?.length ?? 0;
  const marker = `${APP_MARKER} · ${threadCount} threads`;
  setStatus(status.message ? `${statusLine}: ${truncate(status.message, 58)} · ${marker}` : `${statusLine} · ${marker}`);
  renderThreads();
  renderSelectedThread();
}

function renderThreads() {
  const threads = state.snapshot?.threads ?? [];
  els.threadList.replaceChildren();

  if (threads.length === 0) {
    els.threadList.append(createEmptyNotice("No Codex threads returned", "Check that Codex Desktop/CLI has local threads and that this server was restarted after git pull."));
    return;
  }

  const loaded = threads.filter((runtime) => isOpenRuntime(runtime));
  const loadedIds = new Set(loaded.map((runtime) => runtime.thread.id));
  const rest = threads.filter((runtime) => !loadedIds.has(runtime.thread.id));
  const projectGroups = groupProjectThreads(rest.filter((runtime) => !isChatRuntime(runtime)));
  const chats = rest.filter((runtime) => isChatRuntime(runtime));

  if (loaded.length > 0) {
    renderThreadSection("Open threads", loaded, { showProject: true });
  }

  if (projectGroups.length > 0) {
    const section = createSection("Projects");
    for (const group of projectGroups) {
      const project = document.createElement("div");
      project.className = "project-group";

      const title = document.createElement("div");
      title.className = "project-title";
      title.textContent = group.name;

      project.append(title);
      for (const runtime of group.threads) {
        project.append(createThreadButton(runtime));
      }
      section.append(project);
    }
    els.threadList.append(section);
  }

  if (chats.length > 0) {
    renderThreadSection("Chats", chats, { showProject: false });
  }

  if (!els.threadList.children.length) {
    els.threadList.append(createEmptyNotice("No visible groups", `${threads.length} threads were returned, but none matched the sidebar grouping rules.`));
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
  els.stopButton.hidden = !runtime.activeTurnId;
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
  const visible = items.filter(isChatItem).filter((item) => itemText(item).trim()).slice(-60);

  if (!visible.length) {
    els.itemStream.append(
      createEmptyNotice("No chat messages yet", "Send a message from the composer to continue this thread."),
    );
    return;
  }

  for (const item of visible) {
    const card = document.createElement("section");
    card.className = "item-card";
    card.dataset.type = item.type;

    const meta = document.createElement("div");
    meta.className = "item-meta";
    meta.textContent = itemLabel(item);

    const body = document.createElement("div");
    body.className = "message-body";
    renderMarkdown(body, itemText(item));

    card.append(meta, body);
    els.itemStream.append(card);
  }

  requestAnimationFrame(() => {
    els.itemStream.scrollTop = els.itemStream.scrollHeight;
  });
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

function renderThreadSection(title, runtimes, options = {}) {
  const section = createSection(title);
  for (const runtime of runtimes) {
    section.append(createThreadButton(runtime, options));
  }
  els.threadList.append(section);
}

function createSection(title) {
  const section = document.createElement("section");
  section.className = "thread-section";

  const heading = document.createElement("div");
  heading.className = "section-heading";
  heading.textContent = title;

  section.append(heading);
  return section;
}

function createEmptyNotice(title, detail) {
  const notice = document.createElement("div");
  notice.className = "empty-notice";

  const heading = document.createElement("strong");
  heading.textContent = title;

  const body = document.createElement("span");
  body.textContent = detail;

  notice.append(heading, body);
  return notice;
}

function createThreadButton(runtime, options = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `thread-card${runtime.thread.id === state.selectedThreadId ? " active" : ""}`;
  if (runtime.isLoaded) button.classList.add("loaded");
  button.addEventListener("click", () => selectThread(runtime.thread.id));

  const top = document.createElement("div");
  top.className = "thread-card-top";

  const title = document.createElement("strong");
  title.textContent = threadTitle(runtime.thread);

  const age = document.createElement("span");
  age.className = "thread-age";
  age.textContent = formatAge(runtime.thread.updatedAt);

  top.append(title, age);

  const meta = document.createElement("span");
  const project = projectNameFromCwd(runtime.thread.cwd);
  const status = formatThreadStatus(runtime);
  meta.textContent = options.showProject && project ? `${project} · ${status}` : status;

  button.append(top, meta);
  return button;
}

function groupProjectThreads(runtimes) {
  const groups = new Map();

  for (const runtime of runtimes) {
    const key = runtime.thread.cwd || "No project";
    const name = projectNameFromCwd(runtime.thread.cwd) || "No project";
    const group = groups.get(key) ?? { name, threads: [] };
    group.threads.push(runtime);
    groups.set(key, group);
  }

  return Array.from(groups.values()).sort((a, b) => {
    const aUpdated = Math.max(...a.threads.map((runtime) => Number(runtime.thread.updatedAt ?? 0)));
    const bUpdated = Math.max(...b.threads.map((runtime) => Number(runtime.thread.updatedAt ?? 0)));
    return bUpdated - aUpdated;
  });
}

function isOpenRuntime(runtime) {
  return runtime.isLoaded || Boolean(runtime.activeTurnId) || runtime.pendingApprovals.length > 0;
}

function isChatRuntime(runtime) {
  const cwd = runtime.thread.cwd;
  return !cwd || cwd.includes("/Documents/Codex/");
}

function projectNameFromCwd(cwd) {
  if (!cwd) return "";
  const parts = cwd.split("/").filter(Boolean);
  return parts[parts.length - 1] || cwd;
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

function formatAge(seconds) {
  if (!seconds) return "";
  const deltaSeconds = Math.max(0, Math.floor((Date.now() - seconds * 1000) / 1000));
  const minute = 60;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;

  if (deltaSeconds < minute) return "now";
  if (deltaSeconds < hour) return `${Math.floor(deltaSeconds / minute)}m`;
  if (deltaSeconds < day) return `${Math.floor(deltaSeconds / hour)}h`;
  if (deltaSeconds < week) return `${Math.floor(deltaSeconds / day)}d`;
  return `${Math.floor(deltaSeconds / week)}w`;
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
    const status = item.status ? `Status: ${item.status}` : "";
    const exit = Number.isInteger(item.exitCode) ? `Exit: ${item.exitCode}` : "";
    const output = summarizeToolOutput(item.aggregatedOutput);
    return [item.command || "Command", status, exit, output].filter(Boolean).join("\n");
  }
  if (item.type === "fileChange") return JSON.stringify(item.changes || [], null, 2);
  return JSON.stringify(item, null, 2);
}

function isChatItem(item) {
  return item.type === "userMessage" || item.type === "agentMessage" || item.type === "plan";
}

function itemLabel(item) {
  if (item.type === "userMessage") return "You";
  if (item.type === "plan") return "Plan";
  return "Codex";
}

function summarizeToolOutput(output) {
  if (!output) return "";
  const normalized = String(output).replace(/\s+\n/g, "\n").trim();
  if (!normalized) return "";

  if (/^\s*<(!doctype|html|head|body|meta|title|link)\b/i.test(normalized)) {
    return "Output: HTML document";
  }

  return `Output: ${truncate(normalized, 900)}`;
}

function renderMarkdown(container, source) {
  const text = normalizeMarkdown(source);
  const blocks = markdownBlocks(text);

  container.replaceChildren();

  for (const block of blocks) {
    if (block.type === "code") {
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.textContent = block.text;
      pre.append(code);
      container.append(pre);
      continue;
    }

    const lines = block.text.split("\n").filter((line) => line.trim().length > 0);
    if (lines.length === 0) continue;

    if (lines.every((line) => /^\s*[-*]\s+/.test(line))) {
      const list = document.createElement("ul");
      for (const line of lines) {
        const item = document.createElement("li");
        renderInline(item, line.replace(/^\s*[-*]\s+/, ""));
        list.append(item);
      }
      container.append(list);
      continue;
    }

    if (lines.every((line) => /^\s*\d+\.\s+/.test(line))) {
      const list = document.createElement("ol");
      for (const line of lines) {
        const item = document.createElement("li");
        renderInline(item, line.replace(/^\s*\d+\.\s+/, ""));
        list.append(item);
      }
      container.append(list);
      continue;
    }

    if (lines.every((line) => /^\s*>\s?/.test(line))) {
      const quote = document.createElement("blockquote");
      renderInline(quote, lines.map((line) => line.replace(/^\s*>\s?/, "")).join("\n"));
      container.append(quote);
      continue;
    }

    const paragraph = document.createElement("p");
    renderInline(paragraph, lines.join("\n"));
    container.append(paragraph);
  }
}

function markdownBlocks(source) {
  const blocks = [];
  const pending = [];
  const code = [];
  let inCode = false;

  const flushPending = () => {
    if (pending.length > 0) {
      blocks.push({ type: "text", text: pending.join("\n") });
      pending.length = 0;
    }
  };

  const flushCode = () => {
    blocks.push({ type: "code", text: code.join("\n").trimEnd() });
    code.length = 0;
  };

  for (const line of source.split("\n")) {
    if (/^\s*```/.test(line)) {
      if (inCode) {
        flushCode();
        inCode = false;
      } else {
        flushPending();
        inCode = true;
      }
      continue;
    }

    if (inCode) {
      code.push(line);
      continue;
    }

    if (line.trim().length === 0) {
      flushPending();
      continue;
    }

    if (pending.length > 0 && lineKind(pending[pending.length - 1]) !== lineKind(line)) {
      flushPending();
    }

    pending.push(line);
  }

  if (inCode) flushCode();
  flushPending();

  return blocks;
}

function lineKind(line) {
  if (/^\s*[-*]\s+/.test(line)) return "ul";
  if (/^\s*\d+\.\s+/.test(line)) return "ol";
  if (/^\s*>\s?/.test(line)) return "quote";
  return "text";
}

function renderInline(parent, source) {
  const pattern = /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)|`([^`\n]+)`|\*\*([^*\n]+)\*\*|(https?:\/\/[^\s<>()]+)/g;
  let cursor = 0;

  for (const match of source.matchAll(pattern)) {
    appendText(parent, source.slice(cursor, match.index));

    if (match[1] && match[2]) {
      parent.append(createLink(match[2], match[1]));
    } else if (match[3]) {
      const code = document.createElement("code");
      code.textContent = match[3];
      parent.append(code);
    } else if (match[4]) {
      const strong = document.createElement("strong");
      strong.textContent = match[4];
      parent.append(strong);
    } else if (match[5]) {
      const [url, trailing] = splitTrailingPunctuation(match[5]);
      parent.append(createLink(url, shortUrl(url)));
      appendText(parent, trailing);
    }

    cursor = match.index + match[0].length;
  }

  appendText(parent, source.slice(cursor));
}

function createLink(url, label) {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.target = "_blank";
  anchor.rel = "noreferrer";
  anchor.textContent = label;
  return anchor;
}

function appendText(parent, value) {
  if (!value) return;
  parent.append(document.createTextNode(value));
}

function normalizeMarkdown(source) {
  return String(source || "")
    .replace(/\r\n/g, "\n")
    .replace(/\[([^\]\n]+)\]\s*\n\s*\((https?:\/\/[^)\s]+)\)/g, "[$1]($2)")
    .replace(/(^|[^\]])\((https?:\/\/[^)\s]+)\)/g, "$1$2")
    .trim();
}

function splitTrailingPunctuation(url) {
  const match = url.match(/^(.+?)([.,;:!?]+)?$/);
  return [match?.[1] || url, match?.[2] || ""];
}

function shortUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^www\./, "");
    const segments = url.pathname.split("/").filter(Boolean);
    const path = segments.length > 0
      ? `/${segments.slice(0, 2).join("/")}${segments.length > 2 ? "/..." : ""}`
      : "";
    return `${host}${path}${url.search ? "?..." : ""}`;
  } catch {
    return value;
  }
}

function truncate(text, length) {
  if (!text || text.length <= length) return text || "";
  return `${text.slice(0, length - 1)}...`;
}

function titleCase(text) {
  return `${text.slice(0, 1).toUpperCase()}${text.slice(1)}`;
}
