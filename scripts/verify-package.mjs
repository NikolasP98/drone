import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));

function fail(message) {
  throw new Error(`package verification failed: ${message}`);
}

function parseArguments(argv) {
  let packDestination;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--pack-destination") {
      packDestination = argv[index + 1];
      if (!packDestination) fail("--pack-destination requires a path");
      index += 1;
      continue;
    }
    fail(`unknown argument: ${argument}`);
  }
  return { packDestination };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: options.stdio ?? "pipe",
  });
  if (result.error) throw result.error;
  return result;
}

function expectSuccess(result, label) {
  if (result.status !== 0) {
    fail(`${label} exited ${String(result.status)}\n${result.stderr || result.stdout}`);
  }
}

function expectExact(result, expected, label) {
  expectSuccess(result, label);
  if (result.stderr !== "") fail(`${label} wrote to stderr: ${result.stderr}`);
  if (result.stdout !== expected) {
    fail(`${label} output mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(result.stdout)}`);
  }
}

const { packDestination: requestedDestination } = parseArguments(process.argv.slice(2));
const temporaryRoot = mkdtempSync(path.join(tmpdir(), "drone-package-verify-"));
const packDestination = requestedDestination
  ? path.resolve(requestedDestination)
  : path.join(temporaryRoot, "package");
const installRoot = path.join(temporaryRoot, "install");
const home = path.join(temporaryRoot, "home");
const configHome = path.join(temporaryRoot, "config");
const workspace = path.join(temporaryRoot, "workspace");

try {
  mkdirSync(packDestination, { recursive: true });
  const existingTarballs = readdirSync(packDestination).filter((entry) => entry.endsWith(".tgz"));
  if (existingTarballs.length > 0) {
    fail(`pack destination must not contain tarballs: ${packDestination}`);
  }

  execFileSync("pnpm", ["pack", "--pack-destination", packDestination], {
    cwd: repositoryRoot,
    env: process.env,
    stdio: "inherit",
  });

  const tarballs = readdirSync(packDestination)
    .filter((entry) => entry.endsWith(".tgz"))
    .map((entry) => path.join(packDestination, entry));
  if (tarballs.length !== 1) fail(`expected one tarball in ${packDestination}, found ${tarballs.length}`);
  const tarball = path.resolve(tarballs[0]);

  mkdirSync(installRoot, { recursive: true });
  execFileSync(
    "npm",
    ["install", "--prefix", installRoot, "--ignore-scripts", "--no-audit", "--no-fund", tarball],
    { cwd: temporaryRoot, env: process.env, stdio: "inherit" },
  );

  const installedPackageRoot = path.join(installRoot, "node_modules", packageJson.name);
  const installedPackageJson = JSON.parse(
    readFileSync(path.join(installedPackageRoot, "package.json"), "utf8"),
  );
  if (installedPackageJson.version !== packageJson.version) {
    fail(`installed version ${installedPackageJson.version} does not match ${packageJson.version}`);
  }

  for (const requiredPath of [
    "dist/cli.js",
    "dist/index.js",
    "dist/index.d.ts",
    "docs/TUI-RUNTIME.md",
    "LICENSE",
    "README.md",
  ]) {
    if (!existsSync(path.join(installedPackageRoot, requiredPath))) {
      fail(`tarball is missing ${requiredPath}`);
    }
  }

  const cliPath = path.join(installedPackageRoot, "dist", "cli.js");
  if (process.platform !== "win32" && (statSync(cliPath).mode & 0o111) === 0) {
    fail("dist/cli.js is not executable");
  }

  const bun = run("bun", ["--version"]);
  expectSuccess(bun, "bun --version");

  mkdirSync(home, { recursive: true });
  mkdirSync(configHome, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  const isolatedEnvironment = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: configHome,
    TERM: "dumb",
    DRONE_THEME: "mono",
  };
  const binaryPath = path.join(installRoot, "node_modules", ".bin", "drone");

  expectExact(
    run(binaryPath, ["--version"], { cwd: workspace, env: isolatedEnvironment }),
    `${packageJson.version}\n`,
    "installed drone --version",
  );

  const help = run(binaryPath, ["--help"], { cwd: workspace, env: isolatedEnvironment });
  expectSuccess(help, "installed drone --help");
  if (help.stderr !== "") fail(`installed drone --help wrote to stderr: ${help.stderr}`);
  if (!help.stdout.includes(`Minion Drone ${packageJson.version}`)) {
    fail("installed drone --help does not contain the package version");
  }
  if (/\x1b\[[0-?]*[ -/]*[@-~]/.test(help.stdout)) {
    fail("installed drone --help emitted terminal control sequences");
  }

  const config = run(binaryPath, ["--cwd", workspace, "config"], {
    cwd: workspace,
    env: isolatedEnvironment,
  });
  expectSuccess(config, "installed drone config");
  if (config.stderr !== "") fail(`installed drone config wrote to stderr: ${config.stderr}`);
  const parsedConfig = JSON.parse(config.stdout);
  const expectedUserConfig = path.join(configHome, "drone", "config.json");
  const expectedProjectConfig = path.join(workspace, ".drone", "config.json");
  if (parsedConfig.paths?.user !== expectedUserConfig) {
    fail(`config used unexpected user path: ${String(parsedConfig.paths?.user)}`);
  }
  if (parsedConfig.paths?.project !== expectedProjectConfig) {
    fail(`config used unexpected project path: ${String(parsedConfig.paths?.project)}`);
  }
  if (!Array.isArray(parsedConfig.diagnostics) || parsedConfig.diagnostics.length !== 0) {
    fail("isolated config reported diagnostics");
  }

  const libraryImport = run(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { defineDrone, runDroneStream } from ${JSON.stringify(packageJson.name)};\n` +
        `if (typeof defineDrone !== "function" || typeof runDroneStream !== "function") process.exit(1);`,
    ],
    { cwd: installRoot, env: isolatedEnvironment },
  );
  expectSuccess(libraryImport, "installed package library import");

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `tarball=${tarball}\n`);
    appendFileSync(process.env.GITHUB_OUTPUT, `package_name=${packageJson.name}\n`);
    appendFileSync(process.env.GITHUB_OUTPUT, `package_version=${packageJson.version}\n`);
  }
  process.stdout.write(`Verified ${packageJson.name}@${packageJson.version} from ${tarball}\n`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
