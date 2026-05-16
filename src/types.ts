import type { TSchema } from "@sinclair/typebox";

/**
 * A drone is an isolated mini-agent — own model, system prompt, optional
 * tools, optional skills, optional output schema. Runs parallel to the
 * chat pipeline. Not a full pi-embedded subprocess; not a raw forced
 * tool call either.
 */
export type DroneModelSpec = {
  /** Provider id (anthropic / openai / google / openrouter / ...) */
  provider: string;
  /** Model id (e.g. "claude-haiku-4-5"). */
  model: string;
  /** Optional auth profile id; host resolver picks default profile otherwise. */
  authProfileId?: string;
  /** Optional ordered fallback chain (provider/model pairs). */
  fallbacks?: Array<{ provider: string; model: string; authProfileId?: string }>;
};

/**
 * A drone-level tool. Distinct from gateway chat tools — these are simple
 * pure handlers. No filesystem mutation, no channel side-effects (those
 * belong in the chat pipeline, not a drone).
 */
export type DroneToolDef = {
  name: string;
  description: string;
  parameters: TSchema;
  execute: (args: unknown, ctx: DroneToolContext) => Promise<unknown> | unknown;
};

export type DroneToolContext = {
  droneId: string;
  correlationId?: string;
  abortSignal?: AbortSignal;
};

export type DroneSkillFilter = {
  include?: string[];
  exclude?: string[];
};

export type DroneDefinition<TOut = string> = {
  id: string;
  description?: string;
  systemPrompt: string;
  model: DroneModelSpec;
  /** Drone-level tools. Empty = no tool loop. */
  tools?: DroneToolDef[];
  /** Skill filter passed to the host's skill snapshot builder. */
  skills?: DroneSkillFilter;
  /**
   * Structured output schema. When present, execution forces a single tool
   * call returning a value matching this schema. Output is the schema's
   * Static type (use `defineDrone` for inference).
   */
  output?: TSchema;
  /** Tool-loop step bound. Default 1 (no tools) or 4 (tools present). */
  maxSteps?: number;
  /** Wall-clock timeout. Default 15_000ms. */
  timeoutMs?: number;
  /** @internal Phantom marker — TOut is inferred at defineDrone(). */
  readonly __out?: TOut;
};

/** Image input for drones — mirrors pi-ai's ImageContent. */
export type DroneImageInput = {
  /** Base64-encoded image bytes. */
  data: string;
  /** MIME type, e.g. "image/png", "image/jpeg". */
  mimeType: string;
};

export type DroneRunInput = {
  prompt: string;
  /**
   * Optional image inputs sent alongside the prompt in the user message.
   * Provider support varies — Anthropic/OpenAI/Google support vision models;
   * text-only providers will reject. The drone does not validate; the
   * provider's error surfaces through `UPSTREAM_ERROR`.
   */
  images?: DroneImageInput[];
  /** Optional variables interpolated into systemPrompt as {{key}}. */
  context?: Record<string, string | number | boolean>;
  /** Session / message id for telemetry correlation. */
  correlationId?: string;
  abortSignal?: AbortSignal;
  /** Best-effort per-run override (provider-dependent). Defaults to 1024 (free-text) or 512 (schema-only). */
  maxTokens?: number;
  /** Best-effort per-run override (provider-dependent). */
  temperature?: number;
};

export type DroneUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
};

export type DroneRunOk<TOut> = {
  ok: true;
  data: TOut;
  usage: DroneUsage;
  durationMs: number;
  /** Model actually used (after fallback resolution). */
  resolvedModel: { provider: string; model: string };
};

export type DroneRunErr = {
  ok: false;
  error: DroneError;
  usage?: DroneUsage;
  durationMs: number;
};

export type DroneRunResult<TOut> = DroneRunOk<TOut> | DroneRunErr;

export type DroneErrorCode =
  | "NO_API_KEY"
  | "NO_TOOL_CALL"
  | "TIMEOUT"
  | "ABORTED"
  | "MAX_STEPS_EXCEEDED"
  | "SCHEMA_INVALID"
  | "TOOL_FAILED"
  | "UPSTREAM_ERROR";

export type DroneError = {
  code: DroneErrorCode;
  message: string;
  cause?: unknown;
};

/**
 * Host contract — the gateway provides one of these at boot. Drones never
 * reach into gateway internals directly; this is the only surface they see.
 * Matches the HostServices inversion pattern (see project_drone_abstraction_gap).
 */
export type DroneHost = {
  /**
   * Resolve the provider's api key (or oauth token) for the requested model.
   * Throws if no credentials are available.
   */
  resolveApiKey(spec: DroneModelSpec): Promise<{ apiKey: string; source: string }>;
  /**
   * Build a skill prompt block for the given filter. Returns "" when no
   * skills match or when the host has skills configured off.
   */
  resolveSkillsPrompt(filter: DroneSkillFilter | undefined): string;
  /**
   * Optional: emit a structured agent.run.* event. No-op host (in tests)
   * may omit this.
   */
  emitEvent?(input: DroneEventInput): void;
};

/** Streaming events emitted by `runDroneStream`. */
export type DroneStreamEvent =
  | { type: "text"; delta: string }
  | {
      type: "done";
      data: string;
      usage: DroneUsage;
      durationMs: number;
      resolvedModel: { provider: string; model: string };
    }
  | { type: "error"; error: DroneError; durationMs: number };

export type DroneEventInput = {
  event: "agent.run.start" | "agent.run.end" | "agent.run.error";
  droneId: string;
  correlationId?: string;
  durationMs?: number;
  usage?: DroneUsage;
  errorCode?: DroneErrorCode;
};

/** Opaque handle returned by defineDrone — keeps definition immutable. */
export type Drone<TOut = string> = {
  readonly definition: Readonly<DroneDefinition<TOut>>;
};
