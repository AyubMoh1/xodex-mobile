import express, { type ErrorRequestHandler } from "express";
import type { CodexAppServerClient } from "../codex/appServerClient.js";
import type { CompanionState } from "../codex/state.js";
import { EventHub } from "./events.js";

export function createApiRouter(bridge: CodexAppServerClient, state: CompanionState) {
  const router = express.Router();
  const events = new EventHub(state);

  router.get("/health", (_req, res) => {
    res.json({ ok: true, status: state.getStatus() });
  });

  router.get("/events", events.handle);

  router.get("/snapshot", (_req, res) => {
    res.json(state.snapshot());
  });

  router.get("/threads", asyncHandler(async (req, res) => {
    const response = await bridge.listThreads({
      searchTerm: typeof req.query.search === "string" ? req.query.search : null,
    });
    res.json(response);
  }));

  router.post("/threads", asyncHandler(async (req, res) => {
    const response = await bridge.startThread(req.body ?? {});
    res.status(201).json(response);
  }));

  router.get("/threads/:threadId", asyncHandler(async (req, res) => {
    const threadId = requireParam(req.params.threadId, "threadId");
    const response = await bridge.readThread(threadId);
    res.json(response);
  }));

  router.post("/threads/:threadId/resume", asyncHandler(async (req, res) => {
    const threadId = requireParam(req.params.threadId, "threadId");
    const response = await bridge.resumeThread(threadId, req.body ?? {});
    res.json(response);
  }));

  router.post("/threads/:threadId/send", asyncHandler(async (req, res) => {
    const threadId = requireParam(req.params.threadId, "threadId");
    const text = requireText(req.body?.text, "text");
    const { text: _text, ...params } = req.body ?? {};
    const response = await bridge.startTurn(threadId, text, params);
    res.status(202).json(response ?? {});
  }));

  router.post("/threads/:threadId/steer", asyncHandler(async (req, res) => {
    const threadId = requireParam(req.params.threadId, "threadId");
    const text = requireText(req.body?.text, "text");
    const turnId = requireText(req.body?.turnId, "turnId");
    const response = await bridge.steerTurn(threadId, turnId, text);
    res.status(202).json(response ?? {});
  }));

  router.post("/threads/:threadId/interrupt", asyncHandler(async (req, res) => {
    const threadId = requireParam(req.params.threadId, "threadId");
    const runtime = state.getThread(threadId);
    const turnId = req.body?.turnId ?? runtime?.activeTurnId;

    if (typeof turnId !== "string" || turnId.length === 0) {
      res.status(409).json({ error: "thread has no active turn" });
      return;
    }

    const response = await bridge.interruptTurn(threadId, turnId);
    res.status(202).json(response ?? {});
  }));

  router.post("/threads/:threadId/compact", asyncHandler(async (req, res) => {
    const threadId = requireParam(req.params.threadId, "threadId");
    const response = await bridge.compactThread(threadId);
    res.status(202).json(response ?? {});
  }));

  router.post("/threads/:threadId/shell", asyncHandler(async (req, res) => {
    const threadId = requireParam(req.params.threadId, "threadId");
    const command = requireText(req.body?.command, "command");
    const response = await bridge.runShellCommand(threadId, command);
    res.status(202).json(response ?? {});
  }));

  router.get("/threads/:threadId/diff", (req, res) => {
    const threadId = requireParam(req.params.threadId, "threadId");
    const runtime = state.getThread(threadId);

    if (!runtime) {
      res.status(404).json({ error: "thread not found" });
      return;
    }

    res.json({
      threadId,
      diff: runtime.latestDiff,
      changedFiles: runtime.changedFiles,
    });
  });

  router.get("/approvals", (_req, res) => {
    res.json({ data: state.snapshot().pendingApprovals });
  });

  router.post("/approvals/:requestId/respond", asyncHandler(async (req, res) => {
    const requestId = requireParam(req.params.requestId, "requestId");
    await bridge.respondToServerRequest(requestId, req.body ?? {});
    res.json({ ok: true });
  }));

  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    const message = err instanceof Error ? err.message : "Unexpected error";
    const status = err instanceof HttpError ? err.status : 500;
    res.status(status).json({ error: message });
  };

  router.use(errorHandler);

  return router;
}

function requireParam(value: string | string[] | undefined, field: string) {
  if (typeof value !== "string" || value.length === 0) {
    throw new HttpError(400, `${field} is required`);
  }

  return value;
}

function requireText(value: unknown, field: string) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HttpError(400, `${field} is required`);
  }

  return value.trim();
}

function asyncHandler(handler: express.RequestHandler): express.RequestHandler {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
