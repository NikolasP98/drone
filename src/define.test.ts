import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { defineDrone } from "./define.js";

describe("defineDrone", () => {
  const validBase = {
    id: "test-drone",
    systemPrompt: "You are a test drone.",
    model: { provider: "anthropic", model: "claude-haiku-4-5" },
  };

  it("freezes the definition", () => {
    const drone = defineDrone(validBase);
    expect(() => {
      (drone.definition as { id: string }).id = "mutated";
    }).toThrow();
  });

  it("infers Static<TSchema> output type when output is set", () => {
    const Schema = Type.Object({ verdict: Type.String() });
    const drone = defineDrone({ ...validBase, output: Schema });
    // Type-level assertion — runtime check is trivial
    expect(drone.definition.output).toBe(Schema);
  });

  it.each([
    ["empty id", { ...validBase, id: "" }],
    ["uppercase id", { ...validBase, id: "BadId" }],
    ["leading digit", { ...validBase, id: "1bad" }],
    ["too long id", { ...validBase, id: "a".repeat(65) }],
  ])("rejects %s", (_, bad) => {
    expect(() => defineDrone(bad)).toThrow(/invalid id/);
  });

  it("rejects empty systemPrompt", () => {
    expect(() => defineDrone({ ...validBase, systemPrompt: "" })).toThrow(/systemPrompt/);
    expect(() => defineDrone({ ...validBase, systemPrompt: "   " })).toThrow(/systemPrompt/);
  });

  it("rejects missing model fields", () => {
    expect(() => defineDrone({ ...validBase, model: { provider: "", model: "x" } })).toThrow(
      /model/,
    );
    expect(() => defineDrone({ ...validBase, model: { provider: "x", model: "" } })).toThrow(
      /model/,
    );
  });

  it("rejects duplicate tool names", () => {
    expect(() =>
      defineDrone({
        ...validBase,
        tools: [
          { name: "x", description: "d", parameters: Type.Object({}), execute: () => null },
          { name: "x", description: "d", parameters: Type.Object({}), execute: () => null },
        ],
      }),
    ).toThrow(/duplicate tool name/);
  });
});
