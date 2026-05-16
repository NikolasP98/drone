import { describe, expect, it } from "vitest";
import { forceToolCallShape } from "./provider-shapes.js";

describe("forceToolCallShape", () => {
  it("returns Anthropic-style { type, name } for anthropic", () => {
    expect(forceToolCallShape("anthropic", "result")).toEqual({
      type: "tool",
      name: "result",
    });
  });

  it("returns Anthropic-style for anthropic-bedrock", () => {
    expect(forceToolCallShape("anthropic-bedrock", "result")).toEqual({
      type: "tool",
      name: "result",
    });
  });

  it("returns Anthropic-style for provider names containing claude", () => {
    expect(forceToolCallShape("aws-claude-runtime", "result")).toEqual({
      type: "tool",
      name: "result",
    });
  });

  it("returns 'required' for openai", () => {
    expect(forceToolCallShape("openai", "result")).toBe("required");
  });

  it("returns 'required' for openai-completions / openai-responses", () => {
    expect(forceToolCallShape("openai-completions", "result")).toBe("required");
    expect(forceToolCallShape("openai-responses", "result")).toBe("required");
  });

  it("returns 'required' for google / google-vertex", () => {
    expect(forceToolCallShape("google", "result")).toBe("required");
    expect(forceToolCallShape("google-vertex", "result")).toBe("required");
  });

  it("returns 'required' for openrouter", () => {
    expect(forceToolCallShape("openrouter", "result")).toBe("required");
  });

  it("returns 'required' for unknown providers (generic fallback)", () => {
    expect(forceToolCallShape("some-future-provider", "result")).toBe("required");
  });

  it("normalizes case + whitespace", () => {
    expect(forceToolCallShape("  Anthropic  ", "result")).toEqual({
      type: "tool",
      name: "result",
    });
  });
});
