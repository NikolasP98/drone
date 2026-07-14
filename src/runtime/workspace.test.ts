import { link, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DroneToolContext, DroneToolDef } from "../types.js";
import {
  createEnvironmentHost,
  createWorkspaceTools,
  sanitizeEnvironment,
  type CommandResult,
  type WorkspaceApprovalRequest,
} from "./workspace.js";

const temporaryDirectories: string[] = [];

const context: DroneToolContext = { droneId: "workspace-test" };

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "drone-workspace-"));
  temporaryDirectories.push(directory);
  return directory;
}

function tool(tools: DroneToolDef[], name: string): DroneToolDef {
  const found = tools.find((candidate) => candidate.name === name);
  if (!found) {
    throw new Error(`missing test tool: ${name}`);
  }
  return found;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe("workspace path confinement", () => {
  it("rejects lexical traversal and symlink traversal for reads", async () => {
    const cwd = await temporaryDirectory();
    const outside = await temporaryDirectory();
    await writeFile(path.join(outside, "secret.txt"), "outside", "utf8");
    await symlink(outside, path.join(cwd, "escape"));
    const tools = createWorkspaceTools({ cwd });
    const read = tool(tools, "read_file");

    await expect(read.execute({ path: "../secret.txt" }, context)).rejects.toThrow("escapes cwd");
    await expect(read.execute({ path: "escape/secret.txt" }, context)).rejects.toThrow(
      "symlink outside cwd",
    );
  });

  it("checks symlink traversal before requesting write approval", async () => {
    const cwd = await temporaryDirectory();
    const outside = await temporaryDirectory();
    await symlink(outside, path.join(cwd, "escape"));
    const approve = vi.fn<(request: WorkspaceApprovalRequest) => boolean>(() => true);
    const write = tool(createWorkspaceTools({ cwd, approve }), "write_file");

    await expect(write.execute({ path: "escape/new.txt", content: "nope" }, context)).rejects.toThrow(
      "symlink outside cwd",
    );
    expect(approve).not.toHaveBeenCalled();
  });

  it("refuses a final symlink introduced while approval is pending", async () => {
    const cwd = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const outsideFile = path.join(outside, "outside.txt");
    await writeFile(outsideFile, "outside", "utf8");
    await writeFile(path.join(cwd, "target.txt"), "inside", "utf8");
    const write = tool(
      createWorkspaceTools({
        cwd,
        async approve() {
          await rm(path.join(cwd, "target.txt"));
          await symlink(outsideFile, path.join(cwd, "target.txt"));
          return true;
        },
      }),
      "write_file",
    );

    await expect(write.execute({ path: "target.txt", content: "nope" }, context)).rejects.toThrow(
      "symlink outside cwd",
    );
    expect(await readFile(outsideFile, "utf8")).toBe("outside");
  });

  it("atomically replaces a workspace hardlink without mutating the outside inode", async () => {
    const cwd = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const outsideFile = path.join(outside, "outside.txt");
    const workspaceFile = path.join(cwd, "innocent.txt");
    await writeFile(outsideFile, "outside", "utf8");
    await link(outsideFile, workspaceFile);

    const write = tool(createWorkspaceTools({ cwd, approve: () => true }), "write_file");
    await write.execute({ path: "innocent.txt", content: "inside" }, context);

    expect(await readFile(workspaceFile, "utf8")).toBe("inside");
    expect(await readFile(outsideFile, "utf8")).toBe("outside");
  });
});

describe("workspace reads and search", () => {
  it("lists, reads, truncates, and searches workspace files", async () => {
    const cwd = await temporaryDirectory();
    await mkdir(path.join(cwd, "src"));
    await writeFile(path.join(cwd, "README.md"), "hello drone\n", "utf8");
    await writeFile(path.join(cwd, "src", "agent.ts"), "export const drone = 'ready';\n", "utf8");
    const tools = createWorkspaceTools({ cwd, maxReadBytes: 5 });

    const listed = (await tool(tools, "list_files").execute(
      { path: ".", maxDepth: 2 },
      context,
    )) as { entries: Array<{ path: string; type: string }> };
    expect(listed.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "README.md", type: "file" }),
        expect.objectContaining({ path: "src/agent.ts", type: "file" }),
      ]),
    );

    const read = (await tool(tools, "read_file").execute(
      { path: "README.md" },
      context,
    )) as { content: string; size: number; truncated: boolean };
    expect(read).toMatchObject({ content: "hello", size: 12, truncated: true });

    // Search must behave the same whether ripgrep is installed or the bounded
    // filesystem fallback is used. Give the fallback enough bytes to inspect
    // these fixtures; the smaller limit above is specific to read_file.
    const searchTools = createWorkspaceTools({
      cwd,
      env: { PATH: "" },
      maxReadBytes: 1_024,
    });
    const searched = (await tool(searchTools, "search_files").execute(
      { query: "drone", path: ".", maxResults: 10 },
      context,
    )) as { matches: Array<{ path: string; line: number; text: string }> };
    expect(searched.matches).toEqual(
      expect.arrayContaining([
        { path: "README.md", line: 1, text: "hello drone" },
        { path: "src/agent.ts", line: 1, text: "export const drone = 'ready';" },
      ]),
    );
  });

  it("denies credential reads while allowing explicit environment templates", async () => {
    const cwd = await temporaryDirectory();
    await writeFile(path.join(cwd, ".env"), "TOKEN=hidden\n", "utf8");
    await writeFile(path.join(cwd, "credentials.json"), '{"token":"hidden"}\n', "utf8");
    await writeFile(path.join(cwd, ".env.example"), "TOKEN=example\n", "utf8");
    const read = tool(createWorkspaceTools({ cwd }), "read_file");

    await expect(read.execute({ path: ".env" }, context)).rejects.toThrow("sensitive credential");
    await expect(read.execute({ path: "credentials.json" }, context)).rejects.toThrow(
      "sensitive credential",
    );
    await expect(read.execute({ path: ".env.example" }, context)).resolves.toMatchObject({
      content: "TOKEN=example\n",
    });
  });

  it("filters sensitive credential paths from the filesystem search fallback", async () => {
    const cwd = await temporaryDirectory();
    await writeFile(path.join(cwd, ".env"), "needle=hidden\n", "utf8");
    await writeFile(path.join(cwd, "credentials.json"), "needle=hidden\n", "utf8");
    await writeFile(path.join(cwd, ".env.sample"), "needle=example\n", "utf8");
    await writeFile(path.join(cwd, "safe.txt"), "needle=safe\n", "utf8");
    const search = tool(
      createWorkspaceTools({ cwd, env: { PATH: "" }, maxReadBytes: 1_024 }),
      "search_files",
    );

    const result = (await search.execute(
      { query: "needle", path: ".", maxResults: 10 },
      context,
    )) as { engine?: string; matches: Array<{ path: string }> };
    expect(result.engine).toBe("fallback");
    expect(result.matches.map((match) => match.path).sort()).toEqual([".env.sample", "safe.txt"]);
    await expect(
      search.execute({ query: "needle", path: ".env", maxResults: 10 }, context),
    ).rejects.toThrow("sensitive credential");
  });
});

