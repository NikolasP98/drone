import { lstat, readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export type WorkspaceReference = {
  path: string;
  kind: "file" | "directory";
};

export type WorkspaceSkill = {
  name: string;
  description: string;
  path: string;
  scope: "workspace" | "user";
  content: string;
};

export type WorkspaceReferenceDiscoveryOptions = {
  maxDepth?: number;
  maxEntries?: number;
};

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".next",
  ".svelte-kit",
  ".system",
  ".turbo",
  ".worktrees",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "vendor",
]);

const WORKSPACE_SKILL_ROOTS = [
  ".agents/skills",
  ".codex/skills",
  "codex/skills",
  ".claude/skills",
  "skills",
];
const USER_SKILL_ROOTS = [".agents/skills", ".codex/skills", ".claude/skills"];
const MAX_SKILL_BYTES = 128 * 1024;
export const MAX_ACTIVE_SKILLS = 6;

function portable(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

function isIgnoredDirectory(name: string): boolean {
  return IGNORED_DIRECTORIES.has(name);
}

export async function discoverWorkspaceReferences(
  cwd: string,
  options: WorkspaceReferenceDiscoveryOptions = {},
): Promise<WorkspaceReference[]> {
  const maxDepth = Math.max(1, options.maxDepth ?? 4);
  const maxEntries = Math.max(1, options.maxEntries ?? 1_500);
  const found: WorkspaceReference[] = [];
  const queue: Array<{ absolute: string; relative: string; depth: number }> = [
    { absolute: path.resolve(cwd), relative: "", depth: 0 },
  ];

  while (queue.length > 0 && found.length < maxEntries) {
    const current = queue.shift();
    if (!current) break;

    let entries;
    try {
      entries = await readdir(current.absolute, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      if (found.length >= maxEntries) break;
      if (entry.isSymbolicLink()) continue;
      if (entry.name.startsWith(".") && entry.name !== ".drone") continue;
      const relative = current.relative ? path.join(current.relative, entry.name) : entry.name;
      const referencePath = portable(relative);
      if (entry.isDirectory()) {
        if (isIgnoredDirectory(entry.name)) continue;
        found.push({ path: referencePath, kind: "directory" });
        if (current.depth + 1 < maxDepth) {
          queue.push({
            absolute: path.join(current.absolute, entry.name),
            relative,
            depth: current.depth + 1,
          });
        }
      } else if (entry.isFile()) {
        found.push({ path: referencePath, kind: "file" });
      }
    }
  }

  return found.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
    return left.path.localeCompare(right.path);
  });
}

function frontmatterValue(content: string, key: string): string | undefined {
  if (!content.startsWith("---")) return undefined;
  const end = content.indexOf("\n---", 3);
  if (end < 0) return undefined;
  const match = content
    .slice(3, end)
    .match(new RegExp(`^${key}:\\s*(.+?)\\s*$`, "m"));
  return match?.[1]?.trim().replace(/^(["'])(.*)\1$/, "$2");
}

function firstDescriptionLine(content: string): string {
  const withoutFrontmatter = content.startsWith("---")
    ? content.slice(Math.max(0, content.indexOf("\n---", 3) + 4))
    : content;
  return (
    withoutFrontmatter
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !line.startsWith("#")) ?? "Workspace skill"
  ).slice(0, 180);
}

export async function discoverWorkspaceSkills(
  cwd: string,
  options: { includeUser?: boolean } = {},
): Promise<WorkspaceSkill[]> {
  const root = path.resolve(cwd);
  const skills: WorkspaceSkill[] = [];
  const rootSpecs = [
    ...WORKSPACE_SKILL_ROOTS.map((relativeRoot) => ({
      base: root,
      relativeRoot,
      scope: "workspace" as const,
    })),
    ...(options.includeUser === false
      ? []
      : USER_SKILL_ROOTS.map((relativeRoot) => ({
          base: homedir(),
          relativeRoot,
          scope: "user" as const,
        }))),
  ];

  for (const rootSpec of rootSpecs) {
    const absoluteRoot = path.join(rootSpec.base, rootSpec.relativeRoot);
    try {
      const rootInfo = await lstat(absoluteRoot);
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) continue;
    } catch {
      continue;
    }

    const queue: Array<{ absolute: string; depth: number }> = [{ absolute: absoluteRoot, depth: 0 }];
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) break;
      let entries;
      try {
        entries = await readdir(current.absolute, { withFileTypes: true });
      } catch {
        continue;
      }

      const manifest = entries.find((entry) => entry.name === "SKILL.md" && entry.isFile());
      if (manifest) {
        const manifestPath = path.join(current.absolute, manifest.name);
        try {
          const info = await stat(manifestPath);
          if (info.size <= MAX_SKILL_BYTES) {
            const content = await readFile(manifestPath, "utf8");
            const fallbackName = path.basename(current.absolute);
            skills.push({
              name: frontmatterValue(content, "name") ?? fallbackName,
              description:
                frontmatterValue(content, "description") ?? firstDescriptionLine(content),
              path:
                rootSpec.scope === "workspace"
                  ? portable(path.relative(root, manifestPath))
                  : `~/${portable(path.relative(homedir(), manifestPath))}`,
              scope: rootSpec.scope,
              content,
            });
          }
        } catch {
          // An unreadable skill should not prevent the composer from starting.
        }
      }

      if (current.depth >= 3) continue;
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || isIgnoredDirectory(entry.name)) continue;
        queue.push({ absolute: path.join(current.absolute, entry.name), depth: current.depth + 1 });
      }
    }
  }

  const byName = new Map<string, WorkspaceSkill>();
  for (const skill of skills) {
    const key = skill.name.toLowerCase();
    if (!byName.has(key)) byName.set(key, skill);
  }
  return [...byName.values()].sort((left, right) =>
    left.name.localeCompare(right.name) || left.path.localeCompare(right.path),
  );
}

export function renderActiveSkills(
  skills: readonly WorkspaceSkill[],
  activeNames: ReadonlySet<string>,
): string {
  const active = skills
    .filter((skill) => activeNames.has(skill.name))
    .slice(0, MAX_ACTIVE_SKILLS);
  if (active.length === 0) return "";
  return active
    .map(
      (skill) =>
        `<workspace_skill name="${skill.name}" source="${skill.path}">\n${skill.content}\n</workspace_skill>`,
    )
    .join("\n\n");
}
