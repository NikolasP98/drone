import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { constants, realpathSync } from "node:fs";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type {
  DroneEventInput,
  DroneHost,
  DroneModelSpec,
  DroneSkillFilter,
  DroneToolContext,
  DroneToolDef,
} from "../types.js";

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_MAX_READ_BYTES = 256 * 1024;
const DEFAULT_MAX_LIST_ENTRIES = 500;
const DEFAULT_MAX_SEARCH_RESULTS = 200;

const SENSITIVE_ENV_NAME =
  /(?:^|_)(?:API_?KEY|KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|AUTH(?:ORIZATION)?|PAT)(?:$|_)/i;

const SAFE_ENV_TEMPLATES = new Set([".env.example", ".env.sample", ".env.template"]);
const SENSITIVE_CREDENTIAL_FILES = new Set([
  ".envrc",
  ".git-credentials",
  ".netrc",
  ".npmrc",
  ".pypirc",
  "application_default_credentials.json",
  "auth.json",
  "credentials",
  "credentials.json",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_rsa",
  "secrets.json",
  "service-account.json",
  "service_account.json",
]);
const SENSITIVE_CREDENTIAL_EXTENSIONS = new Set([".key", ".p12", ".pem", ".pfx"]);

const PROVIDER_API_KEYS: Readonly<Record<string, readonly string[]>> = {
  anthropic: ["ANTHROPIC_API_KEY"],
  azure: ["AZURE_OPENAI_API_KEY"],
  "azure-openai": ["AZURE_OPENAI_API_KEY"],
  "azure-openai-responses": ["AZURE_OPENAI_API_KEY"],
  cerebras: ["CEREBRAS_API_KEY"],
  "cloudflare-ai-gateway": ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_KEY"],
  "cloudflare-workers-ai": ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_KEY"],
  cohere: ["COHERE_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  fireworks: ["FIREWORKS_API_KEY"],
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  "github-copilot": ["GITHUB_TOKEN"],
  google: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
  "google-vertex": ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
  groq: ["GROQ_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  minimax: ["MINIMAX_API_KEY"],
  "minimax-cn": ["MINIMAX_API_KEY"],
  moonshotai: ["MOONSHOT_API_KEY"],
  "moonshotai-cn": ["MOONSHOT_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  "openai-codex": ["OPENAI_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  together: ["TOGETHER_API_KEY"],
  "vercel-ai-gateway": ["AI_GATEWAY_API_KEY"],
  xai: ["XAI_API_KEY"],
  zai: ["ZAI_API_KEY"],
};

export type ApprovalRequest = {
  kind: "write_file" | "run_command";
  cwd: string;
  path?: string;
  bytes?: number;
  command?: string;
  summary: string;
};

/** Descriptive alias retained for consumers that distinguish workspace approvals. */
export type WorkspaceApprovalRequest = ApprovalRequest;

export type WorkspaceApprovalCallback = (
  request: WorkspaceApprovalRequest,
) => Promise<boolean> | boolean;

export type WorkspaceToolsOptions = {
  cwd: string;
  /** Mutating operations are denied when this callback is omitted. */
  approve?: WorkspaceApprovalCallback;
  /** Omit write_file entirely when false. Defaults to true. */
  allowWrites?: boolean;
  /** Omit run_command entirely when false. Defaults to true. */
  allowShell?: boolean;
  /** Require approve() before mutations. Defaults to true. */
  requireApproval?: boolean;
  /** Base environment used by subprocesses. Defaults to process.env. */
  env?: Readonly<Record<string, string | undefined>>;
  commandTimeoutMs?: number;
  maxOutputBytes?: number;
  maxReadBytes?: number;
  maxListEntries?: number;
  maxSearchResults?: number;
  /** Secret-like environment variables are removed unless explicitly disabled. */
  sanitizeEnv?: boolean;
};

export type EnvironmentHostOptions = {
  cwd: string;
  /** Credential lookup environment. Defaults to process.env and is never mutated. */
  env?: Readonly<Record<string, string | undefined>>;
  skillsPrompt?: string;
  resolveSkillsPrompt?: (filter: DroneSkillFilter | undefined) => string;
  emitEvent?: (input: DroneEventInput) => void;
};

export type CommandResult = {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  truncated: boolean;
};

export type WorkspaceFileEntry = {
  path: string;
  type: "file" | "directory" | "symlink" | "other";
  size?: number;
};

type ProcessResult = Omit<CommandResult, "command">;

type ConfinedWorkspace = {
  root: string;
  resolveExisting(input: string): Promise<string>;
  resolveForWrite(input: string): Promise<string>;
  relative(input: string): string;
};

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function lexicalPath(root: string, input: string): string {
  if (input.includes("\0")) {
    throw new Error("workspace path contains a null byte");
  }
  const candidate = path.resolve(root, input || ".");
  if (!isWithin(root, candidate)) {
    throw new Error(`workspace path escapes cwd: ${input}`);
  }
  return candidate;
}

function createConfinedWorkspace(cwd: string): ConfinedWorkspace {
  const root = realpathSync(path.resolve(cwd));

  return {
    root,
    async resolveExisting(input: string): Promise<string> {
      const candidate = lexicalPath(root, input);
      const resolved = await realpath(candidate);
      if (!isWithin(root, resolved)) {
        throw new Error(`workspace path follows a symlink outside cwd: ${input}`);
      }
      return resolved;
    },
    async resolveForWrite(input: string): Promise<string> {
      const candidate = lexicalPath(root, input);
      let cursor = candidate;

      while (true) {
        try {
          const resolved = await realpath(cursor);
          if (!isWithin(root, resolved)) {
            throw new Error(`workspace path follows a symlink outside cwd: ${input}`);
          }
          break;
        } catch (error) {
          if (!isMissingPathError(error)) {
            throw error;
          }
          const parent = path.dirname(cursor);
          if (parent === cursor) {
            throw error;
          }
          cursor = parent;
        }
      }

      return candidate;
    },
    relative(input: string): string {
      const relative = path.relative(root, input);
      return relative === "" ? "." : relative.split(path.sep).join("/");
    },
  };
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function portablePath(input: string): string {
  return input.split(path.sep).join("/");
}

/** Keep credential material out of model-visible read and search results. */
function isSensitiveWorkspacePath(input: string): boolean {
  const normalized = portablePath(input).toLowerCase();
  const basename = path.posix.basename(normalized);
  if (SAFE_ENV_TEMPLATES.has(basename)) {
    return false;
  }
  if (basename === ".env" || basename.startsWith(".env.")) {
    return true;
  }
  if (SENSITIVE_CREDENTIAL_FILES.has(basename)) {
    return true;
  }
  return SENSITIVE_CREDENTIAL_EXTENSIONS.has(path.posix.extname(basename));
}

function assertReadableWorkspacePath(relative: string, operation: string): void {
  if (isSensitiveWorkspacePath(relative)) {
    throw new Error(`${operation} refuses sensitive credential path: ${relative}`);
  }
}

function requiredString(args: unknown, key: string): string {
  if (typeof args !== "object" || args === null) {
    throw new Error(`expected an object with string property "${key}"`);
  }
  const value = (args as Record<string, unknown>)[key];
  if (typeof value !== "string") {
    throw new Error(`expected "${key}" to be a string`);
  }
  return value;
}

function optionalString(args: unknown, key: string, fallback: string): string {
  if (typeof args !== "object" || args === null) {
    return fallback;
  }
  const value = (args as Record<string, unknown>)[key];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "string") {
    throw new Error(`expected "${key}" to be a string`);
  }
  return value;
}

function optionalInteger(
  args: unknown,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (typeof args !== "object" || args === null) {
    return fallback;
  }
  const value = (args as Record<string, unknown>)[key];
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || typeof value !== "number" || value < minimum || value > maximum) {
    throw new Error(`expected "${key}" to be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function optionalStringArray(args: unknown, key: string): string[] {
  if (typeof args !== "object" || args === null) {
    return [];
  }
  const value = (args as Record<string, unknown>)[key];
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error(`expected "${key}" to be an array of strings`);
  }
  return value;
}

async function ensureApproval(
  approve: WorkspaceApprovalCallback | undefined,
  request: WorkspaceApprovalRequest,
  abortSignal: AbortSignal | undefined,
): Promise<void> {
  throwIfAborted(abortSignal, request.kind);
  if (!approve) {
    throw new Error(`${request.kind} was not approved`);
  }
  const approval = Promise.resolve(approve(request));
  const approved = await waitForApprovalOrAbort(approval, abortSignal, request.kind);
  throwIfAborted(abortSignal, request.kind);
  if (!approved) throw new Error(`${request.kind} was not approved`);
}

function abortedOperationError(operation: string): Error {
  const error = new Error(`${operation} was aborted`);
  error.name = "AbortError";
  return error;
}

function throwIfAborted(abortSignal: AbortSignal | undefined, operation: string): void {
  if (abortSignal?.aborted) throw abortedOperationError(operation);
}

async function waitForApprovalOrAbort<T>(
  approval: Promise<T>,
  abortSignal: AbortSignal | undefined,
  operation: string,
): Promise<T> {
  if (!abortSignal) return await approval;
  throwIfAborted(abortSignal, operation);

  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortedOperationError(operation));
    const cleanup = (): void => abortSignal.removeEventListener("abort", onAbort);
    abortSignal.addEventListener("abort", onAbort, { once: true });
    approval.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

export function sanitizeEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  removeSensitive = true,
): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || (removeSensitive && SENSITIVE_ENV_NAME.test(name))) {
      continue;
    }
    sanitized[name] = value;
  }
  return sanitized;
}

function appendLimited(
  chunks: Buffer[],
  chunk: Buffer,
  remaining: number,
): { accepted: number; reachedLimit: boolean } {
  const accepted = Math.max(0, Math.min(chunk.byteLength, remaining));
  if (accepted > 0) {
    chunks.push(chunk.subarray(0, accepted));
  }
  return { accepted, reachedLimit: accepted < chunk.byteLength };
}

async function spawnCaptured(options: {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
  abortSignal?: AbortSignal;
}): Promise<ProcessResult> {
  if (options.abortSignal?.aborted) {
    return {
      stdout: "",
      stderr: "",
      exitCode: null,
      signal: null,
      timedOut: false,
      aborted: true,
      truncated: false,
    };
  }

  return await new Promise<ProcessResult>((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let capturedBytes = 0;
    let timedOut = false;
    let aborted = false;
    let truncated = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const child = spawn(options.executable, options.args, {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    const sendSignal = (signal: NodeJS.Signals): void => {
      if (child.pid && process.platform !== "win32") {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // Fall back to signaling the direct child if its process group is already gone.
        }
      }
      child.kill(signal);
    };

    const terminate = (): void => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      sendSignal("SIGTERM");
      killTimer ??= setTimeout(() => sendSignal("SIGKILL"), 250);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs);

    const onAbort = (): void => {
      aborted = true;
      terminate();
    };
    options.abortSignal?.addEventListener("abort", onAbort, { once: true });

    const capture = (destination: Buffer[], data: Buffer | string): void => {
      const chunk = typeof data === "string" ? Buffer.from(data) : data;
      const result = appendLimited(destination, chunk, options.maxOutputBytes - capturedBytes);
      capturedBytes += result.accepted;
      if (result.reachedLimit) {
        truncated = true;
        terminate();
      }
    };
    child.stdout.on("data", (data: Buffer | string) => capture(stdout, data));
    child.stderr.on("data", (data: Buffer | string) => capture(stderr, data));

    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (killTimer) {
        clearTimeout(killTimer);
      }
      options.abortSignal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (killTimer) {
        clearTimeout(killTimer);
      }
      options.abortSignal?.removeEventListener("abort", onAbort);
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode,
        signal,
        timedOut,
        aborted,
        truncated,
      });
    });
  });
}

async function collectFiles(options: {
  workspace: ConfinedWorkspace;
  absoluteRoot: string;
  maxDepth: number;
  maxEntries: number;
}): Promise<{ entries: WorkspaceFileEntry[]; truncated: boolean }> {
  const entries: WorkspaceFileEntry[] = [];
  let truncated = false;

  const visit = async (directory: string, depth: number): Promise<void> => {
    if (entries.length >= options.maxEntries) {
      truncated = true;
      return;
    }
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      if (entries.length >= options.maxEntries) {
        truncated = true;
        return;
      }
      const absolute = path.join(directory, child.name);
      const relative = options.workspace.relative(absolute);
      let type: WorkspaceFileEntry["type"] = "other";
      if (child.isDirectory()) {
        type = "directory";
      } else if (child.isFile()) {
        type = "file";
      } else if (child.isSymbolicLink()) {
        type = "symlink";
      }
      const entry: WorkspaceFileEntry = { path: relative, type };
      if (type === "file") {
        entry.size = (await stat(absolute)).size;
      }
      entries.push(entry);
      if (type === "directory" && depth < options.maxDepth) {
        await visit(absolute, depth + 1);
      }
    }
  };

  await visit(options.absoluteRoot, 0);
  return { entries, truncated };
}

async function fallbackSearch(options: {
  workspace: ConfinedWorkspace;
  absoluteRoot: string;
  query: string;
  globs: string[];
  maxResults: number;
  maxReadBytes: number;
}): Promise<Array<{ path: string; line: number; text: string }>> {
  const results: Array<{ path: string; line: number; text: string }> = [];
  const stack = [options.absoluteRoot];

  while (stack.length > 0 && results.length < options.maxResults) {
    const current = stack.pop();
    if (!current) {
      break;
    }
    const info = await lstat(current);
    if (info.isSymbolicLink()) {
      continue;
    }
    if (info.isDirectory()) {
      const children = await readdir(current);
      children.sort((left, right) => right.localeCompare(left));
      for (const child of children) {
        stack.push(path.join(current, child));
      }
      continue;
    }
    if (!info.isFile() || info.size > options.maxReadBytes) {
      continue;
    }
    const relative = options.workspace.relative(current);
    if (isSensitiveWorkspacePath(relative)) {
      continue;
    }
    if (options.globs.length > 0 && !options.globs.some((glob) => simpleGlobMatch(relative, glob))) {
      continue;
    }
    const content = await readFile(current, "utf8");
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length && results.length < options.maxResults; index += 1) {
      if (lines[index]?.includes(options.query)) {
        results.push({ path: relative, line: index + 1, text: lines[index] ?? "" });
      }
    }
  }

  return results;
}

function simpleGlobMatch(input: string, glob: string): boolean {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const source = escaped.replaceAll("**", "\0").replaceAll("*", "[^/]*").replaceAll("\0", ".*");
  return new RegExp(`^${source}$`).test(input);
}

function parseRipgrepOutput(
  output: string,
  workspace: ConfinedWorkspace,
): Array<{ path: string; line: number; text: string }> {
  const matches: Array<{ path: string; line: number; text: string }> = [];
  for (const row of output.split(/\r?\n/)) {
    if (!row) {
      continue;
    }
    const match = /^(.*?):(\d+):(.*)$/.exec(row);
    if (!match) {
      continue;
    }
    const [, file = "", line = "0", text = ""] = match;
    const relative = workspace.relative(path.resolve(workspace.root, file));
    if (isSensitiveWorkspacePath(relative)) {
      continue;
    }
    matches.push({
      path: relative,
      line: Number.parseInt(line, 10),
      text,
    });
  }
  return matches;
}

function baseEnvironment(
  env: Readonly<Record<string, string | undefined>> | undefined,
  sanitize: boolean,
): NodeJS.ProcessEnv {
  const result = sanitizeEnvironment(env ?? process.env, sanitize);
  delete result.BASH_ENV;
  delete result.ENV;
  for (const name of Object.keys(result)) {
    if (name.startsWith("BASH_FUNC_")) delete result[name];
  }
  return result;
}

async function writeAnchoredFile(
  workspace: ConfinedWorkspace,
  absolute: string,
  content: string,
  abortSignal?: AbortSignal,
): Promise<void> {
  if (process.platform !== "linux") {
    throw new Error(
      "write_file is disabled on this platform because descriptor-anchored path confinement is unavailable",
    );
  }

  const parentRelative = workspace.relative(path.dirname(absolute));
  const components = parentRelative === "." ? [] : parentRelative.split("/");
  let directory = await open(
    workspace.root,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );

  try {
    for (const component of components) {
      const anchoredParent = `/proc/self/fd/${directory.fd}`;
      const nextPath = path.join(anchoredParent, component);
      try {
        await mkdir(nextPath);
      } catch (error) {
        if (!isAlreadyExistsError(error)) throw error;
      }

      const nextDirectory = await open(
        nextPath,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      const previousDirectory = directory;
      directory = nextDirectory;
      await previousDirectory.close();
      const openedDirectory = await realpath(`/proc/self/fd/${directory.fd}`);
      if (!isWithin(workspace.root, openedDirectory)) {
        throw new Error("workspace write parent moved outside cwd");
      }
    }

    const anchoredParent = `/proc/self/fd/${directory.fd}`;
    const finalPath = path.join(anchoredParent, path.basename(absolute));
    let existingMode: number | undefined;
    try {
      const existing = await lstat(finalPath);
      if (existing.isSymbolicLink()) {
        throw new Error("workspace write target is a symbolic link");
      }
      if (!existing.isFile()) {
        throw new Error("workspace write target is not a regular file");
      }
      existingMode = existing.mode & 0o777;
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    }

    const temporaryPath = path.join(
      anchoredParent,
      `.drone-write-${process.pid}-${randomUUID()}.tmp`,
    );
    let temporaryExists = false;
    try {
      throwIfAborted(abortSignal, "write_file");
      const file = await open(
        temporaryPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        existingMode ?? 0o666,
      );
      temporaryExists = true;
      try {
        if (existingMode !== undefined) await file.chmod(existingMode);
        await file.writeFile(content, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }

      const openedDirectory = await realpath(`/proc/self/fd/${directory.fd}`);
      if (!isWithin(workspace.root, openedDirectory)) {
        throw new Error("workspace write parent moved outside cwd");
      }
      throwIfAborted(abortSignal, "write_file");
      await rename(temporaryPath, finalPath);
      temporaryExists = false;
    } finally {
      if (temporaryExists) {
        await unlink(temporaryPath).catch(() => undefined);
      }
    }
  } finally {
    await directory.close();
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "EEXIST"
  );
}

/** Build filesystem and shell tools confined to one workspace. */
export function createWorkspaceTools(options: WorkspaceToolsOptions): DroneToolDef[] {
  const workspace = createConfinedWorkspace(options.cwd);
  const timeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const maxReadBytes = options.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
  const maxListEntries = options.maxListEntries ?? DEFAULT_MAX_LIST_ENTRIES;
  const maxSearchResults = options.maxSearchResults ?? DEFAULT_MAX_SEARCH_RESULTS;
  const env = baseEnvironment(options.env, options.sanitizeEnv !== false);

  const listFiles: DroneToolDef = {
    name: "list_files",
    description: "List files and directories inside the current workspace.",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "Workspace-relative directory. Defaults to ." })),
      maxDepth: Type.Optional(Type.Integer({ minimum: 0, maximum: 10, default: 2 })),
    }),
    async execute(args: unknown): Promise<unknown> {
      const requested = optionalString(args, "path", ".");
      const maxDepth = optionalInteger(args, "maxDepth", 2, 0, 10);
      const absoluteRoot = await workspace.resolveExisting(requested);
      const info = await stat(absoluteRoot);
      if (!info.isDirectory()) {
        throw new Error(`list_files path is not a directory: ${requested}`);
      }
      const result = await collectFiles({
        workspace,
        absoluteRoot,
        maxDepth,
        maxEntries: maxListEntries,
      });
      return { root: workspace.relative(absoluteRoot), ...result };
    },
  };

  const readFileTool: DroneToolDef = {
    name: "read_file",
    description: "Read a UTF-8 text file inside the current workspace.",
    parameters: Type.Object({ path: Type.String({ description: "Workspace-relative file path." }) }),
    async execute(args: unknown): Promise<unknown> {
      const requested = requiredString(args, "path");
      const absolute = await workspace.resolveExisting(requested);
      assertReadableWorkspacePath(workspace.relative(absolute), "read_file");
      const info = await stat(absolute);
      if (!info.isFile()) {
        throw new Error(`read_file path is not a file: ${requested}`);
      }
      const bytes = await readFile(absolute);
      const truncated = bytes.byteLength > maxReadBytes;
      return {
        path: workspace.relative(absolute),
        content: bytes.subarray(0, maxReadBytes).toString("utf8"),
        size: bytes.byteLength,
        truncated,
      };
    },
  };

  const searchFiles: DroneToolDef = {
    name: "search_files",
    description: "Search for a fixed text string in workspace files.",
    parameters: Type.Object({
      query: Type.String({ minLength: 1 }),
      path: Type.Optional(Type.String({ description: "Workspace-relative search root. Defaults to ." })),
      globs: Type.Optional(Type.Array(Type.String(), { description: "Optional rg-style include globs." })),
      maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000 })),
    }),
    async execute(args: unknown, ctx: DroneToolContext): Promise<unknown> {
      const query = requiredString(args, "query");
      if (!query) {
        throw new Error("search query must not be empty");
      }
      const requested = optionalString(args, "path", ".");
      const globs = optionalStringArray(args, "globs");
      const maxResults = optionalInteger(args, "maxResults", maxSearchResults, 1, 1_000);
      const absoluteRoot = await workspace.resolveExisting(requested);
      assertReadableWorkspacePath(workspace.relative(absoluteRoot), "search_files");
      const info = await stat(absoluteRoot);
      if (!info.isDirectory() && !info.isFile()) {
        throw new Error(`search_files path is not searchable: ${requested}`);
      }

      const rgArgs = ["--line-number", "--no-heading", "--color", "never", "--fixed-strings"];
      for (const glob of globs) {
        rgArgs.push("--glob", glob);
      }
      rgArgs.push("--", query, workspace.relative(absoluteRoot));

      try {
        const result = await spawnCaptured({
          executable: "rg",
          args: rgArgs,
          cwd: workspace.root,
          env,
          timeoutMs,
          maxOutputBytes,
          abortSignal: ctx.abortSignal,
        });
        if (result.exitCode !== 0 && result.exitCode !== 1) {
          throw new Error(result.stderr.trim() || `rg exited with code ${String(result.exitCode)}`);
        }
        const allMatches = parseRipgrepOutput(result.stdout, workspace);
        const matches = allMatches.slice(0, maxResults);
        return {
          query,
          matches,
          truncated: result.truncated || allMatches.length > maxResults,
        };
      } catch (error) {
        if (!isExecutableMissingError(error)) {
          throw error;
        }
        const matches = await fallbackSearch({
          workspace,
          absoluteRoot,
          query,
          globs,
          maxResults,
          maxReadBytes,
        });
        return { query, matches, truncated: matches.length >= maxResults, engine: "fallback" };
      }
    },
  };

  const writeFileTool: DroneToolDef = {
    name: "write_file",
    description: "Write a UTF-8 file inside the workspace after explicit approval.",
    parameters: Type.Object({
      path: Type.String({ description: "Workspace-relative file path." }),
      content: Type.String(),
    }),
    async execute(args: unknown, ctx: DroneToolContext): Promise<unknown> {
      throwIfAborted(ctx.abortSignal, "write_file");
      const requested = requiredString(args, "path");
      const content = requiredString(args, "content");
      const absolute = await workspace.resolveForWrite(requested);
      const relative = workspace.relative(absolute);
      const bytes = Buffer.byteLength(content, "utf8");
      if (options.requireApproval !== false) {
        await ensureApproval(
          options.approve,
          {
            kind: "write_file",
            cwd: workspace.root,
            path: relative,
            bytes,
            summary: `Write ${bytes} bytes to ${relative}`,
          },
          ctx.abortSignal,
        );
      }
      throwIfAborted(ctx.abortSignal, "write_file");
      // Re-check after approval, then anchor the final open to the verified
      // parent directory and refuse to follow a final-component symlink.
      await workspace.resolveForWrite(requested);
      throwIfAborted(ctx.abortSignal, "write_file");
      await writeAnchoredFile(workspace, absolute, content, ctx.abortSignal);
      return { path: relative, bytes };
    },
  };

  const runCommand: DroneToolDef = {
    name: "run_command",
    description: "Run a bash command in the workspace after explicit approval.",
    parameters: Type.Object({ command: Type.String({ minLength: 1 }) }),
    async execute(args: unknown, ctx: DroneToolContext): Promise<unknown> {
      throwIfAborted(ctx.abortSignal, "run_command");
      const command = requiredString(args, "command");
      if (!command.trim()) {
        throw new Error("command must not be empty");
      }
      if (options.requireApproval !== false) {
        await ensureApproval(
          options.approve,
          {
            kind: "run_command",
            cwd: workspace.root,
            command,
            summary: `Run in ${workspace.root}: ${command}`,
          },
          ctx.abortSignal,
        );
      }
      throwIfAborted(ctx.abortSignal, "run_command");
      const result = await spawnCaptured({
        executable: "bash",
        args: ["--noprofile", "--norc", "-c", command],
        cwd: workspace.root,
        env,
        timeoutMs,
        maxOutputBytes,
        abortSignal: ctx.abortSignal,
      });
      return { command, ...result } satisfies CommandResult;
    },
  };

  const gitStatus: DroneToolDef = {
    name: "git_status",
    description: "Read the current workspace git status without modifying it.",
    parameters: Type.Object({}),
    async execute(_args: unknown, ctx: DroneToolContext): Promise<unknown> {
      const result = await spawnCaptured({
        executable: "git",
        args: ["status", "--short", "--branch"],
        cwd: workspace.root,
        env,
        timeoutMs,
        maxOutputBytes,
        abortSignal: ctx.abortSignal,
      });
      return {
        status: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        aborted: result.aborted,
        truncated: result.truncated,
      };
    },
  };

  return [
    listFiles,
    readFileTool,
    searchFiles,
    ...(options.allowWrites === false ? [] : [writeFileTool]),
    ...(options.allowShell === false ? [] : [runCommand]),
    gitStatus,
  ];
}

function isExecutableMissingError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) {
      continue;
    }
    const [, name = "", rawValue = ""] = match;
    let value = rawValue.trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1).replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t");
    } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    result[name] = value;
  }
  return result;
}

function providerKeyNames(provider: string): string[] {
  const normalized = provider.trim().toLowerCase();
  const known = PROVIDER_API_KEYS[normalized];
  if (known) {
    return [...known];
  }
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(normalized)) {
    return [];
  }
  return [`${normalized.replace(/[^a-z0-9]+/g, "_").toUpperCase()}_API_KEY`];
}

async function readWorkspaceEnv(workspace: ConfinedWorkspace): Promise<Record<string, string>> {
  try {
    const envPath = await workspace.resolveExisting(".env");
    return parseEnvFile(await readFile(envPath, "utf8"));
  } catch (error) {
    if (isMissingPathError(error)) {
      return {};
    }
    // A symlinked .env outside the workspace is intentionally ignored.
    if (error instanceof Error && error.message.includes("outside cwd")) {
      return {};
    }
    throw error;
  }
}

/** Build a standalone DroneHost backed by environment variables and cwd/.env. */
export function createEnvironmentHost(options: EnvironmentHostOptions): DroneHost {
  const workspace = createConfinedWorkspace(options.cwd);
  const env = options.env ?? process.env;
  let envFilePromise: Promise<Record<string, string>> | undefined;

  const getEnvFile = (): Promise<Record<string, string>> => {
    envFilePromise ??= readWorkspaceEnv(workspace);
    return envFilePromise;
  };

  return {
    async resolveApiKey(spec: DroneModelSpec): Promise<{ apiKey: string; source: string }> {
      const providerNames = providerKeyNames(spec.provider);
      const keyNames = ["DRONE_API_KEY", ...providerNames];
      for (const name of keyNames) {
        const value = env[name]?.trim();
        if (value) {
          return { apiKey: value, source: `env:${name}` };
        }
      }

      const envFile = await getEnvFile();
      for (const name of keyNames) {
        const value = envFile[name]?.trim();
        if (value) {
          return { apiKey: value, source: `.env:${name}` };
        }
      }

      throw new Error(
        `No API key found for provider "${spec.provider}" (checked ${keyNames.join(", ")})`,
      );
    },
    resolveSkillsPrompt(filter: DroneSkillFilter | undefined): string {
      return options.resolveSkillsPrompt?.(filter) ?? options.skillsPrompt ?? "";
    },
    ...(options.emitEvent ? { emitEvent: options.emitEvent } : {}),
  };
}
