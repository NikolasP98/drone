import { describe, expect, it } from "vitest";
import type { WorkspaceApprovalRequest } from "../runtime/workspace.js";
import {
  approvalDecisionForKey,
  escapeApprovalText,
  formatApprovalPreview,
  MAX_APPROVAL_PREVIEW_CHARS,
} from "./approval.js";

describe("approval keyboard decisions", () => {
  it("approves only an explicit y", () => {
    expect(approvalDecisionForKey("y")).toBe("approve");
    expect(approvalDecisionForKey("Y")).toBe("approve");
    expect(approvalDecisionForKey("enter")).toBe("deny");
    expect(approvalDecisionForKey("return")).toBe("deny");
    expect(approvalDecisionForKey("kpenter")).toBe("deny");
    expect(approvalDecisionForKey("n")).toBe("deny");
    expect(approvalDecisionForKey("escape")).toBe("deny");
    expect(approvalDecisionForKey("space")).toBeUndefined();
  });
});

describe("approval previews", () => {
  const commandRequest = (command: string): WorkspaceApprovalRequest => ({
    kind: "run_command",
    command,
    cwd: "/workspace",
    summary: "run command",
  });

  it("visibly escapes terminal controls and formatting characters", () => {
    const escaped = escapeApprovalText("printf \\t\t'ok'\n\x1b[31m\u202E");
    expect(escaped).toBe("printf \\\\t\\t'ok'\\n\n\\x1b[31m\\u{202e}");
    expect(escaped).not.toContain("\x1b");
    expect(escaped).not.toContain("\u202E");
  });

  it("renders the complete safe operation when it fits", () => {
    const preview = formatApprovalPreview(commandRequest("printf 'safe'"));
    expect(preview.approvable).toBe(true);
    expect(preview.body).toContain("printf 'safe'");
    expect(preview.body).toContain("workspace: /workspace");
  });

  it("fails closed when a complete operation cannot fit in the bounded preview", () => {
    const preview = formatApprovalPreview(
      commandRequest("x".repeat(MAX_APPROVAL_PREVIEW_CHARS + 1)),
    );
    expect(preview.approvable).toBe(false);
    expect(preview.reason).toContain("Operation denied");
    expect(preview.body.length).toBeLessThan(MAX_APPROVAL_PREVIEW_CHARS + 300);
  });
});
