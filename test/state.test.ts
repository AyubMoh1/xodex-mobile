import { describe, expect, it } from "vitest";
import { CompanionState } from "../src/codex/state.js";

describe("CompanionState", () => {
  it("derives latest output and changed files from resumed thread history", () => {
    const state = new CompanionState();

    state.upsertThread({
      id: "thread-1",
      preview: "Build something",
      updatedAt: 10,
      turns: [
        {
          id: "turn-1",
          items: [
            {
              id: "item-1",
              type: "agentMessage",
              text: "Done",
            },
            {
              id: "item-2",
              type: "fileChange",
              changes: [
                { path: "/tmp/app.ts", kind: { type: "update" }, diff: "@@" },
                { path: "/tmp/readme.md", kind: { type: "add" }, diff: "@@" },
              ],
            },
          ],
          status: "completed",
        },
      ],
    });

    const runtime = state.getThread("thread-1");

    expect(runtime?.latestOutput).toBe("Done");
    expect(runtime?.changedFiles).toEqual(["/tmp/app.ts", "/tmp/readme.md"]);
  });

  it("tracks pending approvals by thread", () => {
    const state = new CompanionState();
    state.addPendingRequest({
      id: 7,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1", itemId: "item-1" },
      createdAt: "2026-04-24T00:00:00.000Z",
    });

    expect(state.snapshot().pendingApprovals).toHaveLength(1);
    expect(state.getThread("thread-1")?.pendingApprovals).toHaveLength(1);

    state.removePendingRequest(7);

    expect(state.snapshot().pendingApprovals).toHaveLength(0);
    expect(state.getThread("thread-1")?.pendingApprovals).toHaveLength(0);
  });
});
