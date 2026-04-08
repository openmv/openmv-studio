import * as monaco from 'monaco-editor';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Store } from '@tauri-apps/plugin-store';
import { open, save, message as dialogMessage } from '@tauri-apps/plugin-dialog';
import { getCurrentWindow } from '@tauri-apps/api/window';

// Disable right-click context menu except on terminal and editor (for copy)
document.addEventListener('contextmenu', (e) => {
  const t = e.target as HTMLElement;
  if (t.closest('.terminal-content') || t.closest('#monaco-editor')) return;
  e.preventDefault();
});

// Monaco workers (required for language features)
self.MonacoEnvironment = {
  getWorker(_: string, label: string) {
    if (label === 'json') {
      return new Worker(new URL('monaco-editor/esm/vs/language/json/json.worker.js', import.meta.url), { type: 'module' });
    }
    if (label === 'typescript' || label === 'javascript') {
      return new Worker(new URL('monaco-editor/esm/vs/language/typescript/ts.worker.js', import.meta.url), { type: 'module' });
    }
    return new Worker(new URL('monaco-editor/esm/vs/editor/editor.worker.js', import.meta.url), { type: 'module' });
  }
};

// Monaco themes
monaco.editor.defineTheme('openmv-dark', {
  base: 'vs-dark', inherit: true,
  rules: [
    { token: 'comment', foreground: '546e7a', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'c792ea' },
    { token: 'string', foreground: 'c3e88d' },
    { token: 'number', foreground: 'f78c6c' },
    { token: 'identifier', foreground: 'e8e6e3' },
    { token: 'type', foreground: 'ffcb6b' },
    { token: 'delimiter', foreground: '89ddff' },
  ],
  colors: {
    'editor.background': '#1e1e23', 'editor.foreground': '#e8e6e3',
    'editor.lineHighlightBackground': '#5b9cf510', 'editor.selectionBackground': '#5b9cf540',
    'editorLineNumber.foreground': '#4a4845', 'editorLineNumber.activeForeground': '#6b6966',
    'editorCursor.foreground': '#5b9cf5',
    'scrollbarSlider.background': '#ffffff14', 'scrollbarSlider.hoverBackground': '#ffffff1f',
  }
});

monaco.editor.defineTheme('openmv-light', {
  base: 'vs', inherit: true,
  rules: [
    { token: 'comment', foreground: '6a737d', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'd73a49' },
    { token: 'string', foreground: '22863a' },
    { token: 'number', foreground: '005cc5' },
    { token: 'identifier', foreground: '24292e' },
    { token: 'type', foreground: 'e36209' },
    { token: 'delimiter', foreground: '6f42c1' },
  ],
  colors: {
    'editor.background': '#f8f8fa', 'editor.foreground': '#1a1a1e',
    'editor.lineHighlightBackground': '#2b7cf508', 'editor.selectionBackground': '#2b7cf530',
    'editorLineNumber.foreground': '#b0b0b8', 'editorLineNumber.activeForeground': '#8a8a94',
    'editorCursor.foreground': '#2b7cf5',
    'scrollbarSlider.background': '#00000014', 'scrollbarSlider.hoverBackground': '#0000001f',
  }
});

// -- Theme management --
type ThemeSetting = 'dark' | 'light' | 'system';
let currentThemeSetting: ThemeSetting = 'dark';

function getEffectiveTheme(): 'dark' | 'light' {
  if (currentThemeSetting === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return currentThemeSetting;
}

function applyTheme(setting: ThemeSetting) {
  currentThemeSetting = setting;
  const effective = getEffectiveTheme();
  document.documentElement.setAttribute('data-theme', effective);
  monaco.editor.setTheme(effective === 'dark' ? 'openmv-dark' : 'openmv-light');
  scheduleSaveSettings();
}

// Listen for system theme changes
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (currentThemeSetting === 'system') applyTheme('system');
});

// -- Settings store --
let store: Store | null = null;
async function getStore(): Promise<Store> {
  if (!store) {
    store = await Store.load('settings.json');
  }
  return store;
}

// -- Welcome screen --
const welcomeEl = document.getElementById('welcome-screen')!;
let welcomeInitialized = false;

function showWelcome() {
  document.getElementById('tab-bar')!.style.display = 'none';
  document.querySelector<HTMLElement>('.editor-area')!.style.display = 'none';

  if (!welcomeInitialized) {
    welcomeEl.innerHTML = `
      <div class="welcome-inner">
        <img src="/openmv-logo.svg" class="welcome-logo-img" alt="OpenMV">
        <h1 class="welcome-title">OpenMV IDE</h1>
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
            <div class="ws-row"><span class="ws-key">Cmd+R</span><span class="ws-desc">Run / Stop Script</span></div>
            <div class="ws-row"><span class="ws-key">Cmd+N</span><span class="ws-desc">New File</span></div>
            <div class="ws-row"><span class="ws-key">Cmd+O</span><span class="ws-desc">Open File</span></div>
            <div class="ws-row"><span class="ws-key">Cmd+S</span><span class="ws-desc">Save</span></div>
            <div class="ws-row"><span class="ws-key">Cmd+W</span><span class="ws-desc">Close Tab</span></div>
            <div class="ws-row"><span class="ws-key">Cmd+,</span><span class="ws-desc">Settings</span></div>
            <div class="ws-row"><span class="ws-key">Cmd+=/-</span><span class="ws-desc">Zoom In / Out</span></div>
          </div>
        </div>
      </div>
    `;
    document.getElementById('welcome-new')!.onclick = () => { hideWelcome(); newFile(); };
    document.getElementById('welcome-open')!.onclick = () => openFileDialog();
    welcomeInitialized = true;
  }

  welcomeEl.style.display = '';
}

function hideWelcome() {
  welcomeEl.style.display = 'none';
  document.getElementById('tab-bar')!.style.display = '';
  document.querySelector<HTMLElement>('.editor-area')!.style.display = '';
}

// -- File management --
interface OpenFile {
  path: string | null; // null = untitled
  name: string | null; // display name override (kept after example is edited)
  model: monaco.editor.ITextModel;
  modified: boolean;
  isExample: boolean;  // true = opened from examples, save should prompt save-as
  untitledIndex: number | null; // sequence number for untitled files
}

let openFiles: OpenFile[] = [];
let activeFileIndex = 0;
let untitledCounter = 1;

// Create editor (empty, will be populated by file management)
const editor = monaco.editor.create(document.getElementById('monaco-editor')!, {
  language: 'python',
  theme: getEffectiveTheme() === 'dark' ? 'openmv-dark' : 'openmv-light',
  fontSize: 13,
  fontFamily: "'SF Mono', 'Menlo', 'Consolas', monospace",
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  renderLineHighlight: 'line',
  automaticLayout: true,
  padding: { top: 8, bottom: 8 },
  glyphMargin: true,
  folding: true,
  cursorBlinking: 'smooth',
  smoothScrolling: true,
  tabSize: 4,
  insertSpaces: true,
});

// Unbind Ctrl+E from Monaco (conflicts with Connect shortcut)
monaco.editor.addKeybindingRules([
  { keybinding: monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyE, command: null },
]);

function fileName(f: OpenFile): string {
  if (f.name) return f.name;
  if (f.path) return f.path.split('/').pop() || f.path;
  return `untitled_${f.untitledIndex ?? 0}`;
}

