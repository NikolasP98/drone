import { getModel, stream } from "@mariozechner/pi-ai";
import type { Context, Message, ProviderStreamOptions } from "@mariozechner/pi-ai";
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
 * model produces text. Only valid for **free-text drones** — drones with
 * an output schema or with tools throw `INVALID_MODE` immediately.
 *
 * The async iterable yields `text` deltas during the response, then exactly
 * one `done` event (or one `error` event on failure). Callers should treat
 * the stream as complete after either terminator.
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
  if ((def.tools ?? []).length > 0) {
    yield {
      type: "error",
      error: err(
        "UPSTREAM_ERROR",
        `streaming is not supported for tool-loop drones (drone "${def.id}" has tools)`,
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
    const auth = await host.resolveApiKey(def.model);
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

    const ctx: Context = { systemPrompt, messages };
    const model = getModel(def.model.provider as never, def.model.model as never) as Parameters<
      typeof stream
    >[0];
    const resolvedModel = { provider: def.model.provider, model: def.model.model };
    const baseOptions: ProviderStreamOptions = {
      apiKey: auth.apiKey,
      signal,
      maxTokens: input.maxTokens ?? 1024,
      ...(input.temperature != null ? { temperature: input.temperature } : {}),
    };

    const eventStream = stream(model, ctx, baseOptions);
    for await (const evt of eventStream) {
      if (evt.type === "text_delta") {
        yield { type: "text", delta: evt.delta };
      }
    }

    const final = await eventStream.result();
    const finalText = final.content
      .filter((c: { type: string }) => c.type === "text")
      .map((c: unknown) => (c as { text: string }).text)
      .join("");
    const u = final.usage;
    if (u) {
      usage.inputTokens = u.input;
      usage.outputTokens = u.output;
      usage.cacheReadTokens = u.cacheRead;
      usage.cacheCreationTokens = u.cacheWrite;
    }
    const durationMs = Date.now() - started;
    host.emitEvent?.({
      event: "agent.run.end",
      droneId: def.id,
      correlationId,
      durationMs,
      usage,
    });
    yield { type: "done", data: finalText, usage, durationMs, resolvedModel };
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
