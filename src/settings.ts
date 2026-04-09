// Settings persistence (save/load) and settings dialog UI.
// Manages the Store, UI scale, and all preference controls.

import * as monaco from "monaco-editor";
import { invoke } from "@tauri-apps/api/core";
import { Store } from "@tauri-apps/plugin-store";
import {
  state,
  scheduleSaveSettings,
  type ThemeSetting,
  setScheduleSaveSettings,
} from "./state";
import { openFiles, activeFileIndex, createFile, switchToFile } from "./files";
import { showWelcome } from "./welcome";
import { loadExamples, resetExamples, clearExamplesTree } from "./panels";
import {
  shortcutBindings,
  shortcutOverrides,
  setShortcutOverrides,
  getShortcutDisplay,
  shortcutToString,
  type Shortcut,
} from "./shortcuts";

let editor: monaco.editor.IStandaloneCodeEditor;
let store: Store | null = null;
let saveTimer: number | null = null;
let applyThemeFn: (setting: ThemeSetting) => void;

async function getStore(): Promise<Store> {
  if (!store) {
    store = await Store.load("settings.json");
  }

  return store;
}

export function initSettings(
  ed: monaco.editor.IStandaloneCodeEditor,
  applyTheme: (setting: ThemeSetting) => void,
) {
  editor = ed;
  applyThemeFn = applyTheme;

  setScheduleSaveSettings(() => {
    if (saveTimer) { clearTimeout(saveTimer); }
    saveTimer = window.setTimeout(saveSettings, 500);
  });

  document
    .getElementById("btn-settings")
    ?.addEventListener("click", () => openSettings());
}

export function setUiScale(scale: number) {
  state.uiScale = Math.max(0.5, Math.min(2.0, scale));
  (document.body.style as any).zoom = String(state.uiScale);
  document.body.style.width = 100 / state.uiScale + "vw";
  document.body.style.height = 100 / state.uiScale + "vh";
  document.querySelector<HTMLElement>(".ide-layout")!.style.height =
    100 / state.uiScale + "vh";
}

// --- Save / Load ---

export async function saveSettings() {
  try {
    const s = await getStore();
    const fb = document.querySelector(".fb-section") as HTMLElement;
    const rp = document.querySelector(".right-panel") as HTMLElement;
    const rpH = rp?.getBoundingClientRect().height / state.uiScale;
    const fbH = fb?.getBoundingClientRect().height / state.uiScale;
    const layoutEl = document.querySelector<HTMLElement>(".ide-layout")!;
    const mainArea = document.querySelector<HTMLElement>(".main-area")!;

    await s.set("ui", {
      scale: state.uiScale,
      theme: state.currentThemeSetting,
      gridCols: layoutEl.style.gridTemplateColumns || "",
      gridRows: mainArea.style.gridTemplateRows || "",
      fbRatio: rpH > 0 ? Math.min(0.85, fbH / rpH) : 0.5,
      pollInterval: state.pollIntervalMs,
      filterExamples: state.filterExamples,
    });

    await s.set("editor", {
      fontSize: editor.getOption(monaco.editor.EditorOption.fontSize),
    });

    await s.set("shortcuts", shortcutOverrides);

    await s.set("files", {
      openFiles: openFiles
        .filter((f) => !f.isExample)
        .map((f) => f.path)
        .filter(Boolean),
      activeFile: openFiles[activeFileIndex]?.path || null,
    });

    await s.save();
  } catch (e) {
    console.error("Failed to save settings:", e);
  }
}

