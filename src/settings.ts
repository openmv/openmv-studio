// Settings persistence (save/load) and settings dialog UI.
// Manages the Store, UI scale, and all preference controls.

import * as monaco from "monaco-editor";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Store } from "@tauri-apps/plugin-store";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  state,
  scheduleSaveSettings,
  type ThemeSetting,
  setScheduleSaveSettings,
} from "./state";
import {
  openFiles,
  activeFileIndex,
  createFile,
  switchToFile,
  recentFiles,
  setRecentFiles,
} from "./files";
import { showWelcome } from "./welcome";
import { loadExamples, resetExamples, clearExamplesTree } from "./panels";
import {
  shortcutBindings,
  shortcutOverrides,
  setShortcutOverrides,
  getShortcutDisplay,
  getActiveShortcuts,
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
    if (saveTimer) {
      clearTimeout(saveTimer);
    }
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
    const rp = document.querySelector<HTMLElement>(".right-panel");
    const tools = document.querySelector(".tools-panel") as HTMLElement;
    const rpH = rp ? rp.getBoundingClientRect().height / state.uiScale : 0;
    const toolsH = tools?.getBoundingClientRect().height / state.uiScale;
    const toolsPct = rpH > 0 ? (toolsH / rpH) * 100 : 50;
    const layoutEl = document.querySelector<HTMLElement>(".ide-layout")!;
    const mainArea = document.querySelector<HTMLElement>(".main-area")!;

    await s.set("ui", {
      scale: state.uiScale,
      theme: state.currentThemeSetting,
      gridCols: layoutEl.style.gridTemplateColumns || "",
      gridRows: mainArea.style.gridTemplateRows || "",
      toolsPct: toolsPct,
      ioInterval: state.ioIntervalMs,
      filterExamples: state.filterExamples,
      splitLocked: state.splitLocked,
      transportType: state.transportType,
      networkAddress: state.networkAddress,
    });

    await s.set("editor", {
      fontSize: editor.getOption(monaco.editor.EditorOption.fontSize),
      wordWrap: editor.getOption(monaco.editor.EditorOption.wordWrap),
      minimap: editor.getOption(monaco.editor.EditorOption.minimap).enabled,
      lineNumbers: editor.getOption(monaco.editor.EditorOption.lineNumbers),
    });

    await s.set("shortcuts", shortcutOverrides);

    await s.set("files", {
      openFiles: openFiles
        .filter((f) => !f.isExample)
        .map((f) => f.path)
        .filter(Boolean),
      activeFile: openFiles[activeFileIndex]?.path || null,
      recentFiles: recentFiles,
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
      fbRatio?: number; // legacy
      toolsHeight?: number; // legacy
      toolsPct?: number;
      ioInterval?: number;
      filterExamples?: boolean;
      splitLocked?: boolean;
      transportType?: "serial" | "udp";
      networkAddress?: string;
    }>("ui");

    if (ui?.scale) {
      state.uiScale = ui.scale;
    }

    if (ui?.theme) {
      state.currentThemeSetting = ui.theme;
    }

    if (ui?.ioInterval) {
      state.ioIntervalMs = ui.ioInterval;
    }

    if (ui?.filterExamples !== undefined) {
      state.filterExamples = ui.filterExamples;
    }

    if (ui?.splitLocked) {
      state.splitLocked = true;
      document.getElementById("btn-lock-split")?.classList.add("active");
    }

    if (ui?.transportType) {
      state.transportType = ui.transportType;
    }

    if (ui?.networkAddress) {
      state.networkAddress = ui.networkAddress;
    }

    if (ui?.gridCols) {
      // Always restore with side panel closed
      const cols = ui.gridCols.replace(/^\s*56px\s+\d+px/, "56px 0px");
      document.querySelector<HTMLElement>(".ide-layout")!
        .style.gridTemplateColumns = cols;
    }

    if (ui?.gridRows) {
      document.querySelector<HTMLElement>(".main-area")!
        .style.gridTemplateRows = ui.gridRows;
    }

    const toolsPct = ui?.toolsPct;

    if (toolsPct !== undefined) {
      const fb = document.querySelector<HTMLElement>(".fb-section");
      const tools = document.querySelector<HTMLElement>(".tools-panel");

      if (fb && tools) {
        fb.style.flex = "1";
        tools.style.flex = "none";
        tools.style.height = toolsPct + "%";
      }
    }

    const editorSettings = await s.get<{
      fontSize?: number;
      wordWrap?: number;
      minimap?: boolean;
      lineNumbers?: number;
    }>("editor");

    if (editorSettings) {
      const opts: any = {};

      if (editorSettings.fontSize) {
        opts.fontSize = editorSettings.fontSize;
      }

      if (editorSettings.wordWrap !== undefined) {
        opts.wordWrap = editorSettings.wordWrap === 1 ? "on" : "off";
      }

      if (editorSettings.minimap !== undefined) {
        opts.minimap = { enabled: editorSettings.minimap };
      }

      if (editorSettings.lineNumbers !== undefined) {
        opts.lineNumbers = editorSettings.lineNumbers === 0 ? "off" : "on";
      }

      editor.updateOptions(opts);
    }

    const savedShortcuts = await s.get<Record<string, string>>("shortcuts");

    if (savedShortcuts) {
      setShortcutOverrides(savedShortcuts);
    }

    const files = await s.get<{
      openFiles?: string[];
      activeFile?: string | null;
      recentFiles?: string[];
    }>("files");

    if (files?.recentFiles) {
      setRecentFiles(files.recentFiles);
    }

    if (files?.openFiles && files.openFiles.length > 0) {
      for (const path of files.openFiles) {
        try {
          const content = await invoke<string>("cmd_read_file", { path });
          const f = createFile(path, content);

          try {
            f.mtime = await invoke<number>("cmd_file_mtime", { path });
          } catch {}
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

// --- Settings dialog (WebviewWindow) ---

let settingsWin: WebviewWindow | null = null;
let settingsUnlisten: (() => void) | null = null;

export async function openSettings() {
  if (settingsWin) {
    return;
  }

  const scale = state.uiScale;
  const win = new WebviewWindow("settings", {
    url: "settings.html",
    title: "Settings",
    width: Math.round(520 * scale),
    height: Math.round(560 * scale),
    resizable: true,
    center: true,
    parent: "main",
  });

  settingsWin = win;

  try {
    await new Promise<void>((resolve, reject) => {
      win.once("tauri://created", () => resolve());
      win.once("tauri://error", (e) => reject(e));
    });
  } catch (e: any) {
    console.error("Failed to create settings window:", e);
    settingsWin = null;
    return;
  }

  // Wait for the settings page JS to load and register listeners
  const readyUnlisten = await listen("settings-ready", () => {
    readyUnlisten();
    const edOpts = editor.getOptions();
    win.emit("settings-init", {
    scalePercent: Math.round(state.uiScale * 100),
    theme: state.currentThemeSetting,
    resolvedTheme: document.documentElement.getAttribute("data-theme") || "dark",
    filterExamples: state.filterExamples,
    transportType: state.transportType,
    networkAddress: state.networkAddress,
    serialPort: state.serialPort,
    ioIntervalMs: state.ioIntervalMs,
    fontSize: edOpts.get(monaco.editor.EditorOption.fontSize),
    tabSize: edOpts.get(monaco.editor.EditorOption.tabSize),
    wordWrap: edOpts.get(monaco.editor.EditorOption.wordWrap) !== 0,
    minimap: edOpts.get(monaco.editor.EditorOption.minimap).enabled,
    lineNumbers: edOpts.get(monaco.editor.EditorOption.lineNumbers) !== 0,
    shortcuts: shortcutBindings.map((b) => ({
      id: b.id,
      label: b.label,
      defaultDisplay: getShortcutDisplay(b),
      override: shortcutOverrides[b.id] || null,
    })),
    tabShortcuts: {
      prev: getActiveShortcuts(shortcutBindings.find((b) => b.id === "prev-tab")!),
      next: getActiveShortcuts(shortcutBindings.find((b) => b.id === "next-tab")!),
    },
    });
  });

  // Listen for changes from settings window
  const unlisten = await listen<any>("settings-change", (event) => {
    const { type, value } = event.payload;

    switch (type) {
      case "uiScale":
        setUiScale(value);
        scheduleSaveSettings();
        break;
      case "theme":
        applyThemeFn(value as ThemeSetting);
        scheduleSaveSettings();
        break;
      case "filterExamples":
        state.filterExamples = value;
        resetExamples();
        if (!state.filterExamples) {
          loadExamples();
        } else if (state.isConnected) {
          loadExamples();
        } else {
          clearExamplesTree();
        }
        scheduleSaveSettings();
        break;
      case "fontSize":
        editor.updateOptions({ fontSize: value });
        scheduleSaveSettings();
        break;
      case "tabSize":
        editor.updateOptions({ tabSize: value });
        scheduleSaveSettings();
        break;
      case "wordWrap":
        editor.updateOptions({ wordWrap: value ? "on" : "off" });
        scheduleSaveSettings();
        break;
      case "minimap":
        editor.updateOptions({ minimap: { enabled: value } });
        scheduleSaveSettings();
        break;
      case "lineNumbers":
        editor.updateOptions({ lineNumbers: value ? "on" : "off" });
        scheduleSaveSettings();
        break;
      case "transportType":
        state.transportType = value;
        scheduleSaveSettings();
        break;
      case "networkAddress":
        state.networkAddress = value;
        scheduleSaveSettings();
        break;
      case "serialPort":
        state.serialPort = value;
        break;
      case "ioIntervalMs":
        state.ioIntervalMs = value;
        scheduleSaveSettings();
        break;
      case "shortcutSet":
        shortcutOverrides[value.id] = value.value;
        scheduleSaveSettings();
        break;
      case "shortcutReset":
        delete shortcutOverrides[value];
        scheduleSaveSettings();
        break;
      case "reset":
        resetAllSettings();
        break;
    }
  });

  settingsUnlisten = unlisten;

  // Clean up when settings window closes
  win.once("tauri://destroyed", () => {
    if (settingsUnlisten) {
      settingsUnlisten();
      settingsUnlisten = null;
    }
    settingsWin = null;
  });
}

async function resetAllSettings() {
  const s = await getStore();

  await s.clear();
  await s.save();

  state.uiScale = 1.2;
  state.currentThemeSetting = "dark";
  state.ioIntervalMs = 10;
  state.splitLocked = false;
  state.transportType = "serial";
  state.networkAddress = "";
  document.getElementById("btn-lock-split")?.classList.remove("active");
  setShortcutOverrides({});

  applyThemeFn("dark");
  setUiScale(1.2);

  editor.updateOptions({
    fontSize: 13,
    tabSize: 4,
    wordWrap: "off",
    minimap: { enabled: false },
    lineNumbers: "on",
  });
}
