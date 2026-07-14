import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { constants, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { TranscriptEntry, TranscriptRole } from "./state.js";

export const SESSION_HISTORY_VERSION = 1 as const;

const DEFAULT_MAX_SESSIONS = 100;
const DEFAULT_MAX_TRANSCRIPT_ENTRIES = 200;
const DEFAULT_MAX_TRANSCRIPT_CHARS = 500_000;
const DEFAULT_MAX_ENTRY_CHARS = 100_000;
const DEFAULT_MAX_SESSION_BYTES = 1_000_000;
const MAX_DIRECTORY_ENTRIES = 2_000;
const MAX_ID_CHARS = 64;
const MAX_TITLE_CHARS = 200;
const MAX_PROVIDER_CHARS = 200;
const MAX_MODEL_CHARS = 300;
const MAX_CWD_CHARS = 4_096;
const MAX_TRANSCRIPT_ID_CHARS = 200;
const MAX_TIMESTAMP = 8_640_000_000_000_000;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const TRANSCRIPT_ROLES = new Set<TranscriptRole>(["user", "assistant", "system"]);

export interface DroneSessionSnapshot {
  version: typeof SESSION_HISTORY_VERSION;
  id: string;
  cwd: string;
  title: string;
  provider: string;
  model: string;
  createdAt: number;
  updatedAt: number;
  transcript: TranscriptEntry[];
}

export type SaveDroneSessionInput = Omit<DroneSessionSnapshot, "version">;

export interface DroneSessionSummary {
  id: string;
  cwd: string;
  title: string;
  provider: string;
  model: string;
  createdAt: number;
  updatedAt: number;
  transcriptEntries: number;
}

export interface SessionHistoryStoreOptions {
  cwd: string;
  env?: Readonly<Record<string, string | undefined>>;
  homeDir?: string;
  maxSessions?: number;
  maxTranscriptEntries?: number;
  maxTranscriptChars?: number;
  maxEntryChars?: number;
  maxSessionBytes?: number;
}

export interface SessionHistoryPaths {
  root: string;
  sessions: string;
  workspace: string;
  workspaceKey: string;
}

export interface SessionHistoryStore {
  readonly cwd: string;
  readonly paths: SessionHistoryPaths;
  save(input: SaveDroneSessionInput): Promise<DroneSessionSnapshot>;
  list(): Promise<DroneSessionSummary[]>;
  load(id: string): Promise<DroneSessionSnapshot | undefined>;
  delete(id: string): Promise<boolean>;
}

type ResolvedStoreOptions = {
  cwd: string;
  paths: SessionHistoryPaths;
  maxSessions: number;
  maxTranscriptEntries: number;
  maxTranscriptChars: number;
  maxEntryChars: number;
  maxSessionBytes: number;
};

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function normalizeTimestamp(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0 || value > MAX_TIMESTAMP) {
    throw new Error(`${name} must be a non-negative finite number`);
  }
  return Math.floor(value);
}

function boundedString(value: string, maximum: number, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value.slice(0, maximum);
}

function assertSessionId(id: string): void {
  if (!SESSION_ID.test(id) || id.length > MAX_ID_CHARS) {
    throw new Error("invalid session id");
  }
}

function isMissingError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function canonicalWorkspacePath(cwd: string): string {
  const resolved = path.resolve(cwd);
  try {
    return realpathSync(resolved);
  } catch (error) {
    // Keeping lexical support for not-yet-created embedding/test paths preserves the
    // existing API, while real workspaces share identity across symlink aliases.
    if (isMissingError(error)) return resolved;
    throw error;
  }
}

function getStateRoot(options: SessionHistoryStoreOptions): string {
  const stateHome = (options.env ?? process.env).XDG_STATE_HOME?.trim();
  return path.join(stateHome || path.join(options.homeDir ?? homedir(), ".local", "state"), "drone");
}

