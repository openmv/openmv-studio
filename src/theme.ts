// Application theme system -- dark, light, and system (auto-detect).
// Defines color schemes for both the Monaco editor and the CSS UI.

import * as monaco from "monaco-editor";
import { state, scheduleSaveSettings } from "./state";

const DARK_THEME: monaco.editor.IStandaloneThemeData = {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "comment", foreground: "546e7a", fontStyle: "italic" },
    { token: "keyword", foreground: "c792ea" },
    { token: "string", foreground: "c3e88d" },
    { token: "number", foreground: "f78c6c" },
    { token: "identifier", foreground: "e8e6e3" },
    { token: "type", foreground: "ffcb6b" },
    { token: "delimiter", foreground: "89ddff" },
  ],
  colors: {
    "editor.background": "#1e1e23",
    "editor.foreground": "#e8e6e3",
    "editor.lineHighlightBackground": "#5b9cf510",
    "editor.selectionBackground": "#5b9cf540",
    "editorLineNumber.foreground": "#4a4845",
    "editorLineNumber.activeForeground": "#6b6966",
    "editorCursor.foreground": "#5b9cf5",
    "scrollbarSlider.background": "#ffffff14",
    "scrollbarSlider.hoverBackground": "#ffffff1f",
  },
};

const LIGHT_THEME: monaco.editor.IStandaloneThemeData = {
  base: "vs",
  inherit: true,
  rules: [
    { token: "comment", foreground: "6a737d", fontStyle: "italic" },
    { token: "keyword", foreground: "d73a49" },
    { token: "string", foreground: "22863a" },
    { token: "number", foreground: "005cc5" },
    { token: "identifier", foreground: "24292e" },
    { token: "type", foreground: "e36209" },
    { token: "delimiter", foreground: "6f42c1" },
  ],
  colors: {
    "editor.background": "#f8f8fa",
    "editor.foreground": "#1a1a1e",
    "editor.lineHighlightBackground": "#2b7cf508",
    "editor.selectionBackground": "#2b7cf530",
    "editorLineNumber.foreground": "#b0b0b8",
    "editorLineNumber.activeForeground": "#8a8a94",
    "editorCursor.foreground": "#2b7cf5",
    "scrollbarSlider.background": "#00000014",
    "scrollbarSlider.hoverBackground": "#0000001f",
  },
};

export function initThemes() {
  monaco.editor.defineTheme("openmv-dark", DARK_THEME);
  monaco.editor.defineTheme("openmv-light", LIGHT_THEME);

  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", () => {
      if (state.currentThemeSetting === "system") {
        applyTheme("system");
      }
    });
}

export function getEffectiveTheme(): "dark" | "light" {
  if (state.currentThemeSetting === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }

  return state.currentThemeSetting;
}

export function applyTheme(setting: typeof state.currentThemeSetting) {
  state.currentThemeSetting = setting;

  const effective = getEffectiveTheme();

  document.documentElement.setAttribute("data-theme", effective);
  monaco.editor.setTheme(effective === "dark" ? "openmv-dark" : "openmv-light");
  scheduleSaveSettings();
}