function createFile(path: string | null, content: string, isExample: boolean = false): OpenFile {
  const model = monaco.editor.createModel(content, 'python');
  const name = isExample && path ? (path.split('/').pop() || null) : null;
  const untitledIndex = path === null && !isExample ? untitledCounter++ : null;
  const file: OpenFile = { path, name, model, modified: false, isExample, untitledIndex };
  model.onDidChangeContent(() => {
    if (file.isExample) {
      // Copy-on-write: editing an example detaches it
      file.isExample = false;
      file.path = null;
      // file.name is kept so the tab still shows the example filename
    }
    file.modified = true;
    renderTabs();
    scheduleSaveSettings();
  });
  openFiles.push(file);
  return file;
}

function switchToFile(index: number) {
  if (index < 0 || index >= openFiles.length) return;
  activeFileIndex = index;
  editor.setModel(openFiles[index].model);
  renderTabs();
  scheduleSaveSettings();
}

function renderTabs() {
  const bar = document.getElementById('tab-bar')!;
  bar.innerHTML = '';
  openFiles.forEach((f, i) => {
    const tab = document.createElement('div');
    tab.className = 'tab' + (i === activeFileIndex ? ' active' : '');

    if (f.modified) {
      const dot = document.createElement('span');
      dot.className = 'dot';
      tab.appendChild(dot);
    } else if (f.isExample) {
      const dot = document.createElement('span');
      dot.className = 'dot example-dot';
      tab.appendChild(dot);
    }

    const label = document.createElement('span');
    label.textContent = fileName(f);
    tab.appendChild(label);

    const close = document.createElement('span');
    close.className = 'close-tab';
    close.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    close.addEventListener('mousedown', (e) => { e.stopPropagation(); e.preventDefault(); });
    close.addEventListener('click', (e) => { e.stopPropagation(); closeFile(i); });
    tab.appendChild(close);

    tab.addEventListener('click', () => switchToFile(i));
    tab.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); closeFile(i); } });
    bar.appendChild(tab);
  });
}

async function newFile() {
  hideWelcome();
  createFile(null, '');
  switchToFile(openFiles.length - 1);
}

async function openFileDialog() {
  const path = await open({
    multiple: false,
    filters: [{ name: 'Python', extensions: ['py'] }, { name: 'All', extensions: ['*'] }],
  });
  if (!path) return;
  hideWelcome();
  const filePath = path as string;

  // Check if already open
  const existing = openFiles.findIndex(f => f.path === filePath);
  if (existing >= 0) { switchToFile(existing); return; }

  try {
    const content = await invoke<string>('cmd_read_file', { path: filePath });
    createFile(filePath, content);
    switchToFile(openFiles.length - 1);
  } catch (e: any) {
    console.error('Open failed:', e);
  }
}

async function saveFile() {
  const f = openFiles[activeFileIndex];
  if (!f) return;
  if (!f.path) { await saveFileAs(); return; }
  try {
    await invoke('cmd_write_file', { path: f.path, content: f.model.getValue() });
    f.modified = false;
    renderTabs();
  } catch (e: any) {
    console.error('Save failed:', e);
  }
}

async function saveFileAs() {
  const f = openFiles[activeFileIndex];
  if (!f) return;
  const path = await save({
    defaultPath: f.path || `${fileName(f)}.py`,
    filters: [{ name: 'Python', extensions: ['py'] }, { name: 'All', extensions: ['*'] }],
  });
  if (!path) return;
  f.path = path;
  try {
    await invoke('cmd_write_file', { path: f.path, content: f.model.getValue() });
    f.modified = false;
    renderTabs();
  } catch (e: any) {
    console.error('Save failed:', e);
  }
}

