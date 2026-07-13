import { complete, getModel } from "@earendil-works/pi-ai";
import type {
  AssistantMessage,
  Context,
  Message,
  ProviderStreamOptions,
  ToolCall,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import type { TObject } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { forceToolCallShape } from "./provider-shapes.js";
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

function sanitizeUpstreamError(message: string | undefined): string {
  const normalized = message
    ?.replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return "provider returned no error details";
  }
  return normalized.slice(0, 1_000);
}

/**
 * Build the user-message content for a drone call. Returns a plain string
 * when no images are attached (most cases), or the mixed array form when
 * images are present.
 */
function buildUserContent(
  input: DroneRunInput,
):
  | string
  | Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> {
  if (!input.images || input.images.length === 0) {
    return input.prompt;
  }
  return [
    { type: "text" as const, text: input.prompt },
    ...input.images.map((img) => ({
      type: "image" as const,
      data: img.data,
      mimeType: img.mimeType,
    })),
  ];
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

  // Build candidate chain: primary + fallbacks (each with its own resolved auth).
  // Skip a candidate if its credentials can't be resolved — never block the
  // entire call on one bad profile.
  type Candidate = {
    spec: { provider: string; model: string };
    apiKey: string;
  };
  const chain: Array<{ provider: string; model: string; authProfileId?: string }> = [
    def.model,
    ...(def.model.fallbacks ?? []),
  ];
  const candidates: Candidate[] = [];
  const authErrors: string[] = [];
  for (const entry of chain) {
    try {
      const auth = await host.resolveApiKey(entry);
      candidates.push({
        spec: { provider: entry.provider, model: entry.model },
        apiKey: auth.apiKey,
      });
    } catch (e) {
      authErrors.push(`${entry.provider}/${entry.model}: ${String(e)}`);
    }
  }
  if (candidates.length === 0) {
    return finish({
      ok: false,
      error: err(
        "NO_API_KEY",
        `Failed to resolve api key for any candidate (${authErrors.join("; ") || "no candidates"})`,
      ),
      durationMs: Date.now() - started,
    }) as DroneRunResult<TOut>;
  }

  const skillsBlock = host.resolveSkillsPrompt(def.skills);
  const systemPrompt = [interpolate(def.systemPrompt, input.context), skillsBlock]
    .filter((s) => s && s.trim().length > 0)
    .join("\n\n");

  const messages: Message[] = [
    { role: "user", content: buildUserContent(input), timestamp: Date.now() },
  ];

  /**
   * Try each candidate in order. On upstream/network error, advance to the
   * next candidate; on success, return the message + the resolved model.
   * Throws the last error if every candidate fails — caller catches and maps
   * to DroneError.
   */
  let lockedCandidate: Candidate | null = null;
  async function attemptComplete(
    extraOptions: Partial<ProviderStreamOptions> & {
      /** Tool name to force a single call against (translated per provider). */
      forceSingleTool?: string;
    } = {},
  ): Promise<{
    msg: Awaited<ReturnType<typeof complete>>;
    resolvedModel: { provider: string; model: string };
  }> {
    // Once a candidate has answered for this run, stick with it for later
    // turns (tool-loop continuations) — switching mid-conversation would
    // break tool-call/result pairing.
    const wasLocked = lockedCandidate != null;
    const pool = lockedCandidate ? [lockedCandidate] : candidates;
    const { forceSingleTool, ...rawExtra } = extraOptions;
    let lastError: unknown;
    for (const cand of pool) {
      const m = getModel(cand.spec.provider as never, cand.spec.model as never) as Parameters<
        typeof complete
      >[0];
      try {
        const opts: ProviderStreamOptions = {
          apiKey: cand.apiKey,
          signal,
          maxTokens: input.maxTokens ?? 1024,
          ...(input.temperature != null ? { temperature: input.temperature } : {}),
          ...rawExtra,
        };
        // Provider-specific toolChoice translation (Anthropic wants
        // {type:"tool",name}, OpenAI/Google accept "required"). Only set when
        // caller passed `forceSingleTool` — otherwise leave whatever extraOptions
        // provided unchanged (free-text + tool-loop modes don't force a tool).
        if (forceSingleTool) {
          (opts as Record<string, unknown>).toolChoice = forceToolCallShape(
            cand.spec.provider,
            forceSingleTool,
          );
        }
        const msg = await complete(
          m,
          { systemPrompt, messages, tools: rawExtra.tools as never },
          opts,
        );
        // pi-ai represents provider failures as resolved AssistantMessages
        // instead of rejected promises. Treat those terminal messages like
        // thrown transport errors so an unlocked run can try its fallback
        // candidates and the final DroneError keeps the upstream diagnostic.
        if (msg.stopReason === "error" || msg.stopReason === "aborted") {
          throw new Error(
            `${cand.spec.provider}/${cand.spec.model} returned ${msg.stopReason}: ${sanitizeUpstreamError(msg.errorMessage)}`,
          );
        }
        lockedCandidate = cand;
        return { msg, resolvedModel: cand.spec };
      } catch (e) {
        lastError = e;
        if (signal.aborted) {
          throw e;
        }
        // continue to next candidate
      }
    }
    // Diagnostic: if we exhausted only the locked candidate, surface the
    // fallback-was-disabled signal in the error message — easy to miss
    // otherwise.
    if (wasLocked && lockedCandidate) {
      throw new Error(
        `fallback exhausted: locked to ${lockedCandidate.spec.provider}/${lockedCandidate.spec.model} after first turn (cannot switch mid-conversation): ${String(lastError)}`,
        { cause: lastError },
      );
    }
    throw lastError ?? new Error("all candidates failed");
  }

  // Mode dispatch
  try {
    if (def.output) {
      // Schema-only mode
      const schema = def.output as TObject;
      const { msg, resolvedModel } = await attemptComplete({
        forceSingleTool: SCHEMA_TOOL_NAME,
        maxTokens: input.maxTokens ?? 512,
        tools: [
          {
            name: SCHEMA_TOOL_NAME,
            description: "Return a structured result.",
            parameters: schema,
          },
        ] as unknown as ProviderStreamOptions["tools"],
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
    let lastResolvedModel: { provider: string; model: string } = {
      provider: def.model.provider,
      model: def.model.model,
    };

    for (let step = 0; step < maxSteps; step++) {
      const { msg, resolvedModel: rm } = await attemptComplete({
        tools: piTools.length > 0 ? (piTools as never) : undefined,
      });
      lastResolvedModel = rm;
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
          resolvedModel: lastResolvedModel,
        });
      }

      for (const call of calls) {
        const emitTool = (phase: "start" | "end", isError?: boolean) =>
          host.emitEvent?.({
            event: "agent.run.tool",
            droneId: def.id,
            correlationId,
            toolName: call.name,
            toolPhase: phase,
            toolIsError: isError,
          });
        const tool = toolMap.get(call.name);
        if (!tool) {
          messages.push(toolResult(call, `Unknown tool "${call.name}"`, true));
          continue;
        }
        emitTool("start");
        try {
          if (!Value.Check(tool.parameters, call.arguments)) {
            emitTool("end", true);
            messages.push(toolResult(call, `Invalid arguments for "${call.name}"`, true));
            continue;
          }
          const out = await tool.execute(call.arguments as never, {
            droneId: def.id,
            correlationId,
            abortSignal: signal,
          });
          emitTool("end", false);
          messages.push(
            toolResult(call, typeof out === "string" ? out : JSON.stringify(out), false),
          );
        } catch (e) {
          emitTool("end", true);
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
