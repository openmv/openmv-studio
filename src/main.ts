// Entry point. Creates the Monaco editor, manages connection/polling,
// parses the binary channel stream, and wires all modules together.

import * as monaco from "monaco-editor";
import { invoke, Channel } from "@tauri-apps/api/core";
import { DataChannel } from "./channel";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { state, scheduleSaveSettings } from "./state";
import { initThemes, getEffectiveTheme, applyTheme } from "./theme";
import { wglInit, wglDrawRgb565, wglDrawGrayscale, wglDrawBitmap } from "./gl";
import { initResize } from "./resize";
import { initShortcuts, setShortcutBindings, type ShortcutBinding } from "./shortcuts";
import { initWelcome } from "./welcome";
import { registerCompletions } from "./completions";
import { registerPythonLanguage } from "./python-lang";
import {
  initFiles,
  openFiles,
  activeFileIndex,
  fileName,
  newFile,
  openFileDialog,
  saveFile,
  saveFileAs,
  closeFile,
  switchToFile,
  moveTabLeft,
  moveTabRight,
  renderTabs,
  startFileWatching,
  openRecentFile,
  recentFiles,
  setRecentFiles,
  updateRecentMenu,
} from "./files";
import {
  initPanels,
  startMemPolling,
  stopMemPolling,
  startProtoPolling,
  stopProtoPolling,
  resetMemState,
  resetProtoState,
  resetExamples,
  loadExamples,
  clearExamplesTree,
  updateHistogram,
  populateInfoTab,
  clearInfoTab,
  populateSensorSelect,
  isMemTabActive,
  isProtoTabActive,
  startChannelsPolling,
  stopChannelsPolling,
  resetChannelsState,
  isChannelsTabActive,
} from "./panels";
import { initSettings, loadSettings, setUiScale, openSettings } from "./settings";

// --- Context menu ---

document.addEventListener("contextmenu", (e) => {
  const t = e.target as HTMLElement;

  if (t.closest(".terminal-content") || t.closest("#monaco-editor")) {
    return;
  }

  e.preventDefault();
});

// --- Monaco workers ---

self.MonacoEnvironment = {
  getWorker(_: string, label: string) {
    if (label === "json") {
      return new Worker(
        new URL(
          "monaco-editor/esm/vs/language/json/json.worker.js",
          import.meta.url,
        ),
        { type: "module" },
      );
    }

    if (label === "typescript" || label === "javascript") {
      return new Worker(
        new URL(
          "monaco-editor/esm/vs/language/typescript/ts.worker.js",
          import.meta.url,
        ),
        { type: "module" },
      );
    }

    return new Worker(
      new URL("monaco-editor/esm/vs/editor/editor.worker.js", import.meta.url),
      { type: "module" },
    );
  },
};

// --- Editor ---

registerPythonLanguage();
initThemes();

const editor = monaco.editor.create(document.getElementById("monaco-editor")!, {
  language: "python",
  theme: getEffectiveTheme() === "dark" ? "openmv-dark" : "openmv-light",
  fontSize: 13,
  fontFamily: "'SF Mono', 'Menlo', 'Consolas', monospace",
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  renderLineHighlight: "line",
  automaticLayout: true,
  padding: { top: 8, bottom: 8 },
  glyphMargin: false,
  folding: true,
  lineNumbersMinChars: 3,
  lineDecorationsWidth: 5,
  cursorBlinking: "smooth",
  smoothScrolling: true,
  fixedOverflowWidgets: true,
  tabSize: 4,
  insertSpaces: true,
  quickSuggestions: true,
  wordBasedSuggestions: "off",
  suggestOnTriggerCharacters: true,
});

registerCompletions(editor);

editor.onDidChangeCursorPosition((e) => {
  const el = document.getElementById("status-cursor");

  if (el) {
    el.textContent = `Ln ${e.position.lineNumber}, Col ${e.position.column}`;
  }
});

// --- Terminal ---

function termLog(text: string, cls: string = "") {
  const el = document.getElementById("terminal-output");

  if (!el) {
    return;
  }

  const div = document.createElement("div");

  if (cls) {
    div.className = cls;
  }

  div.textContent = text;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}

document.getElementById("btn-clear-term")?.addEventListener("click", () => {
  const el = document.getElementById("terminal-output");

  if (el) {
    el.innerHTML = "";
  }
});

