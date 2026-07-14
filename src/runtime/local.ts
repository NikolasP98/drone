import { defineDrone } from "../define.js";
import { runDroneStream } from "../stream.js";
import type { DroneConfig } from "../config.js";
import { createEnvironmentHost, createWorkspaceTools } from "./workspace.js";

export type LocalRunFormat = "text" | "json";

export type LocalRunOptions = {
  cwd: string;
  config: DroneConfig;
  prompt: string;
  format?: LocalRunFormat;
  stdout?: Pick<NodeJS.WriteStream, "write">;
  stderr?: Pick<NodeJS.WriteStream, "write">;
  abortSignal?: AbortSignal;
};

/**
 * Run one safe, line-oriented workspace turn. Mutating tools are deliberately
 * omitted because this mode has no interactive approval surface.
 */
export async function runLocalPrompt(options: LocalRunOptions): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const format = options.format ?? "text";
  const host = createEnvironmentHost({ cwd: options.cwd });
  const tools = createWorkspaceTools({
    cwd: options.cwd,
    allowShell: false,
    allowWrites: false,
    requireApproval: true,
    maxOutputBytes: options.config.runtime.maxOutputChars,
  });
  const drone = defineDrone({
    id: "workspace-drone-plain",
    model: { provider: options.config.provider, model: options.config.model },
    systemPrompt: `${options.config.systemPrompt}\n\nYou are running in ${options.cwd}. Use the available read-only workspace tools to ground your answer.`,
    tools,
    maxSteps: options.config.maxSteps,
    timeoutMs: options.config.timeoutMs,
  });

  let exitCode = 0;
  for await (const event of runDroneStream(
    drone,
    {
      prompt: options.prompt,
      abortSignal: options.abortSignal,
      maxTokens: 1024,
      temperature: options.config.temperature,
    },
    host,
  )) {
    if (format === "json") {
      stdout.write(`${JSON.stringify(event)}\n`);
      if (event.type === "error") exitCode = 1;
      continue;
    }
    if (event.type === "text") stdout.write(event.delta);
    else if (event.type === "tool" && event.phase === "start") {
      stderr.write(`\n[drone] ${event.name}\n`);
    } else if (event.type === "error") {
      stderr.write(`\n[drone] ${event.error.code}: ${event.error.message}\n`);
      exitCode = 1;
    } else if (event.type === "done") {
      stdout.write("\n");
    }
  }
  return exitCode;
}
