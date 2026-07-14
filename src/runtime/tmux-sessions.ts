import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";

const SESSION_PREFIX = "drone-";
const SESSION_MARKER_OPTION = "@drone_workspace_key";
const WINDOW_NAME_OPTION = "@drone_agent_name";
const DEFAULT_COMMAND_TIMEOUT_MS = 5_000;
const DEFAULT_CAPTURE_HISTORY_LINES = 2_000;
const DEFAULT_CAPTURE_MAX_CHARS = 200_000;
const DEFAULT_INPUT_MAX_BYTES = 64 * 1024;
const MAX_CAPTURE_HISTORY_LINES = 20_000;
const MAX_CAPTURE_CHARS = 1_000_000;
const MAX_AGENT_NAME_CHARS = 64;
const MAX_INITIAL_COMMAND_CHARS = 8_192;
const MAX_PROTOCOL_OUTPUT_BYTES = 2 * 1024 * 1024;
const TMUX_WINDOW_ID = /^@(0|[1-9][0-9]*)$/;
const MAX_CREATE_ATTEMPTS = 8;

export const TMUX_AGENT_WINDOW_SLOTS = [10_000, 10_001, 10_002, 10_003] as const;
export const MAX_TMUX_AGENTS = TMUX_AGENT_WINDOW_SLOTS.length;

export interface TmuxCommandRequest {
  executable: string;
  args: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs: number;
  maxOutputBytes: number;
  abortSignal?: AbortSignal;
}

export interface TmuxCommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
}

export interface TmuxCommandExecutor {
  execute(request: TmuxCommandRequest): Promise<TmuxCommandResult>;
}

export interface TmuxSessionManagerOptions {
  cwd: string;
  executable?: string;
  executor?: TmuxCommandExecutor;
  env?: NodeJS.ProcessEnv;
  commandTimeoutMs?: number;
  maxCaptureChars?: number;
  maxCaptureHistoryLines?: number;
  maxInputBytes?: number;
  abortSignal?: AbortSignal;
}

export interface CreateTmuxAgentInput {
  name: string;
  cwd?: string;
  /** A single shell line to paste after creating the window. The user shell is always the process. */
  command?: string;
}

export interface TmuxAgentSession {
  id: string;
  index: number;
  name: string;
  active: boolean;
  dead: boolean;
  currentCommand: string;
}

type TmuxWindowRecord = Omit<TmuxAgentSession, "name"> & { name?: string };

export interface CaptureTmuxAgentOptions {
  historyLines?: number;
  maxChars?: number;
}

export interface TmuxAgentCapture {
  id: string;
  text: string;
  truncated: boolean;
  capturedAt: number;
}

export interface SendTmuxInputOptions {
  enter?: boolean;
}

export type TmuxRuntimeErrorCode =
  | "TMUX_UNAVAILABLE"
  | "TMUX_COMMAND_FAILED"
  | "TMUX_SESSION_COLLISION"
  | "TMUX_AGENT_NOT_FOUND"
  | "TMUX_AGENT_LIMIT"
  | "TMUX_AGENT_NAME_CONFLICT"
  | "TMUX_ABORTED"
  | "TMUX_INVALID_INPUT";

export class TmuxRuntimeError extends Error {
  readonly code: TmuxRuntimeErrorCode;

  constructor(code: TmuxRuntimeErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TmuxRuntimeError";
    this.code = code;
  }
}

export class TmuxUnavailableError extends TmuxRuntimeError {
  constructor(executable: string, options?: ErrorOptions) {
    super(
      "TMUX_UNAVAILABLE",
      `tmux is unavailable at ${JSON.stringify(executable)}; install tmux or configure its executable`,
      options,
    );
    this.name = "TmuxUnavailableError";
  }
}

type BoundedBytes = {
  value: Buffer;
  truncated: boolean;
};

function appendBoundedTail(current: BoundedBytes, chunk: Buffer, maximum: number): BoundedBytes {
  if (chunk.length >= maximum) {
    return { value: chunk.subarray(chunk.length - maximum), truncated: true };
  }
  if (current.value.length + chunk.length <= maximum) {
    return { value: Buffer.concat([current.value, chunk]), truncated: current.truncated };
  }
  const keep = maximum - chunk.length;
  return {
    value: Buffer.concat([current.value.subarray(current.value.length - keep), chunk]),
    truncated: true,
  };
}