export async function loadSettings() {
  try {
    const s = await getStore();

    const ui = await s.get<{
      scale?: number;
      theme?: ThemeSetting;
      gridCols?: string;
      gridRows?: string;
      fbRatio?: number;
      pollInterval?: number;
      filterExamples?: boolean;
    }>("ui");

    if (ui?.scale) { state.uiScale = ui.scale; }
    if (ui?.theme) { state.currentThemeSetting = ui.theme; }
    if (ui?.pollInterval) { state.pollIntervalMs = ui.pollInterval; }
    if (ui?.filterExamples !== undefined) { state.filterExamples = ui.filterExamples; }

    if (ui?.gridCols) {
      document.querySelector<HTMLElement>(".ide-layout")!
        .style.gridTemplateColumns = ui.gridCols;
    }

    if (ui?.gridRows) {
      document.querySelector<HTMLElement>(".main-area")!
        .style.gridTemplateRows = ui.gridRows;
    }

    if (ui?.fbRatio !== undefined) {
      requestAnimationFrame(() => {
        const fb = document.querySelector<HTMLElement>(".fb-section");
        const tools = document.querySelector<HTMLElement>(".tools-panel");
        const rp = document.querySelector<HTMLElement>(".right-panel");

        if (fb && tools && rp) {
          const rpH = rp.getBoundingClientRect().height / state.uiScale;
          const fbH = Math.max(80, rpH * ui.fbRatio!);
          const toolsH = Math.max(60, rpH - fbH - 4);

          fb.style.flex = "none";
          fb.style.height = fbH + "px";
          tools.style.flex = "none";
          tools.style.height = toolsH + "px";
        }
      });
    }

    const editorSettings = await s.get<{ fontSize?: number }>("editor");

    if (editorSettings?.fontSize) {
      editor.updateOptions({ fontSize: editorSettings.fontSize });
    }

    const savedShortcuts = await s.get<Record<string, string>>("shortcuts");

    if (savedShortcuts) { setShortcutOverrides(savedShortcuts); }

    const files = await s.get<{
      openFiles?: string[];
      activeFile?: string | null;
    }>("files");

    if (files?.openFiles && files.openFiles.length > 0) {
      for (const path of files.openFiles) {
        try {
          const content = await invoke<string>("cmd_read_file", { path });
          createFile(path, content);
        } catch {
          // File no longer exists -- skip
        }
      }

      if (openFiles.length > 0) {
        const activeIdx = files.activeFile
          ? openFiles.findIndex((f) => f.path === files.activeFile)
          : 0;

        switchToFile(Math.max(0, activeIdx));
      }
    }
  } catch (e) {
    console.error("Failed to load settings:", e);
  }

  if (openFiles.length === 0) {
    showWelcome();
  }
}

// --- Settings dialog ---

export function openSettings() {
  const prevTab =
    document
      .querySelector(".settings-icon-tab.active")
      ?.getAttribute("data-stab") || null;

  document.getElementById("settings-overlay")?.remove();

  const overlay = document.createElement("div");

  overlay.id = "settings-overlay";
  overlay.className = "settings-overlay";
  overlay.innerHTML = buildSettingsHtml();
  document.body.appendChild(overlay);

  overlay.onclick = (e) => {
    if (e.target === overlay) { overlay.remove(); }
  };

  document.addEventListener("keydown", function esc(e) {
    if (e.key === "Escape") {
      overlay.remove();
      document.removeEventListener("keydown", esc);
    }
  });

  // Tab switching
  const titlebar = overlay.querySelector(".settings-titlebar")!;

  overlay.querySelectorAll(".settings-icon-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const id = (tab as HTMLElement).dataset.stab!;

      overlay
        .querySelectorAll(".settings-icon-tab")
        .forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");

      overlay
        .querySelectorAll(".settings-pane")
        .forEach((p) => ((p as HTMLElement).style.display = "none"));
      (
        overlay.querySelector(
          `.settings-pane[data-stab="${id}"]`,
        ) as HTMLElement
      ).style.display = "";

      titlebar.textContent = (
        tab.querySelector("span") as HTMLElement
      ).textContent;
    });
  });

  if (prevTab) {
    const btn = overlay.querySelector(
      `.settings-icon-tab[data-stab="${prevTab}"]`,
    ) as HTMLElement;

    if (btn) { btn.click(); }
  }

  bindSettingsControls(overlay);
}

