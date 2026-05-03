/*
 * Copyright (C) 2026 OpenMV, LLC.
 *
 * This software is licensed under terms that can be found in the
 * LICENSE file in the root directory of this software component.
 */
// File management, tab bar, open/close/save.
// Each open file has a Monaco editor model and tracked modification state.

import * as monaco from "monaco-editor";
import { invoke } from "@tauri-apps/api/core";
import {
  open,
  save,
  message as dialogMessage,
  ask,
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
  savedContent: string;
  mtime: number;
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
  if (f.name) {
    return f.name;
  }

  if (f.path) {
    return f.path.split("/").pop() || f.path;
  }
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
    savedContent: content,
    mtime: 0,
  };

  model.onDidChangeContent(() => {
    if (file.isExample) {
      file.isExample = false;
      file.path = null;
    }

    const wasModified = file.modified;
    file.modified = file.path === null || model.getValue() !== file.savedContent;

    if (wasModified !== file.modified) {
      renderTabs();
    }

    scheduleSaveSettings();
  });

  openFiles.push(file);
  return file;
}

export function moveTabLeft() {
  if (openFiles.length < 2 || activeFileIndex <= 0) {
    return;
  }

  const i = activeFileIndex;
  const tmp = openFiles[i];
  openFiles[i] = openFiles[i - 1];
  openFiles[i - 1] = tmp;
  activeFileIndex = i - 1;

  renderTabs();
  scheduleSaveSettings();
}

