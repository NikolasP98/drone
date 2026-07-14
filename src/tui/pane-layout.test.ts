import { describe, expect, it } from "vitest";
import { clampDroneSplit, resizePaneBoundary, visiblePaneCapacity } from "./pane-layout.js";

describe("draggable pane layout", () => {
  it("resizes only the panes adjacent to a dragged divider", () => {
    const right = resizePaneBoundary([1, 1, 1], 1, 0.8);
    expect(right[0]).toBe(1);
    expect(right[1]).toBeCloseTo(1.4);
    expect(right[2]).toBeCloseTo(0.6);
    const left = resizePaneBoundary([1, 1, 1], 0, 0.1);
    expect(left[0]).toBeCloseTo(0.36);
    expect(left[1]).toBeCloseTo(1.64);
    expect(left[2]).toBe(1);
  });

  it("keeps both sides visible and tolerates invalid input", () => {
    const clamped = resizePaneBoundary([1, 1], 0, 1);
    expect(clamped[0]).toBeCloseTo(1.7);
    expect(clamped[1]).toBeCloseTo(0.3);
    expect(resizePaneBoundary([1, 1], 4, 0.5)).toEqual([1, 1]);
    expect(resizePaneBoundary([0, Number.NaN], 0, 0.5)).toEqual([1, 1]);
  });

  it("bounds the Drone-to-agent split", () => {
    expect(clampDroneSplit(10, 100)).toBe(0.25);
    expect(clampDroneSplit(60, 100)).toBe(0.6);
    expect(clampDroneSplit(99, 100)).toBe(0.75);
    expect(clampDroneSplit(5, 0)).toBe(0.5);
  });

  it("limits visible panes to the columns available in the agent split", () => {
    expect(visiblePaneCapacity(80, 0.25)).toBe(1);
    expect(visiblePaneCapacity(120, 0.5)).toBe(3);
    expect(visiblePaneCapacity(200, 0.5)).toBe(4);
  });
});
