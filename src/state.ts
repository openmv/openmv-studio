// Global application state shared across all UI modules.
// Single source of truth for connection status, UI preferences, etc.

export type ThemeSetting = "dark" | "light" | "system";

export const state = {
  isConnected: false,
  scriptRunning: false,
  connectedBoard: null as string | null,
  connectedSensor: null as string | null,
  uiScale: 1.2,
  pollIntervalMs: 50,
  filterExamples: true,
  canvasVisible: false,
  splitLocked: false,
  currentThemeSetting: "dark" as ThemeSetting,
  serialPort: "" as string,
};

// Callback slot -- settings.ts fills this during init.
// Other modules call it without importing settings.ts (no circular dep).
export let scheduleSaveSettings: () => void = () => {};

export function setScheduleSaveSettings(fn: () => void) {
  scheduleSaveSettings = fn;
}
