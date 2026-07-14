export type CompletionKind = "command" | "skill" | "file" | "directory";
export type CompletionContextKind = "slash" | "skill" | "workspace-path";

export interface SlashCommandDefinition {
  name: string;
  description: string;
  usage: string;
  aliases?: readonly string[];
}

export const SLASH_COMMANDS: readonly SlashCommandDefinition[] = [
  {
    name: "help",
    aliases: ["?"],
    usage: "/help",
    description: "Show the flight manual and keyboard shortcuts",
  },
  {
    name: "config",
    usage: "/config",
    description: "Show configuration for the current flight",
  },
  {
    name: "status",
    usage: "/status",
    description: "Show runtime, model, workspace, and config diagnostics",
  },
  {
    name: "clear",
    usage: "/clear",
    description: "Clear the conversation transcript",
  },
  {
    name: "model",
    usage: "/model <provider/model>",
    description: "Change the model for the current flight",
  },
  {
    name: "skills",
    usage: "/skills [name]",
    description: "Browse or toggle skills for the current flight",
  },
  {
    name: "exit",
    aliases: ["quit"],
    usage: "/exit",
    description: "Land the Drone and leave the TUI",
  },
] as const;

export interface WorkspacePathDefinition {
  path: string;
  kind: "file" | "directory";
}

export type WorkspacePathInput = string | WorkspacePathDefinition;

export interface SkillCompletionDefinition {
  name: string;
  description?: string;
}

export type SkillCompletionInput = string | SkillCompletionDefinition;

export interface CompletionContext {
  kind: CompletionContextKind;
  /** Full prompt at the time suggestions were computed. */
  prompt: string;
  /** Text typed after the active / or @ marker and before the caret. */
  query: string;
  /** Inclusive start of the token to replace. */
  start: number;
  /** Exclusive end of the token to replace. */
  end: number;
  caret: number;
}

export interface CompletionItem {
  id: string;
  kind: CompletionKind;
  label: string;
  insertText: string;
  description?: string;
}

export interface CompletionModel {
  context: CompletionContext;
  items: readonly CompletionItem[];
  selectedIndex: number;
}

export interface GetCompletionsOptions {
  prompt: string;
  /** Defaults to the end of the prompt. */
  caret?: number;
  workspacePaths?: readonly WorkspacePathInput[];
  /** Query after resolving a temporary ~/ or ../ search scope. */
  workspaceQuery?: string;
  /** Prefix preserved in labels and inserted mentions for a temporary scope. */
  workspaceDisplayPrefix?: string;
  /** Restrict an empty path query to the search root's direct children. */
  workspaceOnlyImmediate?: boolean;
  skills?: readonly SkillCompletionInput[];
  /** Maximum suggestions retained. Defaults to 12 and is capped at 20,000. */
  limit?: number;
  /** Selection to retain when recomputing. Wrapped into the result range. */
  selectedIndex?: number;
}

export interface CompletionEdit {
  prompt: string;
  caret: number;
}

const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 20_000;
const UNSAFE_PATH_SEGMENTS = new Set([".git", "node_modules"]);

function clampCaret(prompt: string, caret: number | undefined): number {
  if (caret === undefined || !Number.isFinite(caret)) return prompt.length;
  return Math.max(0, Math.min(prompt.length, Math.trunc(caret)));
}

function isTokenBoundary(character: string): boolean {
  return /\s/u.test(character);
}

function tokenRange(prompt: string, caret: number): { start: number; end: number } {
  let start = 0;
  let quote: "\"" | "'" | undefined;
  let escaped = false;

  for (let index = 0; index < caret; index += 1) {
    const character = prompt[index] ?? "";
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote && character === "\\") {
      escaped = true;
      continue;
    }
    if (character === quote) {
      quote = undefined;
      continue;
    }
    if (
      !quote &&
      (character === "\"" || character === "'") &&
      index === start + 1 &&
      prompt[start] === "@"
    ) {
      quote = character;
      continue;
    }
    if (!quote && isTokenBoundary(character)) start = index + 1;
  }

  let end = prompt.length;
  for (let index = caret; index < prompt.length; index += 1) {
    const character = prompt[index] ?? "";
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote && character === "\\") {
      escaped = true;
      continue;
    }
    if (character === quote) {
      quote = undefined;
      continue;
    }
    if (
      !quote &&
      (character === "\"" || character === "'") &&
      index === start + 1 &&
      prompt[start] === "@"
    ) {
      quote = character;
      continue;
    }
    if (!quote && isTokenBoundary(character)) {
      end = index;
      break;
    }
  }
  return { start, end };
}