const lockBtn = document.getElementById("btn-lock-split");

lockBtn?.addEventListener("click", () => {
  state.splitLocked = !state.splitLocked;
  lockBtn.classList.toggle("active", state.splitLocked);
  scheduleSaveSettings();
});

// --- Zoom ---

let terminalFontSize = 12;
const termContent = document.querySelector(".terminal-content") as HTMLElement;

function zoomIn() {
  const sz = editor.getOption(monaco.editor.EditorOption.fontSize);

  editor.updateOptions({ fontSize: sz + 1 });
  terminalFontSize = Math.min(32, terminalFontSize + 1);
  termContent.style.fontSize = terminalFontSize + "px";
}

function zoomOut() {
  const sz = editor.getOption(monaco.editor.EditorOption.fontSize);

  editor.updateOptions({ fontSize: Math.max(8, sz - 1) });
  terminalFontSize = Math.max(8, terminalFontSize - 1);
  termContent.style.fontSize = terminalFontSize + "px";
}

function zoomReset() {
  editor.updateOptions({ fontSize: 13 });
  terminalFontSize = 12;
  termContent.style.fontSize = terminalFontSize + "px";
}

// --- Exception inline display ---

let exceptionDecorations: monaco.editor.IEditorDecorationsCollection | null = null;
let exceptionZoneId: string | null = null;

function clearException() {
  if (exceptionDecorations) {
    exceptionDecorations.clear();
    exceptionDecorations = null;
  }

  if (exceptionZoneId) {
    const zoneId = exceptionZoneId;

    editor.changeViewZones((a) => a.removeZone(zoneId));
    exceptionZoneId = null;
  }
}

function showException(msg: string) {
  clearException();

  const lineMatch = msg.match(/File "<stdin>", line (\d+)/);
  const lineNo = lineMatch ? parseInt(lineMatch[1], 10) : null;
  const errorLine =
    msg.split("\n").find((l) => /Error:|Exception:/.test(l)) || msg;

  if (!lineNo) {
    return;
  }

  exceptionDecorations = editor.createDecorationsCollection([
    {
      range: new monaco.Range(lineNo, 1, lineNo, 1),
      options: {
        isWholeLine: true,
        className: "exception-line",
        glyphMarginClassName: "exception-glyph",
      },
    },
  ]);

  editor.changeViewZones((accessor) => {
    const domNode = document.createElement("div");

    domNode.className = "exception-zone";
    domNode.textContent = errorLine.trim();

    exceptionZoneId = accessor.addZone({
      afterLineNumber: Math.max(0, lineNo - 1),
      heightInLines: 1.4,
      domNode,
    });
  });

  editor.revealLineInCenter(lineNo);

  const disposable = editor.onDidChangeModelContent(() => {
    clearException();
    disposable.dispose();
  });
}

// --- Connection and script state ---

const btnRunStop = document.getElementById("btn-run-stop")!;
const iconPlay = btnRunStop.querySelector(".icon-play") as SVGElement;
const iconStop = btnRunStop.querySelector(".icon-stop") as SVGElement;
const runStopLabel = btnRunStop.querySelector(".run-stop-label") as HTMLElement;

function setConnected(connected: boolean, info: string = "Disconnected") {
  state.isConnected = connected;

  const dot = document.querySelector(".status-dot") as HTMLElement;
  const label = document.getElementById("status-board");
  const btnConnect = document.getElementById("btn-connect");

  if (dot) {
    dot.className = "status-dot " + (connected ? "connected" : "disconnected");
  }
  if (label) {
    label.textContent = info;
  }

  if (btnConnect) {
    btnConnect.classList.toggle("connected", connected);

    const lbl = btnConnect.querySelector("span");

    if (lbl) {
      lbl.textContent = connected ? "Disconnect" : "Connect";
    }
  }

  btnRunStop.classList.toggle("disabled", !connected);

  if (!connected) {
    setScriptRunning(false);
  }
}

function setScriptRunning(running: boolean) {
  state.scriptRunning = running;
  btnRunStop.title = running ? "Stop (Cmd+R)" : "Run (Cmd+R)";
  iconPlay.style.display = running ? "none" : "";
  iconStop.style.display = running ? "" : "none";

  if (runStopLabel) {
    runStopLabel.textContent = running ? "Stop" : "Run";
  }
}

