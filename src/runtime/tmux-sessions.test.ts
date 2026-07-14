import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTmuxSessionManager,
  createTmuxCommandExecutor,
  getTmuxWorkspaceSessionName,
  MAX_TMUX_AGENTS,
  TMUX_AGENT_WINDOW_SLOTS,
  sanitizeTmuxOutput,
  TmuxRuntimeError,
  type TmuxCommandExecutor,
  type TmuxCommandRequest,
  type TmuxCommandResult,
} from "./tmux-sessions.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "drone-tmux-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function result(
  stdout = "",
  exitCode = 0,
  overrides: Partial<TmuxCommandResult> = {},
): TmuxCommandResult {
  return {
    exitCode,
    signal: null,
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    ...overrides,
  };
}

type FakeWindow = {
  id: string;
  index: number;
  name?: string;
  active: boolean;
  dead: boolean;
  currentCommand: string;
  capture: string;
};

class FakeTmuxExecutor implements TmuxCommandExecutor {
  readonly requests: TmuxCommandRequest[] = [];
  readonly windows = new Map<string, FakeWindow>();
  readonly buffers = new Map<string, string>();
  sessionExists = false;
  marker = "";
  nextWindow = 1;
  baseIndex = 0;
  renumberWindows = false;
  destroyUnattached = false;
  afterCommand?: (command: string | undefined) => void;

  async execute(request: TmuxCommandRequest): Promise<TmuxCommandResult> {
    this.requests.push({ ...request, args: [...request.args] });
    const queue: string[][] = [[]];
    for (const argument of request.args) {
      if (argument === ";") queue.push([]);
      else queue.at(-1)?.push(argument);
    }
    let combined = result();
    for (const commandArgs of queue) {
      const commandResult = this.executeSingle(commandArgs, request);
      this.afterCommand?.(commandArgs[0]);
      combined = {
        ...commandResult,
        stdout: combined.stdout + commandResult.stdout,
        stderr: combined.stderr + commandResult.stderr,
        stdoutTruncated: combined.stdoutTruncated || commandResult.stdoutTruncated,
        stderrTruncated: combined.stderrTruncated || commandResult.stderrTruncated,
      };
      if (commandResult.exitCode !== 0 || commandResult.timedOut) break;
    }
    return combined;
  }

  addUnmanagedWindow(index = 50_000): string {
    return this.addWindow(index);
  }

