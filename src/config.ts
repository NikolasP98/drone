import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type DroneTheme = "auto" | "dark" | "light" | "mono";
export type DroneMouseMode = "auto" | "on" | "off";
export type DroneMotionMode = "full" | "reduced" | "off";
export type DroneArtMode = "full" | "compact" | "minimal" | "off";
export type DroneScreenMode = "alternate" | "split";

export interface DroneUiConfig {
  theme: DroneTheme;
  mouse: DroneMouseMode;
  mouseClicks: boolean;
  copyOnSelect: boolean;
  motion: DroneMotionMode;
  art: DroneArtMode;
  screen: DroneScreenMode;
}

export interface DroneRuntimeConfig {
  allowShell: boolean;
  allowWrites: boolean;
  requireApproval: boolean;
  maxOutputChars: number;
}

export interface DroneConfig {
  provider: string;
  model: string;
  systemPrompt: string;
  timeoutMs: number;
  maxSteps: number;
  temperature: number;
  ui: DroneUiConfig;
  runtime: DroneRuntimeConfig;
}

export interface DroneConfigOverrides {
  provider?: string;
  model?: string;
  systemPrompt?: string;
  timeoutMs?: number;
  maxSteps?: number;
  temperature?: number;
  ui?: Partial<DroneUiConfig>;
  runtime?: Partial<DroneRuntimeConfig>;
}

export type DroneConfigSource = "user" | "project" | "environment" | "overrides";

export type DroneConfigDiagnosticCode =
  | "read_error"
  | "parse_error"
  | "invalid_value"
  | "unknown_key";

export interface DroneConfigDiagnostic {
  code: DroneConfigDiagnosticCode;
  source: DroneConfigSource;
  message: string;
  key?: string;
  path?: string;
}

export interface DroneConfigPaths {
  user: string;
  project: string;
}

export interface DroneConfigPathOptions {
  cwd?: string;
  env?: Readonly<Record<string, string | undefined>>;
  homeDir?: string;
  userConfigPath?: string;
  projectConfigPath?: string;
}

export interface ResolveDroneConfigOptions {
  user?: unknown;
  project?: unknown;
  env?: Readonly<Record<string, string | undefined>>;
  overrides?: DroneConfigOverrides | unknown;
}

export interface ResolvedDroneConfig {
  config: DroneConfig;
  diagnostics: DroneConfigDiagnostic[];
}

export interface LoadDroneConfigOptions extends DroneConfigPathOptions {
  overrides?: DroneConfigOverrides | unknown;
}

export interface LoadedDroneConfig extends ResolvedDroneConfig {
  paths: DroneConfigPaths;
}

export interface SaveDroneConfigOptions extends DroneConfigPathOptions {}

export interface SavedDroneConfig {
  path: string;
  config: DroneConfigOverrides;
  diagnostics: DroneConfigDiagnostic[];
}

export const DEFAULT_DRONE_CONFIG: Readonly<DroneConfig> = {
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  systemPrompt:
    "You are Drone, a concise and capable coding agent. Inspect the current project, explain consequential actions, and make safe, focused changes.",
  timeoutMs: 120_000,
  maxSteps: 24,
  temperature: 0.2,
  ui: {
    theme: "auto",
    mouse: "auto",
    mouseClicks: true,
    copyOnSelect: true,
    motion: "full",
    art: "full",
    screen: "alternate",
  },
  runtime: {
    allowShell: true,
    allowWrites: true,
    requireApproval: true,
    maxOutputChars: 50_000,
  },
};

/** Lower-camel alias for callers that prefer a value-shaped export. */
export const droneConfigDefaults = DEFAULT_DRONE_CONFIG;

