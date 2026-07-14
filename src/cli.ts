#!/usr/bin/env bun

import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  loadDroneConfig,
  type DroneConfigOverrides,
  type DroneUiConfig,
} from "./config.js";
import { runLocalPrompt } from "./runtime/local.js";

const VERSION = "0.4.0";

const HELP = `Minion Drone ${VERSION}

Usage:
  drone [prompt]                 launch the interactive TUI in the current directory
  drone -p "prompt"              stream one read-only response
  drone --json "prompt"          emit DroneStreamEvent JSONL
  drone --plain [prompt]         use the line-oriented fallback
  drone config                  print resolved config, paths, and diagnostics

Options:
  -p, --print                   non-interactive text output
      --json                    JSONL event output
      --plain                   disable the full-screen TUI
      --cwd <path>              workspace root (default: current directory)
      --provider <id>           provider override
      --model <id>              model override
      --theme <mode>            auto | dark | light | mono
      --motion <mode>           full | reduced | off
      --mouse <mode>            auto | on | off
      --screen <mode>           alternate | split
      --no-mouse                disable all mouse handling
      --no-animation            disable animation
  -h, --help                    show help
  -v, --version                 show version

Config:
  ~/.config/drone/config.json   user defaults (or $XDG_CONFIG_HOME/drone/config.json)
  .drone/config.json            workspace overrides
`;

function enumValue<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  flag: string,
): T | undefined {
  if (value == null) return undefined;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`${flag} must be one of: ${allowed.join(", ")}`);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function runPlainLoop(
  cwd: string,
  loaded: Awaited<ReturnType<typeof loadDroneConfig>>,
  initialPrompt?: string,
): Promise<number> {
  if (initialPrompt) return await runLocalPrompt({ cwd, config: loaded.config, prompt: initialPrompt });
  if (!process.stdin.isTTY) {
    const prompt = await readStdin();
    if (!prompt) throw new Error("plain mode requires a prompt or stdin");
    return await runLocalPrompt({ cwd, config: loaded.config, prompt });
  }

  const readline = createInterface({ input, output, terminal: true });
  output.write(`Drone plain mode · ${loaded.config.provider}/${loaded.config.model} · ${cwd}\n`);
  try {
    while (true) {
      const prompt = (await readline.question("drone> ")).trim();
      if (!prompt) continue;
      if (prompt === "/exit" || prompt === "/quit") return 0;
      await runLocalPrompt({ cwd, config: loaded.config, prompt });
    }
  } finally {
    readline.close();
  }
}

async function main(): Promise<number> {
  const parsed = parseArgs({
    allowPositionals: true,
    strict: true,
    options: {
      print: { type: "boolean", short: "p" },
      json: { type: "boolean" },
      plain: { type: "boolean" },
      cwd: { type: "string" },
      provider: { type: "string" },
      model: { type: "string" },
      theme: { type: "string" },
      motion: { type: "string" },
      mouse: { type: "string" },
      screen: { type: "string" },
      "no-mouse": { type: "boolean" },
      "no-animation": { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  if (parsed.values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (parsed.values.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  const cwd = resolve(parsed.values.cwd ?? process.cwd());
  const ui: Partial<DroneUiConfig> = {};
  const theme = enumValue(parsed.values.theme, ["auto", "dark", "light", "mono"], "--theme");
  const motion = enumValue(parsed.values.motion, ["full", "reduced", "off"], "--motion");
  const mouse = enumValue(parsed.values.mouse, ["auto", "on", "off"], "--mouse");
  const screen = enumValue(parsed.values.screen, ["alternate", "split"], "--screen");
  if (theme) ui.theme = theme;
  if (motion) ui.motion = motion;
  if (mouse) ui.mouse = mouse;
  if (screen) ui.screen = screen;
  if (parsed.values["no-mouse"]) ui.mouse = "off";
  if (parsed.values["no-animation"]) ui.motion = "off";
  const overrides: DroneConfigOverrides = {
    ...(parsed.values.provider ? { provider: parsed.values.provider } : {}),
    ...(parsed.values.model ? { model: parsed.values.model } : {}),
    ...(Object.keys(ui).length > 0 ? { ui } : {}),
  };
  const loaded = await loadDroneConfig({ cwd, overrides });

  if (parsed.positionals[0] === "config") {
    process.stdout.write(
      `${JSON.stringify(
        {
          config: loaded.config,
          paths: loaded.paths,
          diagnostics: loaded.diagnostics,
        },
        null,
        2,
      )}\n`,
    );
    return loaded.diagnostics.some((item) => item.code === "parse_error") ? 1 : 0;
  }

  const prompt = parsed.positionals.join(" ").trim() || undefined;
  if (parsed.values.json) {
    const jsonPrompt = prompt ?? (process.stdin.isTTY ? "" : await readStdin());
    if (!jsonPrompt) throw new Error("--json requires a prompt or stdin");
    return await runLocalPrompt({ cwd, config: loaded.config, prompt: jsonPrompt, format: "json" });
  }
  if (parsed.values.print) {
    const printPrompt = prompt ?? (process.stdin.isTTY ? "" : await readStdin());
    if (!printPrompt) throw new Error("--print requires a prompt or stdin");
    return await runLocalPrompt({ cwd, config: loaded.config, prompt: printPrompt });
  }
  if (parsed.values.plain || !process.stdin.isTTY || !process.stdout.isTTY || process.env.TERM === "dumb") {
    return await runPlainLoop(cwd, loaded, prompt);
  }

  try {
    const { DroneTuiSessionError, runDroneTui } = await import("./tui/app.js");
    try {
      await runDroneTui({
        cwd,
        config: loaded.config,
        configDiagnostics: loaded.diagnostics.map((item) => item.message),
        initialPrompt: prompt,
      });
    } catch (error) {
      if (error instanceof DroneTuiSessionError) {
        process.stderr.write(`drone: ${error.message}\n`);
        return error.exitCode;
      }
      throw error;
    }
    return 0;
  } catch (error) {
    process.stderr.write(`Drone TUI could not start: ${error instanceof Error ? error.message : String(error)}\n`);
    process.stderr.write("Falling back to plain mode.\n");
    return await runPlainLoop(cwd, loaded, prompt);
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`drone: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