// --- Streaming controls ---

const ICON_EYE_OPEN =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
const ICON_EYE_CLOSED =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/><line x1="2" y1="2" x2="22" y2="22"/></svg>';
const ICON_JPG_ON =
  '<svg width="18" height="14" viewBox="0 0 28 24" fill="none" stroke="currentColor" stroke-width="1.8"><text x="1" y="17" font-size="14" font-weight="bold" font-family="sans-serif" fill="currentColor" stroke="none">JPG</text></svg>';
const ICON_JPG_OFF =
  '<svg width="18" height="14" viewBox="0 0 28 24" fill="none" stroke="currentColor" stroke-width="1.8"><text x="1" y="17" font-size="14" font-weight="bold" font-family="sans-serif" fill="currentColor" stroke="none">JPG</text><line x1="2" y1="2" x2="26" y2="22"/></svg>';

const btnFbDisable = document.getElementById("btn-fb-disable")!;
const btnFbJpeg = document.getElementById("btn-fb-jpeg")!;
const fbSourceSelect = document.getElementById("fb-source") as HTMLSelectElement;

async function sendStreaming() {
  try {
    const enable = btnFbDisable.classList.contains("active");
    const raw = !btnFbJpeg.classList.contains("active");

    await invoke("cmd_enable_streaming", { enable, raw });
  } catch (e) {
    console.error("Failed to set streaming:", e);
  }
}

btnFbDisable.addEventListener("click", async () => {
  const enabled = btnFbDisable.classList.toggle("active");

  btnFbDisable.innerHTML = enabled ? ICON_EYE_OPEN : ICON_EYE_CLOSED;
  btnFbDisable.title = enabled ? "Disable streaming" : "Enable streaming";
  updateFbPlaceholder();

  if (state.isConnected) {
    await sendStreaming();
  }
});

btnFbJpeg.addEventListener("click", async () => {
  const jpeg = btnFbJpeg.classList.toggle("active");

  btnFbJpeg.innerHTML = jpeg ? ICON_JPG_ON : ICON_JPG_OFF;
  btnFbJpeg.title = jpeg ? "JPEG mode" : "RAW mode";

  if (state.isConnected) {
    await sendStreaming();
  }
});

fbSourceSelect.addEventListener("change", async () => {
  const chipId = parseInt(fbSourceSelect.value, 10);

  if (isNaN(chipId)) {
    return;
  }

  try {
    await invoke("cmd_set_stream_source", { chipId });

    const selected = fbSourceSelect.options[fbSourceSelect.selectedIndex];

    state.connectedSensor = selected?.textContent || null;
  } catch (e) {
    console.error("Failed to set stream source:", e);
  }
});

// --- Connect / disconnect ---

let connectInProgress = false;

async function doConnect() {
  if (state.isConnected || connectInProgress) {
    return;
  }
  connectInProgress = true;

  try {
    let port = state.serialPort;

    if (!port) {
      const ports = await invoke<string[]>("cmd_list_ports");

      if (ports.length === 0) {
        termLog("No serial ports found.", "error-line");
        return;
      }

      port = ports[0];
    }

    await invoke("cmd_connect", { port });

    const sysinfo = await invoke<any>("cmd_get_sysinfo");
    const version = await invoke<any>("cmd_get_version");
    const fw = `${version.firmware[0]}.${version.firmware[1]}.${version.firmware[2]}`;

    state.connectedBoard = sysinfo.board_type;
    state.connectedSensor = null;
    setConnected(true, `${sysinfo.board_name} | ${port} | v${fw}`);
    populateSensorSelect(sysinfo.sensors || []);
    populateInfoTab(sysinfo, version, port);

    try {
      await invoke("cmd_stop_script");
    } catch {}

    try {
      await sendStreaming();
    } catch {}

    startPolling();

    resetExamples();
    loadExamples();
  } catch (e: any) {
    console.error("Connect failed:", e);
  } finally {
    connectInProgress = false;
  }
}

