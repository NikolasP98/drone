import path from "node:path";

export interface PathSearchScopeInput {
  cwd: string;
  home: string;
  /** The active path query after the @ marker. */
  query: string;
}

export interface PathSearchScope {
  /** Absolute directory from which candidates should be discovered. */
  searchRoot: string;
  /** Prefix restored when rendering or accepting a candidate. */
  displayPrefix: string;
  /** Normalized candidate filter within searchRoot. */
  needle: string;
  /** Empty queries should discover only the temporary root's direct children. */
  onlyImmediate: boolean;
}

const CONTROL_CHARACTERS = /\p{Cc}/u;

function safeAbsoluteRoot(value: string): string | undefined {
  if (value.length === 0 || CONTROL_CHARACTERS.test(value)) return undefined;
  return path.resolve(value);
}

function parentClamped(root: string, levels: number): string {
  let current = root;
  for (let index = 0; index < levels; index += 1) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

function normalizeNeedle(value: string): string | undefined {
  if (value.length === 0) return "";
  if (value.startsWith("/")) return undefined;

  const preserveTrailingSlash = value.endsWith("/");
  const normalizedSegments: string[] = [];
  for (const segment of value.split("/")) {
    if (segment.length === 0 || segment === ".") continue;
    // Parent traversal is valid only as the leading scope shorthand consumed above.
    if (segment === "..") return undefined;
    normalizedSegments.push(segment);
  }

  const normalized = normalizedSegments.join("/");
  if (normalized.length === 0) return "";
  return preserveTrailingSlash ? `${normalized}/` : normalized;
}

/**
 * Resolve an @ query into a temporary, lexical search scope without touching the filesystem.
 * Invalid or scope-escaping queries return undefined.
 */
export function resolvePathSearchScope(
  input: PathSearchScopeInput,
): PathSearchScope | undefined {
  if (CONTROL_CHARACTERS.test(input.query)) return undefined;

  const cwd = safeAbsoluteRoot(input.cwd);
  const home = safeAbsoluteRoot(input.home);
  if (cwd === undefined || home === undefined) return undefined;

  // Completion paths use portable separators even when a caller injects backslashes.
  let remainder = input.query.replaceAll("\\", "/");
  let searchRoot = cwd;
  let displayPrefix = "";

  if (remainder.startsWith("~/")) {
    searchRoot = home;
    displayPrefix = "~/";
    remainder = remainder.slice(2);
  } else if (remainder.startsWith("./")) {
    remainder = remainder.slice(2);
  } else {
    let parentLevels = 0;
    while (remainder.startsWith("../")) {
      parentLevels += 1;
      remainder = remainder.slice(3);
    }
    if (parentLevels > 0) {
      searchRoot = parentClamped(cwd, parentLevels);
      displayPrefix = "../".repeat(parentLevels);
    }
  }

  const needle = normalizeNeedle(remainder);
  if (needle === undefined) return undefined;
  return {
    searchRoot,
    displayPrefix,
    needle,
    onlyImmediate: needle.length === 0,
  };
}

/** Short alias for callers that model this operation as parsing composer text. */
export const parsePathScope = resolvePathSearchScope;