const TOP_LEVEL_KEYS = new Set([
  "provider",
  "model",
  "systemPrompt",
  "timeoutMs",
  "maxSteps",
  "temperature",
  "ui",
  "runtime",
]);
const UI_KEYS = new Set([
  "theme",
  "mouse",
  "mouseClicks",
  "copyOnSelect",
  "motion",
  "art",
  "screen",
]);
const RUNTIME_KEYS = new Set([
  "allowShell",
  "allowWrites",
  "requireApproval",
  "maxOutputChars",
]);
const TRUE_VALUES = new Set(["true", "1", "yes", "on"]);
const FALSE_VALUES = new Set(["false", "0", "no", "off"]);
const THEMES = new Set<DroneTheme>(["auto", "dark", "light", "mono"]);
const MOUSE_MODES = new Set<DroneMouseMode>(["auto", "on", "off"]);
const MOTION_MODES = new Set<DroneMotionMode>(["full", "reduced", "off"]);
const ART_MODES = new Set<DroneArtMode>(["full", "compact", "minimal", "off"]);
const SCREEN_MODES = new Set<DroneScreenMode>(["alternate", "split"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function addInvalidDiagnostic(
  diagnostics: DroneConfigDiagnostic[],
  source: DroneConfigSource,
  key: string,
  expected: string,
): void {
  diagnostics.push({
    code: "invalid_value",
    source,
    key,
    message: `Ignored ${source} config value "${key}": expected ${expected}.`,
  });
}

function readString(
  record: Record<string, unknown>,
  key: string,
  source: DroneConfigSource,
  diagnostics: DroneConfigDiagnostic[],
  diagnosticKey = key,
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value === "string" && value.trim().length > 0) return value;
  addInvalidDiagnostic(diagnostics, source, diagnosticKey, "a non-empty string");
  return undefined;
}

function readBoolean(
  record: Record<string, unknown>,
  key: string,
  source: DroneConfigSource,
  diagnostics: DroneConfigDiagnostic[],
  diagnosticKey = key,
): boolean | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  addInvalidDiagnostic(diagnostics, source, diagnosticKey, "a boolean");
  return undefined;
}

function readNumber(
  record: Record<string, unknown>,
  key: string,
  source: DroneConfigSource,
  diagnostics: DroneConfigDiagnostic[],
  predicate: (value: number) => boolean,
  expected: string,
  diagnosticKey = key,
): number | undefined {
  const value = record[key];
  if (typeof value === "number" && Number.isFinite(value) && predicate(value)) return value;
  if (value === undefined) return undefined;
  addInvalidDiagnostic(diagnostics, source, diagnosticKey, expected);
  return undefined;
}

function readEnum<T extends string>(
  record: Record<string, unknown>,
  key: string,
  source: DroneConfigSource,
  diagnostics: DroneConfigDiagnostic[],
  allowed: ReadonlySet<T>,
  expected: string,
  diagnosticKey = key,
): T | undefined {
  const value = record[key];
  if (typeof value === "string" && allowed.has(value as T)) return value as T;
  if (value === undefined) return undefined;
  addInvalidDiagnostic(diagnostics, source, diagnosticKey, expected);
  return undefined;
}

function addUnknownKeys(
  record: Record<string, unknown>,
  known: ReadonlySet<string>,
  prefix: string,
  source: DroneConfigSource,
  diagnostics: DroneConfigDiagnostic[],
): void {
  for (const key of Object.keys(record)) {
    if (known.has(key)) continue;
    const qualifiedKey = prefix ? `${prefix}.${key}` : key;
    diagnostics.push({
      code: "unknown_key",
      source,
      key: qualifiedKey,
      message: `Ignored unsupported ${source} config key "${qualifiedKey}".`,
    });
  }
}

