import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_DRONE_CONFIG,
  getDroneConfigPaths,
  loadDroneConfig,
  resolveDroneConfig,
  saveProjectConfig,
  saveUserConfig,
} from "./config.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "drone-config-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("drone config paths", () => {
  it("uses XDG_CONFIG_HOME and the working directory", () => {
    expect(
      getDroneConfigPaths({
        cwd: "/workspace/repo",
        homeDir: "/home/tester",
        env: { XDG_CONFIG_HOME: "/xdg/config" },
      }),
    ).toEqual({
      user: "/xdg/config/drone/config.json",
      project: "/workspace/repo/.drone/config.json",
    });
  });

  it("falls back to ~/.config when XDG_CONFIG_HOME is absent", () => {
    expect(getDroneConfigPaths({ cwd: "/repo", homeDir: "/home/tester", env: {} }).user).toBe(
      "/home/tester/.config/drone/config.json",
    );
  });
});

describe("resolveDroneConfig", () => {
  it("deeply layers defaults, user, project, environment, and overrides", () => {
    const result = resolveDroneConfig({
      user: {
        provider: "openrouter",
        timeoutMs: 10_000,
        ui: { theme: "dark", mouse: "off" },
        runtime: { allowWrites: false },
      },
      project: {
        timeoutMs: 20_000,
        ui: { mouse: "on", art: "compact" },
      },
      env: {
        DRONE_TIMEOUT_MS: "30000",
        DRONE_MOUSE: "off",
        DRONE_MOTION: "reduced",
        DRONE_SCREEN: "split",
        DRONE_ALLOW_SHELL: "0",
      },
      overrides: {
        timeoutMs: 40_000,
        ui: { theme: "mono" },
      },
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.config).toMatchObject({
      provider: "openrouter",
      timeoutMs: 40_000,
      ui: {
        theme: "mono",
        mouse: "off",
        art: "compact",
        motion: "reduced",
        screen: "split",
        mouseClicks: DEFAULT_DRONE_CONFIG.ui.mouseClicks,
      },
      runtime: {
        allowShell: false,
        allowWrites: false,
      },
    });
  });

  it("uses NO_COLOR while allowing an explicit theme to win", () => {
    expect(resolveDroneConfig({ env: { NO_COLOR: "" } }).config.ui.theme).toBe("mono");
    expect(
      resolveDroneConfig({ env: { NO_COLOR: "1", DRONE_THEME: "dark" } }).config.ui.theme,
    ).toBe("dark");
    expect(
      resolveDroneConfig({ env: { DRONE_NO_COLOR: "false" } }).config.ui.theme,
    ).toBe(DEFAULT_DRONE_CONFIG.ui.theme);
  });

  it("never lets project config weaken runtime safety", () => {
    const result = resolveDroneConfig({
      user: {
        runtime: { allowShell: false, allowWrites: false, requireApproval: true },
      },
      project: {
        runtime: { allowShell: true, allowWrites: true, requireApproval: false },
      },
      env: {},
    });

    expect(result.config.runtime).toMatchObject({
      allowShell: false,
      allowWrites: false,
      requireApproval: true,
    });
    expect(result.diagnostics.map((diagnostic) => diagnostic.key)).toEqual([
      "runtime.allowShell",
      "runtime.allowWrites",
      "runtime.requireApproval",
    ]);
  });

  it("keeps valid values and reports invalid or unknown values", () => {
    const result = resolveDroneConfig({
      user: {
        model: "claude-haiku-4-5",
        timeoutMs: -1,
        apiKey: "must-not-be-retained",
        ui: { mouse: "sometimes", screen: "fullscreen", extra: true },
      },
      env: {
        DRONE_MAX_STEPS: "many",
        DRONE_TEMPERATURE: "8",
      },
    });

    expect(result.config.model).toBe("claude-haiku-4-5");
    expect(result.config.timeoutMs).toBe(DEFAULT_DRONE_CONFIG.timeoutMs);
    expect(result.config.ui.mouse).toBe(DEFAULT_DRONE_CONFIG.ui.mouse);
    expect(result.config.temperature).toBe(DEFAULT_DRONE_CONFIG.temperature);
    expect(result.diagnostics.map((diagnostic) => diagnostic.key)).toEqual(
      expect.arrayContaining([
        "apiKey",
        "timeoutMs",
        "ui.mouse",
        "ui.screen",
        "ui.extra",
        "DRONE_MAX_STEPS",
        "temperature",
      ]),
    );
  });
});

describe("loadDroneConfig", () => {
  it("loads user and project JSON and preserves precedence", async () => {
    const root = await temporaryDirectory();
    const home = join(root, "home");
    const cwd = join(root, "repo");
    const userPath = join(home, ".config", "drone", "config.json");
    const projectPath = join(cwd, ".drone", "config.json");
    await mkdir(join(home, ".config", "drone"), { recursive: true });
    await mkdir(join(cwd, ".drone"), { recursive: true });
    await writeFile(userPath, JSON.stringify({ model: "user-model", ui: { art: "off" } }));
    await writeFile(projectPath, JSON.stringify({ model: "project-model" }));

    const loaded = await loadDroneConfig({ homeDir: home, cwd, env: {} });

    expect(loaded.config.model).toBe("project-model");
    expect(loaded.config.ui.art).toBe("off");
    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.paths).toEqual({ user: userPath, project: projectPath });
  });

  it("returns defaults plus diagnostics rather than crashing on malformed files", async () => {
    const root = await temporaryDirectory();
    const userPath = join(root, "user.json");
    const projectPath = join(root, "project.json");
    await writeFile(userPath, "{ definitely-not-json");
    await writeFile(projectPath, JSON.stringify({ maxSteps: 0, provider: "openai" }));

    const loaded = await loadDroneConfig({ userConfigPath: userPath, projectConfigPath: projectPath, env: {} });

    expect(loaded.config.provider).toBe("openai");
    expect(loaded.config.maxSteps).toBe(DEFAULT_DRONE_CONFIG.maxSteps);
    expect(loaded.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "parse_error",
      "invalid_value",
    ]);
  });

  it("silently ignores missing config files", async () => {
    const root = await temporaryDirectory();
    const loaded = await loadDroneConfig({ cwd: root, homeDir: root, env: {} });
    expect(loaded.config).toEqual(DEFAULT_DRONE_CONFIG);
    expect(loaded.diagnostics).toEqual([]);
  });
});

