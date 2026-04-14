// Application theme system -- dark, light, and system (auto-detect).
// Defines color schemes for both the Monaco editor and the CSS UI.

import * as monaco from "monaco-editor";
import { state, scheduleSaveSettings } from "./state";
import { resetMemGraphCache } from "./panels";

const DARK_THEME: monaco.editor.IStandaloneThemeData = {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "comment", foreground: "546e7a", fontStyle: "italic" },
    { token: "keyword", foreground: "c792ea" },
    { token: "string", foreground: "c3e88d" },
    { token: "string.escape", foreground: "89ddff" },
    { token: "number", foreground: "f78c6c" },
    { token: "number.hex", foreground: "f78c6c" },
    { token: "number.octal", foreground: "f78c6c" },
    { token: "number.binary", foreground: "f78c6c" },
    { token: "identifier", foreground: "e8e6e3" },
    { token: "type", foreground: "ffcb6b" },
    { token: "entity.name.function", foreground: "82aaff" },
    { token: "entity.name.class", foreground: "ffcb6b" },
    { token: "support.function", foreground: "82aaff" },
    { token: "variable.language", foreground: "f07178", fontStyle: "italic" },
    { token: "tag", foreground: "ffcb6b" },
    { token: "operator", foreground: "e8e6e3" },
    { token: "delimiter", foreground: "e8e6e3" },
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
    { token: "string.escape", foreground: "005cc5" },
    { token: "number", foreground: "005cc5" },
    { token: "number.hex", foreground: "005cc5" },
    { token: "number.octal", foreground: "005cc5" },
    { token: "number.binary", foreground: "005cc5" },
    { token: "identifier", foreground: "24292e" },
    { token: "type", foreground: "e36209" },
    { token: "entity.name.function", foreground: "6f42c1" },
    { token: "entity.name.class", foreground: "e36209" },
    { token: "support.function", foreground: "6f42c1" },
    { token: "variable.language", foreground: "d73a49", fontStyle: "italic" },
    { token: "tag", foreground: "e36209" },
    { token: "operator", foreground: "24292e" },
    { token: "delimiter", foreground: "24292e" },
  ],
  colors: {
    "editor.background": "#f5f5f7",
    "editor.foreground": "#1a1a1e",
    "editor.lineHighlightBackground": "#2670e00a",
    "editor.selectionBackground": "#2670e030",
    "editorLineNumber.foreground": "#9a9aa4",
    "editorLineNumber.activeForeground": "#6e6e7a",
    "editorCursor.foreground": "#2670e0",
    "scrollbarSlider.background": "#00000018",
    "scrollbarSlider.hoverBackground": "#00000028",
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
  resetMemGraphCache();
  scheduleSaveSettings();
}
