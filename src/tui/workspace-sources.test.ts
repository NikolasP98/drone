import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  discoverWorkspaceReferences,
  discoverWorkspaceSkills,
  MAX_ACTIVE_SKILLS,
  renderActiveSkills,
} from "./workspace-sources.js";

describe("workspace completion sources", () => {
  it("discovers bounded files and directories while skipping noisy and symbolic trees", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "drone-references-"));
    await mkdir(path.join(cwd, "src", "nested"), { recursive: true });
    await mkdir(path.join(cwd, "node_modules", "hidden"), { recursive: true });
    await writeFile(path.join(cwd, "README.md"), "hello");
    await writeFile(path.join(cwd, "src", "index.ts"), "export {};");
    await symlink(tmpdir(), path.join(cwd, "outside"));

    const references = await discoverWorkspaceReferences(cwd);

    expect(references).toContainEqual({ path: "src", kind: "directory" });
    expect(references).toContainEqual({ path: "src/index.ts", kind: "file" });
    expect(references).toContainEqual({ path: "README.md", kind: "file" });
    expect(references.some((entry) => entry.path.includes("node_modules"))).toBe(false);
    expect(references.some((entry) => entry.path === "outside")).toBe(false);
  });

  it("discovers local skill manifests and renders only active skill context", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "drone-skills-"));
    const skillDir = path.join(cwd, ".agents", "skills", "reviewer");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      path.join(skillDir, "SKILL.md"),
      [
        "---",
        "name: careful-review",
        'description: "Review changes carefully"',
        "---",
        "# Reviewer",
        "Always inspect the diff.",
      ].join("\n"),
    );

    const skills = await discoverWorkspaceSkills(cwd, { includeUser: false });

    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      name: "careful-review",
      description: "Review changes carefully",
      path: ".agents/skills/reviewer/SKILL.md",
      scope: "workspace",
    });
    expect(renderActiveSkills(skills, new Set())).toBe("");
    expect(renderActiveSkills(skills, new Set(["careful-review"]))).toContain(
      "Always inspect the diff.",
    );
  });

  it("bounds active skill context consistently", () => {
    const skills = Array.from({ length: MAX_ACTIVE_SKILLS + 2 }, (_, index) => ({
      name: `skill-${index}`,
      description: "test",
      path: `skills/skill-${index}/SKILL.md`,
      scope: "workspace" as const,
      content: `instructions-${index}`,
    }));
    const rendered = renderActiveSkills(skills, new Set(skills.map((skill) => skill.name)));
    expect(rendered.match(/<workspace_skill /gu)).toHaveLength(MAX_ACTIVE_SKILLS);
    expect(rendered).not.toContain(`instructions-${MAX_ACTIVE_SKILLS}`);
  });
});