  private executeSingle(commandArgs: readonly string[], request: TmuxCommandRequest): TmuxCommandResult {
    const [command, ...args] = commandArgs;

    if (command === "-V") return result("tmux 3.6b\n");
    if (command === "has-session") return result("", this.sessionExists ? 0 : 1);
    if (command === "new-session") {
      if (this.sessionExists) return result("", 1, { stderr: "duplicate session" });
      this.sessionExists = true;
      return result(`${this.addWindow(this.baseIndex)}\n`);
    }
    if (command === "new-window") {
      if (!this.sessionExists) return result("", 1, { stderr: "session not found" });
      const target = args[args.indexOf("-t") + 1];
      const index = this.targetIndex(target);
      if (index === undefined) return result("", 1, { stderr: "invalid target" });
      if ([...this.windows.values()].some((window) => window.index === index)) {
        return result("", 1, { stderr: `index ${index} in use` });
      }
      return result(`${this.addWindow(index)}\n`);
    }
    if (command === "show-options") {
      if (args.includes("-g")) return result(`${this.baseIndex}\n`);
      return this.marker ? result(`${this.marker}\n`) : result("", 1);
    }
    if (command === "set-option" && !args.includes("-w")) {
      const option = args.at(-2);
      const value = args.at(-1) ?? "";
      if (option === "@drone_workspace_key") this.marker = value;
      if (option === "renumber-windows") this.renumberWindows = value === "on";
      if (option === "destroy-unattached") this.destroyUnattached = value === "on";
      return result();
    }
    if (command === "set-option" && args.includes("-w")) {
      const target = args[args.indexOf("-t") + 1];
      const window = this.findTarget(target);
      if (!window) return result("", 1, { stderr: "window not found" });
      window.name = args.at(-1);
      return result();
    }
    if (command === "set-window-option") return result();
    if (command === "move-window") {
      const source = this.findTarget(args[args.indexOf("-s") + 1]);
      const index = this.targetIndex(args[args.indexOf("-t") + 1]);
      if (!source || index === undefined) return result("", 1, { stderr: "invalid target" });
      if ([...this.windows.values()].some((window) => window !== source && window.index === index)) {
        return result("", 1, { stderr: `index ${index} in use` });
      }
      source.index = index;
      return result();
    }
    if (command === "list-windows") {
      const lines = [...this.windows.values()].map((window) =>
        [
          window.id,
          String(window.index),
          window.active ? "1" : "0",
          window.dead ? "1" : "0",
          window.currentCommand,
          window.name ?? "",
        ].join("\t"),
      );
      return result(lines.length ? `${lines.join("\n")}\n` : "");
    }
    if (command === "load-buffer") {
      const bufferName = args[args.indexOf("-b") + 1];
      if (!bufferName) return result("", 1);
      this.buffers.set(bufferName, request.stdin ?? "");
      return result();
    }
    if (command === "paste-buffer") {
      const bufferName = args[args.indexOf("-b") + 1];
      if (!bufferName || !this.buffers.has(bufferName)) return result("", 1);
      if (args.includes("-d")) this.buffers.delete(bufferName);
      return result();
    }
    if (command === "delete-buffer") {
      const bufferName = args[args.indexOf("-b") + 1];
      if (bufferName) this.buffers.delete(bufferName);
      return result();
    }
    if (command === "send-keys") return result();
    if (command === "capture-pane") {
      const id = args[args.indexOf("-t") + 1];
      const window = this.findTarget(id);
      return window ? result(window.capture) : result("", 1, { stderr: "window not found" });
    }
    if (command === "kill-window") {
      const id = args[args.indexOf("-t") + 1];
      if (!id || !this.windows.delete(id)) return result("", 1);
      if (this.renumberWindows) {
        [...this.windows.values()]
          .sort((left, right) => left.index - right.index)
          .forEach((window, index) => {
            window.index = this.baseIndex + index;
          });
      }
      if (this.windows.size === 0) {
        this.sessionExists = false;
        this.marker = "";
      }
      return result();
    }
    return result("", 1, { stderr: `unsupported fake command: ${command}` });
  }

  private targetIndex(target: string | undefined): number | undefined {
    if (!target) return undefined;
    const rawIndex = target.split(":").at(-1);
    if (!rawIndex) return undefined;
    const index = Number(rawIndex);
    return Number.isSafeInteger(index) && index >= 0 ? index : undefined;
  }

  private findTarget(target: string | undefined): FakeWindow | undefined {
    if (!target) return undefined;
    const byId = this.windows.get(target);
    if (byId) return byId;
    const index = this.targetIndex(target);
    if (index !== undefined) {
      return [...this.windows.values()].find((window) => window.index === index);
    }
    if (target.endsWith(":")) {
      return [...this.windows.values()].find((window) => window.active) ?? this.windows.values().next().value;
    }
    return undefined;
  }

  private addWindow(index: number): string {
    const id = `@${this.nextWindow++}`;
    this.windows.set(id, {
      id,
      index,
      active: this.windows.size === 0,
      dead: false,
      currentCommand: "bash",
      capture: "",
    });
    return id;
  }
}

describe("tmux workspace identity", () => {
  it("derives a deterministic, tmux-safe session name scoped to the real workspace", async () => {
    const alpha = await temporaryDirectory();
    const beta = await temporaryDirectory();
    const alias = path.join(await temporaryDirectory(), "alpha-link");
    await symlink(alpha, alias);

    const first = getTmuxWorkspaceSessionName(alpha);
    expect(first).toBe(getTmuxWorkspaceSessionName(alias));
    expect(first).not.toBe(getTmuxWorkspaceSessionName(beta));
    expect(first).toMatch(/^drone-[a-f0-9]{24}$/);
  });

  it("returns false for a missing tmux executable and exposes a stable error code", async () => {
    const cwd = await temporaryDirectory();
    const missing: TmuxCommandExecutor = {
      async execute() {
        throw Object.assign(new Error("spawn tmux ENOENT"), { code: "ENOENT" });
      },
    };
    const manager = createTmuxSessionManager({ cwd, executor: missing });

    await expect(manager.isAvailable()).resolves.toBe(false);
    await expect(manager.list()).rejects.toMatchObject({ code: "TMUX_UNAVAILABLE" });
  });
});