function unquotePathQuery(query: string): string {
  const quote = query[0];
  if (quote !== "\"" && quote !== "'") return query;
  const body = query.endsWith(quote) && query.length > 1 ? query.slice(1, -1) : query.slice(1);
  let unescaped = "";
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index] ?? "";
    const next = body[index + 1];
    if (character === "\\" && (next === quote || next === "\\")) {
      unescaped += next;
      index += 1;
    } else {
      unescaped += character;
    }
  }
  return unescaped;
}

export function findCompletionContext(
  prompt: string,
  caretInput?: number,
): CompletionContext | undefined {
  const caret = clampCaret(prompt, caretInput);
  const range = tokenRange(prompt, caret);

  // Once /skills is complete, its first argument becomes its own completion level.
  if (/^\s*\/skills\s+$/iu.test(prompt.slice(0, range.start))) {
    return {
      kind: "skill",
      prompt,
      query: prompt.slice(range.start, caret),
      start: range.start,
      end: range.end,
      caret,
    };
  }

  if (range.start === range.end) return undefined;

  const marker = prompt[range.start];
  if (marker === "/") {
    // Slash commands are meaningful only as the first non-whitespace prompt token.
    if (prompt.slice(0, range.start).trim().length > 0) return undefined;
    return {
      kind: "slash",
      prompt,
      query: prompt.slice(range.start + 1, caret),
      start: range.start,
      end: range.end,
      caret,
    };
  }

  if (marker === "@") {
    return {
      kind: "workspace-path",
      prompt,
      query: unquotePathQuery(prompt.slice(range.start + 1, caret)),
      start: range.start,
      end: range.end,
      caret,
    };
  }

  return undefined;
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.max(0, Math.min(MAX_LIMIT, Math.trunc(limit)));
}

function wrapIndex(index: number, length: number): number {
  if (length === 0) return -1;
  const integer = Number.isFinite(index) ? Math.trunc(index) : 0;
  return ((integer % length) + length) % length;
}

function slashCompletionItems(query: string): CompletionItem[] {
  const normalizedQuery = query.toLowerCase();
  const items: CompletionItem[] = [];

  for (const command of SLASH_COMMANDS) {
    const variants = [command.name, ...(command.aliases ?? [])];
    const matchedVariant =
      normalizedQuery.length === 0
        ? command.name
        : variants.find((variant) => variant.toLowerCase().startsWith(normalizedQuery));
    if (matchedVariant === undefined) continue;

    const aliases = command.aliases?.length
      ? ` (aliases: ${command.aliases.map((alias) => `/${alias}`).join(", ")})`
      : "";
    items.push({
      id: `command:${matchedVariant}`,
      kind: "command",
      label: `/${matchedVariant}`,
      insertText: `/${matchedVariant}`,
      description: `${command.description}${aliases}`,
    });
  }

  return items;
}

function normalizeWorkspacePath(input: WorkspacePathInput): WorkspacePathDefinition | undefined {
  const rawPath = typeof input === "string" ? input : input.path;
  const explicitKind = typeof input === "string" ? undefined : input.kind;
  if (typeof rawPath !== "string" || rawPath.length === 0) return undefined;
  if (/\p{Cc}/u.test(rawPath)) return undefined;

  const slashPath = rawPath.replaceAll("\\", "/");
  if (slashPath.startsWith("/") || slashPath.startsWith("~/")) return undefined;
  if (/^[a-zA-Z]:\//u.test(slashPath)) return undefined;

  let relativePath = slashPath;
  while (relativePath.startsWith("./")) relativePath = relativePath.slice(2);
  const inferredDirectory = relativePath.endsWith("/");
  relativePath = relativePath.replace(/\/+$/u, "");
  if (relativePath.length === 0) return undefined;

  const segments = relativePath.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        UNSAFE_PATH_SEGMENTS.has(segment.toLowerCase()),
    )
  ) {
    return undefined;
  }

  const kind = explicitKind ?? (inferredDirectory ? "directory" : "file");
  return {
    path: kind === "directory" ? `${relativePath}/` : relativePath,
    kind,
  };
}

