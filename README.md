# @minion-stack/drone

> Middle-tier mini-agent primitive: an isolated LLM call with its own model,
> system prompt, tools, and skills. Sits between a one-shot forced tool call and
> a full embedded agent loop.

A **drone** is a small, self-contained unit of LLM work. You `defineDrone(...)`
once (model, system prompt, tools, output schema) and `runDrone(...)` it against
a host that supplies the provider transport. Drones can stream, enforce typed
output via BAML streaming-schema mode, and fall back across providers.

```ts
import { defineDrone, runDrone } from "@minion-stack/drone";

const summarizer = defineDrone({
  model: { provider: "openrouter", model: "google/gemini-2.5-flash" },
  system: "Summarize the conversation in one sentence.",
});

const result = await runDrone(summarizer, host, { input: "..." });
if (result.ok) console.log(result.output);
```

## Exports

- `defineDrone`, `runDrone`, `runDroneStream`
- `defineStreamingDrone`, `runStreamingSchemaDrone` — BAML-backed typed streaming
- Types: `Drone`, `DroneDefinition`, `DroneHost`, `DroneRunResult`, `DroneToolDef`,
  `StreamingDrone`, `StreamingSchemaEvent`, and more (see `src/index.ts`).

## Peer dependencies

Drone is transport-agnostic and expects the host application to provide these:

- `@boundaryml/baml` — BAML runtime (streaming-schema mode)
- `@earendil-works/pi-ai` — provider transport
- `@sinclair/typebox` — runtime schema types

## Development

```bash
pnpm install --ignore-workspace   # standalone install
pnpm baml:generate                # generate src/baml_client from baml_src
pnpm build                        # tsc -p tsconfig.build.json → dist/
pnpm test                         # vitest unit tests
pnpm test:live                    # live provider smoke tests (needs API keys)
```

`src/baml_client/` is generated from `baml_src/` and is gitignored — always run
`pnpm baml:generate` before `build`. The `prepack` hook runs `tsc` on publish.

## Releasing

Publishing is automated via `.github/workflows/publish.yml`: push a `v*` tag (or
run the workflow manually) and CI runs baml generate → build → `pnpm publish`.
Bump `version` in `package.json` first. Requires the `NPM_TOKEN` repo secret to
have publish rights to the `@minion-stack` scope.

## License

MIT