describe("tmux agent lifecycle", () => {
  it("creates a persistent user-shell window and marks it as workspace-owned", async () => {
    const cwd = await temporaryDirectory();
    const executor = new FakeTmuxExecutor();
    const manager = createTmuxSessionManager({ cwd, executor });

    const agent = await manager.create({ name: "research" });

    expect(agent).toMatchObject({
      id: "@1",
      index: TMUX_AGENT_WINDOW_SLOTS[0],
      name: "research",
      currentCommand: "bash",
    });
    expect(executor.marker).toBe(manager.workspaceKey);
    const createRequest = executor.requests.find((request) => request.args[0] === "new-session");
    expect(createRequest?.args).toEqual(
      expect.arrayContaining(["-s", manager.sessionName, "-n", "research", "-c", cwd]),
    );
    expect(createRequest?.args).toEqual(
      expect.arrayContaining([
        ";",
        "set-option",
        "-t",
        manager.sessionName,
        "@drone_workspace_key",
        manager.workspaceKey,
        "renumber-windows",
        "off",
        "destroy-unattached",
        "off",
        "move-window",
        "-s",
        `${manager.sessionName}:`,
        "-t",
        `${manager.sessionName}:${TMUX_AGENT_WINDOW_SLOTS[0]}`,
        "automatic-rename",
        "off",
        "allow-rename",
        "off",
        "@drone_agent_name",
        "research",
      ]),
    );
    expect(createRequest?.args.filter((argument) => argument === ";")).toHaveLength(7);
    expect(executor.requests.some((request) => request.args[0] === "kill-session")).toBe(false);
  });

  it("creates additional windows without replacing the workspace session", async () => {
    const cwd = await temporaryDirectory();
    const executor = new FakeTmuxExecutor();
    const manager = createTmuxSessionManager({ cwd, executor });

    await manager.create({ name: "one" });
    const second = await manager.create({ name: "two" });

    expect(second.id).toBe("@2");
    expect(second.index).toBe(TMUX_AGENT_WINDOW_SLOTS[1]);
    expect(await manager.list()).toHaveLength(2);
    expect(executor.requests.filter((request) => request.args[0] === "new-session")).toHaveLength(1);
    expect(executor.requests.filter((request) => request.args[0] === "new-window")).toHaveLength(1);
  });

  it("avoids a globally configured base index that overlaps a reserved slot", async () => {
    const cwd = await temporaryDirectory();
    const executor = new FakeTmuxExecutor();
    executor.baseIndex = TMUX_AGENT_WINDOW_SLOTS[0];
    const manager = createTmuxSessionManager({ cwd, executor });

    const first = await manager.create({ name: "first" });
    const second = await manager.create({ name: "second" });

    expect(first.index).toBe(TMUX_AGENT_WINDOW_SLOTS[1]);
    expect(second.index).toBe(TMUX_AGENT_WINDOW_SLOTS[0]);
  });

  it("arbitrates concurrent names without a process lock", async () => {
    const cwd = await temporaryDirectory();
    const executor = new FakeTmuxExecutor();
    const firstManager = createTmuxSessionManager({ cwd, executor });
    const secondManager = createTmuxSessionManager({ cwd, executor });

    const sameName = await Promise.allSettled([
      firstManager.create({ name: " Builder " }),
      secondManager.create({ name: "builder" }),
    ]);
    expect(sameName.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    expect(sameName.filter((entry) => entry.status === "rejected")).toHaveLength(1);
    const rejection = sameName.find((entry) => entry.status === "rejected");
    expect(rejection).toMatchObject({ reason: { code: "TMUX_AGENT_NAME_CONFLICT" } });

    const differentNames = await Promise.all([
      firstManager.create({ name: "researcher" }),
      secondManager.create({ name: "tester" }),
    ]);
    expect(new Set(differentNames.map((agent) => agent.index)).size).toBe(2);
    expect(
      differentNames.every((agent) =>
        TMUX_AGENT_WINDOW_SLOTS.some((slot) => slot === agent.index),
      ),
    ).toBe(true);
  });

  it("structurally caps a workspace at four reserved agent windows", async () => {
    const cwd = await temporaryDirectory();
    const executor = new FakeTmuxExecutor();
    const manager = createTmuxSessionManager({ cwd, executor });

    const agents = [];
    for (let index = 0; index < MAX_TMUX_AGENTS; index += 1) {
      agents.push(await manager.create({ name: `agent-${index + 1}` }));
    }

    expect(agents.map((agent) => agent.index)).toEqual([...TMUX_AGENT_WINDOW_SLOTS]);
    await expect(manager.create({ name: "one-too-many" })).rejects.toMatchObject({
      code: "TMUX_AGENT_LIMIT",
    });
    expect(await manager.list()).toHaveLength(MAX_TMUX_AGENTS);
  });

  it("disables inherited destructive options and reasserts them before fixed-slot operations", async () => {
    const cwd = await temporaryDirectory();
    const executor = new FakeTmuxExecutor();
    executor.renumberWindows = true;
    executor.destroyUnattached = true;
    const manager = createTmuxSessionManager({ cwd, executor });
    const first = await manager.create({ name: "first" });
    const second = await manager.create({ name: "second" });

    expect(executor.renumberWindows).toBe(false);
    expect(executor.destroyUnattached).toBe(false);
    executor.renumberWindows = true;
    executor.destroyUnattached = true;
    expect((await manager.list()).map((agent) => agent.index)).toEqual([
      TMUX_AGENT_WINDOW_SLOTS[0],
      TMUX_AGENT_WINDOW_SLOTS[1],
    ]);
    expect(executor.renumberWindows).toBe(false);
    expect(executor.destroyUnattached).toBe(false);

    executor.renumberWindows = true;
    executor.destroyUnattached = true;
    await manager.close(first.id);
    expect(executor.renumberWindows).toBe(false);
    expect(executor.destroyUnattached).toBe(false);
    expect(await manager.list()).toEqual([
      expect.objectContaining({ id: second.id, index: TMUX_AGENT_WINDOW_SLOTS[1] }),
    ]);
  });

  it("pastes an optional command over stdin and never places it in process arguments", async () => {
    const cwd = await temporaryDirectory();
    const executor = new FakeTmuxExecutor();
    const manager = createTmuxSessionManager({ cwd, executor });
    const secretCommand = "agent --token secret-value";

    const agent = await manager.create({ name: "builder", command: secretCommand });

    const load = executor.requests.find((request) => request.args[0] === "load-buffer");
    expect(load?.stdin).toBe(secretCommand);
    expect(executor.requests.flatMap((request) => request.args)).not.toContain(secretCommand);
    expect(
      executor.requests.some(
        (request) =>
          request.args[0] === "send-keys" &&
          request.args.includes(agent.id) &&
          request.args.includes("Enter"),
      ),
    ).toBe(true);
    expect(executor.buffers.size).toBe(0);
  });

  it("ignores unmarked windows and only closes a listed Drone agent", async () => {
    const cwd = await temporaryDirectory();
    const executor = new FakeTmuxExecutor();
    const manager = createTmuxSessionManager({ cwd, executor });
    const agent = await manager.create({ name: "owned" });
    const unmanaged = executor.addUnmanagedWindow();

    expect((await manager.list()).map((entry) => entry.id)).toEqual([agent.id]);
    await expect(manager.close(unmanaged)).resolves.toBe(false);
    await expect(manager.close(agent.id)).resolves.toBe(true);
    expect(executor.windows.has(unmanaged)).toBe(true);
    expect(executor.requests.some((request) => request.args[0] === "kill-session")).toBe(false);
  });

  it("refuses a same-name tmux session without the workspace marker", async () => {
    const cwd = await temporaryDirectory();
    const executor = new FakeTmuxExecutor();
    executor.sessionExists = true;
    executor.addUnmanagedWindow();
    const manager = createTmuxSessionManager({ cwd, executor });

    await expect(manager.list()).rejects.toMatchObject({ code: "TMUX_SESSION_COLLISION" });
    expect(executor.requests.some((request) => request.args[0] === "kill-session")).toBe(false);
  });

  it("confines agent working directories to real workspace descendants", async () => {
    const cwd = await temporaryDirectory();
    const inside = path.join(cwd, "packages", "app");
    const outside = await temporaryDirectory();
    await mkdir(inside, { recursive: true });
    const manager = createTmuxSessionManager({ cwd, executor: new FakeTmuxExecutor() });

    await expect(manager.create({ name: "inside", cwd: inside })).resolves.toMatchObject({
      name: "inside",
    });
    await expect(manager.create({ name: "outside", cwd: outside })).rejects.toMatchObject({
      code: "TMUX_INVALID_INPUT",
    });
  });
});

describe("tmux interaction safety", () => {
  it("honors an already-aborted manager lifecycle without invoking tmux", async () => {
    const cwd = await temporaryDirectory();
    const executor = new FakeTmuxExecutor();
    const controller = new AbortController();
    controller.abort();
    const manager = createTmuxSessionManager({ cwd, executor, abortSignal: controller.signal });

    await expect(manager.list()).rejects.toMatchObject({ code: "TMUX_ABORTED" });
    expect(executor.requests).toHaveLength(0);
  });

  it("terminates an in-flight command when its lifecycle is aborted", async () => {
    const executor = createTmuxCommandExecutor();
    const controller = new AbortController();
    const running = executor.execute({
      executable: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      timeoutMs: 5_000,
      maxOutputBytes: 1_024,
      abortSignal: controller.signal,
    });
    setTimeout(() => controller.abort(), 25);

    await expect(running).rejects.toMatchObject({ name: "AbortError" });
  });

  it("deletes a loaded paste buffer even when lifecycle abort prevents further commands", async () => {
    const cwd = await temporaryDirectory();
    const executor = new FakeTmuxExecutor();
    const controller = new AbortController();
    const manager = createTmuxSessionManager({
      cwd,
      executor,
      abortSignal: controller.signal,
      commandTimeoutMs: 321,
    });
    const agent = await manager.create({ name: "agent" });
    executor.afterCommand = (command) => {
      if (command !== "load-buffer") return;
      executor.afterCommand = undefined;
      controller.abort();
    };

    await expect(manager.sendInput(agent.id, "secret input")).rejects.toMatchObject({
      code: "TMUX_ABORTED",
    });

    expect(executor.buffers.size).toBe(0);
    const cleanup = executor.requests.find((request) => request.args[0] === "delete-buffer");
    expect(cleanup).toMatchObject({ abortSignal: undefined, timeoutMs: 321 });
  });

  it("validates ownership before input and supports paste without Enter", async () => {
    const cwd = await temporaryDirectory();
    const executor = new FakeTmuxExecutor();
    const manager = createTmuxSessionManager({ cwd, executor });
    const agent = await manager.create({ name: "agent" });
    const before = executor.requests.length;

    await manager.sendInput(agent.id, "draft", { enter: false });
    const interaction = executor.requests.slice(before);
    expect(interaction.some((request) => request.args[0] === "load-buffer")).toBe(true);
    expect(interaction.some((request) => request.args[0] === "send-keys")).toBe(false);
    await expect(manager.sendInput("@1;kill-server", "bad")).rejects.toBeInstanceOf(
      TmuxRuntimeError,
    );
  });

  it("interrupts only a validated owned window", async () => {
    const cwd = await temporaryDirectory();
    const executor = new FakeTmuxExecutor();
    const manager = createTmuxSessionManager({ cwd, executor });
    const agent = await manager.create({ name: "agent" });

    await manager.interrupt(agent.id);

    expect(executor.requests.at(-1)?.args).toEqual(["send-keys", "-t", agent.id, "C-c"]);
    await expect(manager.interrupt("@999")).rejects.toMatchObject({
      code: "TMUX_AGENT_NOT_FOUND",
    });
  });

  it("sanitizes and bounds captured pane output before rendering", async () => {
    const cwd = await temporaryDirectory();
    const executor = new FakeTmuxExecutor();
    const manager = createTmuxSessionManager({ cwd, executor, maxCaptureChars: 8 });
    const agent = await manager.create({ name: "agent" });
    const window = executor.windows.get(agent.id);
    if (!window) throw new Error("missing fake window");
    window.capture = "old\u001b[31mRED\u001b[0m\u001b]8;;https://evil.test\u0007link\u001b]8;;\u0007\u202e123456789";

    const capture = await manager.capture(agent.id);

    expect(capture.text).toBe("23456789");
    expect(capture.text).not.toContain("\u001b");
    expect(capture.text).not.toContain("\u202e");
    expect(capture.truncated).toBe(true);
  });

  it("strips unterminated terminal strings instead of leaking their payload", () => {
    expect(sanitizeTmuxOutput("safe\u001b]0;malicious title")).toBe("safe");
    expect(sanitizeTmuxOutput("a\r\nb\rc\u0000d")).toBe("a\nb\ncd");
  });
});
