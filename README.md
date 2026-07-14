# Minion Drone

An animated, mouse-aware workspace runtime and a reusable mini-agent primitive.

## Launch the runtime

The published `drone` binary requires **Bun 1.3 or newer** for OpenTUI's native
renderer. Install Bun first and ensure `bun` is on `PATH`; npm does not enforce
the package's Bun engine declaration. The library exports remain Node 22+
compatible. Descriptor-anchored `write_file` support is currently Linux-only;
other platforms fail that tool closed.

```bash
curl -fsSL https://bun.sh/install | bash
bun --version                     # must report 1.3.0 or newer
npm install -g @minion-stack/drone
cd /path/to/project
drone
```

The full-screen command opens in the current directory with original Drone art,
a streamed Markdown transcript, an activity inspector, multiline composer,
mouse scrolling/clicks, copy-on-select, and approval prompts for writes or shell
commands. Type `/` for a live command palette, `@` for workspace path
completion, or `/skills ` to browse and toggle local/user skills. Suggestions
render above the composer with arrow-key, Enter/Tab, Escape, hover, and click
controls. Bare `@` shows the current directory; typed text searches recursively
by substring, and `@~/` or `@../` temporarily search home or a parent without
changing Drone's runtime workspace. Keyboard paths exist for every mouse action.

```bash
drone "summarize this repository"   # launch and submit an initial prompt
drone -p "list the main packages"   # read-only plain output
drone --json "inspect package.json" # DroneStreamEvent JSONL
drone config                        # resolved config and config paths
```

User settings live at `~/.config/drone/config.json` (or
`$XDG_CONFIG_HOME/drone/config.json`); workspace overrides live at
`.drone/config.json`. API keys stay in the environment or workspace `.env` and
are never persisted by Drone. Project config can tighten runtime safety but
cannot enable shell/writes or disable approvals. See
[the TUI/runtime contract](docs/TUI-RUNTIME.md) for configuration, controls,
fallbacks, and the security boundary.

## Use the library

A **drone** is a small, self-contained unit of LLM work. You `defineDrone(...)`
once (model, system prompt, tools, output schema) and `runDrone(...)` it against
a host that supplies provider credentials, skill context, and telemetry. Drones
can stream, use bounded tools, enforce typed output via BAML streaming-schema
mode, and fall back across providers.

```ts
import { defineDrone, runDrone } from "@minion-stack/drone";

const summarizer = defineDrone({
  id: "summarizer",
  model: { provider: "openrouter", model: "google/gemini-2.5-flash" },
  systemPrompt: "Summarize the conversation in one sentence.",
});

const result = await runDrone(summarizer, { prompt: "..." }, host);
if (result.ok) console.log(result.data);
```

## Exports

- `defineDrone`, `runDrone`, `runDroneStream`
- `defineStreamingDrone`, `runStreamingSchemaDrone` — BAML-backed typed streaming
- `loadDroneConfig`, `createEnvironmentHost`, `createWorkspaceTools`,
  `runLocalPrompt` — local runtime building blocks
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
pnpm build                        # clean dist, then compile
pnpm build:release                # clean → generate BAML → compile
pnpm test                         # vitest unit tests
pnpm verify:package               # pack, install, and smoke the consumer artifact
pnpm test:live                    # live provider smoke tests (needs API keys)
pnpm link --global                # expose the local `drone` command
```

`src/baml_client/` is generated from `baml_src/` and is gitignored — always run
`pnpm baml:generate` before a development build that needs it. The `prepack`
hook performs a clean release build so stale `dist/` files cannot enter a
tarball.

## Releasing

Publishing is automated via `.github/workflows/publish.yml`: push the tag that
exactly matches `v<package.json version>` (or run the workflow manually with a
validated npm dist-tag). The workflow type-checks, tests, packs, installs, and
smokes the artifact before publishing that exact tarball. Requires the
`NPM_TOKEN` repo secret to have publish rights to the `@minion-stack` scope.

## License

MIT