export function getWorkspaceSessionKey(cwd: string): string {
  const resolved = canonicalWorkspacePath(cwd);
  return createHash("sha256")
    .update("drone-session-workspace\0", "utf8")
    .update(resolved, "utf8")
    .digest("hex")
    .slice(0, 32);
}

export function getSessionHistoryPaths(options: SessionHistoryStoreOptions): SessionHistoryPaths {
  const root = getStateRoot(options);
  const sessions = path.join(root, "sessions");
  const workspaceKey = getWorkspaceSessionKey(options.cwd);
  return { root, sessions, workspace: path.join(sessions, workspaceKey), workspaceKey };
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`session history path is not a private directory: ${directory}`);
  }
  await chmod(directory, 0o700);
}

async function ensureStoreDirectories(paths: SessionHistoryPaths): Promise<void> {
  await ensurePrivateDirectory(paths.root);
  await ensurePrivateDirectory(paths.sessions);
  await ensurePrivateDirectory(paths.workspace);
}

function normalizeTranscriptEntry(
  entry: TranscriptEntry,
  maxEntryChars: number,
): TranscriptEntry | undefined {
  if (
    typeof entry !== "object" ||
    entry === null ||
    typeof entry.id !== "string" ||
    !TRANSCRIPT_ROLES.has(entry.role) ||
    typeof entry.content !== "string" ||
    !Number.isFinite(entry.createdAt) ||
    entry.createdAt < 0 ||
    entry.createdAt > MAX_TIMESTAMP ||
    (entry.streaming !== undefined && typeof entry.streaming !== "boolean")
  ) {
    return undefined;
  }
  return {
    id: entry.id.slice(0, MAX_TRANSCRIPT_ID_CHARS),
    role: entry.role,
    content: entry.content.slice(0, maxEntryChars),
    createdAt: Math.floor(entry.createdAt),
    ...(entry.streaming === undefined ? {} : { streaming: entry.streaming }),
  };
}

function boundTranscript(
  entries: readonly TranscriptEntry[],
  options: Pick<ResolvedStoreOptions, "maxTranscriptEntries" | "maxTranscriptChars" | "maxEntryChars">,
): TranscriptEntry[] {
  const normalized = entries
    .slice(-options.maxTranscriptEntries)
    .map((entry) => normalizeTranscriptEntry(entry, options.maxEntryChars))
    .filter((entry): entry is TranscriptEntry => entry !== undefined);
  const retained: TranscriptEntry[] = [];
  let remaining = options.maxTranscriptChars;

  for (let index = normalized.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const entry = normalized[index];
    if (!entry) continue;
    const content = entry.content.slice(Math.max(0, entry.content.length - remaining));
    remaining -= content.length;
    retained.push({ ...entry, content });
  }
  return retained.reverse();
}

