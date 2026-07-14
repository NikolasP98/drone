import { describe, expect, it } from "vitest";
import { resolvePalette } from "./theme.js";

describe("resolvePalette", () => {
  it("follows explicit and detected themes", () => {
    expect(resolvePalette("auto", "light").background).toBe("#f5f1e8");
    expect(resolvePalette("dark", "light").background).toBe("#0b0d10");
  });

  it("honors no-color", () => {
    expect(resolvePalette("light", "light", true).accent).toBe("#ffffff");
  });
});
