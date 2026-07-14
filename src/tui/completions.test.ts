import { describe, expect, it } from "vitest";
import {
  SLASH_COMMANDS,
  acceptCompletion,
  findCompletionContext,
  getCompletions,
  moveCompletionSelection,
  type WorkspacePathInput,
} from "./completions.js";

describe("slash command completions", () => {
  it("catalogs every supported command, /skills, and command aliases", () => {
    expect(SLASH_COMMANDS.map((command) => command.name)).toEqual([
      "help",
      "config",
      "status",
      "clear",
      "history",
      "agents",
      "spawn",
      "close-agent",
      "model",
      "skills",
      "exit",
    ]);
    expect(SLASH_COMMANDS.find((command) => command.name === "help")?.aliases).toContain("?");
    expect(SLASH_COMMANDS.find((command) => command.name === "exit")?.aliases).toContain("quit");
  });

  it("filters live without regard to case", () => {
    expect(getCompletions({ prompt: "/CO" })?.items.map((item) => item.label)).toEqual([
      "/config",
    ]);
    expect(getCompletions({ prompt: "/q" })?.items.map((item) => item.label)).toEqual([
      "/quit",
    ]);
  });

  it("offers canonical commands for an empty slash query", () => {
    const labels = getCompletions({ prompt: "/", limit: 100 })?.items.map((item) => item.label);
    expect(labels).toEqual([
      "/help",
      "/config",
      "/status",
      "/clear",
      "/history",
      "/agents",
      "/spawn",
      "/close-agent",
      "/model",
      "/skills",
      "/exit",
    ]);
  });

  it("only treats a slash as a command in the first prompt token", () => {
    expect(findCompletionContext("  /he")).toMatchObject({ kind: "slash", query: "he" });
    expect(findCompletionContext("explain /help")).toBeUndefined();
  });
});

describe("workspace path completions", () => {
  const workspacePaths: WorkspacePathInput[] = [
    "src/",
    { path: "src/tui", kind: "directory" },
    "src/tui/app.ts",
    "src/tui/art.ts",
    "README.md",
    ".git/config",
    "node_modules/package/index.js",
    "packages/tool/node_modules/cache.js",
    "../outside.txt",
    "/etc/passwd",
    "C:\\Users\\outside.txt",
  ];

  it("filters safe relative paths and distinguishes directories", () => {
    const model = getCompletions({ prompt: "inspect @SRC/T", workspacePaths });

    expect(model?.items).toEqual([
      expect.objectContaining({ kind: "directory", label: "@src/tui/" }),
      expect.objectContaining({ kind: "file", label: "@src/tui/app.ts" }),
      expect.objectContaining({ kind: "file", label: "@src/tui/art.ts" }),
    ]);
  });

  it("opens a workspace context for a bare @", () => {
    expect(findCompletionContext("explain @", 9)).toMatchObject({
      kind: "workspace-path",
      query: "",
      start: 8,
      end: 9,
    });
  });

  it("does not treat apostrophes in ordinary prose as quoted mentions", () => {
    expect(findCompletionContext("don't inspect @src")).toMatchObject({
      kind: "workspace-path",
      query: "src",
    });
  });

  it("shows only direct children for an empty scoped query", () => {
    const labels = getCompletions({
      prompt: "@",
      workspacePaths,
      workspaceOnlyImmediate: true,
      limit: 100,
    })?.items.map((item) => item.label);

    expect(labels).toEqual(["@src/", "@README.md"]);
  });

  it("uses case-insensitive substring search throughout recursive paths", () => {
    const labels = getCompletions({
      prompt: "@app",
      workspacePaths: [
        { path: "packages/web/src/AppShell.ts", kind: "file" },
        { path: "services/application/config.ts", kind: "file" },
        { path: "docs/guide.md", kind: "file" },
      ],
    })?.items.map((item) => item.label);

    expect(labels).toEqual(["@packages/web/src/AppShell.ts", "@services/application/config.ts"]);
  });

  it("ranks recursive substring matches deterministically", () => {
    const labels = getCompletions({
      prompt: "@app",
      workspacePaths: [
        "services/application/config.ts",
        "src/zapper.ts",
        "src/AppShell.ts",
        "app/",
      ],
    })?.items.map((item) => item.label);

    expect(labels).toEqual([
      "@app/",
      "@src/AppShell.ts",
      "@src/zapper.ts",
      "@services/application/config.ts",
    ]);
  });

  it("omits an accepted directory while continuing with its descendants", () => {
    const model = getCompletions({
      prompt: "@src/",
      workspacePaths: ["src/", "src/tui/", "src/app.ts", "other.ts"],
    });

    expect(model?.items.map((item) => item.label)).toEqual(["@src/tui/", "@src/app.ts"]);
    expect(model?.context.query).toBe("src/");
  });

  it("preserves temporary search prefixes in labels and accepted edits", () => {
    const model = getCompletions({
      prompt: "inspect @../note",
      workspaceQuery: "note",
      workspaceDisplayPrefix: "../",
      workspacePaths: [{ path: "archive/notes.md", kind: "file" }],
    });

    expect(model?.items[0]?.label).toBe("@../archive/notes.md");
    expect(model && acceptCompletion(model)).toEqual({
      prompt: "inspect @../archive/notes.md",
      caret: "inspect @../archive/notes.md".length,
    });
  });

  it("never exposes .git, node_modules, parent, or absolute path noise", () => {
    const labels = getCompletions({ prompt: "@", workspacePaths, limit: 100 })?.items.map(
      (item) => item.label,
    );

    expect(labels).toEqual(["@src/", "@src/tui/", "@README.md", "@src/tui/app.ts", "@src/tui/art.ts"]);
    expect(labels?.join(" ")).not.toMatch(/node_modules|\.git|outside|passwd/u);
  });

  it("bounds result counts", () => {
    const manyPaths = Array.from({ length: 30 }, (_, index) => `file-${index}.ts`);
    expect(getCompletions({ prompt: "@", workspacePaths: manyPaths })?.items).toHaveLength(12);
    expect(getCompletions({ prompt: "@", workspacePaths: manyPaths, limit: 3 })?.items).toHaveLength(3);
    expect(getCompletions({ prompt: "@", workspacePaths: manyPaths, limit: 1_000 })?.items).toHaveLength(30);
  });

  it("can retain a full large result set for a virtualized menu", () => {
    const manyPaths = Array.from({ length: 250 }, (_, index) => `packages/package-${index}/`);
    expect(getCompletions({ prompt: "@", workspacePaths: manyPaths, limit: 250 })?.items).toHaveLength(
      250,
    );
  });

  it("quotes accepted paths that contain spaces", () => {
    const model = getCompletions({
      prompt: "inspect @docs",
      workspacePaths: [{ path: "docs/My File.md", kind: "file" }],
    });
    expect(model && acceptCompletion(model)).toEqual({
      prompt: 'inspect @"docs/My File.md"',
      caret: 'inspect @"docs/My File.md"'.length,
    });
  });

  it("keeps quoted directories as one completable token", () => {
    const initial = getCompletions({
      prompt: "open @docs",
      workspacePaths: [{ path: "docs/My Dir/", kind: "directory" }],
    });
    const edit = initial && acceptCompletion(initial);

    expect(edit).toEqual({
      prompt: 'open @"docs/My Dir/"',
      caret: 'open @"docs/My Dir/"'.length,
    });
    expect(edit && findCompletionContext(edit.prompt, edit.caret)).toMatchObject({
      kind: "workspace-path",
      query: "docs/My Dir/",
      start: 5,
      end: edit?.prompt.length,
    });
  });

  it("escapes embedded quotes in quoted path completions", () => {
    const model = getCompletions({
      prompt: "open @guide",
      workspacePaths: [{ path: 'docs/My "Guide".md', kind: "file" }],
    });
    const edit = model && acceptCompletion(model);

    expect(edit?.prompt).toBe('open @"docs/My \\"Guide\\".md"');
    expect(edit && findCompletionContext(edit.prompt, edit.caret)?.query).toBe(
      'docs/My "Guide".md',
    );
  });
});