function sanitizeUi(
  input: unknown,
  source: DroneConfigSource,
  diagnostics: DroneConfigDiagnostic[],
): Partial<DroneUiConfig> | undefined {
  if (input === undefined) return undefined;
  if (!isRecord(input)) {
    addInvalidDiagnostic(diagnostics, source, "ui", "an object");
    return undefined;
  }

  addUnknownKeys(input, UI_KEYS, "ui", source, diagnostics);
  const ui: Partial<DroneUiConfig> = {};
  const theme = readEnum(
    input,
    "theme",
    source,
    diagnostics,
    THEMES,
    '"auto", "dark", "light", or "mono"',
    "ui.theme",
  );
  const mouse = readEnum(
    input,
    "mouse",
    source,
    diagnostics,
    MOUSE_MODES,
    '"auto", "on", or "off"',
    "ui.mouse",
  );
  const mouseClicks = readBoolean(
    input,
    "mouseClicks",
    source,
    diagnostics,
    "ui.mouseClicks",
  );
  const copyOnSelect = readBoolean(
    input,
    "copyOnSelect",
    source,
    diagnostics,
    "ui.copyOnSelect",
  );
  const motion = readEnum(
    input,
    "motion",
    source,
    diagnostics,
    MOTION_MODES,
    '"full", "reduced", or "off"',
    "ui.motion",
  );
  const art = readEnum(
    input,
    "art",
    source,
    diagnostics,
    ART_MODES,
    '"full", "compact", "minimal", or "off"',
    "ui.art",
  );
  const screen = readEnum(
    input,
    "screen",
    source,
    diagnostics,
    SCREEN_MODES,
    '"alternate" or "split"',
    "ui.screen",
  );

  if (theme !== undefined) ui.theme = theme;
  if (mouse !== undefined) ui.mouse = mouse;
  if (mouseClicks !== undefined) ui.mouseClicks = mouseClicks;
  if (copyOnSelect !== undefined) ui.copyOnSelect = copyOnSelect;
  if (motion !== undefined) ui.motion = motion;
  if (art !== undefined) ui.art = art;
  if (screen !== undefined) ui.screen = screen;

  return Object.keys(ui).length > 0 ? ui : undefined;
}

function sanitizeRuntime(
  input: unknown,
  source: DroneConfigSource,
  diagnostics: DroneConfigDiagnostic[],
): Partial<DroneRuntimeConfig> | undefined {
  if (input === undefined) return undefined;
  if (!isRecord(input)) {
    addInvalidDiagnostic(diagnostics, source, "runtime", "an object");
    return undefined;
  }

  addUnknownKeys(input, RUNTIME_KEYS, "runtime", source, diagnostics);
  const runtime: Partial<DroneRuntimeConfig> = {};
  const allowShell = readBoolean(
    input,
    "allowShell",
    source,
    diagnostics,
    "runtime.allowShell",
  );
  const allowWrites = readBoolean(
    input,
    "allowWrites",
    source,
    diagnostics,
    "runtime.allowWrites",
  );
  const requireApproval = readBoolean(
    input,
    "requireApproval",
    source,
    diagnostics,
    "runtime.requireApproval",
  );
  const maxOutputChars = readNumber(
    input,
    "maxOutputChars",
    source,
    diagnostics,
    (value) => Number.isInteger(value) && value > 0 && value <= 1_000_000,
    "an integer from 1 through 1000000",
    "runtime.maxOutputChars",
  );

  if (allowShell !== undefined) {
    if (source === "project" && allowShell) {
      addInvalidDiagnostic(
        diagnostics,
        source,
        "runtime.allowShell",
        "false (project config may only tighten runtime safety)",
      );
    } else {
      runtime.allowShell = allowShell;
    }
  }
  if (allowWrites !== undefined) {
    if (source === "project" && allowWrites) {
      addInvalidDiagnostic(
        diagnostics,
        source,
        "runtime.allowWrites",
        "false (project config may only tighten runtime safety)",
      );
    } else {
      runtime.allowWrites = allowWrites;
    }
  }
  if (requireApproval !== undefined) {
    if (source === "project" && !requireApproval) {
      addInvalidDiagnostic(
        diagnostics,
        source,
        "runtime.requireApproval",
        "true (project config may only tighten runtime safety)",
      );
    } else {
      runtime.requireApproval = requireApproval;
    }
  }
  if (maxOutputChars !== undefined) runtime.maxOutputChars = maxOutputChars;
  return Object.keys(runtime).length > 0 ? runtime : undefined;
}