function normalizeSnapshot(
  input: SaveDroneSessionInput,
  options: ResolvedStoreOptions,
): DroneSessionSnapshot {
  assertSessionId(input.id);
  const cwd = canonicalWorkspacePath(boundedString(input.cwd, MAX_CWD_CHARS, "cwd"));
  if (cwd !== options.cwd) throw new Error("session cwd does not match history workspace");
  const createdAt = normalizeTimestamp(input.createdAt, "createdAt");
  const updatedAt = normalizeTimestamp(input.updatedAt, "updatedAt");
  if (updatedAt < createdAt) throw new Error("updatedAt must not precede createdAt");
  if (!Array.isArray(input.transcript)) throw new Error("transcript must be an array");

  return {
    version: SESSION_HISTORY_VERSION,
    id: input.id,
    cwd,
    title: boundedString(input.title, MAX_TITLE_CHARS, "title"),
    provider: boundedString(input.provider, MAX_PROVIDER_CHARS, "provider"),
    model: boundedString(input.model, MAX_MODEL_CHARS, "model"),
    createdAt,
    updatedAt,
    transcript: boundTranscript(input.transcript, options),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTranscriptEntry(value: unknown, maxEntryChars: number): TranscriptEntry | undefined {
  if (!isRecord(value)) return undefined;
  const role = value.role;
  if (role !== "user" && role !== "assistant" && role !== "system") return undefined;
  if (
    typeof value.id !== "string" ||
    value.id.length > MAX_TRANSCRIPT_ID_CHARS ||
    typeof value.content !== "string" ||
    value.content.length > maxEntryChars ||
    typeof value.createdAt !== "number" ||
    !Number.isFinite(value.createdAt) ||
    value.createdAt < 0 ||
    value.createdAt > MAX_TIMESTAMP ||
    (value.streaming !== undefined && typeof value.streaming !== "boolean")
  ) {
    return undefined;
  }
  return {
    id: value.id,
    role,
    content: value.content,
    createdAt: Math.floor(value.createdAt),
    ...(value.streaming === undefined ? {} : { streaming: value.streaming }),
  };
}

function parseSnapshot(value: unknown, options: ResolvedStoreOptions): DroneSessionSnapshot | undefined {
  if (!isRecord(value) || value.version !== SESSION_HISTORY_VERSION) return undefined;
  if (
    typeof value.id !== "string" ||
    !SESSION_ID.test(value.id) ||
    typeof value.cwd !== "string" ||
    canonicalWorkspacePath(value.cwd) !== options.cwd ||
    typeof value.title !== "string" ||
    value.title.length > MAX_TITLE_CHARS ||
    typeof value.provider !== "string" ||
    value.provider.length > MAX_PROVIDER_CHARS ||
    typeof value.model !== "string" ||
    value.model.length > MAX_MODEL_CHARS ||
    typeof value.createdAt !== "number" ||
    !Number.isFinite(value.createdAt) ||
    value.createdAt < 0 ||
    value.createdAt > MAX_TIMESTAMP ||
    typeof value.updatedAt !== "number" ||
    !Number.isFinite(value.updatedAt) ||
    value.updatedAt < value.createdAt ||
    value.updatedAt > MAX_TIMESTAMP ||
    !Array.isArray(value.transcript) ||
    value.transcript.length > options.maxTranscriptEntries
  ) {
    return undefined;
  }
  const transcript = value.transcript.map((entry) =>
    parseTranscriptEntry(entry, options.maxEntryChars),
  );
  if (transcript.some((entry) => entry === undefined)) return undefined;
  const parsedTranscript = transcript.filter((entry): entry is TranscriptEntry => entry !== undefined);
  if (
    parsedTranscript.reduce((total, entry) => total + entry.content.length, 0) >
    options.maxTranscriptChars
  ) {
    return undefined;
  }
  return {
    version: SESSION_HISTORY_VERSION,
    id: value.id,
    cwd: options.cwd,
    title: value.title,
    provider: value.provider,
    model: value.model,
    createdAt: Math.floor(value.createdAt),
    updatedAt: Math.floor(value.updatedAt),
    transcript: parsedTranscript,
  };
}

function sessionFile(options: ResolvedStoreOptions, id: string): string {
  assertSessionId(id);
  return path.join(options.paths.workspace, `${id}.json`);
}

async function readSnapshotFile(
  file: string,
  options: ResolvedStoreOptions,
): Promise<DroneSessionSnapshot | undefined> {
  try {
    const filename = path.basename(file);
    if (!filename.endsWith(".json")) return undefined;
    const expectedId = filename.slice(0, -".json".length);
    if (!SESSION_ID.test(expectedId)) return undefined;
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > options.maxSessionBytes) return undefined;
      const contents = await handle.readFile("utf8");
      const snapshot = parseSnapshot(JSON.parse(contents) as unknown, options);
      return snapshot?.id === expectedId ? snapshot : undefined;
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

function toSummary(snapshot: DroneSessionSnapshot): DroneSessionSummary {
  return {
    id: snapshot.id,
    cwd: snapshot.cwd,
    title: snapshot.title,
    provider: snapshot.provider,
    model: snapshot.model,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
    transcriptEntries: snapshot.transcript.length,
  };
}

async function listSnapshots(options: ResolvedStoreOptions): Promise<DroneSessionSnapshot[]> {
  let entries;
  try {
    entries = await readdir(options.paths.workspace, { withFileTypes: true });
  } catch (error) {
    if (isMissingError(error)) return [];
    throw error;
  }
  const candidates = entries
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(".json"))
    .slice(0, MAX_DIRECTORY_ENTRIES);
  const snapshots = await Promise.all(
    candidates.map((entry) => readSnapshotFile(path.join(options.paths.workspace, entry.name), options)),
  );
  return snapshots
    .filter((snapshot): snapshot is DroneSessionSnapshot => snapshot !== undefined)
    .sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt);
}

async function atomicWriteSnapshot(
  options: ResolvedStoreOptions,
  snapshot: DroneSessionSnapshot,
): Promise<void> {
  await ensureStoreDirectories(options.paths);
  const target = sessionFile(options, snapshot.id);
  const temporary = path.join(
    options.paths.workspace,
    `.${snapshot.id}.${process.pid}.${randomUUID()}.tmp`,
  );
  const serialized = `${JSON.stringify(snapshot)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > options.maxSessionBytes) {
    throw new Error("session snapshot exceeds maximum persisted size");
  }
  let temporaryExists = false;
  try {
    await writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
    temporaryExists = true;
    await chmod(temporary, 0o600);
    await rename(temporary, target);
    temporaryExists = false;
  } finally {
    if (temporaryExists) await unlink(temporary).catch(() => undefined);
  }
}

async function pruneSnapshots(options: ResolvedStoreOptions): Promise<void> {
  const snapshots = await listSnapshots(options);
  await Promise.all(
    snapshots.slice(options.maxSessions).map((snapshot) =>
      unlink(sessionFile(options, snapshot.id)).catch((error: unknown) => {
        if (!isMissingError(error)) throw error;
      }),
    ),
  );
}

function resolveStoreOptions(options: SessionHistoryStoreOptions): ResolvedStoreOptions {
  const cwd = canonicalWorkspacePath(options.cwd);
  return {
    cwd,
    paths: getSessionHistoryPaths({ ...options, cwd }),
    maxSessions: positiveInteger(options.maxSessions, DEFAULT_MAX_SESSIONS, "maxSessions"),
    maxTranscriptEntries: positiveInteger(
      options.maxTranscriptEntries,
      DEFAULT_MAX_TRANSCRIPT_ENTRIES,
      "maxTranscriptEntries",
    ),
    maxTranscriptChars: positiveInteger(
      options.maxTranscriptChars,
      DEFAULT_MAX_TRANSCRIPT_CHARS,
      "maxTranscriptChars",
    ),
    maxEntryChars: positiveInteger(
      options.maxEntryChars,
      DEFAULT_MAX_ENTRY_CHARS,
      "maxEntryChars",
    ),
    maxSessionBytes: positiveInteger(
      options.maxSessionBytes,
      DEFAULT_MAX_SESSION_BYTES,
      "maxSessionBytes",
    ),
  };
}

export function createSessionHistoryStore(options: SessionHistoryStoreOptions): SessionHistoryStore {
  const resolved = resolveStoreOptions(options);
  return {
    cwd: resolved.cwd,
    paths: resolved.paths,
    async save(input): Promise<DroneSessionSnapshot> {
      const snapshot = normalizeSnapshot(input, resolved);
      await atomicWriteSnapshot(resolved, snapshot);
      await pruneSnapshots(resolved);
      return snapshot;
    },
    async list(): Promise<DroneSessionSummary[]> {
      return (await listSnapshots(resolved)).slice(0, resolved.maxSessions).map(toSummary);
    },
    async load(id): Promise<DroneSessionSnapshot | undefined> {
      return await readSnapshotFile(sessionFile(resolved, id), resolved);
    },
    async delete(id): Promise<boolean> {
      const file = sessionFile(resolved, id);
      try {
        await unlink(file);
        return true;
      } catch (error) {
        if (isMissingError(error)) return false;
        throw error;
      }
    },
  };
}
