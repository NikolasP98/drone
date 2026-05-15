import { complete, getModel } from "@mariozechner/pi-ai";
import type {
  AssistantMessage,
  Context,
  Message,
  ProviderStreamOptions,
  ToolCall,
  ToolResultMessage,
} from "@mariozechner/pi-ai";
import type { TObject } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type {
  Drone,
  DroneError,
  DroneErrorCode,
  DroneHost,
  DroneRunInput,
  DroneRunResult,
  DroneUsage,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const SCHEMA_TOOL_NAME = "result";

function interpolate(
  template: string,
  context: Record<string, string | number | boolean> | undefined,
): string {
  if (!context) {
    return template;
  }
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const v = context[key as string];
    if (v == null) {
      return "";
    }
    if (typeof v === "string") {
      return v;
    }
    if (typeof v === "number" || typeof v === "boolean") {
      return String(v);
    }
    return "";
  });
}

function mergeUsage(acc: DroneUsage, msg: AssistantMessage): DroneUsage {
  const u = msg.usage;
  if (!u) {
    return acc;
  }
  return {
    inputTokens: (acc.inputTokens ?? 0) + (u.input ?? 0),
    outputTokens: (acc.outputTokens ?? 0) + (u.output ?? 0),
    cacheReadTokens: (acc.cacheReadTokens ?? 0) + (u.cacheRead ?? 0),
    cacheCreationTokens: (acc.cacheCreationTokens ?? 0) + (u.cacheWrite ?? 0),
  };
}

function err(code: DroneErrorCode, message: string, cause?: unknown): DroneError {
  return { code, message, cause };
}

function findToolCalls(msg: AssistantMessage): ToolCall[] {
  return msg.content.filter((c): c is ToolCall => c.type === "toolCall");
}

function findText(msg: AssistantMessage): string {
  return msg.content
    .filter((c) => c.type === "text")
    .map((c) => (c as { text: string }).text)
    .join("");
}

/**
 * Execute a drone. Picks mode based on definition:
 *  - `output` set, no `tools` → schema-only (single forced tool call)
 *  - `tools` non-empty → tool-loop (multi-step in-process)
 *  - else → free-text (single completion, returns assistant text)
 */
