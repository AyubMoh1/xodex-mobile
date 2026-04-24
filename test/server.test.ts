import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { CodexAppServerClient } from "../src/codex/appServerClient.js";
import { CompanionState } from "../src/codex/state.js";
import { createApp } from "../src/server.js";

function createTestApp(options: { token?: string } = {}) {
  const state = new CompanionState();
  state.setStatus({ codex: "ready", message: null, codexUserAgent: "test" });

  const bridge = {
    listThreads: vi.fn(async () => {
      state.setThreads([
        {
          id: "thread-1",
          preview: "Existing thread",
          cwd: "/tmp/project",
          updatedAt: 10,
          turns: [],
        },
      ]);
      return { data: [state.getThread("thread-1")?.thread], nextCursor: null };
    }),
    readThread: vi.fn(async (threadId: string) => ({ thread: state.getThread(threadId)?.thread })),
    startThread: vi.fn(async () => {
      state.upsertThread({ id: "thread-2", preview: "", cwd: "/tmp/project", turns: [] });
      return { thread: state.getThread("thread-2")?.thread };
    }),
    resumeThread: vi.fn(async (threadId: string) => ({ thread: state.getThread(threadId)?.thread })),
    startTurn: vi.fn(async () => ({})),
    steerTurn: vi.fn(async () => ({})),
    interruptTurn: vi.fn(async () => ({})),
    compactThread: vi.fn(async () => ({})),
    runShellCommand: vi.fn(async () => ({})),
    respondToServerRequest: vi.fn(async (requestId: string | number) => {
      state.removePendingRequest(requestId);
    }),
  } as unknown as CodexAppServerClient;

  const app = createApp({
    bridge,
    state,
    config: {
      port: 0,
      host: "127.0.0.1",
      codexBin: "codex",
      accessToken: options.token ?? null,
    },
  });

  return { app, bridge, state };
}

describe("server API", () => {
  it("serves health without spawning the real bridge", async () => {
    const { app } = createTestApp();

    await request(app)
      .get("/api/health")
      .expect(200)
      .expect((response) => {
        expect(response.body.status.codex).toBe("ready");
      });
  });

  it("protects API routes when an access token is configured", async () => {
    const { app } = createTestApp({ token: "secret" });

    await request(app).get("/api/snapshot").expect(401);
    await request(app).get("/api/snapshot").set("x-xodex-token", "secret").expect(200);
  });

  it("starts a turn with cwd when sending a message", async () => {
    const { app, bridge } = createTestApp();

    await request(app)
      .post("/api/threads/thread-1/send")
      .send({ text: "Continue this", cwd: "/tmp/project" })
      .expect(202);

    expect(bridge.startTurn).toHaveBeenCalledWith("thread-1", "Continue this", {
      cwd: "/tmp/project",
    });
  });

  it("responds to pending approvals", async () => {
    const { app, bridge, state } = createTestApp();
    state.addPendingRequest({
      id: "approval-1",
      method: "item/fileChange/requestApproval",
      params: { threadId: "thread-1", itemId: "item-1" },
      createdAt: "2026-04-24T00:00:00.000Z",
    });

    await request(app)
      .post("/api/approvals/approval-1/respond")
      .send({ decision: "accept" })
      .expect(200);

    expect(bridge.respondToServerRequest).toHaveBeenCalledWith("approval-1", { decision: "accept" });
    expect(state.snapshot().pendingApprovals).toHaveLength(0);
  });
});
