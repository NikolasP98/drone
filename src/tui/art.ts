import type { FlightStatus } from "./state.js";

const FLIGHT_FRAMES = [
  ["  ╲╲      ╱╱  ", "───╲╭─◆─╮╱───", "    │ ◉ │    ", "   ╱╰─┬─╯╲   ", "      ╵      "],
  [" ───╲    ╱─── ", "    ╲╭─◆─╮╱   ", "     │ ◉ │    ", "    ╱╰─┬─╯╲   ", "       ╵      "],
  ["  ╱╱      ╲╲  ", "───╱╭─◆─╮╲───", "    │ ◉ │    ", "   ╱╰─┬─╯╲   ", "      ╵      "],
  [" ───╱    ╲─── ", "    ╱╭─◆─╮╲   ", "     │ ◉ │    ", "    ╱╰─┬─╯╲   ", "       ╵      "],
] as const;

const STATUS_GLYPH: Record<FlightStatus, string> = {
  idle: "◇",
  thinking: "◈",
  tool: "◆",
  approval: "!",
  done: "●",
  error: "×",
};

export function renderDroneArt(
  status: FlightStatus,
  frame: number,
  mode: "full" | "compact" | "minimal" | "off",
  ascii = false,
): string {
  if (mode === "off") return "";
  if (mode === "minimal") return ascii ? `[D:${status}]` : `${STATUS_GLYPH[status]} DRONE`;
  if (mode === "compact") {
    const rotor = frame % 2 === 0 ? "╲╱" : "╱╲";
    return ascii ? `--[o]-- ${status}` : `${rotor}─[${STATUS_GLYPH[status]}]─${rotor}  ${status}`;
  }
  if (ascii) {
    const spin = frame % 2 === 0 ? "\\" : "/";
    return [` ${spin}--+--${spin} `, " ---[o]--- ", "    |     ", "   / \\    ", `  ${status}`].join("\n");
  }
  const lines: string[] = [...FLIGHT_FRAMES[Math.abs(frame) % FLIGHT_FRAMES.length]];
  lines[2] = lines[2].replace("◉", STATUS_GLYPH[status]);
  return [...lines, `  ${status.toUpperCase().padStart(9, " ")}`].join("\n");
}