function bindSettingsControls(overlay: HTMLElement) {
  // UI scale
  const scaleSlider = document.getElementById("set-scale") as HTMLInputElement;
  const scaleLabel = document.getElementById("scale-label")!;

  scaleSlider.oninput = () => {
    const v = parseInt(scaleSlider.value);
    scaleLabel.textContent = v + "%";
    setUiScale(v / 100);
  };

  // Editor controls
  document.getElementById("set-font-size")!.onchange = (e) => {
    editor.updateOptions({
      fontSize: parseInt((e.target as HTMLInputElement).value),
    });
  };

  document.getElementById("set-tab-size")!.onchange = (e) => {
    editor.updateOptions({
      tabSize: parseInt((e.target as HTMLInputElement).value),
    });
  };

  document.getElementById("set-word-wrap")!.onchange = (e) => {
    editor.updateOptions({
      wordWrap: (e.target as HTMLInputElement).checked ? "on" : "off",
    });
  };

  document.getElementById("set-minimap")!.onchange = (e) => {
    editor.updateOptions({
      minimap: { enabled: (e.target as HTMLInputElement).checked },
    });
  };

  document.getElementById("set-line-numbers")!.onchange = (e) => {
    editor.updateOptions({
      lineNumbers: (e.target as HTMLInputElement).checked ? "on" : "off",
    });
  };

  // Filter examples
  document.getElementById("set-filter-examples")!.onchange = (e) => {
    state.filterExamples = (e.target as HTMLInputElement).checked;
    resetExamples();

    if (!state.filterExamples) {
      loadExamples();
    } else if (state.isConnected) {
      loadExamples();
    } else {
      clearExamplesTree();
    }

    scheduleSaveSettings();
  };

  // Poll rate
  const pollSlider = document.getElementById("set-poll-rate") as HTMLInputElement;
  const pollLabel = document.getElementById("poll-rate-label")!;

  if (pollSlider) {
    pollSlider.oninput = () => {
      pollLabel.textContent = pollSlider.value + " ms";
    };

    pollSlider.onchange = () => {
      state.pollIntervalMs = parseInt(pollSlider.value);
      invoke("cmd_set_poll_interval", { intervalMs: state.pollIntervalMs });
      scheduleSaveSettings();
    };
  }

  // Theme
  overlay.querySelectorAll('input[name="theme"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      applyThemeFn((radio as HTMLInputElement).value as ThemeSetting);
    });
  });

  // Shortcut recording
  overlay.querySelectorAll(".shortcut-input").forEach((input) => {
    input.addEventListener("click", () => {
      const el = input as HTMLInputElement;

      el.value = "Press keys...";
      el.removeAttribute("readonly");

      const handler = (e: KeyboardEvent) => {
        e.preventDefault();
        e.stopPropagation();

        if (e.key === "Escape") {
          const sid = el.dataset.sid!;

          el.value =
            shortcutOverrides[sid] ||
            getShortcutDisplay(shortcutBindings.find((b) => b.id === sid)!);
          el.setAttribute("readonly", "");
          document.removeEventListener("keydown", handler, true);
          return;
        }

        if (["Meta", "Control", "Alt", "Shift"].includes(e.key)) { return; }

        const s: Shortcut = {
          key: e.key.length === 1 ? e.key.toLowerCase() : e.key,
        };

        if (e.metaKey) { s.meta = true; }
        if (e.ctrlKey) { s.ctrl = true; }
        if (e.shiftKey) { s.shift = true; }
        if (e.altKey) { s.alt = true; }

        const str = shortcutToString(s);
        const sid = el.dataset.sid!;

        shortcutOverrides[sid] = str;
        el.value = str;
        el.setAttribute("readonly", "");
        document.removeEventListener("keydown", handler, true);
        scheduleSaveSettings();
        openSettings();
      };

      document.addEventListener("keydown", handler, true);
    });
  });

  // Shortcut reset
  overlay.querySelectorAll(".shortcut-reset").forEach((btn) => {
    btn.addEventListener("click", () => {
      const sid = (btn as HTMLElement).dataset.sid!;

      delete shortcutOverrides[sid];
      scheduleSaveSettings();
      openSettings();
    });
  });

  // Reset all
  document.getElementById("set-reset")!.onclick = async () => {
    const s = await getStore();

    await s.clear();
    await s.save();

    state.uiScale = 1.2;
    state.currentThemeSetting = "dark";
    state.pollIntervalMs = 50;
    setShortcutOverrides({});

    invoke("cmd_set_poll_interval", { intervalMs: state.pollIntervalMs });
    applyThemeFn("dark");
    setUiScale(1.2);

    editor.updateOptions({
      fontSize: 13,
      tabSize: 4,
      wordWrap: "off",
      minimap: { enabled: false },
      lineNumbers: "on",
    });

    overlay.remove();
  };
}

// --- Settings dialog HTML ---

function buildSettingsHtml(): string {
  const scalePercent = Math.round(state.uiScale * 100);
  const fontSize = editor.getOption(monaco.editor.EditorOption.fontSize);

  return SETTINGS_HTML
    .replace("{{scalePercent}}", String(scalePercent))
    .replace("{{scalePercent2}}", String(scalePercent))
    .replace("{{fontSize}}", String(fontSize))
    .replace("{{pollInterval}}", String(state.pollIntervalMs))
    .replace("{{pollInterval2}}", String(state.pollIntervalMs))
    .replace("{{lightChecked}}", state.currentThemeSetting === "light" ? "checked" : "")
    .replace("{{darkChecked}}", state.currentThemeSetting === "dark" ? "checked" : "")
    .replace("{{systemChecked}}", state.currentThemeSetting === "system" ? "checked" : "")
    .replace("{{filterChecked}}", state.filterExamples ? "checked" : "")
    .replace("{{shortcutRows}}", shortcutBindings
      .map(
        (b) => `
      <div class="shortcut-row">
        <span class="shortcut-action">${b.label}</span>
        <input class="shortcut-input" data-sid="${b.id}"
          value="${shortcutOverrides[b.id] || getShortcutDisplay(b)}"
          placeholder="${b.defaults.map(shortcutToString).join(" / ")}"
          readonly>
        ${shortcutOverrides[b.id] ? `<button class="shortcut-reset" data-sid="${b.id}" title="Reset to default">x</button>` : ""}
      </div>
    `,
      )
      .join(""));
}

