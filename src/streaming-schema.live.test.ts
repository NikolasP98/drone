import { ClientRegistry } from "@boundaryml/baml";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { b } from "./baml_client/index.js";
import {
  defineStreamingDrone,
  runStreamingSchemaDrone,
  type StreamingSchemaEvent,
} from "./streaming-schema.js";
import type { DroneHost, DroneModelSpec } from "./types.js";

/**
 * Live test — exercises the streaming-schema drone against a real Anthropic
 * model. Requires ANTHROPIC_API_KEY in env. Run with:
 *   pnpm vitest --config vitest.live.config.ts
 */

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SKIP = !ANTHROPIC_API_KEY;

const EntitySchema = Type.Object({
  name: Type.String(),
  kind: Type.Union([
    Type.Literal("PERSON"),
    Type.Literal("PLACE"),
    Type.Literal("ORG"),
    Type.Literal("CONCEPT"),
    Type.Literal("OTHER"),
  ]),
  mentions: Type.Number(),
});

const ExtractionSchema = Type.Object({
  entities: Type.Array(EntitySchema),
  summary: Type.String(),
});

function makeHost(): DroneHost {
  return {
    resolveApiKey: async (spec: DroneModelSpec) => {
      if (spec.provider === "anthropic") {
        return { apiKey: ANTHROPIC_API_KEY!, source: "env" };
      }
      throw new Error(`no key for ${spec.provider}`);
    },
    resolveSkillsPrompt: () => "",
    emitEvent: () => {},
  };
}

describe.skipIf(SKIP)("runStreamingSchemaDrone (live, Anthropic)", () => {
  it("yields partial frames before the validated final", async () => {
    const drone = defineStreamingDrone<{ text: string }, typeof ExtractionSchema>({
      id: "extract-entities-live",
      model: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
      output: ExtractionSchema,
      clientRegistry: () => new ClientRegistry(),
      callBaml: (args, registry) =>
        b.stream.ExtractEntities(args.text, { clientRegistry: registry }),
    });

    const text =
      "Niko and Renzo started Minion together. Niko writes the code while Renzo " +
      "runs operations from Buenos Aires. The product targets self-hosted AI gateways.";

    const events: StreamingSchemaEvent<{
      entities: Array<{ name: string; kind: string; mentions: number }>;
      summary: string;
    }>[] = [];
    for await (const evt of runStreamingSchemaDrone(drone, { args: { text } }, makeHost())) {
      events.push(evt);
    }

    const partials = events.filter((e) => e.type === "partial");
    const dones = events.filter((e) => e.type === "done");
    const errors = events.filter((e) => e.type === "error");

    expect(errors).toHaveLength(0);
    expect(partials.length).toBeGreaterThan(0);
    expect(dones).toHaveLength(1);

    const done = dones[0];
    if (done?.type !== "done") {
      throw new Error("expected done event");
    }
    expect(done.data.entities.length).toBeGreaterThan(0);
    expect(done.data.summary.length).toBeGreaterThan(0);

    const names = done.data.entities.map((e) => e.name);
    expect(names).toContain("Niko");

    // eslint-disable-next-line no-console
    console.log(
      `[live] partials=${partials.length} entities=${done.data.entities.length} duration=${done.durationMs}ms`,
    );
  });
});