export function createTmuxCommandExecutor(): TmuxCommandExecutor {
  return {
    execute(request) {
      return new Promise<TmuxCommandResult>((resolve, reject) => {
        const child = spawn(request.executable, [...request.args], {
          cwd: request.cwd,
          env: request.env,
          shell: false,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
          signal: request.abortSignal,
        });
        let stdout: BoundedBytes = { value: Buffer.alloc(0), truncated: false };
        let stderr: BoundedBytes = { value: Buffer.alloc(0), truncated: false };
        let timedOut = false;
        let settled = false;
        let forceKillTimer: NodeJS.Timeout | undefined;

        const timeout = setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 500);
          forceKillTimer.unref();
        }, request.timeoutMs);
        timeout.unref();

        child.stdout.on("data", (chunk: Buffer) => {
          stdout = appendBoundedTail(stdout, chunk, request.maxOutputBytes);
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr = appendBoundedTail(stderr, chunk, request.maxOutputBytes);
        });
        child.once("error", (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          if (forceKillTimer) clearTimeout(forceKillTimer);
          reject(error);
        });
        child.once("close", (exitCode, signal) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          if (forceKillTimer) clearTimeout(forceKillTimer);
          resolve({
            exitCode,
            signal,
            stdout: stdout.value.toString("utf8"),
            stderr: stderr.value.toString("utf8"),
            stdoutTruncated: stdout.truncated,
            stderrTruncated: stderr.truncated,
            timedOut,
          });
        });

        child.stdin.on("error", () => {
          // The close event owns command failure reporting (for example EPIPE).
        });
        child.stdin.end(request.stdin ?? "");
      });
    },
  };
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw new TmuxRuntimeError("TMUX_INVALID_INPUT", `${name} must be a positive integer`);
  }
  return value;
}

function cappedPositiveInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: string,
): number {
  const resolved = positiveInteger(value, fallback, name);
  if (resolved > maximum) {
    throw new TmuxRuntimeError("TMUX_INVALID_INPUT", `${name} must be at most ${maximum}`);
  }
  return resolved;
}

function isExecutableMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

function tailByCodeUnits(value: string, maximum: number): { value: string; truncated: boolean } {
  if (value.length <= maximum) return { value, truncated: false };
  let start = value.length - maximum;
  const first = value.charCodeAt(start);
  if (first >= 0xdc00 && first <= 0xdfff) start += 1;
  return { value: value.slice(start), truncated: true };
}

function skipUntilStringTerminator(value: string, index: number, allowBell: boolean): number {
  for (let cursor = index; cursor < value.length; cursor += 1) {
    const code = value.charCodeAt(cursor);
    if (allowBell && code === 0x07) return cursor + 1;
    if (code === 0x9c) return cursor + 1;
    if (code === 0x1b && value.charCodeAt(cursor + 1) === 0x5c) return cursor + 2;
  }
  return value.length;
}

function skipControlSequence(value: string, index: number): number {
  const introducer = value.charCodeAt(index);
  const next = value.charCodeAt(index + 1);

  if (introducer === 0x1b) {
    if (next === 0x5b) {
      for (let cursor = index + 2; cursor < value.length; cursor += 1) {
        const code = value.charCodeAt(cursor);
        if (code >= 0x40 && code <= 0x7e) return cursor + 1;
      }
      return value.length;
    }
    if (next === 0x5d) {
      return skipUntilStringTerminator(value, index + 2, true);
    }
    if (next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) {
      return skipUntilStringTerminator(value, index + 2, false);
    }
    return Math.min(value.length, index + 2);
  }

  if (introducer === 0x9b) {
    for (let cursor = index + 1; cursor < value.length; cursor += 1) {
      const code = value.charCodeAt(cursor);
      if (code >= 0x40 && code <= 0x7e) return cursor + 1;
    }
    return value.length;
  }
  if (introducer === 0x9d || introducer === 0x90 || introducer === 0x98) {
    return skipUntilStringTerminator(value, index + 1, introducer === 0x9d);
  }
  return index + 1;
}

function isInvisibleDirectionControl(codePoint: number): boolean {
  return (
    codePoint === 0x061c ||
    codePoint === 0x200b ||
    codePoint === 0x200e ||
    codePoint === 0x200f ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2060 && codePoint <= 0x2069) ||
    codePoint === 0xfeff
  );
}