function sanitizeLayer(
  input: unknown,
  source: DroneConfigSource,
  diagnostics: DroneConfigDiagnostic[],
): DroneConfigOverrides {
  if (input === undefined) return {};
  if (!isRecord(input)) {
    addInvalidDiagnostic(diagnostics, source, "config", "an object");
    return {};
  }

  addUnknownKeys(input, TOP_LEVEL_KEYS, "", source, diagnostics);
  const result: DroneConfigOverrides = {};
  const provider = readString(input, "provider", source, diagnostics);
  const model = readString(input, "model", source, diagnostics);
  const systemPrompt = readString(input, "systemPrompt", source, diagnostics);
  const timeoutMs = readNumber(
    input,
    "timeoutMs",
    source,
    diagnostics,
    (value) => Number.isInteger(value) && value > 0,
    "a positive integer",
  );
  const maxSteps = readNumber(
    input,
    "maxSteps",
    source,
    diagnostics,
    (value) => Number.isInteger(value) && value > 0,
    "a positive integer",
  );
  const temperature = readNumber(
    input,
    "temperature",
    source,
    diagnostics,
    (value) => value >= 0 && value <= 2,
    "a number from 0 through 2",
  );
  const ui = sanitizeUi(input.ui, source, diagnostics);
  const runtime = sanitizeRuntime(input.runtime, source, diagnostics);

  if (provider !== undefined) result.provider = provider;
  if (model !== undefined) result.model = model;
  if (systemPrompt !== undefined) result.systemPrompt = systemPrompt;
  if (timeoutMs !== undefined) result.timeoutMs = timeoutMs;
  if (maxSteps !== undefined) result.maxSteps = maxSteps;
  if (temperature !== undefined) result.temperature = temperature;
  if (ui !== undefined) result.ui = ui;
  if (runtime !== undefined) result.runtime = runtime;
  return result;
}

function parseEnvBoolean(
  value: string | undefined,
  key: string,
  diagnostics: DroneConfigDiagnostic[],
): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  addInvalidDiagnostic(
    diagnostics,
    "environment",
    key,
    'one of true/false, 1/0, yes/no, or on/off',
  );
  return undefined;
}

function parseEnvNumber(
  value: string | undefined,
  key: string,
  diagnostics: DroneConfigDiagnostic[],
): number | undefined {
  if (value === undefined) return undefined;
  if (value.trim() === "") {
    addInvalidDiagnostic(diagnostics, "environment", key, "a number");
    return undefined;
  }
  const parsed = Number(value);
  if (Number.isFinite(parsed)) return parsed;
  addInvalidDiagnostic(diagnostics, "environment", key, "a number");
  return undefined;
}

function parseEnvEnum<T extends string>(
  value: string | undefined,
  key: string,
  allowed: ReadonlySet<T>,
  aliases: Readonly<Record<string, T>>,
  expected: string,
  diagnostics: DroneConfigDiagnostic[],
): T | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  const alias = aliases[normalized];
  if (alias !== undefined) return alias;
  if (allowed.has(normalized as T)) return normalized as T;
  addInvalidDiagnostic(diagnostics, "environment", key, expected);
  return undefined;
}