async function closeFile(index: number) {
  if (index < 0 || index >= openFiles.length) return;
  const f = openFiles[index];
  if (f.modified) {
    const result = await dialogMessage(
      `Do you want to save changes to ${fileName(f)}?`,
      {
        title: 'Save Changes',
        buttons: { yes: 'Save', no: "Don't Save", cancel: 'Cancel' },
      },
    );
    if (result === 'Cancel') return;
    if (result === 'Yes') {
      // Switch to the file so saveFile/saveFileAs operates on it
      switchToFile(index);
      await saveFile();
      // If still modified after save attempt (e.g. user cancelled save-as), abort close
      if (f.modified) return;
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

// -- Settings persistence --
let saveSettingsTimer: number | null = null;

function scheduleSaveSettings() {
  if (saveSettingsTimer) clearTimeout(saveSettingsTimer);
  saveSettingsTimer = window.setTimeout(saveSettings, 500);
}

async function saveSettings() {
  try {
    const s = await getStore();
    const fb = document.querySelector('.fb-section') as HTMLElement;
    const tools = document.querySelector('.tools-panel') as HTMLElement;
    const rp = document.querySelector('.right-panel') as HTMLElement;
    const rpH = rp?.getBoundingClientRect().height / uiScale;
    const fbH = fb?.getBoundingClientRect().height / uiScale;
    await s.set('ui', {
      scale: uiScale,
      theme: currentThemeSetting,
      gridCols: layout.style.gridTemplateColumns || '',
      gridRows: mainArea.style.gridTemplateRows || '',
      fbRatio: rpH > 0 ? fbH / rpH : 0.5,
      pollInterval: pollIntervalMs,
      filterExamples: filterExamples,
    });
    await s.set('editor', {
      fontSize: editor.getOption(monaco.editor.EditorOption.fontSize),
      tabSize: editor.getOption(monaco.editor.EditorOption.tabSize),
    });
    await s.set('shortcuts', shortcutOverrides);
    await s.set('files', {
      openFiles: openFiles.filter(f => !f.isExample).map(f => f.path).filter(Boolean),
      activeFile: openFiles[activeFileIndex]?.path || null,
    });
    await s.save();
  } catch (e) {
    console.error('Failed to save settings:', e);
  }
}

async function loadSettings() {
  try {
    const s = await getStore();
    const ui = await s.get<{
      scale?: number; theme?: ThemeSetting;
      gridCols?: string; gridRows?: string;
      fbRatio?: number; pollInterval?: number; filterExamples?: boolean;
    }>('ui');
    if (ui?.scale) uiScale = ui.scale;
    if (ui?.theme) currentThemeSetting = ui.theme;
    if (ui?.pollInterval) pollIntervalMs = ui.pollInterval;
    if (ui?.filterExamples !== undefined) filterExamples = ui.filterExamples;
    if (ui?.gridCols) document.querySelector<HTMLElement>('.ide-layout')!.style.gridTemplateColumns = ui.gridCols;
    if (ui?.gridRows) document.querySelector<HTMLElement>('.main-area')!.style.gridTemplateRows = ui.gridRows;
    // Defer FB/tools ratio until layout is rendered
    if (ui?.fbRatio !== undefined) {
      requestAnimationFrame(() => {
        const fb = document.querySelector<HTMLElement>('.fb-section');
        const tools = document.querySelector<HTMLElement>('.tools-panel');
        const rp = document.querySelector<HTMLElement>('.right-panel');
        if (fb && tools && rp) {
          const rpH = rp.getBoundingClientRect().height / uiScale;
          const fbH = Math.max(80, rpH * ui.fbRatio!);
          const toolsH = Math.max(60, rpH - fbH - 4);
          fb.style.flex = 'none'; fb.style.height = fbH + 'px';
          tools.style.flex = 'none'; tools.style.height = toolsH + 'px';
        }
      });
    }
    const editorSettings = await s.get<{ fontSize?: number; tabSize?: number }>('editor');
    if (editorSettings) {
      if (editorSettings.fontSize) editor.updateOptions({ fontSize: editorSettings.fontSize });
      if (editorSettings.tabSize) editor.updateOptions({ tabSize: editorSettings.tabSize });
    }
    const savedShortcuts = await s.get<Record<string, string>>('shortcuts');
    if (savedShortcuts) shortcutOverrides = savedShortcuts;
    const files = await s.get<{ openFiles?: string[]; activeFile?: string | null }>('files');
    if (files?.openFiles && files.openFiles.length > 0) {
      for (const path of files.openFiles) {
        try {
          const content = await invoke<string>('cmd_read_file', { path });
          createFile(path, content);
        } catch {
          // File no longer exists or can't be read -- skip silently
        }
      }
      if (openFiles.length > 0) {
        const activeIdx = files.activeFile
          ? openFiles.findIndex(f => f.path === files.activeFile)
          : 0;
        switchToFile(Math.max(0, activeIdx));
      }
    }
  } catch (e) {
    console.error('Failed to load settings:', e);
  }

  // If no files were loaded, show welcome screen
  if (openFiles.length === 0) {
    showWelcome();
  }
}

// -- Init: load settings then set up UI --
loadSettings().then(() => {
  setUIScale(uiScale);
  applyTheme(currentThemeSetting);
  renderTabs();
  if (!filterExamples) loadExamples();
});

// Prompt on unsaved files before quitting
listen('request-close', async () => {
  for (const f of openFiles) {
    if (!f.modified) continue;
    const result = await dialogMessage(
      `Do you want to save changes to ${fileName(f)}?`,
      {
        title: 'Save Changes',
        buttons: { yes: 'Save', no: "Don't Save", cancel: 'Cancel' },
      },
    );
    if (result === 'Cancel') return;
    if (result === 'Save') {
      const idx = openFiles.indexOf(f);
      switchToFile(idx);
      if (f.path) {
        await saveFile();
      } else {
        await saveFileAs();
      }
      if (f.modified) return; // user cancelled save-as
    }
  }
  await getCurrentWindow().destroy();
});

// Cursor position in status bar
editor.onDidChangeCursorPosition((e) => {
  const el = document.getElementById('status-cursor');
  if (el) el.textContent = `Ln ${e.position.lineNumber}, Col ${e.position.column}`;
});

// Tools panel tab switching
document.querySelectorAll('.tools-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const tool = (tab as HTMLElement).dataset.tool!;
    document.querySelectorAll('.tools-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    document.querySelectorAll('.tools-body').forEach(b => (b as HTMLElement).style.display = 'none');
    const body = document.querySelector(`.tools-body[data-tool="${tool}"]`) as HTMLElement;
    if (body) body.style.display = '';
    if (tool === 'memory') startMemPolling(); else stopMemPolling();
  });
});

// -- Memory stats --

const MEM_HISTORY_MAX = 120;
let memHistory: Map<string, { used: number; total: number }[]> = new Map();
let memPollTimer: number | null = null;
let memPollInFlight = false;
let memPollInterval = 500;

function memKey(e: any): string {
  return e.mem_type === 'gc' ? 'gc' : `uma_${e.index}`;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return bytes + ' B';
}

function drawMemGraph(canvas: HTMLCanvasElement, history: { used: number; total: number }[]) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);

  // Background
  ctx.fillStyle = getComputedStyle(canvas).getPropertyValue('--bg-deep').trim() || '#0a0a0c';
  ctx.fillRect(0, 0, w, h);

  if (history.length < 2) return;

  const maxTotal = Math.max(...history.map(s => s.total));
  if (maxTotal === 0) return;

  // Grid lines at 25%, 50%, 75%
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  for (const frac of [0.25, 0.5, 0.75]) {
    const y = h - frac * h;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  // Total line (dimmed)
  ctx.strokeStyle = 'rgba(255,255,255,0.15)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i < history.length; i++) {
    const x = (i / (MEM_HISTORY_MAX - 1)) * w;
    const y = h - (history[i].total / maxTotal) * h;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Used fill
  ctx.beginPath();
  for (let i = 0; i < history.length; i++) {
    const x = (i / (MEM_HISTORY_MAX - 1)) * w;
    const y = h - (history[i].used / maxTotal) * h;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  const lastX = ((history.length - 1) / (MEM_HISTORY_MAX - 1)) * w;
  ctx.lineTo(lastX, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fillStyle = 'rgba(91,156,245,0.2)';
  ctx.fill();

  // Used line
  ctx.strokeStyle = '#5b9cf5';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i < history.length; i++) {
    const x = (i / (MEM_HISTORY_MAX - 1)) * w;
    const y = h - (history[i].used / maxTotal) * h;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function memUsed(e: any): number {
  return e.used + e.persist;
}

function renderMemEntry(e: any): string {
  const key = memKey(e);
  const used = memUsed(e);
  const pct = e.total > 0 ? Math.round((used / e.total) * 100) : 0;
  const label = e.mem_type === 'gc' ? 'GC Heap' : `UMA Pool ${e.index}`;
  let details = `<div class="mem-row"><span>Used / Total</span><span>${formatBytes(used)} / ${formatBytes(e.total)} (${pct}%)</span></div>`
    + `<div class="mem-row"><span>Free</span><span>${formatBytes(e.free)}</span></div>`;
  if (e.mem_type !== 'gc') {
    details += `<div class="mem-row"><span>Persist</span><span>${formatBytes(e.persist)}</span></div>`
      + `<div class="mem-row"><span>Peak</span><span>${formatBytes(e.peak)}</span></div>`;
  }
  return `<div class="mem-card">`
    + `<div class="mem-card-header">${label}</div>`
    + `<canvas class="mem-graph" id="mem-graph-${key}" width="300" height="80"></canvas>`
    + details
    + `</div>`;
}

function updateMemUI(entries: any[]) {
  const content = document.getElementById('memory-content');
  if (!content) return;

  // Check if DOM needs rebuilding (entry count or keys changed)
  const keys = entries.map(memKey);
  const existing = content.querySelectorAll('.mem-card');
  const needRebuild = existing.length !== keys.length;

  if (needRebuild) {
    content.innerHTML = entries.map(renderMemEntry).join('');
  }

  // Update history
  for (const e of entries) {
    const key = memKey(e);
    let hist = memHistory.get(key);
    if (!hist) { hist = []; memHistory.set(key, hist); }
    hist.push({ used: memUsed(e), total: e.total });
    if (hist.length > MEM_HISTORY_MAX) hist.shift();
  }

  // Update values and redraw graphs
  for (const e of entries) {
    const key = memKey(e);
    const used = memUsed(e);
    const pct = e.total > 0 ? Math.round((used / e.total) * 100) : 0;
    const card = content.querySelector(`#mem-graph-${key}`)?.closest('.mem-card');
    if (card) {
      const rows = card.querySelectorAll('.mem-row');
      if (rows[0]) rows[0].querySelector('span:last-child')!.textContent = `${formatBytes(used)} / ${formatBytes(e.total)} (${pct}%)`;
      if (rows[1]) rows[1].querySelector('span:last-child')!.textContent = formatBytes(e.free);
      if (e.mem_type !== 'gc') {
        if (rows[2]) rows[2].querySelector('span:last-child')!.textContent = formatBytes(e.persist);
        if (rows[3]) rows[3].querySelector('span:last-child')!.textContent = formatBytes(e.peak);
      }
    }

    const canvas = document.getElementById(`mem-graph-${key}`) as HTMLCanvasElement | null;
    if (canvas) {
      drawMemGraph(canvas, memHistory.get(key) || []);
    }
  }
}

async function fetchMemoryStats() {
  const content = document.getElementById('memory-content');
  if (!content) return;
  if (!isConnected) {
    content.innerHTML = '<div style="padding:8px;color:var(--text-muted)">Connect to view memory</div>';
    return;
  }
  if (memPollInFlight) return;
  memPollInFlight = true;
  try {
    const entries = await invoke<any[]>('cmd_get_memory');
    updateMemUI(entries);
  } catch (e) {
    content.innerHTML = '<div style="padding:8px;color:var(--text-muted)">Failed to read memory</div>';
  } finally {
    memPollInFlight = false;
  }
}

function startMemPolling() {
  stopMemPolling();
  fetchMemoryStats();
  memPollTimer = window.setInterval(fetchMemoryStats, memPollInterval);
}

const memPollSlider = document.getElementById('mem-poll-slider') as HTMLInputElement;
const memPollValueLabel = document.getElementById('mem-poll-value')!;
memPollSlider?.addEventListener('input', () => {
  memPollInterval = parseInt(memPollSlider.value, 10);
  memPollValueLabel.textContent = `${memPollInterval} ms`;
  if (memPollTimer !== null) startMemPolling();
});

function stopMemPolling() {
  if (memPollTimer !== null) {
    clearInterval(memPollTimer);
    memPollTimer = null;
  }
}

function isMemTabActive(): boolean {
  const tab = document.querySelector('.tools-tab[data-tool="memory"]');
  return tab?.classList.contains('active') || false;
}

// Camera controls -- update value labels on slider change
document.querySelectorAll('.ctrl-slider').forEach(slider => {
  slider.addEventListener('input', () => {
    const val = (slider as HTMLInputElement).value;
    const label = (slider as HTMLElement).nextElementSibling as HTMLElement;
    if (label) label.textContent = val;
  });
});

// -- Examples tree --
let examplesLoaded = false;


async function loadExamples() {
  if (examplesLoaded) return;
  const container = document.getElementById('examples-tree');
  if (!container) return;
  container.innerHTML = '<div style="padding:8px;color:var(--text-tertiary)">Loading...</div>';
  try {
    const args: Record<string, any> = {};
    if (filterExamples && connectedBoard) args.board = connectedBoard;
    if (filterExamples && connectedSensor) args.sensor = connectedSensor;
    const tree = await invoke<any[]>('cmd_list_examples', args);
    container.innerHTML = '';
    if (!tree || tree.length === 0) {
      container.innerHTML = '<div style="padding:8px;color:var(--text-muted)">No examples found</div>';
      return;
    }
    renderTree(container, tree, 0);
    examplesLoaded = true;
  } catch (e: any) {
    container.innerHTML = `<div style="padding:8px;color:var(--accent-red)">Error: ${String(e)}</div>`;
  }
}

function renderTree(parent: HTMLElement, nodes: any[], depth: number) {
  for (const node of nodes) {
    if (node.type === 'dir') {
      const section = document.createElement('div');
      section.className = 'tree-section';

      const header = document.createElement('div');
      header.className = 'tree-section-header';
      header.style.paddingLeft = (8 + depth * 12) + 'px';
      header.innerHTML = `<svg class="tree-arrow" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg> ${node.name}`;

      const children = document.createElement('div');
      children.className = 'tree-children';
      children.style.display = 'none'; // start collapsed
      renderTree(children, node.children, depth + 1);

      header.classList.add('collapsed');
      header.addEventListener('click', () => {
        header.classList.toggle('collapsed');
        children.style.display = children.style.display === 'none' ? '' : 'none';
      });

      section.appendChild(header);
      section.appendChild(children);
      parent.appendChild(section);
    } else {
      const item = document.createElement('div');
      item.className = 'tree-item';
      item.style.paddingLeft = (8 + (depth + 1) * 12) + 'px';
      item.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z"/><polyline points="13 2 13 9 20 9"/></svg> <span>${node.name}</span>`;
      item.addEventListener('click', async () => {
        try {
          const content = await invoke<string>('cmd_read_file', { path: node.path });
          hideWelcome();
          createFile(node.path, content, true);
          switchToFile(openFiles.length - 1);
          closeSidePanel();
        } catch (e) {
          console.error('Failed to open example:', e);
        }
      });
      parent.appendChild(item);
    }
  }
}

// Sidebar nav buttons (Files, Examples, Docs, Settings -- not Connect/Run)
const sidePanel = document.getElementById('side-panel')!;
let activePanelName: string | null = null;

function closeSidePanel() {
  document.querySelectorAll('.sidebar-btn[data-panel]').forEach(b => b.classList.remove('active'));
  sidePanel.classList.remove('visible');
  layout.style.gridTemplateColumns = '56px 0px 1fr 4px 40%';
  activePanelName = null;
}

document.querySelectorAll('.sidebar-btn[data-panel]').forEach(btn => {
  btn.addEventListener('click', () => {
    const panel = (btn as HTMLElement).dataset.panel!;

    if (activePanelName === panel) {
      closeSidePanel();
    } else {
      // Switch panel
      document.querySelectorAll('.sidebar-btn[data-panel]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.side-panel-content').forEach(p => (p as HTMLElement).style.display = 'none');
      const content = sidePanel.querySelector(`[data-panel="${panel}"]`) as HTMLElement;
      if (content) content.style.display = '';
      sidePanel.classList.add('visible');
      layout.style.gridTemplateColumns = '56px 220px 1fr 4px 40%';
      activePanelName = panel;

    }
  });
});

// -- Resize handles --

const layout = document.querySelector('.ide-layout') as HTMLElement;
const mainArea = document.querySelector('.main-area') as HTMLElement;

// Horizontal: between main area and right panel
setupResize('resize-h', 'col', (delta) => {
  const rp = document.querySelector('.right-panel') as HTMLElement;
  const w = Math.max(200, Math.min(800, rp.getBoundingClientRect().width / uiScale - delta));
  const spW = sidePanel.classList.contains('visible') ? '220px' : '0px';
  layout.style.gridTemplateColumns = `56px ${spW} 1fr 4px ${w}px`;
});

// Snap threshold in pixels
const SNAP_PX = 15;

function getToolsTopY(): number {
  const tools = document.querySelector('.tools-panel') as HTMLElement;
  return tools.getBoundingClientRect().top / uiScale;
}

function getTerminalTopY(): number {
  const tp = document.querySelector('.terminal-panel') as HTMLElement;
  return tp.getBoundingClientRect().top / uiScale;
}

function snapToolsToTerminal(toolsH: number): number {
  // Calculate where the tools top would be vs where the terminal top is
  const tools = document.querySelector('.tools-panel') as HTMLElement;
  const rp = document.querySelector('.right-panel') as HTMLElement;
  const rpRect = rp.getBoundingClientRect();
  const toolsTop = (rpRect.bottom / uiScale) - toolsH;
  const termTop = getTerminalTopY();
  if (Math.abs(toolsTop - termTop) < SNAP_PX) {
    // Snap: adjust tools height so its top aligns with terminal top
    return (rpRect.bottom / uiScale) - termTop;
  }
  return toolsH;
}

// Vertical: between editor and terminal (manual, not setupResize -- same pattern as FB/tools)
{
  const handle = document.getElementById('resize-v');
  if (handle) {
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      handle.classList.add('active');
      const tp = document.querySelector('.terminal-panel') as HTMLElement;
      const startY = e.clientY / uiScale;
      const startH = tp.getBoundingClientRect().height / uiScale;
      const maBottom = mainArea.getBoundingClientRect().bottom / uiScale;

      const onMove = (ev: MouseEvent) => {
        const delta = startY - ev.clientY / uiScale;
        let h = Math.max(60, Math.min(600, startH + delta));
        // Snap: where would terminal top be?
        const termTop = maBottom - h;
        const toolsTop = getToolsTopY();
        if (Math.abs(termTop - toolsTop) < SNAP_PX) {
          h = maBottom - toolsTop;
        }
        mainArea.style.gridTemplateRows = `32px 1fr 4px ${h}px`;
      };
      const onUp = () => {
        handle.classList.remove('active');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        scheduleSaveSettings();
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }
}

// Vertical: between framebuffer and histogram
{
  const handle = document.getElementById('resize-fb-hist');
  if (handle) {
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      handle.classList.add('active');
      const fb = document.querySelector('.fb-section') as HTMLElement;
      const hist = document.querySelector('.tools-panel') as HTMLElement;
      const startY = e.clientY / uiScale;
      const startFbH = fb.getBoundingClientRect().height / uiScale;
      const startHistH = hist.getBoundingClientRect().height / uiScale;
      const totalH = startFbH + startHistH;

      const onMove = (e: MouseEvent) => {
        const delta = e.clientY / uiScale - startY;
        const fbH = Math.max(80, Math.min(totalH - 80, startFbH + delta));
        let toolsH = snapToolsToTerminal(totalH - fbH);
        const adjFbH = totalH - toolsH;
        fb.style.flex = 'none';
        hist.style.flex = 'none';
        fb.style.height = adjFbH + 'px';
        hist.style.height = toolsH + 'px';
      };
      const onUp = () => {
        handle.classList.remove('active');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        scheduleSaveSettings();
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }
}

function setupResize(handleId: string, axis: 'col' | 'row', onDelta: (delta: number) => void) {
  const handle = document.getElementById(handleId);
  if (!handle) return;
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    handle.classList.add('active');
    const startPos = (axis === 'col' ? e.clientX : e.clientY) / uiScale;
    let lastPos = startPos;
    const onMove = (e: MouseEvent) => {
      const pos = (axis === 'col' ? e.clientX : e.clientY) / uiScale;
      onDelta(pos - lastPos);
      lastPos = pos;
    };
    const onUp = () => {
      handle.classList.remove('active');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      scheduleSaveSettings();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// -- Exception inline display --
let exceptionDecorations: monaco.editor.IEditorDecorationsCollection | null = null;
let exceptionZoneId: string | null = null;

function clearException() {
  if (exceptionDecorations) { exceptionDecorations.clear(); exceptionDecorations = null; }
  if (exceptionZoneId) {
    const zoneId = exceptionZoneId;
    editor.changeViewZones(a => a.removeZone(zoneId));
    exceptionZoneId = null;
  }
}

function showExceptionDialog(msg: string) {
  clearException();

  // Parse line number from traceback: File "<stdin>", line NN
  const lineMatch = msg.match(/File "<stdin>", line (\d+)/);
  const lineNo = lineMatch ? parseInt(lineMatch[1], 10) : null;

  // Extract the error message (e.g. "RuntimeError: Sensor control failed.")
  const errorLine = msg.split('\n').find(l => /Error:|Exception:/.test(l)) || msg;

  if (!lineNo) return; // Can't show inline without a line number

  // Highlight the error line in the gutter + background
  exceptionDecorations = editor.createDecorationsCollection([
    {
      range: new monaco.Range(lineNo, 1, lineNo, 1),
      options: {
        isWholeLine: true,
        className: 'exception-line',
        glyphMarginClassName: 'exception-glyph',
      },
    },
  ]);

  // Insert a view zone below the error line to show the message
  editor.changeViewZones(accessor => {
    const domNode = document.createElement('div');
    domNode.className = 'exception-zone';
    domNode.textContent = errorLine.trim();
    exceptionZoneId = accessor.addZone({
      afterLineNumber: lineNo,
      heightInLines: 1.4,
      domNode,
    });
  });

  // Scroll to the error line
  editor.revealLineInCenter(lineNo);

  // Clear on next edit
  const disposable = editor.onDidChangeModelContent(() => {
    clearException();
    disposable.dispose();
  });
}

function termLog(text: string, cls: string = '') {
  const el = document.getElementById('terminal-output');
  if (!el) return;
  const div = document.createElement('div');
  if (cls) div.className = cls;
  div.textContent = text;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}

// Clear terminal
document.getElementById('btn-clear-term')?.addEventListener('click', () => {
  const el = document.getElementById('terminal-output');
  if (el) el.innerHTML = '';
});

// -- Connection and script state --
let isConnected = false;
let scriptRunning = false;
let connectedBoard: string | null = null;
let connectedSensor: string | null = null;

const btnRunStop = document.getElementById('btn-run-stop')!;
const iconPlay = btnRunStop.querySelector('.icon-play') as SVGElement;
const iconStop = btnRunStop.querySelector('.icon-stop') as SVGElement;
const runStopLabel = btnRunStop.querySelector('.run-stop-label') as HTMLElement;

function setConnected(connected: boolean, info: string = 'Disconnected') {
  isConnected = connected;
  const dot = document.querySelector('.status-dot') as HTMLElement;
  const label = document.getElementById('status-board');
  const btnConnect = document.getElementById('btn-connect');
  if (dot) dot.className = 'status-dot ' + (connected ? 'connected' : 'disconnected');
  if (label) label.textContent = info;
  if (btnConnect) {
    btnConnect.classList.toggle('connected', connected);
    const lbl = btnConnect.querySelector('span');
    if (lbl) lbl.textContent = connected ? 'Disconnect' : 'Connect';
  }
  btnRunStop.classList.toggle('disabled', !connected);
  if (!connected) setScriptRunning(false);
}

function setScriptRunning(running: boolean) {
  scriptRunning = running;
  btnRunStop.title = running ? 'Stop (Cmd+R)' : 'Run (Cmd+R)';
  iconPlay.style.display = running ? 'none' : '';
  iconStop.style.display = running ? '' : 'none';
  if (runStopLabel) runStopLabel.textContent = running ? 'Stop' : 'Run';
}

const fbSourceSelect = document.getElementById('fb-source') as HTMLSelectElement;

function populateSensorSelect(sensors: { chip_id: number; name: string }[]) {
  fbSourceSelect.innerHTML = '';
  if (sensors.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No sensor';
    fbSourceSelect.appendChild(opt);
    fbSourceSelect.disabled = true;
    connectedSensor = null;
    return;
  }
  fbSourceSelect.disabled = false;
  for (const s of sensors) {
    const opt = document.createElement('option');
    opt.value = s.chip_id.toString();
    opt.textContent = s.name;
    fbSourceSelect.appendChild(opt);
  }
  connectedSensor = sensors[0].name;
}

fbSourceSelect.addEventListener('change', async () => {
  const chipId = parseInt(fbSourceSelect.value, 10);
  if (isNaN(chipId)) return;
  try {
    await invoke('cmd_set_stream_source', { chipId });
    const selected = fbSourceSelect.options[fbSourceSelect.selectedIndex];
    connectedSensor = selected?.textContent || null;
  } catch (e) {
    console.error('Failed to set stream source:', e);
  }
});

async function doConnect() {
  if (isConnected) return;
  try {
    const ports = await invoke<string[]>('cmd_list_ports');
    if (ports.length === 0) return;

    await invoke('cmd_connect', { port: ports[0] });

    // Query board info from cached sysinfo
    const sysinfo = await invoke<any>('cmd_get_sysinfo');
    const version = await invoke<any>('cmd_get_version');
    const fw = version?.data ? `${version.data.firmware[0]}.${version.data.firmware[1]}.${version.data.firmware[2]}` : '?';
    connectedBoard = sysinfo.board_type;
    connectedSensor = null;
    setConnected(true, `${sysinfo.board_name} | ${ports[0]} | v${fw}`);
    populateSensorSelect(sysinfo.sensors || []);

    // Stop any running script from a previous session
    try { await invoke('cmd_stop_script'); } catch (_) {}
    // Enable streaming and start polling
    try { await invoke('cmd_enable_streaming', { enable: true }); } catch (_) {}
    startPolling();
    if (isMemTabActive()) startMemPolling();
    // Load examples (filtered by board/sensor if enabled)
    examplesLoaded = false;
    loadExamples();
  } catch (e: any) {
    console.error('Connect failed:', e);
  }
}

async function doDisconnect() {
  if (!isConnected) return;
  stopPolling();
  stopMemPolling();
  memHistory.clear();
  const memContent = document.getElementById('memory-content');
  if (memContent) memContent.innerHTML = '<div style="padding:8px;color:var(--text-muted)">Connect to view memory</div>';
  try { await invoke('cmd_stop_script'); } catch (_) {}
  try { await invoke('cmd_enable_streaming', { enable: false }); } catch (_) {}
  try { await invoke('cmd_disconnect'); } catch (_) {}
  connectedBoard = null;
  connectedSensor = null;
  setConnected(false);
  populateSensorSelect([]);
  // Reload examples unfiltered, or clear if filtering is on
  examplesLoaded = false;
  if (filterExamples) {
    const exTree = document.getElementById('examples-tree');
    if (exTree) exTree.innerHTML = '<div style="padding:8px;color:var(--text-muted)">Connect to load examples</div>';
  } else {
    loadExamples();
  }
}

async function toggleConnect() {
  if (isConnected) await doDisconnect();
  else await doConnect();
}

async function runScript() {
  if (!isConnected) return;
  try {
    await invoke('cmd_run_script', { script: editor.getValue() });
    setScriptRunning(true);
  } catch (e: any) {
    console.error('Run failed:', e);
  }
}

async function stopScript() {
  if (!isConnected) return;
  try {
    await invoke('cmd_stop_script');
  } catch (e: any) {
    console.error('Stop failed:', e);
  }
}

async function toggleRunStop() {
  if (scriptRunning) await stopScript();
  else await runScript();
}

document.getElementById('btn-connect')?.addEventListener('click', toggleConnect);
btnRunStop.addEventListener('click', toggleRunStop);

// -- Unified polling (stdout + frame in one call) --
let pollTimer: number | null = null;
let pollInFlight = false;
const fpsTimestamps: number[] = [];

const fbCanvas = document.getElementById('framebuffer-canvas') as HTMLCanvasElement;
const fbNoImage = document.querySelector('.no-image') as HTMLElement;
const fbResolution = document.getElementById('fb-resolution')!;
const fbFormat = document.getElementById('fb-format')!;
const statusFps = document.getElementById('status-fps')!;

function startPolling() {
  stopPolling();
  pollTimer = window.setInterval(doPoll, pollIntervalMs);
}

function stopPolling() {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function doPoll() {
  if (pollInFlight || !isConnected) return;
  pollInFlight = true;
  try {
    const raw = await invoke<ArrayBuffer>('cmd_poll');
    const buf = new DataView(raw);
    let pos = 0;

    // Parse script_running flag
    const running = buf.getUint8(pos) !== 0; pos += 1;
    if (scriptRunning !== running) {
      setScriptRunning(running);
    }

    // Parse stdout: [len:u32 LE] [bytes]
    const stdoutLen = buf.getUint32(pos, true); pos += 4;
    let hasException = false;
    const errorLines: string[] = [];
    if (stdoutLen > 0) {
      const stdoutBytes = new Uint8Array(raw, pos, stdoutLen);
      const text = new TextDecoder().decode(stdoutBytes);
      for (const line of text.split('\n')) {
        if (line.length > 0) {
          const isError = /^(Traceback|  File |.*Error:|.*Exception:|.*Interrupt:|MPY:)/.test(line);
          termLog(line, isError ? 'error-line' : 'fps-line');
          if (isError) { hasException = true; errorLines.push(line); }
        }
      }
    }
    pos += stdoutLen;

    // Show error dialog (ignore KeyboardInterrupt -- that's just script stop)
    const allErrors = errorLines.join('\n');
    if (hasException && !/KeyboardInterrupt/.test(allErrors)) {
      showExceptionDialog(errorLines.join('\n'));
    }

    // Parse frame: [width:u32] [height:u32] ...
    if (pos + 8 > buf.byteLength) return;
    const width = buf.getUint32(pos, true); pos += 4;
    const height = buf.getUint32(pos, true); pos += 4;

    if (width > 0 && height > 0) {
      const fmtLen = buf.getUint8(pos); pos += 1;
      const fmtBytes = new Uint8Array(raw, pos, fmtLen);
      const formatStr = new TextDecoder().decode(fmtBytes); pos += fmtLen;
      const isJpeg = buf.getUint8(pos) !== 0; pos += 1;
      const frameData = new Uint8Array(raw, pos);

      fbResolution.textContent = `${width} x ${height}`;
      fbFormat.textContent = formatStr;

      const now = performance.now();
      fpsTimestamps.push(now);
      while (fpsTimestamps.length > 0 && now - fpsTimestamps[0] > 1000) {
        fpsTimestamps.shift();
      }
      statusFps.textContent = fpsTimestamps.length.toString();

      if (isJpeg) {
        const blob = new Blob([frameData], { type: 'image/jpeg' });
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
          fbCanvas.width = img.width;
          fbCanvas.height = img.height;
          const ctx = fbCanvas.getContext('2d')!;
          ctx.drawImage(img, 0, 0);
          showCanvas();
          URL.revokeObjectURL(url);
        };
        img.src = url;
      } else {
        fbCanvas.width = width;
        fbCanvas.height = height;
        const ctx = fbCanvas.getContext('2d')!;
        const imageData = new ImageData(new Uint8ClampedArray(frameData.buffer, frameData.byteOffset, frameData.byteLength), width, height);
        ctx.putImageData(imageData, 0, 0);
        showCanvas();
      }
    }
  } catch (e) {
    console.error('poll error:', e);
  } finally {
    pollInFlight = false;
  }
}

function showCanvas() {
  fbCanvas.style.display = 'block';
  fbCanvas.style.maxWidth = '100%';
  fbCanvas.style.maxHeight = '100%';
  fbCanvas.style.objectFit = 'contain';
  fbNoImage.style.display = 'none';
}

// -- Zoom: Cmd+= / Cmd+- for editor and terminal --
let terminalFontSize = 12;
const termContent = document.querySelector('.terminal-content') as HTMLElement;

// -- Keyboard shortcuts system --
interface Shortcut {
  key: string;       // e.g. "r", "s", "e", "F5"
  meta?: boolean;    // Cmd on mac
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
}

interface ShortcutBinding {
  id: string;
  label: string;
  defaults: Shortcut[];  // multiple bindings allowed
  action: () => void;
}

function shortcutToString(s: Shortcut): string {
  const parts: string[] = [];
  if (s.meta) parts.push('Cmd');
  if (s.ctrl) parts.push('Ctrl');
  if (s.alt) parts.push('Alt');
  if (s.shift) parts.push('Shift');
  parts.push(s.key.length === 1 ? s.key.toUpperCase() : s.key);
  return parts.join('+');
}

function parseShortcutString(str: string): Shortcut {
  const parts = str.split('+').map(s => s.trim());
  const s: Shortcut = { key: '' };
  for (const p of parts) {
    const lower = p.toLowerCase();
    if (lower === 'cmd' || lower === 'meta') s.meta = true;
    else if (lower === 'ctrl') s.ctrl = true;
    else if (lower === 'shift') s.shift = true;
    else if (lower === 'alt' || lower === 'opt') s.alt = true;
    else s.key = p.length === 1 ? p.toLowerCase() : p;
  }
  return s;
}

function matchesShortcut(e: KeyboardEvent, s: Shortcut): boolean {
  const keyMatch = e.key.toLowerCase() === s.key.toLowerCase() || e.key === s.key;
  return keyMatch
    && (!!s.meta === e.metaKey)
    && (!!s.ctrl === e.ctrlKey)
    && (!!s.shift === e.shiftKey)
    && (!!s.alt === e.altKey);
}

// User overrides loaded from settings (shortcut id -> shortcut string)
let shortcutOverrides: Record<string, string> = {};

const shortcutBindings: ShortcutBinding[] = [
  { id: 'run-stop', label: 'Run / Stop', defaults: [{ meta: true, key: 'r' }, { key: 'F5' }, { key: 'F6' }], action: toggleRunStop },
  { id: 'connect', label: 'Connect / Disconnect', defaults: [{ ctrl: true, key: 'e' }], action: toggleConnect },
  { id: 'new-file', label: 'New File', defaults: [{ meta: true, key: 'n' }], action: newFile },
  { id: 'open-file', label: 'Open File', defaults: [{ meta: true, key: 'o' }], action: openFileDialog },
  { id: 'save', label: 'Save', defaults: [{ meta: true, key: 's' }], action: saveFile },
  { id: 'save-as', label: 'Save As', defaults: [{ meta: true, shift: true, key: 's' }], action: saveFileAs },
  { id: 'close-tab', label: 'Close Tab', defaults: [{ meta: true, key: 'w' }], action: () => closeFile(activeFileIndex) },
  { id: 'zoom-in', label: 'Zoom In', defaults: [{ meta: true, key: '=' }], action: () => {
    const sz = editor.getOption(monaco.editor.EditorOption.fontSize);
    editor.updateOptions({ fontSize: sz + 1 });
    terminalFontSize = Math.min(32, terminalFontSize + 1);
    termContent.style.fontSize = terminalFontSize + 'px';
  }},
  { id: 'zoom-out', label: 'Zoom Out', defaults: [{ meta: true, key: '-' }], action: () => {
    const sz = editor.getOption(monaco.editor.EditorOption.fontSize);
    editor.updateOptions({ fontSize: Math.max(8, sz - 1) });
    terminalFontSize = Math.max(8, terminalFontSize - 1);
    termContent.style.fontSize = terminalFontSize + 'px';
  }},
  { id: 'zoom-reset', label: 'Reset Zoom', defaults: [{ meta: true, key: '0' }], action: () => {
    editor.updateOptions({ fontSize: 13 });
    terminalFontSize = 12;
    termContent.style.fontSize = terminalFontSize + 'px';
  }},
  { id: 'settings', label: 'Settings', defaults: [{ meta: true, key: ',' }], action: openSettings },
];

function getActiveShortcuts(binding: ShortcutBinding): Shortcut[] {
  const override = shortcutOverrides[binding.id];
  if (override) return [parseShortcutString(override)];
  return binding.defaults;
}

function getShortcutDisplay(binding: ShortcutBinding): string {
  const shortcuts = getActiveShortcuts(binding);
  return shortcuts.map(shortcutToString).join(' / ');
}

document.addEventListener('keydown', (e) => {
  for (const binding of shortcutBindings) {
    const shortcuts = getActiveShortcuts(binding);
    for (const s of shortcuts) {
      if (matchesShortcut(e, s)) {
        e.preventDefault();
        binding.action();
        return;
      }
    }
  }
});

// -- UI Scaling --
let uiScale = 1.2;
let pollIntervalMs = 50;
let filterExamples = true;

function setUIScale(scale: number) {
  uiScale = Math.max(0.5, Math.min(2.0, scale));
  (document.body.style as any).zoom = String(uiScale);
  // Compensate: zoom shrinks/grows content but viewport stays the same
  document.body.style.width = (100 / uiScale) + 'vw';
  document.body.style.height = (100 / uiScale) + 'vh';
  document.querySelector<HTMLElement>('.ide-layout')!.style.height = (100 / uiScale) + 'vh';
}
setUIScale(uiScale);

// -- Settings dialog --
function openSettings() {
  document.getElementById('settings-overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'settings-overlay';
  overlay.className = 'settings-overlay';
  overlay.innerHTML = `
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
            <input type="range" id="set-scale" min="50" max="200" step="10" value="${Math.round(uiScale * 100)}">
            <span class="scale-value" id="scale-label">${Math.round(uiScale * 100)}%</span>
          </div>
        </div>
        <div class="pref-row">
          <span class="pref-label">Theme:</span>
          <div class="radio-group">
            <label class="radio-opt"><input type="radio" name="theme" value="light" ${currentThemeSetting === 'light' ? 'checked' : ''}> Light</label>
            <label class="radio-opt"><input type="radio" name="theme" value="dark" ${currentThemeSetting === 'dark' ? 'checked' : ''}> Dark</label>
            <label class="radio-opt"><input type="radio" name="theme" value="system" ${currentThemeSetting === 'system' ? 'checked' : ''}> System</label>
          </div>
        </div>
        <div class="pref-row">
          <span class="pref-label">Filter Examples:</span>
          <label class="switch"><input type="checkbox" id="set-filter-examples" ${filterExamples ? 'checked' : ''}><span class="switch-slider"></span></label>
        </div>
        <div class="pref-row">
          <span class="pref-label"></span>
          <button class="pref-btn" id="set-reset">Reset All Settings</button>
        </div>
      </div>

      <div class="settings-pane" data-stab="editor" style="display:none">
        <div class="pref-row">
          <span class="pref-label">Font Size:</span>
          <input type="number" class="pref-input" id="set-font-size" value="${editor.getOption(monaco.editor.EditorOption.fontSize)}" min="8" max="32">
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
          <span class="pref-label">Baudrate:</span>
          <select class="pref-select" id="set-baudrate">
            <option selected>921600</option>
            <option>460800</option>
            <option>115200</option>
          </select>
        </div>
        <div class="pref-row">
          <span class="pref-label">Auto Connect:</span>
          <label class="switch"><input type="checkbox"><span class="switch-slider"></span></label>
        </div>
        <div class="pref-row">
          <span class="pref-label">Auto Run:</span>
          <label class="switch"><input type="checkbox"><span class="switch-slider"></span></label>
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
          ${shortcutBindings.map(b => `
            <div class="shortcut-row">
              <span class="shortcut-action">${b.label}</span>
              <input class="shortcut-input" data-sid="${b.id}"
                value="${shortcutOverrides[b.id] || getShortcutDisplay(b)}"
                placeholder="${b.defaults.map(shortcutToString).join(' / ')}"
                readonly>
              ${shortcutOverrides[b.id] ? `<button class="shortcut-reset" data-sid="${b.id}" title="Reset to default">x</button>` : ''}
            </div>
          `).join('')}
        </div>
        <p class="shortcut-hint">Click a shortcut, then press the new key combination to rebind.</p>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  // Close
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', esc); }
  });

  // Tab switching
  const titlebar = overlay.querySelector('.settings-titlebar')!;
  overlay.querySelectorAll('.settings-icon-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const id = (tab as HTMLElement).dataset.stab!;
      overlay.querySelectorAll('.settings-icon-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      overlay.querySelectorAll('.settings-pane').forEach(p => (p as HTMLElement).style.display = 'none');
      (overlay.querySelector(`.settings-pane[data-stab="${id}"]`) as HTMLElement).style.display = '';
      titlebar.textContent = (tab.querySelector('span') as HTMLElement).textContent;
    });
  });

  // Live-apply
  const scaleSlider = document.getElementById('set-scale') as HTMLInputElement;
  const scaleLabel = document.getElementById('scale-label')!;
  scaleSlider.oninput = () => {
    const v = parseInt(scaleSlider.value);
    scaleLabel.textContent = v + '%';
    setUIScale(v / 100);
  };
  document.getElementById('set-font-size')!.onchange = (e) => {
    editor.updateOptions({ fontSize: parseInt((e.target as HTMLInputElement).value) });
  };
  document.getElementById('set-tab-size')!.onchange = (e) => {
    editor.updateOptions({ tabSize: parseInt((e.target as HTMLInputElement).value) });
  };
  document.getElementById('set-word-wrap')!.onchange = (e) => {
    editor.updateOptions({ wordWrap: (e.target as HTMLInputElement).checked ? 'on' : 'off' });
  };
  document.getElementById('set-minimap')!.onchange = (e) => {
    editor.updateOptions({ minimap: { enabled: (e.target as HTMLInputElement).checked } });
  };
  document.getElementById('set-line-numbers')!.onchange = (e) => {
    editor.updateOptions({ lineNumbers: (e.target as HTMLInputElement).checked ? 'on' : 'off' });
  };
  document.getElementById('set-filter-examples')!.onchange = (e) => {
    filterExamples = (e.target as HTMLInputElement).checked;
    examplesLoaded = false;
    if (!filterExamples) {
      loadExamples();
    } else if (isConnected) {
      loadExamples();
    } else {
      const exTree = document.getElementById('examples-tree');
      if (exTree) exTree.innerHTML = '<div style="padding:8px;color:var(--text-muted)">Connect to load examples</div>';
    }
    scheduleSaveSettings();
  };
  // Theme radios
  overlay.querySelectorAll('input[name="theme"]').forEach(radio => {
    radio.addEventListener('change', () => {
      applyTheme((radio as HTMLInputElement).value as ThemeSetting);
    });
  });
  // Shortcut recording
  overlay.querySelectorAll('.shortcut-input').forEach(input => {
    input.addEventListener('click', () => {
      const el = input as HTMLInputElement;
      el.value = 'Press keys...';
      el.removeAttribute('readonly');
      const handler = (e: KeyboardEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === 'Escape') {
          const sid = el.dataset.sid!;
          el.value = shortcutOverrides[sid] || getShortcutDisplay(shortcutBindings.find(b => b.id === sid)!);
          el.setAttribute('readonly', '');
          document.removeEventListener('keydown', handler, true);
          return;
        }
        // Ignore modifier-only presses
        if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) return;

        const s: Shortcut = { key: e.key.length === 1 ? e.key.toLowerCase() : e.key };
        if (e.metaKey) s.meta = true;
        if (e.ctrlKey) s.ctrl = true;
        if (e.shiftKey) s.shift = true;
        if (e.altKey) s.alt = true;

        const str = shortcutToString(s);
        const sid = el.dataset.sid!;
        shortcutOverrides[sid] = str;
        el.value = str;
        el.setAttribute('readonly', '');
        document.removeEventListener('keydown', handler, true);
        scheduleSaveSettings();
        // Re-render to show reset button
        openSettings();
      };
      document.addEventListener('keydown', handler, true);
    });
  });

  // Shortcut reset buttons
  overlay.querySelectorAll('.shortcut-reset').forEach(btn => {
    btn.addEventListener('click', () => {
      const sid = (btn as HTMLElement).dataset.sid!;
      delete shortcutOverrides[sid];
      scheduleSaveSettings();
      openSettings();
    });
  });

  // Reset button
  document.getElementById('set-reset')!.onclick = async () => {
    const s = await getStore();
    await s.clear();
    await s.save();
    uiScale = 1.2;
    currentThemeSetting = 'dark';
    shortcutOverrides = {};
    applyTheme('dark');
    setUIScale(1.2);
    editor.updateOptions({ fontSize: 13, tabSize: 4, wordWrap: 'off', minimap: { enabled: false }, lineNumbers: 'on' });
    overlay.remove();
    // settings reset
  };
}

// Settings sidebar button opens dialog
document.getElementById('btn-settings')?.addEventListener('click', () => openSettings());

// -- System menu events --
listen<string>('menu-action', (event) => {
  const action = event.payload;
  switch (action) {
    case 'zoom-in': {
      const sz = editor.getOption(monaco.editor.EditorOption.fontSize);
      editor.updateOptions({ fontSize: sz + 1 });
      terminalFontSize = Math.min(32, terminalFontSize + 1);
      termContent.style.fontSize = terminalFontSize + 'px';
      break;
    }
    case 'zoom-out': {
      const sz = editor.getOption(monaco.editor.EditorOption.fontSize);
      editor.updateOptions({ fontSize: Math.max(8, sz - 1) });
      terminalFontSize = Math.max(8, terminalFontSize - 1);
      termContent.style.fontSize = terminalFontSize + 'px';
      break;
    }
    case 'zoom-reset':
      setUIScale(1.0);
      break;
    case 'settings':
      openSettings();
      break;
    case 'new':
      newFile();
      break;
    case 'open':
      openFileDialog();
      break;
    case 'save':
      saveFile();
      break;
    case 'save-as':
      saveFileAs();
      break;
    default:
      console.log('Menu:', action);
  }
});
