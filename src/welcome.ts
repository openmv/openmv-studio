/*
 * Copyright (C) 2026 OpenMV, LLC.
 *
 * This software is licensed under terms that can be found in the
 * LICENSE file in the root directory of this software component.
 */
// Welcome screen shown when no files are open.
// Provides quick-action buttons for New File and Open File.

import { isMac } from "./shortcuts";

const mod = isMac ? "Cmd" : "Ctrl";

const WELCOME_HTML = `
  <div class="welcome-inner">
    <img src="/openmv-logo.svg" class="welcome-logo-img" alt="OpenMV">
    <h1 class="welcome-title">OpenMV Studio</h1>
    <p class="welcome-subtitle">Machine Vision Made Simple</p>
    <div class="welcome-actions">
      <button class="welcome-btn" id="welcome-new">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>
        New File
      </button>
      <button class="welcome-btn" id="welcome-open">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
        Open File
      </button>
    </div>
    <div class="welcome-shortcuts">
      <h2>Shortcuts</h2>
      <div class="welcome-shortcut-grid">
        <div class="ws-row"><span class="ws-key">Ctrl+E</span><span class="ws-desc">Connect / Disconnect</span></div>
        <div class="ws-row"><span class="ws-key">${mod}+R</span><span class="ws-desc">Run / Stop Script</span></div>
        <div class="ws-row"><span class="ws-key">${mod}+N</span><span class="ws-desc">New File</span></div>
        <div class="ws-row"><span class="ws-key">${mod}+O</span><span class="ws-desc">Open File</span></div>
        <div class="ws-row"><span class="ws-key">${mod}+S</span><span class="ws-desc">Save</span></div>
        <div class="ws-row"><span class="ws-key">${mod}+W</span><span class="ws-desc">Close Tab</span></div>
        <div class="ws-row"><span class="ws-key">${mod}+,</span><span class="ws-desc">Settings</span></div>
        <div class="ws-row"><span class="ws-key">${mod}+=/-</span><span class="ws-desc">Zoom In / Out</span></div>
      </div>
    </div>
  </div>
`;

const welcomeEl = document.getElementById("welcome-screen")!;
let initialized = false;

// Set by initWelcome so we don't import files.ts (avoid circular dep)
let onNew: () => void = () => {};
let onOpen: () => void = () => {};

export function initWelcome(newFile: () => void, openFile: () => void) {
  onNew = newFile;
  onOpen = openFile;
}

export function showWelcome() {
  document.getElementById("tab-bar-container")!.style.display = "none";
  document.querySelector<HTMLElement>(".editor-area")!.style.display = "none";

  if (!initialized) {
    welcomeEl.innerHTML = WELCOME_HTML;

    document.getElementById("welcome-new")!.onclick = () => {
      hideWelcome();
      onNew();
    };
    document.getElementById("welcome-open")!.onclick = () => onOpen();

    initialized = true;
  }

  welcomeEl.style.display = "";
}

export function hideWelcome() {
  welcomeEl.style.display = "none";
  document.getElementById("tab-bar-container")!.style.display = "";
  document.querySelector<HTMLElement>(".editor-area")!.style.display = "";
}