function workspaceCompletionItems(
  query: string,
  workspacePaths: readonly WorkspacePathInput[],
  displayPrefix = "",
  onlyImmediate = false,
): CompletionItem[] {
  const normalizedQuery = query.replaceAll("\\", "/").toLowerCase();
  const seen = new Set<string>();
  const paths: WorkspacePathDefinition[] = [];

  for (const input of workspacePaths) {
    const candidate = normalizeWorkspacePath(input);
    if (candidate === undefined) continue;
    const unqualifiedPath = candidate.path.replace(/\/$/u, "");
    if (onlyImmediate && normalizedQuery.length === 0 && unqualifiedPath.includes("/")) continue;
    const key = `${candidate.kind}:${candidate.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const normalizedPath = candidate.path.toLowerCase();
    if (
      candidate.kind === "directory" &&
      normalizedQuery.endsWith("/") &&
      normalizedPath === normalizedQuery
    ) {
      continue;
    }
    if (normalizedQuery.length > 0 && !normalizedPath.includes(normalizedQuery)) continue;
    paths.push(candidate);
  }

  paths.sort((left, right) => {
    const leftBasename = left.path.replace(/\/$/u, "").split("/").at(-1)?.toLowerCase() ?? "";
    const rightBasename = right.path.replace(/\/$/u, "").split("/").at(-1)?.toLowerCase() ?? "";
    const leftRank = leftBasename.startsWith(normalizedQuery)
      ? 0
      : leftBasename.includes(normalizedQuery)
        ? 1
        : 2;
    const rightRank = rightBasename.startsWith(normalizedQuery)
      ? 0
      : rightBasename.includes(normalizedQuery)
        ? 1
        : 2;
    if (leftRank !== rightRank) return leftRank - rightRank;
    if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
    const depthDifference = left.path.split("/").length - right.path.split("/").length;
    if (depthDifference !== 0) return depthDifference;
    return left.path.localeCompare(right.path, undefined, { sensitivity: "base" });
  });

  return paths.map((candidate) => {
    const displayPath = `${displayPrefix}${candidate.path}`;
    const needsQuotes = /\s/u.test(displayPath) || /^["']/u.test(displayPath);
    const quotedPath = displayPath.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
    return {
      id: `path:${candidate.kind}:${displayPath}`,
      kind: candidate.kind,
      label: `@${displayPath}`,
      insertText: needsQuotes ? `@"${quotedPath}"` : `@${displayPath}`,
      description: candidate.kind === "directory" ? "directory" : "file",
    };
  });
}

function skillCompletionItems(
  query: string,
  skills: readonly SkillCompletionInput[],
): CompletionItem[] {
  const normalizedQuery = query.toLowerCase();
  const seen = new Set<string>();
  const items: CompletionItem[] = [];

  for (const input of skills) {
    const name = (typeof input === "string" ? input : input.name).trim();
    const description = typeof input === "string" ? undefined : input.description;
    if (name.length === 0 || /\s|\p{Cc}/u.test(name)) continue;
    const normalizedName = name.toLowerCase();
    if (seen.has(normalizedName) || !normalizedName.startsWith(normalizedQuery)) continue;
    seen.add(normalizedName);
    items.push({
      id: `skill:${name}`,
      kind: "skill",
      label: `/skills ${name}`,
      insertText: name,
      description,
    });
  }

  return items.sort((left, right) =>
    left.insertText.localeCompare(right.insertText, undefined, { sensitivity: "base" }),
  );
}

export function getCompletions(options: GetCompletionsOptions): CompletionModel | undefined {
  const context = findCompletionContext(options.prompt, options.caret);
  if (context === undefined) return undefined;

  const allItems =
    context.kind === "slash"
      ? slashCompletionItems(context.query)
      : context.kind === "skill"
        ? skillCompletionItems(context.query, options.skills ?? [])
        : workspaceCompletionItems(
            options.workspaceQuery ?? context.query,
            options.workspacePaths ?? [],
            options.workspaceDisplayPrefix,
            options.workspaceOnlyImmediate,
          );
  const items = allItems.slice(0, normalizeLimit(options.limit));
  return {
    context,
    items,
    selectedIndex: wrapIndex(
      options.selectedIndex === undefined || options.selectedIndex < 0 ? 0 : options.selectedIndex,
      items.length,
    ),
  };
}

export function moveCompletionSelection(
  model: CompletionModel,
  delta: number,
): CompletionModel {
  if (model.items.length === 0) return { ...model, selectedIndex: -1 };
  const current = model.selectedIndex < 0 ? 0 : model.selectedIndex;
  return {
    ...model,
    selectedIndex: wrapIndex(current + Math.trunc(delta), model.items.length),
  };
}

export function acceptCompletion(
  model: CompletionModel,
  index = model.selectedIndex,
): CompletionEdit | undefined {
  const selectedIndex = wrapIndex(index, model.items.length);
  if (selectedIndex < 0) return undefined;
  const item = model.items[selectedIndex];
  if (item === undefined) return undefined;

  const before = model.context.prompt.slice(0, model.context.start);
  const after = model.context.prompt.slice(model.context.end);
  return {
    prompt: `${before}${item.insertText}${after}`,
    caret: before.length + item.insertText.length,
  };
}