describe("skill completions", () => {
  const skills = [
    { name: "frontend-design", description: "Build polished interfaces" },
    { name: "form-cro", description: "Improve lead forms" },
    "lessons-learned",
  ];

  it("opens a filtered second-level menu after /skills", () => {
    const model = getCompletions({ prompt: "/skills F", skills });
    expect(model?.context).toMatchObject({ kind: "skill", query: "F" });
    expect(model?.items).toEqual([
      expect.objectContaining({
        kind: "skill",
        label: "/skills form-cro",
        description: "Improve lead forms",
      }),
      expect.objectContaining({
        kind: "skill",
        label: "/skills frontend-design",
        description: "Build polished interfaces",
      }),
    ]);
  });

  it("accepts a skill argument while preserving the /skills command", () => {
    const model = getCompletions({ prompt: "/skills front", skills });
    expect(model && acceptCompletion(model)).toEqual({
      prompt: "/skills frontend-design",
      caret: "/skills frontend-design".length,
    });
  });

  it("suggests all injected skills immediately after the command space", () => {
    expect(getCompletions({ prompt: "/skills ", skills })?.items).toHaveLength(3);
  });
});

describe("completion editing and navigation", () => {
  it("detects the active token at an injected caret and replaces the full token", () => {
    const prompt = "check @src/apx next";
    const caret = prompt.indexOf("x");
    const model = getCompletions({
      prompt,
      caret,
      workspacePaths: ["src/app.ts"],
    });

    expect(model?.context).toMatchObject({
      kind: "workspace-path",
      query: "src/ap",
      start: 6,
      end: 14,
    });
    expect(model && acceptCompletion(model)).toEqual({
      prompt: "check @src/app.ts next",
      caret: "check @src/app.ts".length,
    });
  });

  it("preserves prompt text surrounding an accepted slash completion", () => {
    const prompt = "  /he trailing";
    const caret = prompt.indexOf(" trailing");
    const model = getCompletions({ prompt, caret });
    expect(model && acceptCompletion(model)).toEqual({
      prompt: "  /help trailing",
      caret: "  /help".length,
    });
  });

  it("wraps selected-index navigation in both directions", () => {
    const model = getCompletions({ prompt: "/", limit: 3 });
    expect(model).toBeDefined();
    if (!model) return;

    expect(moveCompletionSelection(model, -1).selectedIndex).toBe(2);
    expect(moveCompletionSelection({ ...model, selectedIndex: 2 }, 1).selectedIndex).toBe(0);
    expect(moveCompletionSelection(model, 4).selectedIndex).toBe(1);
  });

  it("has no selected result or accepted edit when filtering finds nothing", () => {
    const model = getCompletions({ prompt: "/not-a-command" });
    expect(model?.selectedIndex).toBe(-1);
    expect(model && acceptCompletion(model)).toBeUndefined();
  });

  it("selects the first item when multiple results arrive after an empty model", () => {
    expect(
      getCompletions({ prompt: "@", workspacePaths: ["a.ts", "b.ts"], selectedIndex: -1 })
        ?.selectedIndex,
    ).toBe(0);
  });
});