describe("save config", () => {
  it("creates user and project config directories", async () => {
    const root = await temporaryDirectory();
    const user = await saveUserConfig(
      { provider: "openai", ui: { motion: "reduced" } },
      { homeDir: join(root, "home"), env: {} },
    );
    const project = await saveProjectConfig(
      { runtime: { allowWrites: false, requireApproval: true } },
      { cwd: join(root, "repo") },
    );

    expect(JSON.parse(await readFile(user.path, "utf8"))).toEqual({
      provider: "openai",
      ui: { motion: "reduced" },
    });
    expect(JSON.parse(await readFile(project.path, "utf8"))).toEqual({
      runtime: { allowWrites: false, requireApproval: true },
    });
  });

  it("never persists API keys or other unsupported fields", async () => {
    const root = await temporaryDirectory();
    const saved = await saveProjectConfig(
      {
        model: "safe-model",
        apiKey: "secret",
        runtime: { allowShell: false, token: "also-secret" },
      },
      { cwd: root },
    );
    const contents = await readFile(saved.path, "utf8");

    expect(JSON.parse(contents)).toEqual({ model: "safe-model", runtime: { allowShell: false } });
    expect(contents).not.toContain("secret");
    expect(saved.diagnostics.map((diagnostic) => diagnostic.key)).toEqual([
      "apiKey",
      "runtime.token",
    ]);
  });
});
