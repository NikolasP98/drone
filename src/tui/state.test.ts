import { describe, expect, it } from "vitest";
import { addUserTurn, clearConversation, createInitialTuiState, reduceStreamEvent } from "./state.js";

describe("TUI state", () => {
  it("reduces a streamed turn into a completed transcript", () => {
    let state = addUserTurn(createInitialTuiState(1), "inspect the repo", "turn-1", 2);
    state = reduceStreamEvent(state, { type: "thinking", delta: "checking" }, 3);
    state = reduceStreamEvent(state, { type: "text", delta: "All " }, 4);
    state = reduceStreamEvent(state, { type: "text", delta: "good." }, 5);
    state = reduceStreamEvent(
      state,
      {
        type: "done",
        data: "All good.",
        usage: { inputTokens: 10, outputTokens: 3 },
        durationMs: 25,
        resolvedModel: { provider: "openrouter", model: "test" },
      },
      6,
    );

    expect(state.status).toBe("done");
    expect(state.thinking).toBe("");
    expect(state.transcript.at(-1)).toMatchObject({ content: "All good.", streaming: false });
    expect(state.usage.inputTokens).toBe(10);
  });

  it("records tool lifecycle and terminal errors", () => {
    let state = addUserTurn(createInitialTuiState(), "run it", "turn-2");
    state = reduceStreamEvent(state, {
      type: "tool",
      phase: "start",
      name: "git_status",
      toolCallId: "tool-1",
    });
    state = reduceStreamEvent(state, {
      type: "error",
      error: { code: "UPSTREAM_ERROR", message: "provider unavailable" },
      durationMs: 30,
    });

    expect(state.status).toBe("error");
    expect(state.activity.some((entry) => entry.label === "Running git_status")).toBe(true);
    expect(state.transcript.at(-1)?.content).toContain("provider unavailable");
  });

  it("clears turns while preserving a small activity tail", () => {
    const active = addUserTurn(createInitialTuiState(), "hello", "turn-3");
    const cleared = clearConversation(active);
    expect(cleared.transcript).toHaveLength(1);
    expect(cleared.status).toBe("idle");
    expect(cleared.activity.length).toBeLessThanOrEqual(3);
  });
});
