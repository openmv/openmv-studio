// File management, tab bar, open/close/save.
// Each open file has a Monaco editor model and tracked modification state.

import * as monaco from "monaco-editor";
import { invoke } from "@tauri-apps/api/core";
import {
  open,
  save,
  message as dialogMessage,
} from "@tauri-apps/plugin-dialog";
import { scheduleSaveSettings } from "./state";
import { showWelcome, hideWelcome } from "./welcome";

export interface OpenFile {
  path: string | null;
  name: string | null;
  model: monaco.editor.ITextModel;
  modified: boolean;
  isExample: boolean;
  untitledIndex: number | null;
}

let editor: monaco.editor.IStandaloneCodeEditor;
let untitledCounter = 1;

export let openFiles: OpenFile[] = [];
export let activeFileIndex = 0;

export function initFiles(ed: monaco.editor.IStandaloneCodeEditor) {
  editor = ed;
}

export function getActiveFile(): OpenFile | undefined {
  return openFiles[activeFileIndex];
}

export function fileName(f: OpenFile): string {
  if (f.name) { return f.name; }
  if (f.path) { return f.path.split("/").pop() || f.path; }
  return `untitled_${f.untitledIndex ?? 0}`;
}

export function createFile(
  path: string | null,
  content: string,
  isExample: boolean = false,
): OpenFile {
  const model = monaco.editor.createModel(content, "python");
  const name = isExample && path ? path.split("/").pop() || null : null;
  const untitledIndex = path === null && !isExample ? untitledCounter++ : null;

  const file: OpenFile = {
    path,
    name,
    model,
    modified: false,
    isExample,
    untitledIndex,
  };

  model.onDidChangeContent(() => {
    if (file.isExample) {
      file.isExample = false;
      file.path = null;
    }

    file.modified = true;
    renderTabs();
    scheduleSaveSettings();
  });

  openFiles.push(file);
  return file;
}

export function switchToFile(index: number) {
  if (index < 0 || index >= openFiles.length) {
    return;
  }

  activeFileIndex = index;
  editor.setModel(openFiles[index].model);
  renderTabs();
  scheduleSaveSettings();
}

export function renderTabs() {
  const bar = document.getElementById("tab-bar")!;

  bar.innerHTML = "";

  openFiles.forEach((f, i) => {
    const tab = document.createElement("div");

    tab.className = "tab" + (i === activeFileIndex ? " active" : "");

    if (f.modified) {
      const dot = document.createElement("span");
      dot.className = "dot";
      tab.appendChild(dot);
    } else if (f.isExample) {
      const dot = document.createElement("span");
      dot.className = "dot example-dot";
      tab.appendChild(dot);
    }

    const label = document.createElement("span");
    label.textContent = fileName(f);
    tab.appendChild(label);

    const close = document.createElement("span");

    close.className = "close-tab";
    close.innerHTML =
      '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    close.addEventListener("mousedown", (e) => {
      e.stopPropagation();
      e.preventDefault();
    });
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      closeFile(i);
    });
    tab.appendChild(close);

    tab.addEventListener("click", () => switchToFile(i));
    tab.addEventListener("auxclick", (e) => {
      if (e.button === 1) {
        e.preventDefault();
        closeFile(i);
      }
    });

    bar.appendChild(tab);
  });
}

export async function newFile() {
  hideWelcome();
  createFile(null, "");
  switchToFile(openFiles.length - 1);
}

export async function openFileDialog() {
  const path = await open({
    multiple: false,
    filters: [
      { name: "Python", extensions: ["py"] },
      { name: "All", extensions: ["*"] },
    ],
  });

  if (!path) {
    return;
  }

  hideWelcome();
  const filePath = path as string;

  const existing = openFiles.findIndex((f) => f.path === filePath);

  if (existing >= 0) {
    switchToFile(existing);
    return;
  }

  try {
    const content = await invoke<string>("cmd_read_file", { path: filePath });
    createFile(filePath, content);
    switchToFile(openFiles.length - 1);
  } catch (e: any) {
    console.error("Open failed:", e);
  }
}

export async function saveFile() {
  const f = openFiles[activeFileIndex];

  if (!f) { return; }

  if (!f.path) {
    await saveFileAs();
    return;
  }

  try {
    await invoke("cmd_write_file", {
      path: f.path,
      content: f.model.getValue(),
    });

    f.modified = false;
    renderTabs();
  } catch (e: any) {
    console.error("Save failed:", e);
  }
}

export async function saveFileAs() {
  const f = openFiles[activeFileIndex];

  if (!f) { return; }

  const path = await save({
    defaultPath: f.path || `${fileName(f)}.py`,
    filters: [
      { name: "Python", extensions: ["py"] },
      { name: "All", extensions: ["*"] },
    ],
  });

  if (!path) { return; }

  f.path = path;

  try {
    await invoke("cmd_write_file", {
      path: f.path,
      content: f.model.getValue(),
    });

    f.modified = false;
    renderTabs();
  } catch (e: any) {
    console.error("Save failed:", e);
  }
}

export async function closeFile(index: number) {
  if (index < 0 || index >= openFiles.length) {
    return;
  }

  const f = openFiles[index];

  if (f.modified) {
    const result = await dialogMessage(
      `Do you want to save changes to ${fileName(f)}?`,
      {
        title: "Save Changes",
        buttons: { yes: "Save", no: "Don't Save", cancel: "Cancel" },
      },
    );

    if (result === "Cancel") { return; }

    if (result === "Yes") {
      switchToFile(index);
      await saveFile();

      if (f.modified) { return; }
    }
  }

  f.model.dispose();
  openFiles.splice(index, 1);

  if (openFiles.length === 0) {
    renderTabs();
    showWelcome();
    scheduleSaveSettings();
    return;
  } else if (activeFileIndex >= openFiles.length) {
    activeFileIndex = openFiles.length - 1;
  } else if (activeFileIndex > index) {
    activeFileIndex--;
  }

  switchToFile(activeFileIndex);
  scheduleSaveSettings();
}