/** Remove terminal control sequences before pane output is rendered by a parent TUI. */
export function sanitizeTmuxOutput(value: string, maxChars = DEFAULT_CAPTURE_MAX_CHARS): string {
  const output: string[] = [];
  for (let index = 0; index < value.length; ) {
    const code = value.charCodeAt(index);
    if (
      code === 0x1b ||
      code === 0x9b ||
      code === 0x9d ||
      code === 0x90 ||
      code === 0x98
    ) {
      index = skipControlSequence(value, index);
      continue;
    }
    if (code === 0x0d) {
      if (value.charCodeAt(index + 1) !== 0x0a) output.push("\n");
      index += 1;
      continue;
    }
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a) || (code >= 0x7f && code <= 0x9f)) {
      index += 1;
      continue;
    }
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) break;
    if (!isInvisibleDirectionControl(codePoint)) output.push(String.fromCodePoint(codePoint));
    index += codePoint > 0xffff ? 2 : 1;
  }
  return tailByCodeUnits(output.join(""), maxChars).value;
}

function canonicalWorkspacePath(cwd: string): string {
  return realpathSync(path.resolve(cwd));
}

function workspaceKey(canonicalCwd: string): string {
  return createHash("sha256")
    .update("drone-tmux-workspace\0", "utf8")
    .update(canonicalCwd, "utf8")
    .digest("hex");
}

export function getTmuxWorkspaceSessionName(cwd: string): string {
  return `${SESSION_PREFIX}${workspaceKey(canonicalWorkspacePath(cwd)).slice(0, 24)}`;
}

function normalizeAgentName(name: string): string {
  if (typeof name !== "string") {
    throw new TmuxRuntimeError("TMUX_INVALID_INPUT", "agent name must be a string");
  }
  const sanitized = sanitizeTmuxOutput(name.normalize("NFKC"), MAX_AGENT_NAME_CHARS)
    .replace(/[\t\r\n:]/g, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_AGENT_NAME_CHARS);
  if (!sanitized) {
    throw new TmuxRuntimeError("TMUX_INVALID_INPUT", "agent name must contain visible characters");
  }
  return sanitized;
}