async function doDisconnect() {
  if (!state.isConnected) {
    return;
  }

  stopPolling();
  stopMemPolling();
  stopProtoPolling();
  stopChannelsPolling();
  resetMemState();
  resetProtoState();
  resetChannelsState();

  try { await invoke("cmd_stop_script"); } catch {}
  try { await invoke("cmd_disconnect"); } catch {}

  state.connectedBoard = null;
  state.connectedSensor = null;
  state.canvasVisible = false;

  setConnected(false);
  populateSensorSelect([]);
  clearInfoTab();

  resetExamples();

  if (state.filterExamples) {
    clearExamplesTree();
  } else {
    loadExamples();
  }
}

async function toggleConnect() {
  if (state.isConnected) {
    await doDisconnect();
  } else {
    await doConnect();
  }
}

// --- Run / stop script ---

async function runScript() {
  if (!state.isConnected) {
    return;
  }

  clearException();

  try {
    await sendStreaming();
    await invoke("cmd_run_script", { script: editor.getValue() });
  } catch (e: any) {
    console.error("Run failed:", e);
  }
}

async function stopScript() {
  if (!state.isConnected) {
    return;
  }

  try {
    await invoke("cmd_stop_script");
  } catch (e: any) {
    console.error("Stop failed:", e);
  }
}

async function toggleRunStop() {
  if (state.scriptRunning) {
    await stopScript();
  } else {
    await runScript();
  }
}

document
  .getElementById("btn-connect")
  ?.addEventListener("click", toggleConnect);
btnRunStop.addEventListener("click", toggleRunStop);

// --- Framebuffer rendering ---

const fbCanvas = document.getElementById("framebuffer-canvas") as HTMLCanvasElement;
const fbNoImage = document.querySelector(".no-image") as HTMLElement;
const fbResolution = document.getElementById("fb-resolution")!;
const fbFormat = document.getElementById("fb-format")!;
const fbFps = document.getElementById("fb-fps")!;

wglInit(fbCanvas);

const ICON_NO_IMAGE =
  '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="20" height="20" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>';
const ICON_FB_DISABLED =
  '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="20" height="20" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/><line x1="2" y1="2" x2="22" y2="22" stroke-width="2"/></svg>';

function updateFbPlaceholder() {
  const streaming = btnFbDisable.classList.contains("active");
  const svg = fbNoImage.querySelector("svg");
  const span = fbNoImage.querySelector("span");

  if (svg) {
    svg.outerHTML = streaming ? ICON_NO_IMAGE : ICON_FB_DISABLED;
  }

  if (span) {
    span.textContent = streaming ? "No image data" : "Streaming disabled";
  }

  if (!streaming) {
    fbCanvas.style.display = "none";
    fbNoImage.style.display = "";
    state.canvasVisible = false;
  }
}

// Reusable frame buffer -- grows as needed, never shrinks
let frameBuf = new ArrayBuffer(0);

// Pending frame for rAF-based rendering. The poll channel stashes the
// latest frame here; requestAnimationFrame draws it. This decouples
// serial I/O from rendering so the main thread stays responsive.
let pendingFrame: {
  format: number;
  width: number;
  height: number;
  dataLen: number;
} | null = null;

let rafId = 0;

function renderFrame() {
  rafId = 0;

  const f = pendingFrame;

  if (!f) {
    return;
  }

  pendingFrame = null;

  if (f.format === 0x06060000) {
    const blob = new Blob([new Uint8Array(frameBuf, 0, f.dataLen)], {
      type: "image/jpeg",
    });

    createImageBitmap(blob).then((bitmap) => {
      wglDrawBitmap(bitmap);
      bitmap.close();
      showCanvas(f.format);
    });
  } else if (f.format === 0x0c030002) {
    wglDrawRgb565(
      new Uint16Array(frameBuf, 0, f.width * f.height),
      f.width,
      f.height,
    );
    showCanvas(f.format);
  } else if (f.format === 0x08020001) {
    wglDrawGrayscale(
      new Uint8Array(frameBuf, 0, f.width * f.height),
      f.width,
      f.height,
    );
    showCanvas(f.format);
  }
}

function scheduleRender() {
  if (!rafId) {
    rafId = requestAnimationFrame(renderFrame);
  }
}

function showCanvas(format: number) {
  if (!btnFbDisable.classList.contains("active")) {
    return;
  }

  if (!state.canvasVisible) {
    fbCanvas.style.display = "block";
    fbCanvas.style.maxWidth = "100%";
    fbCanvas.style.maxHeight = "100%";
    fbCanvas.style.objectFit = "contain";
    fbNoImage.style.display = "none";
    state.canvasVisible = true;
  }

  updateHistogram(format, frameBuf);
}

