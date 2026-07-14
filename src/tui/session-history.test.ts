import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TranscriptEntry } from "./state.js";
import {
  SESSION_HISTORY_VERSION,
  createSessionHistoryStore,
  getSessionHistoryPaths,
  getWorkspaceSessionKey,
  type SaveDroneSessionInput,
} from "./session-history.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "drone-session-history-"));
  temporaryDirectories.push(directory);
  return directory;
}

function transcript(content: string, createdAt = 1): TranscriptEntry[] {
  return [{ id: `entry-${createdAt}`, role: "user", content, createdAt }];
}

function session(
  cwd: string,
  id: string,
  updatedAt: number,
  overrides: Partial<SaveDroneSessionInput> = {},
): SaveDroneSessionInput {
  return {
    id,
    cwd,
    title: `Session ${id}`,
    provider: "anthropic",
    model: "claude-test",
    createdAt: Math.max(0, updatedAt - 1),
    updatedAt,
    transcript: transcript(id, updatedAt),
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("session history paths", () => {
  it("uses XDG state and hashes workspace paths without exposing them in filenames", async () => {
    const stateHome = await temporaryDirectory();
    const cwd = "/private/projects/customer-secret";
    const paths = getSessionHistoryPaths({ cwd, env: { XDG_STATE_HOME: stateHome } });

    expect(paths.root).toBe(path.join(stateHome, "drone"));
    expect(paths.workspaceKey).toMatch(/^[a-f0-9]{32}$/);
    expect(path.basename(paths.workspace)).toBe(getWorkspaceSessionKey(cwd));
    expect(paths.workspace).not.toContain("customer-secret");
  });

  it("falls back to the user local state directory", () => {
    const paths = getSessionHistoryPaths({ cwd: "/work", env: {}, homeDir: "/home/tester" });
    expect(paths.root).toBe("/home/tester/.local/state/drone");
  });

  it("uses one canonical workspace identity through symlink aliases", async () => {
    const stateHome = await temporaryDirectory();
    const workspace = path.join(stateHome, "workspace");
    const alias = path.join(stateHome, "workspace-link");
    await mkdir(workspace);
    await symlink(workspace, alias, "dir");

    const direct = createSessionHistoryStore({
      cwd: workspace,
      env: { XDG_STATE_HOME: stateHome },
    });
    const linked = createSessionHistoryStore({
      cwd: alias,
      env: { XDG_STATE_HOME: stateHome },
    });

    expect(linked.cwd).toBe(workspace);
    expect(linked.paths.workspaceKey).toBe(direct.paths.workspaceKey);
    expect(linked.paths.workspace).toBe(direct.paths.workspace);

    await linked.save(session(alias, "linked-session", 10));
    await expect(direct.load("linked-session")).resolves.toMatchObject({ cwd: workspace });
  });
});

describe("session persistence", () => {
  it("isolates workspaces and enforces private directory and file modes", async () => {
    const stateHome = await temporaryDirectory();
    const firstCwd = path.join(stateHome, "workspace-one");
    const secondCwd = path.join(stateHome, "workspace-two");
    const first = createSessionHistoryStore({ cwd: firstCwd, env: { XDG_STATE_HOME: stateHome } });
    const second = createSessionHistoryStore({ cwd: secondCwd, env: { XDG_STATE_HOME: stateHome } });

    await first.save(session(firstCwd, "same-id", 10, { title: "First" }));
    await second.save(session(secondCwd, "same-id", 20, { title: "Second" }));

    await expect(first.load("same-id")).resolves.toMatchObject({
      version: SESSION_HISTORY_VERSION,
      cwd: path.resolve(firstCwd),
      title: "First",
    });
    await expect(second.load("same-id")).resolves.toMatchObject({ title: "Second" });
    expect(first.paths.workspace).not.toBe(second.paths.workspace);

    for (const directory of [first.paths.root, first.paths.sessions, first.paths.workspace]) {
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
    }
    const file = path.join(first.paths.workspace, "same-id.json");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await readdir(first.paths.workspace)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("lists newest first and safely skips corrupt or mismatched snapshots", async () => {
    const stateHome = await temporaryDirectory();
    const cwd = path.join(stateHome, "workspace");
    const store = createSessionHistoryStore({ cwd, env: { XDG_STATE_HOME: stateHome } });
    await store.save(session(cwd, "older", 10));
    await store.save(session(cwd, "newer", 30));
    await writeFile(path.join(store.paths.workspace, "broken.json"), "{not-json", "utf8");
    await writeFile(
      path.join(store.paths.workspace, "wrong-workspace.json"),
      JSON.stringify({
        ...session("/somewhere/else", "wrong-workspace", 40),
        version: SESSION_HISTORY_VERSION,
      }),
      "utf8",
    );

    expect((await store.list()).map((entry) => entry.id)).toEqual(["newer", "older"]);
    await expect(store.load("broken")).resolves.toBeUndefined();
    await expect(store.load("wrong-workspace")).resolves.toBeUndefined();
  });

  it("bounds retained sessions, transcript entries, and transcript content", async () => {
    const stateHome = await temporaryDirectory();
    const cwd = path.join(stateHome, "workspace");
    const store = createSessionHistoryStore({
      cwd,
      env: { XDG_STATE_HOME: stateHome },
      maxSessions: 2,
      maxTranscriptEntries: 2,
      maxTranscriptChars: 10,
      maxEntryChars: 8,
      maxSessionBytes: 4_096,
    });
    const longTranscript: TranscriptEntry[] = [
      { id: "one", role: "user", content: "11111111", createdAt: 1 },
      { id: "two", role: "assistant", content: "22222222", createdAt: 2 },
      { id: "three", role: "user", content: "333333333333", createdAt: 3 },
    ];
    await store.save(session(cwd, "first", 10, { transcript: longTranscript }));
    await store.save(session(cwd, "second", 20));
    const saved = await store.save(session(cwd, "third", 30, { transcript: longTranscript }));

    expect((await store.list()).map((entry) => entry.id)).toEqual(["third", "second"]);
    await expect(store.load("first")).resolves.toBeUndefined();
    expect(saved.transcript.length).toBeLessThanOrEqual(2);
    expect(saved.transcript.reduce((total, entry) => total + entry.content.length, 0)).toBeLessThanOrEqual(
      10,
    );

    const stored = JSON.parse(
      await readFile(path.join(store.paths.workspace, "third.json"), "utf8"),
    ) as { transcript: TranscriptEntry[] };
    expect(stored.transcript.every((entry) => entry.content.length <= 8)).toBe(true);
  });

  it("validates ids before load, save, and delete to prevent path traversal", async () => {
    const stateHome = await temporaryDirectory();
    const cwd = path.join(stateHome, "workspace");
    const store = createSessionHistoryStore({ cwd, env: { XDG_STATE_HOME: stateHome } });

    await expect(store.save(session(cwd, "../escape", 10))).rejects.toThrow("invalid session id");
    await expect(store.load("../../escape")).rejects.toThrow("invalid session id");
    await expect(store.delete("nested/session")).rejects.toThrow("invalid session id");
    await expect(store.load("missing")).resolves.toBeUndefined();
    await expect(store.delete("missing")).resolves.toBe(false);

    await mkdir(store.paths.workspace, { recursive: true });
    expect(await readdir(stateHome, { recursive: true })).not.toContain("escape.json");
  });

  it("refuses symlinked store directories and snapshot files", async () => {
    const stateHome = await temporaryDirectory();
    const redirected = await temporaryDirectory();
    const cwd = path.join(stateHome, "workspace");
    await symlink(redirected, path.join(stateHome, "drone"), "dir");
    const redirectedStore = createSessionHistoryStore({
      cwd,
      env: { XDG_STATE_HOME: stateHome },
    });
    await expect(redirectedStore.save(session(cwd, "blocked", 10))).rejects.toThrow(
      "not a private directory",
    );

    const cleanStateHome = await temporaryDirectory();
    const store = createSessionHistoryStore({
      cwd,
      env: { XDG_STATE_HOME: cleanStateHome },
    });
    await store.save(session(cwd, "real", 20));
    await symlink(
      path.join(store.paths.workspace, "real.json"),
      path.join(store.paths.workspace, "linked.json"),
    );
    await expect(store.load("linked")).resolves.toBeUndefined();
  });
});