function agentNameKey(name: string): string {
  return normalizeAgentName(name).toLocaleLowerCase("en-US");
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function describeFailure(result: TmuxCommandResult): string {
  if (result.timedOut) return "command timed out";
  const detail = sanitizeTmuxOutput(result.stderr || result.stdout, 500).trim();
  if (detail) return detail;
  if (result.signal) return `terminated by ${result.signal}`;
  return `exited with status ${result.exitCode ?? "unknown"}`;
}

export class TmuxSessionManager {
  readonly cwd: string;
  readonly sessionName: string;
  readonly workspaceKey: string;

  private readonly executable: string;
  private readonly executor: TmuxCommandExecutor;
  private readonly env: NodeJS.ProcessEnv | undefined;
  private readonly commandTimeoutMs: number;
  private readonly maxCaptureChars: number;
  private readonly maxCaptureHistoryLines: number;
  private readonly maxInputBytes: number;
  private readonly abortSignal: AbortSignal | undefined;

  constructor(options: TmuxSessionManagerOptions) {
    this.cwd = canonicalWorkspacePath(options.cwd);
    this.workspaceKey = workspaceKey(this.cwd);
    this.sessionName = `${SESSION_PREFIX}${this.workspaceKey.slice(0, 24)}`;
    this.executable = options.executable ?? "tmux";
    this.executor = options.executor ?? createTmuxCommandExecutor();
    this.env = options.env;
    this.commandTimeoutMs = positiveInteger(
      options.commandTimeoutMs,
      DEFAULT_COMMAND_TIMEOUT_MS,
      "commandTimeoutMs",
    );
    this.maxCaptureChars = cappedPositiveInteger(
      options.maxCaptureChars,
      DEFAULT_CAPTURE_MAX_CHARS,
      MAX_CAPTURE_CHARS,
      "maxCaptureChars",
    );
    this.maxCaptureHistoryLines = cappedPositiveInteger(
      options.maxCaptureHistoryLines,
      DEFAULT_CAPTURE_HISTORY_LINES,
      MAX_CAPTURE_HISTORY_LINES,
      "maxCaptureHistoryLines",
    );
    this.maxInputBytes = cappedPositiveInteger(
      options.maxInputBytes,
      DEFAULT_INPUT_MAX_BYTES,
      DEFAULT_INPUT_MAX_BYTES,
      "maxInputBytes",
    );
    this.abortSignal = options.abortSignal;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const result = await this.execute(["-V"], MAX_PROTOCOL_OUTPUT_BYTES);
      return result.exitCode === 0 && !result.timedOut;
    } catch (error) {
      if (error instanceof TmuxUnavailableError) return false;
      throw error;
    }
  }

  async list(): Promise<TmuxAgentSession[]> {
    if (!(await this.sessionExists())) return [];
    await this.assertOwnedSession();
    return (await this.listWindowRecords()).filter(
      (window): window is TmuxAgentSession =>
        window.name !== undefined &&
        TMUX_AGENT_WINDOW_SLOTS.includes(
          window.index as (typeof TMUX_AGENT_WINDOW_SLOTS)[number],
        ),
    );
  }

  private async listWindowRecords(): Promise<TmuxWindowRecord[]> {
    const format = [
      "#{window_id}",
      "#{window_index}",
      "#{window_active}",
      "#{pane_dead}",
      "#{pane_current_command}",
      `#{${WINDOW_NAME_OPTION}}`,
    ].join("\t");
    const result = await this.executeChecked(
      ["list-windows", "-t", this.sessionName, "-F", format],
      MAX_PROTOCOL_OUTPUT_BYTES,
      "list agent windows",
    );
    if (result.stdoutTruncated) {
      throw new TmuxRuntimeError("TMUX_COMMAND_FAILED", "tmux window list exceeded its safe limit");
    }

    return result.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const fields = line.split("\t");
        const [id, rawIndex, active, dead, currentCommand, ...nameFields] = fields;
        const index = Number(rawIndex);
        if (
          !id ||
          !TMUX_WINDOW_ID.test(id) ||
          !rawIndex?.match(/^(0|[1-9][0-9]*)$/) ||
          !Number.isSafeInteger(index) ||
          nameFields.length === 0
        ) {
          throw new TmuxRuntimeError("TMUX_COMMAND_FAILED", "tmux returned a malformed window list");
        }
        const rawName = nameFields.join(" ");
        return {
          id,
          index,
          active: active === "1",
          dead: dead === "1",
          currentCommand: sanitizeTmuxOutput(currentCommand ?? "", 128).trim(),
          ...(rawName.trim() ? { name: normalizeAgentName(rawName) } : {}),
        };
      });
  }

  async create(input: CreateTmuxAgentInput): Promise<TmuxAgentSession> {
    const name = normalizeAgentName(input.name);
    const requestedCwd = await realpath(
      input.cwd === undefined ? this.cwd : path.resolve(this.cwd, input.cwd),
    );
    if (!isWithin(this.cwd, requestedCwd)) {
      throw new TmuxRuntimeError("TMUX_INVALID_INPUT", "agent cwd must remain inside the workspace");
    }
    if (input.command !== undefined) {
      if (
        typeof input.command !== "string" ||
        input.command.length > MAX_INITIAL_COMMAND_CHARS ||
        /[\0\r\n]/.test(input.command)
      ) {
        throw new TmuxRuntimeError(
          "TMUX_INVALID_INPUT",
          `initial command must be one line of at most ${MAX_INITIAL_COMMAND_CHARS} characters`,
        );
      }
    }

    const id = await this.reserveAgentWindow(name, requestedCwd);

    try {
      if (input.command !== undefined) {
        await this.sendInput(id, input.command, { enter: true });
      }
      const created = (await this.list()).find((agent) => agent.id === id);
      if (!created) {
        throw new TmuxRuntimeError("TMUX_COMMAND_FAILED", "created tmux window disappeared");
      }
      return created;
    } catch (error) {
      await this.killCreatedWindowBestEffort(id);
      throw error;
    }
  }

  async capture(id: string, options: CaptureTmuxAgentOptions = {}): Promise<TmuxAgentCapture> {
    await this.requireOwnedWindow(id);
    const historyLines = cappedPositiveInteger(
      options.historyLines,
      this.maxCaptureHistoryLines,
      this.maxCaptureHistoryLines,
      "historyLines",
    );
    const maxChars = cappedPositiveInteger(
      options.maxChars,
      this.maxCaptureChars,
      this.maxCaptureChars,
      "maxChars",
    );
    const result = await this.executeChecked(
      ["capture-pane", "-p", "-t", id, "-S", `-${historyLines}`],
      Math.min(MAX_PROTOCOL_OUTPUT_BYTES, Math.max(64 * 1024, maxChars * 4)),
      `capture agent ${id}`,
    );
    const fullSanitized = sanitizeTmuxOutput(result.stdout, MAX_CAPTURE_CHARS);
    const bounded = tailByCodeUnits(fullSanitized, maxChars);
    return {
      id,
      text: bounded.value,
      truncated: result.stdoutTruncated || bounded.truncated,
      capturedAt: Date.now(),
    };
  }

  async sendInput(id: string, text: string, options: SendTmuxInputOptions = {}): Promise<void> {
    await this.requireOwnedWindow(id);
    if (typeof text !== "string" || text.includes("\0")) {
      throw new TmuxRuntimeError("TMUX_INVALID_INPUT", "agent input must be NUL-free text");
    }
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > this.maxInputBytes) {
      throw new TmuxRuntimeError(
        "TMUX_INVALID_INPUT",
        `agent input must be at most ${this.maxInputBytes} UTF-8 bytes`,
      );
    }

    const bufferName = `drone-${process.pid}-${randomUUID()}`;
    try {
      await this.executeChecked(
        ["load-buffer", "-b", bufferName, "-"],
        MAX_PROTOCOL_OUTPUT_BYTES,
        "load private input buffer",
        text,
      );
      await this.executeChecked(
        ["paste-buffer", "-d", "-b", bufferName, "-t", id],
        MAX_PROTOCOL_OUTPUT_BYTES,
        `paste input into agent ${id}`,
      );
      if (options.enter ?? true) {
        await this.executeChecked(
          ["send-keys", "-t", id, "Enter"],
          MAX_PROTOCOL_OUTPUT_BYTES,
          `submit input to agent ${id}`,
        );
      }
    } catch (error) {
      await this.deleteBufferBestEffort(bufferName);
      throw error;
    }
  }

  async interrupt(id: string): Promise<void> {
    await this.requireOwnedWindow(id);
    await this.executeChecked(
      ["send-keys", "-t", id, "C-c"],
      MAX_PROTOCOL_OUTPUT_BYTES,
      `interrupt agent ${id}`,
    );
  }

  async close(id: string): Promise<boolean> {
    const agent = await this.findOwnedWindow(id);
    if (!agent) return false;
    await this.executeChecked(
      [
        "set-option",
        "-t",
        this.sessionName,
        "renumber-windows",
        "off",
        ";",
        "set-option",
        "-t",
        this.sessionName,
        "destroy-unattached",
        "off",
        ";",
        "kill-window",
        "-t",
        id,
      ],
      MAX_PROTOCOL_OUTPUT_BYTES,
      `close agent ${id}`,
    );
    return true;
  }

  private async execute(
    args: readonly string[],
    maxOutputBytes: number,
    stdin?: string,
  ): Promise<TmuxCommandResult> {
    if (this.abortSignal?.aborted) {
      throw new TmuxRuntimeError("TMUX_ABORTED", "tmux operation was cancelled");
    }
    try {
      const result = await this.executor.execute({
        executable: this.executable,
        args,
        cwd: this.cwd,
        env: this.env,
        stdin,
        timeoutMs: this.commandTimeoutMs,
        maxOutputBytes,
        abortSignal: this.abortSignal,
      });
      if (this.abortSignal?.aborted) {
        throw new TmuxRuntimeError("TMUX_ABORTED", "tmux operation was cancelled");
      }
      return result;
    } catch (error) {
      if (isExecutableMissing(error)) throw new TmuxUnavailableError(this.executable, { cause: error });
      if (isAbortError(error) || this.abortSignal?.aborted) {
        throw new TmuxRuntimeError("TMUX_ABORTED", "tmux operation was cancelled", { cause: error });
      }
      throw error;
    }
  }

  private async executeChecked(
    args: readonly string[],
    maxOutputBytes: number,
    operation: string,
    stdin?: string,
  ): Promise<TmuxCommandResult> {
    const result = await this.execute(args, maxOutputBytes, stdin);
    if (result.exitCode !== 0 || result.timedOut) {
      throw new TmuxRuntimeError(
        "TMUX_COMMAND_FAILED",
        `unable to ${operation}: ${describeFailure(result)}`,
      );
    }
    return result;
  }

  private async deleteBufferBestEffort(bufferName: string): Promise<void> {
    try {
      await this.executor.execute({
        executable: this.executable,
        args: ["delete-buffer", "-b", bufferName],
        cwd: this.cwd,
        env: this.env,
        timeoutMs: this.commandTimeoutMs,
        maxOutputBytes: MAX_PROTOCOL_OUTPUT_BYTES,
        // Cleanup must outlive a cancelled TUI lifecycle so secrets cannot be
        // stranded in tmux's server-global paste buffer.
        abortSignal: undefined,
      });
    } catch {
      // Bounded best effort only; preserve the original input/abort failure.
    }
  }

  private async sessionExists(): Promise<boolean> {
    const result = await this.execute(
      ["has-session", "-t", this.sessionName],
      MAX_PROTOCOL_OUTPUT_BYTES,
    );
    if (result.exitCode === 0 && !result.timedOut) return true;
    if (result.exitCode === 1 && !result.timedOut) return false;
    throw new TmuxRuntimeError(
      "TMUX_COMMAND_FAILED",
      `unable to inspect workspace tmux session: ${describeFailure(result)}`,
    );
  }

  private async assertOwnedSession(): Promise<void> {
    const result = await this.execute(
      ["show-options", "-v", "-t", this.sessionName, SESSION_MARKER_OPTION],
      MAX_PROTOCOL_OUTPUT_BYTES,
    );
    if (
      result.exitCode !== 0 ||
      result.timedOut ||
      result.stdoutTruncated ||
      result.stdout.trim() !== this.workspaceKey
    ) {
      throw new TmuxRuntimeError(
        "TMUX_SESSION_COLLISION",
        `tmux session ${this.sessionName} is not owned by this Drone workspace`,
      );
    }
    await this.executeChecked(
      [
        "set-option",
        "-t",
        this.sessionName,
        "renumber-windows",
        "off",
        ";",
        "set-option",
        "-t",
        this.sessionName,
        "destroy-unattached",
        "off",
      ],
      MAX_PROTOCOL_OUTPUT_BYTES,
      "enforce persistent tmux session options for this workspace",
    );
  }

  private async reserveAgentWindow(name: string, cwd: string): Promise<string> {
    const requestedNameKey = agentNameKey(name);

    for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt += 1) {
      const exists = await this.sessionExists();
      let records: TmuxWindowRecord[] = [];
      let excludedFirstIndex: number | undefined;
      if (exists) {
        await this.assertOwnedSession();
        records = await this.listWindowRecords();
      } else {
        excludedFirstIndex = await this.readGlobalBaseIndex();
      }

      const agents = records.filter(
        (window): window is TmuxAgentSession => window.name !== undefined,
      );
      if (agents.some((agent) => agentNameKey(agent.name) === requestedNameKey)) {
        throw new TmuxRuntimeError(
          "TMUX_AGENT_NAME_CONFLICT",
          `an agent named ${JSON.stringify(name)} already exists in this workspace`,
        );
      }

      const occupied = new Set(records.map((window) => window.index));
      const slot = TMUX_AGENT_WINDOW_SLOTS.find(
        (candidate) => !occupied.has(candidate) && candidate !== excludedFirstIndex,
      );
      if (slot === undefined) {
        throw new TmuxRuntimeError(
          "TMUX_AGENT_LIMIT",
          `this workspace already has the maximum of ${MAX_TMUX_AGENTS} agents`,
        );
      }

      const result = await this.execute(
        exists
          ? this.createWindowQueue(name, cwd, slot)
          : this.createSessionQueue(name, cwd, slot),
        MAX_PROTOCOL_OUTPUT_BYTES,
      );
      if (result.exitCode === 0 && !result.timedOut) {
        return this.parseCreatedWindowId(result);
      }
      if (result.timedOut) {
        throw new TmuxRuntimeError(
          "TMUX_COMMAND_FAILED",
          `unable to reserve an agent window: ${describeFailure(result)}`,
        );
      }

      // Another process may have claimed the session or slot after our list.
      // Relisting is the lock-free arbitration step; deterministic slot order
      // makes same-name contenders observe one winner on their next attempt.
      if (!(await this.sessionExists())) {
        throw new TmuxRuntimeError(
          "TMUX_COMMAND_FAILED",
          `unable to reserve an agent window: ${describeFailure(result)}`,
        );
      }
      await this.assertOwnedSession();
    }

    throw new TmuxRuntimeError(
      "TMUX_COMMAND_FAILED",
      "unable to reserve an agent window after concurrent tmux updates",
    );
  }

  private createSessionQueue(name: string, cwd: string, slot: number): readonly string[] {
    const target = `${this.sessionName}:${slot}`;
    return [
      "new-session",
      "-d",
      "-P",
      "-F",
      "#{window_id}",
      "-s",
      this.sessionName,
      "-n",
      name,
      "-c",
      cwd,
      ";",
      "set-option",
      "-t",
      this.sessionName,
      SESSION_MARKER_OPTION,
      this.workspaceKey,
      ";",
      "set-option",
      "-t",
      this.sessionName,
      "renumber-windows",
      "off",
      ";",
      "set-option",
      "-t",
      this.sessionName,
      "destroy-unattached",
      "off",
      ";",
      "move-window",
      "-s",
      `${this.sessionName}:`,
      "-t",
      target,
      ";",
      ...this.configureWindowQueue(target, name),
    ];
  }

  private createWindowQueue(name: string, cwd: string, slot: number): readonly string[] {
    const target = `${this.sessionName}:${slot}`;
    return [
      "new-window",
      "-d",
      "-P",
      "-F",
      "#{window_id}",
      "-t",
      target,
      "-n",
      name,
      "-c",
      cwd,
      ";",
      ...this.configureWindowQueue(target, name),
    ];
  }

  private configureWindowQueue(target: string, name: string): readonly string[] {
    return [
      "set-window-option",
      "-t",
      target,
      "automatic-rename",
      "off",
      ";",
      "set-window-option",
      "-t",
      target,
      "allow-rename",
      "off",
      ";",
      "set-option",
      "-w",
      "-t",
      target,
      WINDOW_NAME_OPTION,
      name,
    ];
  }

  private async readGlobalBaseIndex(): Promise<number> {
    const result = await this.execute(
      ["show-options", "-g", "-v", "base-index"],
      MAX_PROTOCOL_OUTPUT_BYTES,
    );
    if (result.exitCode !== 0 || result.timedOut || result.stdoutTruncated) return 0;
    const parsed = Number(result.stdout.trim());
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
  }

  private parseCreatedWindowId(result: TmuxCommandResult): string {
    if (result.stdoutTruncated) {
      throw new TmuxRuntimeError("TMUX_COMMAND_FAILED", "tmux returned an oversized window id");
    }
    const id = result.stdout.trim();
    if (!TMUX_WINDOW_ID.test(id)) {
      throw new TmuxRuntimeError("TMUX_COMMAND_FAILED", "tmux returned an invalid window id");
    }
    return id;
  }

  private assertWindowId(id: string): void {
    if (!TMUX_WINDOW_ID.test(id)) {
      throw new TmuxRuntimeError("TMUX_INVALID_INPUT", "invalid tmux agent id");
    }
  }

  private async findOwnedWindow(id: string): Promise<TmuxAgentSession | undefined> {
    this.assertWindowId(id);
    return (await this.list()).find((agent) => agent.id === id);
  }

  private async requireOwnedWindow(id: string): Promise<TmuxAgentSession> {
    const agent = await this.findOwnedWindow(id);
    if (!agent) {
      throw new TmuxRuntimeError("TMUX_AGENT_NOT_FOUND", `tmux agent ${id} was not found`);
    }
    return agent;
  }

  private async killCreatedWindowBestEffort(id: string): Promise<void> {
    try {
      this.assertWindowId(id);
      if (!(await this.sessionExists())) return;
      await this.assertOwnedSession();
      await this.execute(["kill-window", "-t", id], MAX_PROTOCOL_OUTPUT_BYTES);
    } catch {
      // Preserve the original create error. The id came directly from the owned create call.
    }
  }
}

export function createTmuxSessionManager(options: TmuxSessionManagerOptions): TmuxSessionManager {
  return new TmuxSessionManager(options);
}