const SETTINGS_HTML = `
  <div class="settings-dialog">
    <div class="settings-titlebar">General</div>
    <div class="settings-icon-tabs">
      <button class="settings-icon-tab active" data-stab="general">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>
        <span>General</span>
      </button>
      <button class="settings-icon-tab" data-stab="editor">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
        <span>Editor</span>
      </button>
      <button class="settings-icon-tab" data-stab="connection">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
        <span>Connection</span>
      </button>
      <button class="settings-icon-tab" data-stab="framebuffer">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="20" height="20" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
        <span>Frame Buffer</span>
      </button>
      <button class="settings-icon-tab" data-stab="shortcuts">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h8M6 16h.01M18 16h.01M10 16h4"/></svg>
        <span>Shortcuts</span>
      </button>
    </div>
    <div class="settings-divider"></div>

    <div class="settings-pane" data-stab="general">
      <div class="pref-row">
        <span class="pref-label">UI Scale:</span>
        <div class="scale-control">
          <input type="range" id="set-scale" min="50" max="200" step="5" value="{{scalePercent}}">
          <span class="scale-value" id="scale-label">{{scalePercent2}}%</span>
        </div>
      </div>
      <div class="pref-row">
        <span class="pref-label">Theme:</span>
        <div class="radio-group">
          <label class="radio-opt"><input type="radio" name="theme" value="light" {{lightChecked}}> Light</label>
          <label class="radio-opt"><input type="radio" name="theme" value="dark" {{darkChecked}}> Dark</label>
          <label class="radio-opt"><input type="radio" name="theme" value="system" {{systemChecked}}> System</label>
        </div>
      </div>
      <div class="pref-row">
        <span class="pref-label">Filter Examples:</span>
        <label class="switch"><input type="checkbox" id="set-filter-examples" {{filterChecked}}><span class="switch-slider"></span></label>
      </div>
      <div class="pref-row">
        <span class="pref-label"></span>
        <button class="pref-btn" id="set-reset">Reset All Settings</button>
      </div>
    </div>

    <div class="settings-pane" data-stab="editor" style="display:none">
      <div class="pref-row">
        <span class="pref-label">Font Size:</span>
        <input type="number" class="pref-input" id="set-font-size" value="{{fontSize}}" min="8" max="32">
      </div>
      <div class="pref-row">
        <span class="pref-label">Tab Size:</span>
        <input type="number" class="pref-input" id="set-tab-size" value="4" min="2" max="8">
      </div>
      <div class="pref-row">
        <span class="pref-label">Word Wrap:</span>
        <label class="switch"><input type="checkbox" id="set-word-wrap"><span class="switch-slider"></span></label>
      </div>
      <div class="pref-row">
        <span class="pref-label">Minimap:</span>
        <label class="switch"><input type="checkbox" id="set-minimap"><span class="switch-slider"></span></label>
      </div>
      <div class="pref-row">
        <span class="pref-label">Line Numbers:</span>
        <label class="switch"><input type="checkbox" checked id="set-line-numbers"><span class="switch-slider"></span></label>
      </div>
    </div>

    <div class="settings-pane" data-stab="connection" style="display:none">
      <div class="pref-row">
        <span class="pref-label">Connection Type:</span>
        <select class="pref-select" id="set-conn-type">
          <option value="serial" selected>Serial</option>
        </select>
      </div>
      <div class="pref-row">
        <span class="pref-label">Baudrate:</span>
        <select class="pref-select" id="set-baudrate">
          <option selected>921600</option>
          <option>460800</option>
          <option>115200</option>
        </select>
      </div>
      <div class="pref-row">
        <span class="pref-label">Poll Rate:</span>
        <div class="scale-control">
          <input type="range" id="set-poll-rate" min="10" max="200" step="10" value="{{pollInterval}}">
          <span class="scale-value" id="poll-rate-label">{{pollInterval2}} ms</span>
        </div>
      </div>
    </div>

    <div class="settings-pane" data-stab="framebuffer" style="display:none">
      <div class="pref-row">
        <span class="pref-label">JPEG Quality:</span>
        <input type="number" class="pref-input" value="80" min="10" max="100">
      </div>
      <div class="pref-row">
        <span class="pref-label">Auto Zoom:</span>
        <label class="switch"><input type="checkbox" checked><span class="switch-slider"></span></label>
      </div>
      <div class="pref-row">
        <span class="pref-label">Show Crosshair:</span>
        <label class="switch"><input type="checkbox"><span class="switch-slider"></span></label>
      </div>
    </div>

    <div class="settings-pane" data-stab="shortcuts" style="display:none">
      <div class="shortcuts-list">
        {{shortcutRows}}
      </div>
      <p class="shortcut-hint">Click a shortcut, then press the new key combination to rebind.</p>
    </div>
  </div>
`;
