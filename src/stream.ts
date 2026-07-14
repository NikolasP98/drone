import { getModel, stream } from "@earendil-works/pi-ai";
import type {
  AssistantMessage,
  Context,
  Message,
  ProviderStreamOptions,
  ToolCall,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import { Value } from "@sinclair/typebox/value";
import type {
  Drone,
  DroneError,
  DroneHost,
  DroneRunInput,
  DroneStreamEvent,
  DroneUsage,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 15_000;

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

function err(code: DroneError["code"], message: string, cause?: unknown): DroneError {
  return { code, message, cause };
}

function sanitizeUpstreamError(message: string | undefined): string {
  const normalized = message
    ?.replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized ? normalized.slice(0, 1_000) : "provider returned no error details";
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

/**
 * Run a drone in streaming mode. Yields {@link DroneStreamEvent}s as the
 * model produces output: `text` / `thinking` deltas, `tool` start/end events
 * while a tool-loop drone works, then exactly one `done` (or `error`) event.
 * Only schema-only drones are unsupported (structured output can't stream).
 */
export async function* runDroneStream(
  drone: Drone,
  input: DroneRunInput,
  host: DroneHost,
): AsyncIterable<DroneStreamEvent> {
  const def = drone.definition;
  const started = Date.now();
  const timeoutMs = def.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const correlationId = input.correlationId;

  if (def.output) {
    yield {
      type: "error",
      error: err(
        "UPSTREAM_ERROR",
        `streaming is not supported for schema-only drones (drone "${def.id}" has output schema)`,
      ),
      durationMs: 0,
    };
    return;
  }

  const timeoutCtl = new AbortController();
  const timer = setTimeout(() => timeoutCtl.abort(), timeoutMs);
  const signal = anySignal([input.abortSignal, timeoutCtl.signal]);

  host.emitEvent?.({ event: "agent.run.start", droneId: def.id, correlationId });
  const usage: DroneUsage = {};

  try {
    type Candidate = {
      spec: { provider: string; model: string };
      apiKey: string;
    };
    const chain = [def.model, ...(def.model.fallbacks ?? [])];
    const candidates: Candidate[] = [];
    const authErrors: string[] = [];
    for (const entry of chain) {
      try {
        const auth = await host.resolveApiKey(entry);
        candidates.push({
          spec: { provider: entry.provider, model: entry.model },
          apiKey: auth.apiKey,
        });
      } catch (error) {
        authErrors.push(`${entry.provider}/${entry.model}: ${String(error)}`);
      }
    }
    if (candidates.length === 0) {
      const durationMs = Date.now() - started;
      const error = err(
        "NO_API_KEY",
        `Failed to resolve api key for any candidate (${authErrors.join("; ") || "no candidates"})`,
      );
      host.emitEvent?.({
        event: "agent.run.error",
        droneId: def.id,
        correlationId,
        durationMs,
        errorCode: error.code,
      });
      yield { type: "error", error, durationMs };
      return;
    }

    const skillsBlock = host.resolveSkillsPrompt(def.skills);
    const systemPrompt = [interpolate(def.systemPrompt, input.context), skillsBlock]
      .filter((s) => s && s.trim().length > 0)
      .join("\n\n");

    const userContent:
      | string
      | Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> =
      input.images && input.images.length > 0
        ? [
            { type: "text", text: input.prompt },
            ...input.images.map((img) => ({
              type: "image" as const,
              data: img.data,
              mimeType: img.mimeType,
            })),
          ]
        : input.prompt;
    const messages: Message[] = [{ role: "user", content: userContent, timestamp: Date.now() }];

    const tools = def.tools ?? [];
    const maxSteps = def.maxSteps ?? (tools.length > 0 ? 4 : 1);
    const piTools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
    const toolMap = new Map(tools.map((t) => [t.name, t]));

    let finalText = "";
    let lockedCandidate: Candidate | undefined;
    let resolvedModel = candidates[0].spec;
    for (let step = 0; step < maxSteps; step++) {
      const ctx: Context = { systemPrompt, messages };
      const pool = lockedCandidate ? [lockedCandidate] : candidates;
      let final: AssistantMessage | undefined;
      let lastError: unknown;

      for (const candidate of pool) {
        let emittedDelta = false;
        try {
          const model = getModel(
            candidate.spec.provider as never,
            candidate.spec.model as never,
          ) as Parameters<typeof stream>[0];
          const streamOptions: ProviderStreamOptions = {
            apiKey: candidate.apiKey,
            signal,
            maxTokens: input.maxTokens ?? 1024,
            ...(input.temperature != null ? { temperature: input.temperature } : {}),
            ...(piTools.length > 0 ? { tools: piTools as never } : {}),
          };
          const eventStream = stream(model, ctx, streamOptions);
          for await (const evt of eventStream) {
            if (evt.type === "text_delta") {
              emittedDelta = true;
              yield { type: "text", delta: evt.delta };
            } else if (evt.type === "thinking_delta") {
              emittedDelta = true;
              yield { type: "thinking", delta: evt.delta };
            }
          }
          const candidateFinal = await eventStream.result();
          if (candidateFinal.stopReason === "error" || candidateFinal.stopReason === "aborted") {
            throw new Error(
              `${candidate.spec.provider}/${candidate.spec.model} returned ${candidateFinal.stopReason}: ${sanitizeUpstreamError(candidateFinal.errorMessage)}`,
            );
          }
          final = candidateFinal;
          lockedCandidate = candidate;
          resolvedModel = candidate.spec;
          break;
        } catch (error) {
          lastError = error;
          // Never replay a partially streamed answer, and never switch providers
          // after a tool-loop conversation has been locked to one candidate.
          if (signal.aborted || emittedDelta || lockedCandidate) throw error;
        }
      }

      if (!final) throw lastError ?? new Error("all streaming candidates failed");
      messages.push(final);
      const u = final.usage;
      if (u) {
        usage.inputTokens = (usage.inputTokens ?? 0) + (u.input ?? 0);
        usage.outputTokens = (usage.outputTokens ?? 0) + (u.output ?? 0);
        usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + (u.cacheRead ?? 0);
        usage.cacheCreationTokens = (usage.cacheCreationTokens ?? 0) + (u.cacheWrite ?? 0);
      }
      finalText = final.content
        .filter((c: { type: string }) => c.type === "text")
        .map((c: unknown) => (c as { text: string }).text)
        .join("");

      const calls = final.content.filter((c): c is ToolCall => c.type === "toolCall");
      if (calls.length === 0) {
        const durationMs = Date.now() - started;
        host.emitEvent?.({
          event: "agent.run.end",
          droneId: def.id,
          correlationId,
          durationMs,
          usage,
        });
        yield { type: "done", data: finalText, usage, durationMs, resolvedModel };
        return;
      }

      for (const call of calls) {
        const emitTool = (phase: "start" | "end", isError?: boolean) => {
          host.emitEvent?.({
            event: "agent.run.tool",
            droneId: def.id,
            correlationId,
            toolName: call.name,
            toolPhase: phase,
            toolIsError: isError,
          });
        };
        const tool = toolMap.get(call.name);
        if (!tool) {
          messages.push(streamToolResult(call, `Unknown tool "${call.name}"`, true));
          continue;
        }
        emitTool("start");
        yield { type: "tool", phase: "start", name: call.name, toolCallId: call.id };
        let out: unknown;
        let isError = false;
        try {
          if (!Value.Check(tool.parameters, call.arguments)) {
            out = `Invalid arguments for "${call.name}"`;
            isError = true;
          } else {
            out = await tool.execute(call.arguments as never, {
              droneId: def.id,
              correlationId,
              abortSignal: signal,
            });
          }
        } catch (e) {
          out = String(e);
          isError = true;
        }
        emitTool("end", isError);
        yield { type: "tool", phase: "end", name: call.name, toolCallId: call.id, isError };
        messages.push(
          streamToolResult(call, typeof out === "string" ? out : JSON.stringify(out), isError),
        );
      }
    }

    yield {
      type: "error",
      error: err(
        "MAX_STEPS_EXCEEDED",
        `drone "${def.id}" exceeded ${maxSteps} steps without final reply`,
      ),
      durationMs: Date.now() - started,
    };
    host.emitEvent?.({
      event: "agent.run.error",
      droneId: def.id,
      correlationId,
      durationMs: Date.now() - started,
      errorCode: "MAX_STEPS_EXCEEDED",
    });
  } catch (e) {
    const durationMs = Date.now() - started;
    const code: DroneError["code"] =
      signal.aborted && timeoutCtl.signal.aborted
        ? "TIMEOUT"
        : signal.aborted
          ? "ABORTED"
          : "UPSTREAM_ERROR";
    host.emitEvent?.({
      event: "agent.run.error",
      droneId: def.id,
      correlationId,
      durationMs,
      errorCode: code,
    });
    yield {
      type: "error",
      error: err(code, `drone "${def.id}" stream failed: ${String(e)}`, e),
      durationMs,
    };
  } finally {
    clearTimeout(timer);
  }
}

function streamToolResult(call: ToolCall, text: string, isError: boolean): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: "text", text }],
    isError,
    timestamp: Date.now(),
  };
}