describe("workspace mutation approval", () => {
  it("requires explicit approval for writes by default", async () => {
    const cwd = await temporaryDirectory();
    const deniedWrite = tool(createWorkspaceTools({ cwd }), "write_file");
    await expect(
      deniedWrite.execute({ path: "denied.txt", content: "denied" }, context),
    ).rejects.toThrow("not approved");

    const requests: WorkspaceApprovalRequest[] = [];
    const approvedWrite = tool(
      createWorkspaceTools({
        cwd,
        approve(request) {
          requests.push(request);
          return true;
        },
      }),
      "write_file",
    );
    await approvedWrite.execute({ path: "nested/allowed.txt", content: "allowed" }, context);

    expect(await readFile(path.join(cwd, "nested", "allowed.txt"), "utf8")).toBe("allowed");
    expect(requests).toEqual([
      expect.objectContaining({ kind: "write_file", path: "nested/allowed.txt", bytes: 7 }),
    ]);
  });

  it("only bypasses approval when requireApproval is explicitly false", async () => {
    const cwd = await temporaryDirectory();
    const approve = vi.fn<(request: WorkspaceApprovalRequest) => boolean>(() => false);
    const write = tool(
      createWorkspaceTools({ cwd, approve, requireApproval: false }),
      "write_file",
    );

    await write.execute({ path: "bypassed.txt", content: "ok" }, context);
    expect(approve).not.toHaveBeenCalled();
    expect(await readFile(path.join(cwd, "bypassed.txt"), "utf8")).toBe("ok");
  });

  it("does not write or spawn when approval resolves after cancellation", async () => {
    const cwd = await temporaryDirectory();
    const controller = new AbortController();
    let resolveApproval: ((approved: boolean) => void) | undefined;
    const approvalStarted = deferred<void>();
    const approve = (): Promise<boolean> => {
      approvalStarted.resolve(undefined);
      return new Promise<boolean>((resolve) => {
        resolveApproval = resolve;
      });
    };
    const tools = createWorkspaceTools({ cwd, approve });
    const write = tool(tools, "write_file");
    const cancelledContext: DroneToolContext = {
      droneId: "workspace-test",
      abortSignal: controller.signal,
    };

    const pendingWrite = write.execute(
      { path: "late.txt", content: "must-not-exist" },
      cancelledContext,
    );
    await approvalStarted.promise;
    controller.abort();
    await expect(pendingWrite).rejects.toThrow("aborted");
    resolveApproval?.(true);
    await expect(readFile(path.join(cwd, "late.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    const commandController = new AbortController();
    let resolveCommandApproval: ((approved: boolean) => void) | undefined;
    const commandApprovalStarted = deferred<void>();
    const commandTools = createWorkspaceTools({
      cwd,
      approve: () => {
        commandApprovalStarted.resolve(undefined);
        return new Promise<boolean>((resolve) => {
          resolveCommandApproval = resolve;
        });
      },
    });
    const pendingCommand = tool(commandTools, "run_command").execute(
      { command: "touch spawned.txt" },
      { droneId: "workspace-test", abortSignal: commandController.signal },
    );
    await commandApprovalStarted.promise;
    commandController.abort();
    await expect(pendingCommand).rejects.toThrow("aborted");
    resolveCommandApproval?.(true);
    await expect(readFile(path.join(cwd, "spawned.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("can omit write and shell tools entirely", async () => {
    const cwd = await temporaryDirectory();
    const names = createWorkspaceTools({ cwd, allowWrites: false, allowShell: false }).map(
      (candidate) => candidate.name,
    );
    expect(names).not.toContain("write_file");
    expect(names).not.toContain("run_command");
    expect(names).toEqual(expect.arrayContaining(["list_files", "read_file", "search_files", "git_status"]));
  });

  it("runs approved commands with sanitized environment and bounded output", async () => {
    const cwd = await temporaryDirectory();
    const approve = vi.fn<(request: WorkspaceApprovalRequest) => boolean>(() => true);
    const run = tool(
      createWorkspaceTools({
        cwd,
        approve,
        maxOutputBytes: 1_024,
        env: {
          ...process.env,
          DRONE_SAFE_VALUE: "visible",
          DRONE_TEST_PASSWORD: "hidden",
        },
      }),
      "run_command",
    );
    const result = (await run.execute(
      { command: "printf '%s|%s' \"$DRONE_SAFE_VALUE\" \"${DRONE_TEST_PASSWORD-unset}\"" },
      context,
    )) as CommandResult;

    expect(result.stdout).toBe("visible|unset");
    expect(result.truncated).toBe(false);
    expect(approve).toHaveBeenCalledWith(expect.objectContaining({ kind: "run_command" }));

    const cappedRun = tool(
      createWorkspaceTools({ cwd, approve, maxOutputBytes: 16, env: process.env }),
      "run_command",
    );
    const capped = (await cappedRun.execute(
      { command: "printf 'abcdefghijklmnopqrstuvwxyz'" },
      context,
    )) as CommandResult;
    expect(Buffer.byteLength(capped.stdout) + Buffer.byteLength(capped.stderr)).toBeLessThanOrEqual(16);
    expect(capped.truncated).toBe(true);
  });

  it("does not execute login or non-interactive shell startup files", async () => {
    const cwd = await temporaryDirectory();
    const startup = path.join(cwd, "startup.sh");
    await writeFile(startup, "export DRONE_PROFILE_SECRET=restored\n", "utf8");
    const run = tool(
      createWorkspaceTools({
        cwd,
        approve: () => true,
        env: {
          ...process.env,
          BASH_ENV: startup,
          ENV: startup,
        },
      }),
      "run_command",
    );

    const result = (await run.execute(
      { command: "printf '%s' \"${DRONE_PROFILE_SECRET-unset}\"" },
      context,
    )) as CommandResult;
    expect(result.stdout).toBe("unset");
  });
});

describe("environment handling", () => {
  it("removes secret-like variables without changing the input", () => {
    const input = {
      PATH: "/usr/bin",
      DRONE_API_KEY: "secret",
      GITHUB_TOKEN: "secret",
      DATABASE_PASSWORD: "secret",
      AWS_ACCESS_KEY_ID: "secret",
      SAFE_SETTING: "kept",
    } as const;

    expect(sanitizeEnvironment(input)).toEqual({ PATH: "/usr/bin", SAFE_SETTING: "kept" });
    expect(input.DRONE_API_KEY).toBe("secret");
  });

  it("prefers DRONE_API_KEY and then the provider-specific environment key", async () => {
    const cwd = await temporaryDirectory();
    const global = createEnvironmentHost({
      cwd,
      env: { DRONE_API_KEY: "drone-key", ANTHROPIC_API_KEY: "provider-key" },
    });
    await expect(global.resolveApiKey({ provider: "anthropic", model: "test" })).resolves.toEqual({
      apiKey: "drone-key",
      source: "env:DRONE_API_KEY",
    });

    const provider = createEnvironmentHost({ cwd, env: { ANTHROPIC_API_KEY: "provider-key" } });
    await expect(provider.resolveApiKey({ provider: "anthropic", model: "test" })).resolves.toEqual({
      apiKey: "provider-key",
      source: "env:ANTHROPIC_API_KEY",
    });

    await writeFile(path.join(cwd, ".env"), "DRONE_API_KEY=project-drone-key\n", "utf8");
    const environmentOverride = createEnvironmentHost({
      cwd,
      env: { ANTHROPIC_API_KEY: "provider-key" },
    });
    await expect(
      environmentOverride.resolveApiKey({ provider: "anthropic", model: "test" }),
    ).resolves.toEqual({
      apiKey: "provider-key",
      source: "env:ANTHROPIC_API_KEY",
    });

    const projectFallback = createEnvironmentHost({ cwd, env: {} });
    await expect(
      projectFallback.resolveApiKey({ provider: "anthropic", model: "test" }),
    ).resolves.toEqual({
      apiKey: "project-drone-key",
      source: ".env:DRONE_API_KEY",
    });
  });

  it("loads recognized keys from cwd .env without injecting process.env", async () => {
    const cwd = await temporaryDirectory();
    const original = process.env.ACME_API_KEY;
    await writeFile(
      path.join(cwd, ".env"),
      "UNRELATED_SECRET=ignore-me\nACME_API_KEY='from-dotenv'\n",
      "utf8",
    );
    const host = createEnvironmentHost({ cwd, env: {} });

    await expect(host.resolveApiKey({ provider: "acme", model: "test" })).resolves.toEqual({
      apiKey: "from-dotenv",
      source: ".env:ACME_API_KEY",
    });
    expect(process.env.ACME_API_KEY).toBe(original);
    expect(host.resolveSkillsPrompt(undefined)).toBe("");
  });
});