function envToLayer(
  env: Readonly<Record<string, string | undefined>>,
  diagnostics: DroneConfigDiagnostic[],
): DroneConfigOverrides {
  const layer: DroneConfigOverrides = {};
  const ui: Partial<DroneUiConfig> = {};
  const runtime: Partial<DroneRuntimeConfig> = {};

  if (env.DRONE_PROVIDER !== undefined) layer.provider = env.DRONE_PROVIDER;
  if (env.DRONE_MODEL !== undefined) layer.model = env.DRONE_MODEL;
  if (env.DRONE_SYSTEM_PROMPT !== undefined) layer.systemPrompt = env.DRONE_SYSTEM_PROMPT;
  const timeoutMs = parseEnvNumber(env.DRONE_TIMEOUT_MS, "DRONE_TIMEOUT_MS", diagnostics);
  const maxSteps = parseEnvNumber(env.DRONE_MAX_STEPS, "DRONE_MAX_STEPS", diagnostics);
  const temperature = parseEnvNumber(
    env.DRONE_TEMPERATURE,
    "DRONE_TEMPERATURE",
    diagnostics,
  );
  if (timeoutMs !== undefined) layer.timeoutMs = timeoutMs;
  if (maxSteps !== undefined) layer.maxSteps = maxSteps;
  if (temperature !== undefined) layer.temperature = temperature;

  if (env.DRONE_THEME !== undefined) {
    const theme = parseEnvEnum(
      env.DRONE_THEME,
      "DRONE_THEME",
      THEMES,
      {},
      '"auto", "dark", "light", or "mono"',
      diagnostics,
    );
    if (theme !== undefined) ui.theme = theme;
  } else if (Object.hasOwn(env, "DRONE_NO_COLOR")) {
    const noColor = parseEnvBoolean(env.DRONE_NO_COLOR, "DRONE_NO_COLOR", diagnostics);
    if (noColor === true) ui.theme = "mono";
  } else if (Object.hasOwn(env, "NO_COLOR")) {
    ui.theme = "mono";
  }

  const mouse = parseEnvEnum(
    env.DRONE_MOUSE,
    "DRONE_MOUSE",
    MOUSE_MODES,
    { true: "on", "1": "on", yes: "on", false: "off", "0": "off", no: "off" },
    '"auto", "on", or "off"',
    diagnostics,
  );
  const mouseClicks = parseEnvBoolean(
    env.DRONE_MOUSE_CLICKS,
    "DRONE_MOUSE_CLICKS",
    diagnostics,
  );
  const copyOnSelect = parseEnvBoolean(
    env.DRONE_COPY_ON_SELECT,
    "DRONE_COPY_ON_SELECT",
    diagnostics,
  );
  const motion = parseEnvEnum(
    env.DRONE_MOTION,
    "DRONE_MOTION",
    MOTION_MODES,
    { true: "full", "1": "full", yes: "full", on: "full", false: "off", "0": "off", no: "off" },
    '"full", "reduced", or "off"',
    diagnostics,
  );
  const art = parseEnvEnum(
    env.DRONE_ART,
    "DRONE_ART",
    ART_MODES,
    { true: "full", "1": "full", yes: "full", on: "full", false: "off", "0": "off", no: "off" },
    '"full", "compact", "minimal", or "off"',
    diagnostics,
  );
  if (mouse !== undefined) ui.mouse = mouse;
  if (mouseClicks !== undefined) ui.mouseClicks = mouseClicks;
  if (copyOnSelect !== undefined) ui.copyOnSelect = copyOnSelect;
  if (motion !== undefined) ui.motion = motion;
  if (art !== undefined) ui.art = art;
  const screen = parseEnvEnum(
    env.DRONE_SCREEN,
    "DRONE_SCREEN",
    SCREEN_MODES,
    {},
    '"alternate" or "split"',
    diagnostics,
  );
  if (screen !== undefined) ui.screen = screen;

  const allowShell = parseEnvBoolean(
    env.DRONE_ALLOW_SHELL,
    "DRONE_ALLOW_SHELL",
    diagnostics,
  );
  const allowWrites = parseEnvBoolean(
    env.DRONE_ALLOW_WRITES,
    "DRONE_ALLOW_WRITES",
    diagnostics,
  );
  const requireApproval = parseEnvBoolean(
    env.DRONE_REQUIRE_APPROVAL,
    "DRONE_REQUIRE_APPROVAL",
    diagnostics,
  );
  const maxOutputChars = parseEnvNumber(
    env.DRONE_MAX_OUTPUT_CHARS,
    "DRONE_MAX_OUTPUT_CHARS",
    diagnostics,
  );
  if (allowShell !== undefined) runtime.allowShell = allowShell;
  if (allowWrites !== undefined) runtime.allowWrites = allowWrites;
  if (requireApproval !== undefined) runtime.requireApproval = requireApproval;
  if (maxOutputChars !== undefined) runtime.maxOutputChars = maxOutputChars;

  if (Object.keys(ui).length > 0) layer.ui = ui;
  if (Object.keys(runtime).length > 0) layer.runtime = runtime;
  return layer;
}

function mergeConfig(base: DroneConfig, layer: DroneConfigOverrides): DroneConfig {
  return {
    ...base,
    ...layer,
    ui: { ...base.ui, ...layer.ui },
    runtime: { ...base.runtime, ...layer.runtime },
  };
}

