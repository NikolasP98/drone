import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "@sinclair/typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";

const completeMock = vi.fn();
const getModelMock = vi.fn(() => ({ provider: "anthropic", id: "claude-haiku-4-5" }));

vi.mock("@earendil-works/pi-ai", () => ({
  complete: completeMock,
  getModel: getModelMock,
}));

const { defineDrone } = await import("./define.js");
const { runDrone } = await import("./run.js");
import type { DroneEventInput, DroneHost } from "./types.js";

function asstWithToolCall(name: string, args: Record<string, unknown>): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id: "tc1", name, arguments: args }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-haiku-4-5",
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
  } as unknown as AssistantMessage;
}

function asstWithText(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-haiku-4-5",
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
  } as unknown as AssistantMessage;
}

function mockHost(events: DroneEventInput[] = []): DroneHost {
  return {
    resolveApiKey: async () => ({ apiKey: "test-key", source: "test" }),
    resolveSkillsPrompt: () => "",
    emitEvent: (e) => events.push(e),
  };
}

const baseDef = {
  id: "test-drone",
  systemPrompt: "You are a test drone.",
  model: { provider: "anthropic", model: "claude-haiku-4-5" },
};

describe("runDrone — schema-only mode", () => {
  beforeEach(() => completeMock.mockReset());

  it("returns validated data on successful tool call", async () => {
    const Schema = Type.Object({ verdict: Type.String() });
    const drone = defineDrone({ ...baseDef, output: Schema });
    completeMock.mockResolvedValueOnce(asstWithToolCall("result", { verdict: "yes" }));

    const r = await runDrone(drone, { prompt: "hi" }, mockHost());

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data).toEqual({ verdict: "yes" });
      expect(r.usage.inputTokens).toBe(10);
      expect(r.usage.outputTokens).toBe(5);
    }
  });

  it("returns NO_TOOL_CALL when model emits only text", async () => {
    const Schema = Type.Object({ verdict: Type.String() });
    const drone = defineDrone({ ...baseDef, output: Schema });
    completeMock.mockResolvedValueOnce(asstWithText("sorry I refuse"));

    const r = await runDrone(drone, { prompt: "hi" }, mockHost());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("NO_TOOL_CALL");
    }
  });

  it("returns SCHEMA_INVALID when arguments fail Zod check", async () => {
    const Schema = Type.Object({ verdict: Type.String() });
    const drone = defineDrone({ ...baseDef, output: Schema });
    completeMock.mockResolvedValueOnce(asstWithToolCall("result", { verdict: 42 }));

    const r = await runDrone(drone, { prompt: "hi" }, mockHost());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("SCHEMA_INVALID");
    }
  });

  it("emits start + end events on success", async () => {
    const Schema = Type.Object({ ok: Type.Boolean() });
    const drone = defineDrone({ ...baseDef, output: Schema });
    completeMock.mockResolvedValueOnce(asstWithToolCall("result", { ok: true }));
    const events: DroneEventInput[] = [];

    await runDrone(drone, { prompt: "hi", correlationId: "corr-1" }, mockHost(events));

    expect(events.map((e) => e.event)).toEqual(["agent.run.start", "agent.run.end"]);
    expect(events[0].correlationId).toBe("corr-1");
    expect(events[0].droneId).toBe("test-drone");
  });
});

