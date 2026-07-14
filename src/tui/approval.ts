import type { WorkspaceApprovalRequest } from "../runtime/workspace.js";

export type ApprovalKeyDecision = "approve" | "deny" | undefined;

export type ApprovalPreview = {
  body: string;
  approvable: boolean;
  reason?: string;
};

export const MAX_APPROVAL_PREVIEW_CHARS = 4_096;

/** Approval is deliberately fail-closed: only an explicit Y grants it. */
export function approvalDecisionForKey(name: string): ApprovalKeyDecision {
  if (name.toLowerCase() === "y") return "approve";
  if (["n", "escape", "enter", "return", "kpenter"].includes(name.toLowerCase())) {
    return "deny";
  }
  return undefined;
}

function visibleCharacter(character: string): string {
  if (character === "\\") return "\\\\";
  if (character === "\n") return "\\n\n";
  if (character === "\r") return "\\r";
  if (character === "\t") return "\\t";

  const codePoint = character.codePointAt(0) ?? 0;
  if (
    codePoint < 0x20 ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    /\p{Cf}/u.test(character)
  ) {
    return codePoint <= 0xff
      ? `\\x${codePoint.toString(16).padStart(2, "0")}`
      : `\\u{${codePoint.toString(16)}}`;
  }
  return character;
}

export function escapeApprovalText(value: string): string {
  return [...value].map(visibleCharacter).join("");
}

function boundedVisibleText(value: string): {
  text: string;
  complete: boolean;
  visibleLength: number;
} {
  const escaped = escapeApprovalText(value);
  const characters = [...escaped];
  if (characters.length <= MAX_APPROVAL_PREVIEW_CHARS) {
    return { text: escaped, complete: true, visibleLength: characters.length };
  }
  return {
    text: `${characters.slice(0, MAX_APPROVAL_PREVIEW_CHARS).join("")}\n…`,
    complete: false,
    visibleLength: characters.length,
  };
}

/** Render an inert, bounded preview. Oversized operations are not approvable. */
export function formatApprovalPreview(request: WorkspaceApprovalRequest): ApprovalPreview {
  const operation = request.command ?? request.path ?? request.summary;
  const operationPreview = boundedVisibleText(operation);
  const cwdPreview = boundedVisibleText(request.cwd);
  const title =
    request.kind === "run_command"
      ? "Drone wants to run this shell command:"
      : "Drone wants to write this file:";

  if (!operationPreview.complete || !cwdPreview.complete) {
    const oversized = operationPreview.complete
      ? { label: "workspace path", length: cwdPreview.visibleLength }
      : { label: "operation", length: operationPreview.visibleLength };
    const reason = `Operation denied: the ${oversized.label} safe preview is too large (${oversized.length} visible characters; limit ${MAX_APPROVAL_PREVIEW_CHARS}).`;
    return {
      approvable: false,
      reason,
      body: [title, "", operationPreview.text, "", reason].join("\n"),
    };
  }

  const details =
    request.kind === "write_file" && request.bytes != null
      ? `bytes: ${request.bytes}`
      : undefined;
  return {
    approvable: true,
    body: [
      title,
      "",
      operationPreview.text,
      ...(details ? ["", details] : []),
      "",
      `workspace: ${cwdPreview.text}`,
    ].join("\n"),
  };
}