export async function runDrone<TOut>(
  drone: Drone<TOut>,
  input: DroneRunInput,
  host: DroneHost,
): Promise<DroneRunResult<TOut>> {
  const def = drone.definition;
  const started = Date.now();
  const timeoutMs = def.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const correlationId = input.correlationId;

  const timeoutCtl = new AbortController();
  const timer = setTimeout(() => timeoutCtl.abort(), timeoutMs);
  const signal = anySignal([input.abortSignal, timeoutCtl.signal]);

  host.emitEvent?.({ event: "agent.run.start", droneId: def.id, correlationId });

  let usage: DroneUsage = {};

  const finish = <T>(r: DroneRunResult<T>): DroneRunResult<T> => {
    clearTimeout(timer);
    host.emitEvent?.({
      event: r.ok ? "agent.run.end" : "agent.run.error",
      droneId: def.id,
      correlationId,
      durationMs: r.durationMs,
      usage: r.usage,
      errorCode: r.ok ? undefined : r.error.code,
    });
    return r;
  };

  let apiKey: string;
  try {
    const resolved = await host.resolveApiKey(def.model);
    apiKey = resolved.apiKey;
  } catch (e) {
    return finish({
      ok: false,
      error: err("NO_API_KEY", `Failed to resolve api key: ${String(e)}`, e),
      durationMs: Date.now() - started,
    }) as DroneRunResult<TOut>;
  }

  const skillsBlock = host.resolveSkillsPrompt(def.skills);
  const systemPrompt = [interpolate(def.systemPrompt, input.context), skillsBlock]
    .filter((s) => s && s.trim().length > 0)
    .join("\n\n");

  const messages: Message[] = [{ role: "user", content: input.prompt, timestamp: Date.now() }];

  const model = getModel(def.model.provider as never, def.model.model as never) as Parameters<
    typeof complete
  >[0];
  const resolvedModel = { provider: def.model.provider, model: def.model.model };
  const baseOptions: ProviderStreamOptions = {
    apiKey,
    signal,
    maxTokens: input.maxTokens ?? 1024,
    ...(input.temperature != null ? { temperature: input.temperature } : {}),
  };

  // Mode dispatch
  try {
    if (def.output) {
      // Schema-only mode
      const schema = def.output as TObject;
      const ctx: Context = {
        systemPrompt,
        messages,
        tools: [
          {
            name: SCHEMA_TOOL_NAME,
            description: "Return a structured result.",
            parameters: schema,
          },
        ],
      };
      const msg = await complete(model, ctx, {
        ...baseOptions,
        toolChoice: { type: "tool", name: SCHEMA_TOOL_NAME },
        maxTokens: input.maxTokens ?? 512,
      });
      usage = mergeUsage(usage, msg);
      const calls = findToolCalls(msg);
      const call = calls.find((c) => c.name === SCHEMA_TOOL_NAME);
      if (!call) {
        return finish({
          ok: false,
          error: err(
            "NO_TOOL_CALL",
            `drone "${def.id}" did not return a ${SCHEMA_TOOL_NAME} tool call`,
          ),
          usage,
          durationMs: Date.now() - started,
        }) as DroneRunResult<TOut>;
      }
      if (!Value.Check(schema, call.arguments)) {
        const issues = [...Value.Errors(schema, call.arguments)].slice(0, 3);
        return finish({
          ok: false,
          error: err(
            "SCHEMA_INVALID",
            `drone "${def.id}" output failed schema validation: ${JSON.stringify(issues)}`,
          ),
          usage,
          durationMs: Date.now() - started,
        }) as DroneRunResult<TOut>;
      }
      return finish({
        ok: true,
        data: call.arguments as TOut,
        usage,
        durationMs: Date.now() - started,
        resolvedModel,
      });
    }

    // Tool-loop or free-text mode
    const tools = def.tools ?? [];
    const maxSteps = def.maxSteps ?? (tools.length > 0 ? 4 : 1);
    const piTools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
    const toolMap = new Map(tools.map((t) => [t.name, t]));

    for (let step = 0; step < maxSteps; step++) {
      const ctx: Context = {
        systemPrompt,
        messages,
        tools: piTools.length > 0 ? piTools : undefined,
      };
      const msg = await complete(model, ctx, baseOptions);
      usage = mergeUsage(usage, msg);
      messages.push(msg);

      const calls = findToolCalls(msg);
      if (calls.length === 0) {
        // Final assistant text reply
        return finish({
          ok: true,
          data: findText(msg) as TOut,
          usage,
          durationMs: Date.now() - started,
          resolvedModel,
        });
      }

      for (const call of calls) {
        const tool = toolMap.get(call.name);
        if (!tool) {
          messages.push(toolResult(call, `Unknown tool "${call.name}"`, true));
          continue;
        }
        try {
          if (!Value.Check(tool.parameters, call.arguments)) {
            messages.push(toolResult(call, `Invalid arguments for "${call.name}"`, true));
            continue;
          }
          const out = await tool.execute(call.arguments as never, {
            droneId: def.id,
            correlationId,
            abortSignal: signal,
          });
          messages.push(
            toolResult(call, typeof out === "string" ? out : JSON.stringify(out), false),
          );
        } catch (e) {
          return finish({
            ok: false,
            error: err("TOOL_FAILED", `tool "${call.name}" threw: ${String(e)}`, e),
            usage,
            durationMs: Date.now() - started,
          }) as DroneRunResult<TOut>;
        }
      }
    }

    return finish({
      ok: false,
      error: err(
        "MAX_STEPS_EXCEEDED",
        `drone "${def.id}" exceeded ${maxSteps} steps without final reply`,
      ),
      usage,
      durationMs: Date.now() - started,
    }) as DroneRunResult<TOut>;
  } catch (e) {
    const code: DroneErrorCode =
      signal.aborted && timeoutCtl.signal.aborted
        ? "TIMEOUT"
        : signal.aborted
          ? "ABORTED"
          : "UPSTREAM_ERROR";
    return finish({
      ok: false,
      error: err(code, `drone "${def.id}" failed: ${String(e)}`, e),
      usage,
      durationMs: Date.now() - started,
    }) as DroneRunResult<TOut>;
  }
}

function toolResult(call: ToolCall, text: string, isError: boolean): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: "text", text }],
    isError,
    timestamp: Date.now(),
  };
}

function anySignal(signals: Array<AbortSignal | undefined>): AbortSignal {
  const ctl = new AbortController();
  for (const s of signals) {
    if (!s) {
      continue;
    }
    if (s.aborted) {
      ctl.abort(s.reason);
      return ctl.signal;
    }
    s.addEventListener("abort", () => ctl.abort(s.reason), { once: true });
  }
  return ctl.signal;
}
