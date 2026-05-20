import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import {
  defineStreamingDrone,
  runStreamingSchemaDrone,
  type BamlClientRegistryLike,
  type BamlStreamLike,
} from "./streaming-schema.js";
import type { DroneHost } from "./types.js";

const EntitySchema = Type.Object({
  name: Type.String(),
  kind: Type.Union([Type.Literal("PERSON"), Type.Literal("PLACE"), Type.Literal("OTHER")]),
});
const ExtractionSchema = Type.Object({
  entities: Type.Array(EntitySchema),
  summary: Type.String(),
});

type Extraction = {
  entities: Array<{ name: string; kind: "PERSON" | "PLACE" | "OTHER" }>;
  summary: string;
};

class FakeRegistry implements BamlClientRegistryLike {
  clients: Record<string, { provider: string; options: Record<string, unknown> }> = {};
  primary: string | null = null;
  addLlmClient(name: string, provider: string, options: Record<string, unknown>) {
    this.clients[name] = { provider, options };
  }
  setPrimary(name: string) {
    this.primary = name;
  }
}

function makeStream(
  partials: Array<Partial<Extraction>>,
  final: Extraction,
): BamlStreamLike<Partial<Extraction>, Extraction> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          if (i >= partials.length) {
            return { done: true, value: undefined as never };
          }
          const value = partials[i++]!;
          return { done: false, value };
        },
      };
    },
    async getFinalResponse() {
      return final;
    },
  };
}

function makeHost(overrides: Partial<DroneHost> = {}): DroneHost {
  return {
    resolveApiKey: async () => ({ apiKey: "sk-fake", source: "test" }),
    resolveSkillsPrompt: () => "",
    ...overrides,
  };
}

describe("runStreamingSchemaDrone", () => {
  it("yields partials then validated done", async () => {
    let registryUsed: FakeRegistry | null = null;
    const drone = defineStreamingDrone({
      id: "test",
      model: { provider: "anthropic", model: "claude-sonnet-4-5" },
      output: ExtractionSchema,
      clientRegistry: () => {
        registryUsed = new FakeRegistry();
        return registryUsed;
      },
      callBaml: () =>
        makeStream(
          [
            { entities: [{ name: "Niko", kind: "PERSON" }] },
            { entities: [{ name: "Niko", kind: "PERSON" }], summary: "About Niko." },
          ],
          { entities: [{ name: "Niko", kind: "PERSON" }], summary: "About Niko." },
        ),
    });

    const events: Array<{ type: string }> = [];
    for await (const evt of runStreamingSchemaDrone(drone, { args: {} }, makeHost())) {
      events.push(evt);
    }

    const partials = events.filter((e) => e.type === "partial");
    const dones = events.filter((e) => e.type === "done");
    expect(partials).toHaveLength(2);
    expect(dones).toHaveLength(1);
    expect(registryUsed).not.toBeNull();
    expect(registryUsed!.primary).toBe("DroneInjected");
    expect(registryUsed!.clients.DroneInjected!.options.api_key).toBe("sk-fake");
  });

  it("emits SCHEMA_INVALID when final doesn't validate", async () => {
    const drone = defineStreamingDrone({
      id: "bad-schema",
      model: { provider: "anthropic", model: "claude-sonnet-4-5" },
      output: ExtractionSchema,
      clientRegistry: () => new FakeRegistry(),
      callBaml: () => makeStream([], { entities: "not-an-array" } as unknown as never),
    });

    const events = [];
    for await (const evt of runStreamingSchemaDrone(drone, { args: {} }, makeHost())) {
      events.push(evt);
    }
    const lastEvent = events.at(-1);
    expect(lastEvent?.type).toBe("error");
    if (lastEvent?.type === "error") {
      expect(lastEvent.error.code).toBe("SCHEMA_INVALID");
    }
  });

  it("emits UPSTREAM_ERROR when callBaml throws", async () => {
    const drone = defineStreamingDrone({
      id: "throws",
      model: { provider: "anthropic", model: "claude-sonnet-4-5" },
      output: ExtractionSchema,
      clientRegistry: () => new FakeRegistry(),
      callBaml: () => {
        throw new Error("boom");
      },
    });
    const events = [];
    for await (const evt of runStreamingSchemaDrone(drone, { args: {} }, makeHost())) {
      events.push(evt);
    }
    const lastEvent = events.at(-1);
    expect(lastEvent?.type).toBe("error");
    if (lastEvent?.type === "error") {
      expect(lastEvent.error.code).toBe("UPSTREAM_ERROR");
    }
  });

  it("emits ABORTED when abortSignal fires", async () => {
    const ctl = new AbortController();
    const drone = defineStreamingDrone({
      id: "abort-test",
      model: { provider: "anthropic", model: "claude-sonnet-4-5" },
      output: ExtractionSchema,
      clientRegistry: () => new FakeRegistry(),
      callBaml: () =>
        makeStream([{ entities: [] }, { entities: [], summary: "x" }], {
          entities: [],
          summary: "x",
        }),
    });
    ctl.abort();
    const events = [];
    for await (const evt of runStreamingSchemaDrone(
      drone,
      { args: {}, abortSignal: ctl.signal },
      makeHost(),
    )) {
      events.push(evt);
    }
    const lastEvent = events.at(-1);
    expect(lastEvent?.type).toBe("error");
    if (lastEvent?.type === "error") {
      expect(lastEvent.error.code).toBe("ABORTED");
    }
  });

  it("emits telemetry events through host.emitEvent", async () => {
    const emitted: string[] = [];
    const drone = defineStreamingDrone({
      id: "telemetry",
      model: { provider: "anthropic", model: "claude-sonnet-4-5" },
      output: ExtractionSchema,
      clientRegistry: () => new FakeRegistry(),
      callBaml: () => makeStream([{ entities: [], summary: "x" }], { entities: [], summary: "x" }),
    });
    for await (const _ of runStreamingSchemaDrone(
      drone,
      { args: {} },
      makeHost({ emitEvent: (e) => emitted.push(e.event) }),
    )) {
      void _;
    }
    expect(emitted).toEqual(["agent.run.start", "agent.run.end"]);
  });
});
