import { describe, expect, it } from "vitest";
import { renderDroneArt } from "./art.js";

describe("drone art", () => {
  it("animates full unicode art", () => {
    expect(renderDroneArt("thinking", 0, "full")).not.toBe(
      renderDroneArt("thinking", 1, "full"),
    );
    expect(renderDroneArt("thinking", 0, "full")).toContain("THINKING");
  });

  it("offers compact, ascii, and disabled variants", () => {
    expect(renderDroneArt("tool", 0, "compact")).toContain("tool");
    expect(renderDroneArt("error", 0, "full", true)).toContain("error");
    expect(renderDroneArt("idle", 0, "off")).toBe("");
  });
});