describe("runDrone — free-text mode", () => {
  beforeEach(() => completeMock.mockReset());

  it("returns assistant text when no schema and no tools", async () => {
    const drone = defineDrone(baseDef);
    completeMock.mockResolvedValueOnce(asstWithText("hello there"));

    const r = await runDrone(drone, { prompt: "say hi" }, mockHost());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data).toBe("hello there");
    }
  });

  it("interpolates {{vars}} into systemPrompt", async () => {
    const drone = defineDrone({ ...baseDef, systemPrompt: "Hello {{name}}, role {{role}}." });
    completeMock.mockResolvedValueOnce(asstWithText("ok"));

    await runDrone(drone, { prompt: "x", context: { name: "alice", role: "tester" } }, mockHost());

    const ctx = completeMock.mock.calls[0][1];
    expect(ctx.systemPrompt).toBe("Hello alice, role tester.");
  });

  it("prepends skill block when host returns one", async () => {
    const drone = defineDrone(baseDef);
    completeMock.mockResolvedValueOnce(asstWithText("ok"));
    const host: DroneHost = {
      resolveApiKey: async () => ({ apiKey: "k", source: "t" }),
      resolveSkillsPrompt: () => "## Skills\n- foo",
    };
    await runDrone(drone, { prompt: "x" }, host);
    const ctx = completeMock.mock.calls[0][1];
    expect(ctx.systemPrompt).toContain("You are a test drone.");
    expect(ctx.systemPrompt).toContain("## Skills");
  });
});

describe("runDrone — tool-loop mode", () => {
  beforeEach(() => completeMock.mockReset());

  it("executes tool then returns final text", async () => {
    let executed = false;
    const drone = defineDrone({
      ...baseDef,
      tools: [
        {
          name: "echo",
          description: "echo back",
          parameters: Type.Object({ msg: Type.String() }),
          execute: (args) => {
            executed = true;
            return (args as { msg: string }).msg.toUpperCase();
          },
        },
      ],
    });
    completeMock
      .mockResolvedValueOnce(asstWithToolCall("echo", { msg: "hi" }))
      .mockResolvedValueOnce(asstWithText("done"));

    const r = await runDrone(drone, { prompt: "use echo" }, mockHost());

    expect(executed).toBe(true);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data).toBe("done");
    }
    expect(completeMock).toHaveBeenCalledTimes(2);
  });

  it("returns MAX_STEPS_EXCEEDED when model keeps calling tools", async () => {
    const drone = defineDrone({
      ...baseDef,
      maxSteps: 2,
      tools: [
        {
          name: "loop",
          description: "infinite",
          parameters: Type.Object({}),
          execute: () => "ok",
        },
      ],
    });
    completeMock.mockResolvedValue(asstWithToolCall("loop", {}));

    const r = await runDrone(drone, { prompt: "x" }, mockHost());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("MAX_STEPS_EXCEEDED");
    }
  });

  it("returns TOOL_FAILED when tool throws", async () => {
    const drone = defineDrone({
      ...baseDef,
      tools: [
        {
          name: "broken",
          description: "broken",
          parameters: Type.Object({}),
          execute: () => {
            throw new Error("boom");
          },
        },
      ],
    });
    completeMock.mockResolvedValueOnce(asstWithToolCall("broken", {}));

    const r = await runDrone(drone, { prompt: "x" }, mockHost());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("TOOL_FAILED");
      expect(r.error.message).toContain("boom");
    }
  });
});

describe("runDrone — errors", () => {
  beforeEach(() => completeMock.mockReset());

  it("returns NO_API_KEY when host throws", async () => {
    const drone = defineDrone(baseDef);
    const host: DroneHost = {
      resolveApiKey: async () => {
        throw new Error("no creds");
      },
      resolveSkillsPrompt: () => "",
    };

    const r = await runDrone(drone, { prompt: "x" }, host);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("NO_API_KEY");
    }
    expect(completeMock).not.toHaveBeenCalled();
  });

  it("returns TIMEOUT when wall-clock exceeded", async () => {
    const drone = defineDrone({ ...baseDef, timeoutMs: 10 });
    completeMock.mockImplementation(async (...args: unknown[]) => {
      const opts = args[2] as { signal?: AbortSignal } | undefined;
      await new Promise<void>((resolve, reject) => {
        if (opts?.signal) {
          opts.signal.addEventListener("abort", () => reject(new Error("AbortError")), {
            once: true,
          });
        } else {
          // No signal plumbed — fall through with timeout so test still completes
          setTimeout(resolve, 100);
        }
      });
      return null;
    });

    const r = await runDrone(drone, { prompt: "x" }, mockHost());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("TIMEOUT");
    }
  });
});