export function getUserConfigPath(options: DroneConfigPathOptions = {}): string {
  if (options.userConfigPath) return options.userConfigPath;
  const env = options.env ?? process.env;
  const xdgConfigHome = env.XDG_CONFIG_HOME?.trim();
  const configHome = xdgConfigHome || join(options.homeDir ?? homedir(), ".config");
  return join(configHome, "drone", "config.json");
}

export function getProjectConfigPath(options: DroneConfigPathOptions = {}): string {
  if (options.projectConfigPath) return options.projectConfigPath;
  return join(options.cwd ?? process.cwd(), ".drone", "config.json");
}

export function getDroneConfigPaths(options: DroneConfigPathOptions = {}): DroneConfigPaths {
  return {
    user: getUserConfigPath(options),
    project: getProjectConfigPath(options),
  };
}

export function resolveDroneConfig(options: ResolveDroneConfigOptions = {}): ResolvedDroneConfig {
  const diagnostics: DroneConfigDiagnostic[] = [];
  const user = sanitizeLayer(options.user, "user", diagnostics);
  const project = sanitizeLayer(options.project, "project", diagnostics);
  const envLayer = envToLayer(options.env ?? process.env, diagnostics);
  const env = sanitizeLayer(envLayer, "environment", diagnostics);
  const overrides = sanitizeLayer(options.overrides, "overrides", diagnostics);

  let config = mergeConfig(
    {
      ...DEFAULT_DRONE_CONFIG,
      ui: { ...DEFAULT_DRONE_CONFIG.ui },
      runtime: { ...DEFAULT_DRONE_CONFIG.runtime },
    },
    user,
  );
  config = mergeConfig(config, project);
  config = mergeConfig(config, env);
  config = mergeConfig(config, overrides);
  return { config, diagnostics };
}

async function readConfigFile(
  path: string,
  source: "user" | "project",
  diagnostics: DroneConfigDiagnostic[],
): Promise<unknown> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return undefined;
    diagnostics.push({
      code: "read_error",
      source,
      path,
      message: `Could not read ${source} config at ${path}: ${errorMessage(error)}`,
    });
    return undefined;
  }

  try {
    return JSON.parse(contents) as unknown;
  } catch (error) {
    diagnostics.push({
      code: "parse_error",
      source,
      path,
      message: `Ignored malformed ${source} config at ${path}: ${errorMessage(error)}`,
    });
    return undefined;
  }
}

export async function loadDroneConfig(
  options: LoadDroneConfigOptions = {},
): Promise<LoadedDroneConfig> {
  const paths = getDroneConfigPaths(options);
  const diagnostics: DroneConfigDiagnostic[] = [];
  const [user, project] = await Promise.all([
    readConfigFile(paths.user, "user", diagnostics),
    readConfigFile(paths.project, "project", diagnostics),
  ]);
  const resolved = resolveDroneConfig({ user, project, env: options.env, overrides: options.overrides });
  return {
    config: resolved.config,
    diagnostics: [...diagnostics, ...resolved.diagnostics],
    paths,
  };
}

async function saveConfigFile(
  path: string,
  config: DroneConfigOverrides | unknown,
  source: "user" | "project",
): Promise<SavedDroneConfig> {
  const diagnostics: DroneConfigDiagnostic[] = [];
  const sanitized = sanitizeLayer(config, source, diagnostics);
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(sanitized, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, path);
  return { path, config: sanitized, diagnostics };
}

export async function saveUserConfig(
  config: DroneConfigOverrides | unknown,
  options: SaveDroneConfigOptions = {},
): Promise<SavedDroneConfig> {
  return saveConfigFile(getUserConfigPath(options), config, "user");
}

export async function saveProjectConfig(
  config: DroneConfigOverrides | unknown,
  options: SaveDroneConfigOptions = {},
): Promise<SavedDroneConfig> {
  return saveConfigFile(getProjectConfigPath(options), config, "project");
}

export function formatDroneConfigDiagnostics(
  diagnostics: readonly DroneConfigDiagnostic[],
): string[] {
  return diagnostics.map((diagnostic) => `drone config: ${diagnostic.message}`);
}
