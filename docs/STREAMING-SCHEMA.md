# Streaming-schema drones

Drone's 4th execution mode: yields **partial typed objects** as the model generates structured output, then a validated final result. Backed by [BAML](https://github.com/BoundaryML/baml) — every field of the output schema materializes nullable-until-finalized via schema-aligned parsing.

## When to use this mode

Use streaming-schema when **early fields are valuable before later ones land**:

- Knowledge-graph extraction: emit entities into the KG as they're parsed, before relationships finish.
- Multi-section reports: render section A while section B is still streaming.
- Voice/TTS: speak the first sentence while the rest of the structured reply continues.

**Don't use streaming-schema for:**

- Flat classifiers (label + confidence). Use `defineDrone({ output })` — the schema-only mode is faster and doesn't need codegen.
- Tool-loop drones. Streaming-schema is single-turn, no tool calls.
- Free-text generation. Use `runDroneStream` — yields raw text deltas, no schema.

## Architecture

Two source-of-truth dialects coexist, never overlap:

| Drone mode                          | Schema lives in                         | Runtime validator                      |
| ----------------------------------- | --------------------------------------- | -------------------------------------- |
| schema-only / tool-loop / free-text | TypeBox (`Type.Object({...})`)          | TypeBox                                |
| **streaming-schema**                | BAML (`class X { ... }` in `baml_src/`) | BAML SAP + TypeBox belt-and-suspenders |

BAML owns the streaming drone's schema because its [Stream<T>](https://docs.boundaryml.com/guide/baml-basics/streaming) materializer is the value-add. TypeBox stays as a final-result runtime check — if BAML's SAP recovery produces something that doesn't match the contract, you get `SCHEMA_INVALID`, not a silent type lie.

## Adding a new streaming drone

### 1. Declare the BAML function

`baml_src/<name>.baml`:

```baml
class Entity {
  name string
  kind EntityKind
}

enum EntityKind {
  PERSON
  PLACE
  ORG
  CONCEPT
  OTHER
}

class EntityExtraction {
  entities Entity[]
  summary string
}

function ExtractEntities(text: string) -> EntityExtraction {
  client ClaudeSonnet
  prompt #"
    Extract every named entity from the text below.

    {{ ctx.output_format }}

    Text:
    {{ text }}
  "#
}
```

Run `pnpm baml:generate` — emits the typed client into `src/baml_client/` (gitignored).

### 2. Mirror the schema in TypeBox

`src/my-drone.ts`:

```ts
import { Type } from "@sinclair/typebox";

export const EntityExtractionSchema = Type.Object({
  entities: Type.Array(
    Type.Object({
      name: Type.String(),
      kind: Type.Union([
        Type.Literal("PERSON"),
        Type.Literal("PLACE"),
        Type.Literal("ORG"),
        Type.Literal("CONCEPT"),
        Type.Literal("OTHER"),
      ]),
    }),
  ),
  summary: Type.String(),
});
```

### 3. Define the drone

```ts
import { ClientRegistry } from "@boundaryml/baml";
import { b } from "./baml_client/index.js";
import { defineStreamingDrone, runStreamingSchemaDrone } from "@nikolasp98/drone";

export const extractEntities = defineStreamingDrone({
  id: "extract-entities",
  model: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
  output: EntityExtractionSchema,
  clientRegistry: () => new ClientRegistry(),
  callBaml: (args: { text: string }, registry) =>
    b.stream.ExtractEntities(args.text, { clientRegistry: registry }),
});
```

### 4. Consume the stream

```ts
for await (const evt of runStreamingSchemaDrone(extractEntities, { args: { text } }, host)) {
  if (evt.type === "partial") {
    // Partial<EntityExtraction> — every field may be undefined or partial
    if (evt.data.entities) {
      for (const entity of evt.data.entities) {
        // entity.name may exist before entity.kind
      }
    }
  } else if (evt.type === "done") {
    // EntityExtraction — fully validated against TypeBox
    saveToDb(evt.data);
  } else if (evt.type === "error") {
    // error.code: TIMEOUT | ABORTED | SCHEMA_INVALID | UPSTREAM_ERROR
    log.error(evt.error);
  }
}
```

## Constraints

**Single-model lock.** Streaming drones cannot fall over mid-stream — partial tokens are model-specific. Configure one model; on failure you get `UPSTREAM_ERROR` and the caller decides whether to retry on a different drone. This mirrors drone's tool-loop "lock to first model that produced an answer" pattern.

**API key injection.** Drone constructs a `ClientRegistry` per-call and overrides the named client in your `.baml` (e.g. `ClaudeSonnet`) with the apiKey resolved by `host.resolveApiKey()`. The static `client<llm>` binding in `clients.baml` only exists so codegen can compile; the actual key + model used at runtime comes from the drone definition, not the `.baml` file.

**Schema validation.** The final result is checked against the TypeBox schema. BAML's SAP is best-effort — when it produces something the TypeBox schema rejects, you get `SCHEMA_INVALID` with up to three path/message errors in the error payload. This is the belt-and-suspenders for catching SAP recovery slip-ups.

## Testing

Unit tests use a fake `BamlStreamLike` + `BamlClientRegistryLike` — no network, no codegen needed. See `streaming-schema.test.ts`.

Live tests use the real BAML client + a real provider key:

```bash
ANTHROPIC_API_KEY=sk-... pnpm test:live
```

See `streaming-schema.live.test.ts` for the canonical pattern. Live tests are excluded from the default `pnpm test` run via the separate `vitest.live.config.ts`.

## Why BAML for this and not for everything

Drone v0.2 covers schema-only, tool-loop, and free-text via TypeBox + pi-ai — same dialect as the rest of the codebase. BAML is scoped to streaming-schema because that's where its `Stream<T>` is genuinely hard to roll yourself. For everything else, the cost of a second schema dialect + a codegen step doesn't pay off. See `project_baml_audit_kill_decision` in `~/.claude/.../memory/` for the strategic context.