// --- Channel callbacks ---
// Poll channel: backend pushes [connected:u8][running:u8][has_stdout:u8][has_frame:u8]
// Data channels: backend pushes raw binary in response to invoke requests.

let pollChannel: Channel<ArrayBuffer> | null = null;
const stdoutChannel = new DataChannel();
const frameChannel = new DataChannel();

stdoutChannel.onmessage = (raw: ArrayBuffer) => {
  if (!state.isConnected || raw.byteLength === 0) {
    return;
  }

  const text = new TextDecoder().decode(raw);
  let hasException = false;
  const errorLines: string[] = [];

  for (const line of text.split("\n")) {
    if (line.length > 0) {
      const isError =
        /^(Traceback|  File |.*Error:|.*Exception:|.*Interrupt:|MPY:)/.test(line);

      termLog(line, isError ? "error-line" : "fps-line");

      if (isError) {
        hasException = true;
        errorLines.push(line);
      }
    }
  }

  if (hasException && !/KeyboardInterrupt/.test(errorLines.join("\n"))) {
    showException(errorLines.join("\n"));
  }
};

frameChannel.onmessage = (raw: ArrayBuffer) => {
  if (!state.isConnected || raw.byteLength < 16) {
    return;
  }

  const view = new DataView(raw);
  const width = view.getUint32(0, true);
  const height = view.getUint32(4, true);
  const format = view.getUint32(8, true);
  const fps = view.getFloat32(12, true);
  const dataLen = raw.byteLength - 16;

  fbResolution.textContent = `${width}x${height}`;
  fbFormat.textContent =
    format === 0x06060000
      ? "JPEG"
      : format === 0x0c030002
        ? "RGB565"
        : format === 0x08020001
          ? "GRAY"
          : `0x${format.toString(16).toUpperCase()}`;

  if (fps > 0) {
    fbFps.textContent = fps.toFixed(1);
  }

  if (dataLen > frameBuf.byteLength) {
    frameBuf = new ArrayBuffer(dataLen);
  }

  new Uint8Array(frameBuf, 0, dataLen).set(new Uint8Array(raw, 16, dataLen));
  pendingFrame = { format, width, height, dataLen };
  scheduleRender();
};

function handlePollFlags(raw: ArrayBuffer) {
  if (raw.byteLength < 4 || !state.isConnected) {
    return;
  }

  const view = new DataView(raw);
  const connected = view.getUint8(0) !== 0;
  const running = view.getUint8(1) !== 0;
  const hasStdout = view.getUint8(2) !== 0;
  const hasFrame = view.getUint8(3) !== 0;

  if (!connected) {
    doDisconnect();
    return;
  }

  if (state.scriptRunning !== running) {
    setScriptRunning(running);
  }

  if (hasStdout) {
    stdoutChannel.request("cmd_get_stdout");
  }

  if (hasFrame) {
    frameChannel.request("cmd_get_frame");
  }
}

// --- Polling lifecycle ---

function startPolling() {
  pollChannel = new Channel<ArrayBuffer>();
  const currentChannel = pollChannel;
  pollChannel.onmessage = (raw) => {
    if (pollChannel !== currentChannel) {
      return;
    }
    handlePollFlags(raw);
  };

  invoke("cmd_start_polling", {
    intervalMs: state.pollIntervalMs,
    channel: pollChannel,
  });

  if (isMemTabActive()) {
    startMemPolling(200);
  }

  if (isProtoTabActive()) {
    startProtoPolling();
  }

  if (isChannelsTabActive()) {
    startChannelsPolling();
  }
}

function stopPolling() {
  pollChannel = null;
  stdoutChannel.reset();
  frameChannel.reset();

  invoke("cmd_stop_polling");

  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = 0;
    pendingFrame = null;
  }
}

// --- Module init ---

initWelcome(newFile, openFileDialog);
initFiles(editor);
initPanels();
initSettings(editor, applyTheme);

