export type DronePalette = {
  background: string;
  surface: string;
  surfaceRaised: string;
  border: string;
  borderFocus: string;
  text: string;
  muted: string;
  accent: string;
  accentSoft: string;
  success: string;
  warning: string;
  error: string;
  user: string;
  assistant: string;
};

const DARK: DronePalette = {
  background: "#0b0d10",
  surface: "#11151a",
  surfaceRaised: "#171d24",
  border: "#35404a",
  borderFocus: "#f3ad3d",
  text: "#e7e2d7",
  muted: "#87919b",
  accent: "#f3ad3d",
  accentSoft: "#9e6d24",
  success: "#79c48a",
  warning: "#f1c35d",
  error: "#ef7373",
  user: "#80c7d9",
  assistant: "#e7e2d7",
};

const LIGHT: DronePalette = {
  background: "#f5f1e8",
  surface: "#ebe5d8",
  surfaceRaised: "#fffaf0",
  border: "#9c8f7b",
  borderFocus: "#9a5b00",
  text: "#29251f",
  muted: "#6f675c",
  accent: "#9a5b00",
  accentSoft: "#c1842e",
  success: "#287a42",
  warning: "#946200",
  error: "#b83232",
  user: "#126b80",
  assistant: "#29251f",
};

const MONO: DronePalette = {
  background: "#000000",
  surface: "#000000",
  surfaceRaised: "#000000",
  border: "#8a8a8a",
  borderFocus: "#ffffff",
  text: "#ffffff",
  muted: "#a0a0a0",
  accent: "#ffffff",
  accentSoft: "#b0b0b0",
  success: "#ffffff",
  warning: "#ffffff",
  error: "#ffffff",
  user: "#ffffff",
  assistant: "#ffffff",
};

export function resolvePalette(
  theme: "auto" | "dark" | "light" | "mono",
  terminalTheme: "dark" | "light" | null = null,
  noColor = false,
): DronePalette {
  if (noColor || theme === "mono") return MONO;
  if (theme === "light" || (theme === "auto" && terminalTheme === "light")) return LIGHT;
  return DARK;
}
