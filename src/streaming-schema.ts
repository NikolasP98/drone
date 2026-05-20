import type { TSchema, Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { DroneError, DroneErrorCode, DroneHost, DroneModelSpec, DroneUsage } from "./types.js";

/**
 * Streaming schema drone — yields partial typed objects as the model
 * generates structured output. Backed by BAML's `Stream<T>` materializer
 * (every field becomes nullable-until-finalized via schema-aligned parsing).
 *
 * Use when:
 *  - The output schema is deep enough that early fields are valuable before
 *    later ones land (knowledge-graph extraction, multi-section reports).
 *  - Latency-sensitive consumers want to act on partial output (voice TTS
 *    speaking the first sentence of a generated reply, UI revealing entities
 *    as they're parsed).
 *
 * Single-model lock: streaming drones cannot fall over mid-stream because
 * partial tokens are model-specific. Configure one model; failures surface
 * as `UPSTREAM_ERROR`.
 */

/** Minimal subset of BAML's BamlStream surface drone depends on. */
export interface BamlStreamLike<TPartial, TFinal> {
  [Symbol.asyncIterator](): AsyncIterator<TPartial>;
  getFinalResponse(): Promise<TFinal>;
}

/** Minimal subset of BAML's ClientRegistry surface drone needs to inject api keys. */
export interface BamlClientRegistryLike {
  addLlmClient(name: string, provider: string, options: Record<string, unknown>): void;
  setPrimary(name: string): void;
}

/** Construct ClientRegistry — caller supplies the concrete class from baml_client. */
export type BamlClientRegistryFactory = () => BamlClientRegistryLike;

/**
 * Caller-supplied BAML function invocation. Drone passes the constructed
 * ClientRegistry; the closure forwards it to the generated client.
 * @example
 *   callBaml: (args, registry) => b.stream.ExtractEntities(args.text, { clientRegistry: registry })
 */
export type StreamingDroneCall<TArgs, TPartial, TFinal> = (
  args: TArgs,
  registry: BamlClientRegistryLike,
) => BamlStreamLike<TPartial, TFinal>;

export type StreamingDroneDefinition<TArgs, TSchemaOut extends TSchema> = {
  id: string;
  description?: string;
  model: DroneModelSpec;
  /** TypeBox schema for runtime validation of the final result. */
  output: TSchemaOut;
  /** Factory for an empty BAML ClientRegistry. Pass `() => new ClientRegistry()` from baml_client. */
  clientRegistry: BamlClientRegistryFactory;
  /** Closure invoking the generated `b.stream.X(...)` call. */
  callBaml: StreamingDroneCall<TArgs, Partial<Static<TSchemaOut>>, Static<TSchemaOut>>;
  timeoutMs?: number;
};

export type StreamingDrone<TArgs, TSchemaOut extends TSchema> = {
  readonly definition: Readonly<StreamingDroneDefinition<TArgs, TSchemaOut>>;
};

export type StreamingSchemaEvent<TFinal> =
  | { type: "partial"; data: Partial<TFinal> }
  | { type: "done"; data: TFinal; usage: DroneUsage; durationMs: number }
  | { type: "error"; error: DroneError; durationMs: number };

export type StreamingDroneRunInput<TArgs> = {
  args: TArgs;
  correlationId?: string;
  abortSignal?: AbortSignal;
};

const DEFAULT_TIMEOUT_MS = 30_000;

/** Define a streaming-schema drone with full type inference. */
export function defineStreamingDrone<TArgs, TSchemaOut extends TSchema>(
  def: StreamingDroneDefinition<TArgs, TSchemaOut>,
): StreamingDrone<TArgs, TSchemaOut> {
  const frozen = Object.freeze({ ...def });
  return Object.freeze({ definition: frozen });
}

function err(code: DroneErrorCode, message: string, cause?: unknown): DroneError {
  return { code, message, cause };
}

/** Map DroneModelSpec → BAML client provider + options. */
function applyModelToRegistry(
  registry: BamlClientRegistryLike,
  model: DroneModelSpec,
  apiKey: string,
): void {
  const clientName = "DroneInjected";
  const options: Record<string, unknown> = {
    model: model.model,
    api_key: apiKey,
  };
  registry.addLlmClient(clientName, model.provider, options);
  registry.setPrimary(clientName);
}

/**
 * Run a streaming-schema drone. Yields partial typed objects until the
 * model finishes, then a `done` event with the validated final value.
 *
 * Validation: the final result is checked against `definition.output`
 * (TypeBox). A mismatch surfaces as `SCHEMA_INVALID` — BAML's SAP recovery
 * is best-effort, not guaranteed.
 */
export async function* runStreamingSchemaDrone<TArgs, TSchemaOut extends TSchema>(
  drone: StreamingDrone<TArgs, TSchemaOut>,
  input: StreamingDroneRunInput<TArgs>,
  host: DroneHost,
): AsyncIterable<StreamingSchemaEvent<Static<TSchemaOut>>> {
  const def = drone.definition;
  const started = Date.now();
  const timeoutMs = def.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const timeoutCtl = new AbortController();
  const timer = setTimeout(() => timeoutCtl.abort(), timeoutMs);

  host.emitEvent?.({
    event: "agent.run.start",
    droneId: def.id,
    correlationId: input.correlationId,
  });

  try {
    const auth = await host.resolveApiKey(def.model);
    const registry = def.clientRegistry();
    applyModelToRegistry(registry, def.model, auth.apiKey);

    const stream = def.callBaml(input.args, registry);

    for await (const partial of stream) {
      if (timeoutCtl.signal.aborted) {
        throw new Error("timeout");
      }
      if (input.abortSignal?.aborted) {
        throw new Error("aborted");
      }
      yield { type: "partial", data: partial };
    }

    const final = await stream.getFinalResponse();
    const durationMs = Date.now() - started;

    if (!Value.Check(def.output, final)) {
      const errors = [...Value.Errors(def.output, final)].slice(0, 3);
      yield {
        type: "error",
        error: err(
          "SCHEMA_INVALID",
          `drone "${def.id}" final result failed schema validation: ${errors
            .map((e) => `${e.path}: ${e.message}`)
            .join("; ")}`,
        ),
        durationMs,
      };
      return;
    }

    const usage: DroneUsage = {};
    host.emitEvent?.({
      event: "agent.run.end",
      droneId: def.id,
      correlationId: input.correlationId,
      durationMs,
      usage,
    });
    yield { type: "done", data: final as Static<TSchemaOut>, usage, durationMs };
  } catch (e) {
    const durationMs = Date.now() - started;
    const code: DroneErrorCode = timeoutCtl.signal.aborted
      ? "TIMEOUT"
      : input.abortSignal?.aborted
        ? "ABORTED"
        : "UPSTREAM_ERROR";
    host.emitEvent?.({
      event: "agent.run.error",
      droneId: def.id,
      correlationId: input.correlationId,
      durationMs,
      errorCode: code,
    });
    yield {
      type: "error",
      error: err(code, `drone "${def.id}" streaming-schema failed: ${String(e)}`, e),
      durationMs,
    };
  } finally {
    clearTimeout(timer);
  }
}