setShortcutBindings([
  {
    id: "run-stop",
    label: "Run / Stop",
    defaults: [{ meta: true, key: "r" }, { key: "F5" }, { key: "F6" }],
    action: toggleRunStop,
  },
  {
    id: "connect",
    label: "Connect / Disconnect",
    defaults: [{ ctrl: true, key: "e" }],
    action: toggleConnect,
  },
  {
    id: "new-file",
    label: "New File",
    defaults: [{ meta: true, key: "n" }],
    action: newFile,
  },
  {
    id: "open-file",
    label: "Open File",
    defaults: [{ meta: true, key: "o" }],
    action: openFileDialog,
  },
  {
    id: "save",
    label: "Save",
    defaults: [{ meta: true, key: "s" }],
    action: saveFile,
  },
  {
    id: "save-as",
    label: "Save As",
    defaults: [{ meta: true, shift: true, key: "s" }],
    action: saveFileAs,
  },
  {
    id: "close-tab",
    label: "Close Tab",
    defaults: [{ meta: true, key: "w" }],
    action: () => closeFile(activeFileIndex),
  },
  {
    id: "zoom-in",
    label: "Zoom In",
    defaults: [{ meta: true, key: "=" }],
    action: zoomIn,
  },
  {
    id: "zoom-out",
    label: "Zoom Out",
    defaults: [{ meta: true, key: "-" }],
    action: zoomOut,
  },
  {
    id: "zoom-reset",
    label: "Reset Zoom",
    defaults: [{ meta: true, key: "0" }],
    action: zoomReset,
  },
  {
    id: "settings",
    label: "Settings",
    defaults: [{ meta: true, key: "," }],
    action: openSettings,
  },
  {
    id: "prev-tab",
    label: "Previous Tab",
    defaults: [{ meta: true, shift: true, key: "ArrowUp" }],
    action: () => {
      if (openFiles.length > 1) {
        switchToFile(
          (activeFileIndex - 1 + openFiles.length) % openFiles.length,
        );
      }
    },
  },
  {
    id: "next-tab",
    label: "Next Tab",
    defaults: [{ meta: true, shift: true, key: "ArrowDown" }],
    action: () => {
      if (openFiles.length > 1) {
        switchToFile((activeFileIndex + 1) % openFiles.length);
      }
    },
  },
  {
    id: "move-tab-left",
    label: "Move Tab Left",
    defaults: [{ meta: true, shift: true, key: "ArrowLeft" }],
    action: moveTabLeft,
  },
  {
    id: "move-tab-right",
    label: "Move Tab Right",
    defaults: [{ meta: true, shift: true, key: "ArrowRight" }],
    action: moveTabRight,
  },
] as ShortcutBinding[]);

initShortcuts(editor);
initResize();
setUiScale(state.uiScale);

// --- Load settings then finalize UI ---

loadSettings().then(() => {
  setUiScale(state.uiScale);
  applyTheme(state.currentThemeSetting);
  renderTabs();
  startFileWatching();
  updateRecentMenu();

  document.querySelector<HTMLElement>(".right-panel")!.style.visibility = "";

  if (!state.filterExamples) {
    loadExamples();
  }
});

// --- Close request ---

listen("request-close", async () => {
  for (const f of openFiles) {
    if (!f.modified) {
      continue;
    }

    const { message: dialogMessage } = await import("@tauri-apps/plugin-dialog");

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

    if (result === "Save") {
      const idx = openFiles.indexOf(f);

      switchToFile(idx);

      if (f.path) {
        await saveFile();
      } else {
        await saveFileAs();
      }

      if (f.modified) {
        return;
      }
    }
  }

  try { await invoke("cmd_disconnect"); } catch {}

  await getCurrentWindow().destroy();
});

// --- System menu ---

listen<string>("menu-action", (event) => {
  const action = event.payload;

  switch (action) {
    case "zoom-in":
      zoomIn();
      break;
    case "zoom-out":
      zoomOut();
      break;
    case "zoom-reset":
      setUiScale(1.0);
      break;
    case "settings":
      openSettings();
      break;
    case "new":
      newFile();
      break;
    case "open":
      openFileDialog();
      break;
    case "save":
      saveFile();
      break;
    case "save-as":
      saveFileAs();
      break;
    default:
      if (action.startsWith("recent:")) {
        const idx = parseInt(action.slice(7), 10);

        if (idx >= 0 && idx < recentFiles.length) {
          openRecentFile(recentFiles[idx]);
        }
      } else if (action === "recent-clear") {
        setRecentFiles([]);
        updateRecentMenu();
      } else {
        console.log("Menu:", action);
      }
  }
});