export function moveTabRight() {
  if (openFiles.length < 2 || activeFileIndex >= openFiles.length - 1) {
    return;
  }

  const i = activeFileIndex;
  const tmp = openFiles[i];
  openFiles[i] = openFiles[i + 1];
  openFiles[i + 1] = tmp;
  activeFileIndex = i + 1;

  renderTabs();
  scheduleSaveSettings();
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

let dragState: { index: number; startX: number } | null = null;

function initTabDrag(tab: HTMLElement, index: number) {
  tab.addEventListener("mousedown", (e) => {
    if (e.button !== 0) {
      return;
    }

    if ((e.target as HTMLElement).closest(".close-tab")) {
      return;
    }

    dragState = { index, startX: e.clientX };

    const onMove = (ev: MouseEvent) => {
      if (!dragState) {
        return;
      }

      if (Math.abs(ev.clientX - dragState.startX) < 5) {
        return;
      }

      tab.classList.add("dragging");

      const bar = tab.parentElement!;
      const tabs = Array.from(bar.children) as HTMLElement[];

      tabs.forEach((t) => {
        t.classList.remove("drag-before", "drag-after");
      });

      for (const t of tabs) {
        if (t === tab) {
          continue;
        }

        const rect = t.getBoundingClientRect();
        const mid = rect.left + rect.width / 2;

        if (ev.clientX >= rect.left && ev.clientX <= rect.right) {
          t.classList.add(ev.clientX < mid ? "drag-before" : "drag-after");
          break;
        }
      }
    };

    const onUp = (ev: MouseEvent) => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);

      if (!dragState) {
        return;
      }

      const fromIdx = dragState.index;
      dragState = null;

      tab.classList.remove("dragging");
      const bar = tab.parentElement!;
      const tabs = Array.from(bar.children) as HTMLElement[];
      tabs.forEach((t) => t.classList.remove("drag-before", "drag-after"));

      // Find drop target
      let toIdx = -1;
      let after = false;

      for (let ti = 0; ti < tabs.length; ti++) {
        if (ti === fromIdx) {
          continue;
        }

        const rect = tabs[ti].getBoundingClientRect();
        const mid = rect.left + rect.width / 2;

        if (ev.clientX >= rect.left && ev.clientX <= rect.right) {
          toIdx = ti;
          after = ev.clientX >= mid;
          break;
        }
      }

      if (toIdx < 0 || toIdx === fromIdx) {
        return;
      }

      // Calculate insert position accounting for removal shift
      let insertIdx = after ? toIdx + 1 : toIdx;

      if (fromIdx < insertIdx) {
        insertIdx--;
      }

      if (insertIdx === fromIdx) {
        return;
      }

      const moved = openFiles.splice(fromIdx, 1)[0];
      openFiles.splice(insertIdx, 0, moved);

      if (activeFileIndex === fromIdx) {
        activeFileIndex = insertIdx;
      } else if (fromIdx < activeFileIndex && insertIdx >= activeFileIndex) {
        activeFileIndex--;
      } else if (fromIdx > activeFileIndex && insertIdx <= activeFileIndex) {
        activeFileIndex++;
      }

      renderTabs();
      scheduleSaveSettings();
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

function updateScrollButtons() {
  const bar = document.getElementById("tab-bar")!;
  const left = document.getElementById("tab-scroll-left")!;
  const right = document.getElementById("tab-scroll-right")!;
  const overflows = bar.scrollWidth > bar.clientWidth;

  left.classList.toggle("visible", overflows && bar.scrollLeft > 0);
  right.classList.toggle("visible",
    overflows && bar.scrollLeft < bar.scrollWidth - bar.clientWidth - 1);
}

let tabScrollInit = false;

function initTabScroll() {
  if (tabScrollInit) {
    return;
  }
  tabScrollInit = true;

  const bar = document.getElementById("tab-bar")!;
  const left = document.getElementById("tab-scroll-left")!;
  const right = document.getElementById("tab-scroll-right")!;

  left.addEventListener("click", () => {
    bar.scrollBy({ left: -120, behavior: "smooth" });
  });

  right.addEventListener("click", () => {
    bar.scrollBy({ left: 120, behavior: "smooth" });
  });

  bar.addEventListener("wheel", (e) => {
    e.preventDefault();
    bar.scrollLeft += e.deltaX + e.deltaY;
  }, { passive: false });

  bar.addEventListener("scroll", updateScrollButtons);

  new ResizeObserver(updateScrollButtons).observe(bar);
}

export function renderTabs() {
  const bar = document.getElementById("tab-bar")!;

  bar.innerHTML = "";
  initTabScroll();

  openFiles.forEach((f, i) => {
    const tab = document.createElement("div");

    tab.className = "tab" + (i === activeFileIndex ? " active" : "");

    initTabDrag(tab, i);

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

  // Scroll active tab into view
  const activeTab = bar.children[activeFileIndex] as HTMLElement | undefined;

  if (activeTab) {
    activeTab.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  updateScrollButtons();
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
    const f = createFile(filePath, content);

    try {
      f.mtime = await invoke<number>("cmd_file_mtime", { path: filePath });
    } catch {}

    switchToFile(openFiles.length - 1);
  } catch (e: any) {
    console.error("Open failed:", e);
  }
}

export async function saveFile() {
  const f = openFiles[activeFileIndex];

  if (!f) {
    return;
  }

  if (!f.path) {
    await saveFileAs();
    return;
  }

  try {
    const content = f.model.getValue();

    await invoke("cmd_write_file", {
      path: f.path,
      content,
    });

    f.savedContent = content;
    f.modified = false;

    try {
      f.mtime = await invoke<number>("cmd_file_mtime", { path: f.path! });
    } catch {}

    renderTabs();
  } catch (e: any) {
    console.error("Save failed:", e);
  }
}

export async function saveFileAs() {
  const f = openFiles[activeFileIndex];

  if (!f) {
    return;
  }

  const path = await save({
    defaultPath: f.path || `${fileName(f)}.py`,
    filters: [
      { name: "Python", extensions: ["py"] },
      { name: "All", extensions: ["*"] },
    ],
  });

  if (!path) {
    return;
  }

  f.path = path;

  try {
    const content = f.model.getValue();

    await invoke("cmd_write_file", {
      path: f.path,
      content,
    });

    f.savedContent = content;
    f.modified = false;

    try {
      f.mtime = await invoke<number>("cmd_file_mtime", { path: f.path! });
    } catch {}

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

    if (result === "Cancel") {
      return;
    }

    if (result === "Yes") {
      switchToFile(index);
      await saveFile();

      if (f.modified) {
        return;
      }
    }
  }

  if (f.path && !f.isExample) {
    addRecentFile(f.path);
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

// --- Recent files ---

const MAX_RECENT = 10;
export let recentFiles: string[] = [];

export function setRecentFiles(paths: string[]) {
  recentFiles = paths;
}

function addRecentFile(path: string) {
  recentFiles = recentFiles.filter((p) => p !== path);
  recentFiles.unshift(path);

  if (recentFiles.length > MAX_RECENT) {
    recentFiles.length = MAX_RECENT;
  }

  updateRecentMenu();
  scheduleSaveSettings();
}

export function updateRecentMenu() {
  invoke("cmd_update_recent_menu", { paths: recentFiles }).catch((e) => {
    console.error("Failed to update recent menu:", e);
  });
}

export async function openRecentFile(path: string) {
  hideWelcome();

  const existing = openFiles.findIndex((f) => f.path === path);

  if (existing >= 0) {
    switchToFile(existing);
    return;
  }

  try {
    const content = await invoke<string>("cmd_read_file", { path });
    const f = createFile(path, content);

    try {
      f.mtime = await invoke<number>("cmd_file_mtime", { path });
    } catch {}

    // Remove from recents since it's now open in a tab
    recentFiles = recentFiles.filter((p) => p !== path);
    updateRecentMenu();
    scheduleSaveSettings();
    switchToFile(openFiles.length - 1);
  } catch (e: any) {
    console.error("Open recent failed:", e);
    recentFiles = recentFiles.filter((p) => p !== path);
    updateRecentMenu();
    scheduleSaveSettings();
  }
}

// --- File watching ---

let watchTimer: number | null = null;
let watchInFlight = false;

export function startFileWatching() {
  stopFileWatching();
  watchTimer = window.setInterval(checkFilesForChanges, 2000);
}

export function stopFileWatching() {
  if (watchTimer !== null) {
    clearInterval(watchTimer);
    watchTimer = null;
  }
}

async function checkFilesForChanges() {
  if (watchInFlight) {
    return;
  }

  watchInFlight = true;

  try {
    for (const f of openFiles) {
      if (!f.path || f.mtime === 0) {
        continue;
      }

      let currentMtime: number;

      try {
        currentMtime = await invoke<number>("cmd_file_mtime", { path: f.path });
      } catch {
        continue;
      }

      if (currentMtime <= f.mtime) {
        continue;
      }

      f.mtime = currentMtime;

      const reload = await ask(
        `${fileName(f)} has been modified externally. Reload?`,
        { title: "File Changed", kind: "info" },
      );

      if (reload) {
        try {
          const content = await invoke<string>("cmd_read_file", { path: f.path });

          f.savedContent = content;
          f.model.setValue(content);
          f.modified = false;
          renderTabs();
        } catch (e: any) {
          console.error("Reload failed:", e);
        }
      }
    }
  } finally {
    watchInFlight = false;
  }
}
