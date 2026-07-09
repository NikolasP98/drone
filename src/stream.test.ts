import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "@sinclair/typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";

const streamMock = vi.fn();
const getModelMock = vi.fn(() => ({ provider: "anthropic", id: "claude-haiku-4-5" }));

vi.mock("@earendil-works/pi-ai", () => ({
  stream: streamMock,
  getModel: getModelMock,
}));

const { defineDrone } = await import("./define.js");
const { runDroneStream } = await import("./stream.js");
import type { DroneEventInput, DroneHost, DroneStreamEvent } from "./types.js";

function asst(content: Array<Record<string, unknown>>, stopReason: string): AssistantMessage {
  return {
    role: "assistant",
    content,
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
    stopReason,
  } as unknown as AssistantMessage;
}

function fakeEventStream(deltas: string[], final: AssistantMessage) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const d of deltas) {
        yield { type: "text_delta", contentIndex: 0, delta: d, partial: final };
      }
    },
    result: async () => final,
  };
}

function mockHost(events: DroneEventInput[] = []): DroneHost {
  return {
    resolveApiKey: async () => ({ apiKey: "test-key", source: "test" }),
    resolveSkillsPrompt: () => "",
    emitEvent: (e) => events.push(e),
  };
}

async function collect(iter: AsyncIterable<DroneStreamEvent>): Promise<DroneStreamEvent[]> {
  const out: DroneStreamEvent[] = [];
  for await (const e of iter) out.push(e);
  return out;
}

const baseDef = {
  id: "test-drone",
  systemPrompt: "You are a test drone.",
  model: { provider: "anthropic", model: "claude-haiku-4-5" },
};

describe("runDroneStream", () => {
  beforeEach(() => streamMock.mockReset());

  it("free-text: yields text deltas then done", async () => {
    const drone = defineDrone(baseDef);
    streamMock.mockReturnValueOnce(
      fakeEventStream(["Hel", "lo"], asst([{ type: "text", text: "Hello" }], "stop")),
    );

    const events = await collect(runDroneStream(drone, { prompt: "hi" }, mockHost()));

    expect(events).toEqual([
      { type: "text", delta: "Hel" },
      { type: "text", delta: "lo" },
      expect.objectContaining({ type: "done", data: "Hello" }),
    ]);
  });

  it("tool-loop: yields tool start/end events between steps and emits agent.run.tool", async () => {
    const echo = vi.fn(async () => "echoed");
    const drone = defineDrone({
      ...baseDef,
      tools: [
        {
          name: "echo",
          description: "Echo",
          parameters: Type.Object({ q: Type.String() }),
          execute: echo,
        },
      ],
    });
    streamMock
      .mockReturnValueOnce(
        fakeEventStream(
          [],
          asst([{ type: "toolCall", id: "tc1", name: "echo", arguments: { q: "x" } }], "toolUse"),
        ),
      )
      .mockReturnValueOnce(
        fakeEventStream(["done!"], asst([{ type: "text", text: "done!" }], "stop")),
      );

    const hostEvents: DroneEventInput[] = [];
    const events = await collect(runDroneStream(drone, { prompt: "hi" }, mockHost(hostEvents)));

    expect(echo).toHaveBeenCalledOnce();
    expect(events).toEqual([
      { type: "tool", phase: "start", name: "echo", toolCallId: "tc1" },
      { type: "tool", phase: "end", name: "echo", toolCallId: "tc1", isError: false },
      { type: "text", delta: "done!" },
      expect.objectContaining({ type: "done", data: "done!" }),
    ]);
    expect(hostEvents.filter((e) => e.event === "agent.run.tool")).toEqual([
      expect.objectContaining({ toolName: "echo", toolPhase: "start" }),
      expect.objectContaining({ toolName: "echo", toolPhase: "end", toolIsError: false }),
    ]);
    // usage accumulated across both steps
    const done = events.at(-1);
    expect(done && done.type === "done" ? done.usage.inputTokens : 0).toBe(20);
  });

  it("schema-only drones still refuse to stream", async () => {
    const drone = defineDrone({ ...baseDef, output: Type.Object({ a: Type.String() }) });
    const events = await collect(runDroneStream(drone, { prompt: "hi" }, mockHost()));
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("error");
  });
});
