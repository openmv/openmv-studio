/*
 * Copyright (C) 2026 OpenMV, LLC.
 *
 * This software is licensed under terms that can be found in the
 * LICENSE file in the root directory of this software component.
 */
// Entry point. Creates the Monaco editor, manages connection,
// dispatches worker channel messages, and wires all modules together.

import * as monaco from "monaco-editor";
import { invoke, Channel } from "@tauri-apps/api/core";
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
  clearChannelsCache,
  isChannelsTabActive,
  updateMemUi,
  updateStatsUi,
  updateChannelUi,
} from "./panels";
import { initSettings, loadSettings, setUiScale, openSettings } from "./settings";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { openPinoutViewer } from "./pinout";
import { openResourceWindow, type ResourceStatus } from "./resources";
import { message as dialogMessage } from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";

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

// --- IDE log toggle ---

const logToggleBtn = document.getElementById("btn-toggle-log");
let logUnlisten: (() => void) | null = null;

async function enableLog() {
  if (logUnlisten) {
    return;
  }

  const { attachLogger, LogLevel } = await import("@tauri-apps/plugin-log");
  logUnlisten = await attachLogger(({ level, message }) => {
    const el = document.getElementById("terminal-output");

    if (!el) {
      return;
    }

    const levelCls: Record<number, string> = {
      [LogLevel.Trace]: "log-line",
      [LogLevel.Debug]: "log-line log-debug",
      [LogLevel.Info]: "log-line",
      [LogLevel.Warn]: "log-line log-warn",
      [LogLevel.Error]: "log-line log-error",
    };
    const div = document.createElement("div");
    div.className = levelCls[level] || "log-line";
    div.textContent = message;
    el.appendChild(div);
    el.scrollTop = el.scrollHeight;
  });
}

function disableLog() {
  if (logUnlisten) {
    logUnlisten();
    logUnlisten = null;
  }
}

logToggleBtn?.addEventListener("click", () => {
  state.showLog = !state.showLog;
  logToggleBtn.classList.toggle("active", state.showLog);

  if (state.showLog) {
    enableLog();
  } else {
    disableLog();
  }

  scheduleSaveSettings();
});

// enableLog() is called from loadSettings().then() after state is loaded

// --- Clear / Lock ---

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
    clearTimeout(staleTimer);

    if (btnConnect) {
      btnConnect.classList.remove("alive");
    }
  }
}

function setScriptRunning(running: boolean) {
  state.scriptRunning = running;
  btnRunStop.title = running ? "Stop (Cmd+R)" : "Run (Cmd+R)";
  iconPlay.style.display = running ? "none" : "";
  iconStop.style.display = running ? "" : "none";

  if (!running) {
    stopChannelsPolling();
    clearChannelsCache();
  } else if (isChannelsTabActive()) {
    startChannelsPolling();
  }

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
    // Create worker channel for all backend data
    workerChannel = new Channel<ArrayBuffer>();
    workerChannel.onmessage = handleWorkerMessage;

    let connLabel: string;

    if (state.transportType === "udp") {
      if (!state.networkAddress) {
        termLog(
          "Network address not configured. Set it in Settings > Connection.",
          "error-line",
        );
        return;
      }

      connLabel = state.networkAddress;
    } else {
      let port = state.serialPort;

      if (!port) {
        const ports = await invoke<string[]>("cmd_list_ports");

        if (ports.length === 0) {
          termLog("No serial ports found.", "error-line");
          return;
        }

        port = ports[0];
      }

      connLabel = port;
    }

    await invoke("cmd_connect", {
      address: connLabel,
      transport: state.transportType,
      channel: workerChannel,
      ioIntervalMs: state.ioIntervalMs,
    });

    const sysinfo = await invoke<any>("cmd_get_sysinfo");
    const version = await invoke<any>("cmd_get_version");
    const fw = `${version.firmware[0]}.${version.firmware[1]}.${version.firmware[2]}`;

    state.connectedBoard = sysinfo.board_type;
    state.connectedSensor = null;
    setConnected(true, `${sysinfo.board_name} | ${connLabel} | v${fw}`);
    populateSensorSelect(sysinfo.sensors || []);
    populateInfoTab(sysinfo, version, connLabel);

    try {
      await invoke("cmd_stop_script");
    } catch {}

    try {
      await sendStreaming();
    } catch {}

    if (isMemTabActive()) {
      startMemPolling(200);
    }

    if (isProtoTabActive()) {
      startProtoPolling();
    }

    if (isChannelsTabActive()) {
      startChannelsPolling();
    }

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

  stopMemPolling();
  stopProtoPolling();
  stopChannelsPolling();
  resetMemState();
  resetProtoState();
  resetChannelsState();

  try {
    await invoke("cmd_disconnect");
  } catch {}

  workerChannel = null;

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

  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = 0;
    pendingFrame = null;
  }

  resetFbBadges();
}

async function toggleConnect() {
  if (state.isConnected) {
    await doDisconnect();
  } else {
    await doConnect();
  }
}

// --- Run / stop script ---

// Strip # comments from script to reduce firmware memory usage.
// Lines are preserved (never removed) so traceback line numbers stay correct.
function stripComments(src: string): string {
  return src.split("\n").map((line) => {
    let inStr: string | null = null;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inStr) {
        if (ch === "\\") {
          i++;
        } else if (ch === inStr) {
          inStr = null;
        }
      } else if (ch === "#") {
        return line.slice(0, i).trimEnd();
      } else if (ch === "'" || ch === '"') {
        inStr = ch;
      }
    }
    return line;
  }).join("\n");
}

async function runScript() {
  if (!state.isConnected) {
    return;
  }

  clearException();

  try {
    await sendStreaming();
    const script = stripComments(editor.getValue());
    await invoke("cmd_run_script", { script });

    // Firmware reverts to default source on script start,
    // re-send the user's selected source.
    const chipId = parseInt(fbSourceSelect.value, 10);

    if (!isNaN(chipId)) {
      await invoke("cmd_set_stream_source", { chipId });
    }

    setScriptRunning(true);
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
    setScriptRunning(false);
    resetFbBadges();
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

async function eraseFilesystem() {
  if (!state.isConnected) {
    return;
  }

  const scale = state.uiScale;
  const win = new WebviewWindow("dfu-progress", {
    url: "progress.html",
    title: "Erase Filesystem",
    width: Math.round(480 * scale),
    height: Math.round(320 * scale),
    resizable: true,
    center: true,
    alwaysOnTop: true,
    parent: "main",
  });

  try {
    await new Promise<void>((resolve, reject) => {
      win.once("tauri://created", () => resolve());
      win.once("tauri://error", (e) => reject(e));
    });
  } catch (e: any) {
    console.error("Failed to create progress window:", e);
    return;
  }

  try {
    await invoke("cmd_erase_filesystem");
  } catch (e: any) {
    console.error("Erase filesystem failed:", e);
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

function resetFbBadges() {
  fbResolution.textContent = "";
  fbFormat.textContent = "";
  fbFps.textContent = "";
}

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

// Pending frame for rAF-based rendering. The worker channel stashes the
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

// --- Worker channel ---
// Single binary channel from backend. Messages prefixed with a tag byte:
// 0x01=Frame, 0x02=Stdout, 0x03=Memory, 0x04=Stats, 0x05=Channels,
// 0x10=SoftReboot, 0x12=Disconnected, 0x13=Error

let workerChannel: Channel<ArrayBuffer> | null = null;

// Liveness: run/stop button breathes while data is flowing
let staleTimer = 0;
const STALE_THRESHOLD = 3000;

function tickActivity() {
  const btn = document.getElementById("btn-connect");

  if (btn) {
    btn.classList.add("alive");
  }

  clearTimeout(staleTimer);
  staleTimer = window.setTimeout(() => {
    if (btn) {
      btn.classList.remove("alive");
    }
  }, STALE_THRESHOLD);
}

function handleWorkerMessage(raw: ArrayBuffer) {
  if (raw.byteLength < 1 || !state.isConnected) {
    return;
  }

  tickActivity();

  const tag = new Uint8Array(raw)[0];
  const view = new DataView(raw, 1, raw.byteLength - 1);

  switch (tag) {
    case 0x01:
      handleFrame(view);
      break;
    case 0x02:
      handleStdout(view);
      break;
    case 0x03:
      handleMemory(view);
      break;
    case 0x04:
      handleStats(view);
      break;
    case 0x05:
      handleChannels(view);
      break;
    case 0x10:
      setScriptRunning(false);
      break;
    case 0x12:
      handleDisconnected();
      break;
    case 0x13:
      handleError(view);
      break;
  }
}

function handleStdout(view: DataView) {
  if (view.byteLength === 0) {
    return;
  }

  const text = new TextDecoder().decode(view);
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
}

function handleFrame(view: DataView) {
  if (view.byteLength < 16) {
    return;
  }

  const width = view.getUint32(0, true);
  const height = view.getUint32(4, true);
  const format = view.getUint32(8, true);
  const fps = view.getFloat32(12, true);
  const dataLen = view.byteLength - 16;

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

  new Uint8Array(frameBuf, 0, dataLen).set(
    new Uint8Array(view.buffer, view.byteOffset + 16, dataLen),
  );
  pendingFrame = { format, width, height, dataLen };
  scheduleRender();
}

// --- Data handlers (binary parsing) ---

const STAT_KEYS = [
  "sent", "received", "checksum", "sequence",
  "retransmit", "transport", "sent_events", "max_ack_queue_depth",
];

function handleMemory(view: DataView) {
  if (view.byteLength < 4) {
    return;
  }

  const count = view.getUint8(0);
  const entries: any[] = [];

  for (let i = 0; i < count; i++) {
    const o = 4 + i * 24;

    if (o + 24 > view.byteLength) {
      break;
    }

    entries.push({
      mem_type: view.getUint8(o) === 0 ? "gc" : "uma",
      flags: view.getUint16(o + 2, true),
      total: view.getUint32(o + 4, true),
      used: view.getUint32(o + 8, true),
      free: view.getUint32(o + 12, true),
      persist: view.getUint32(o + 16, true),
      peak: view.getUint32(o + 20, true),
    });
  }

  updateMemUi(entries);
}

function handleStats(view: DataView) {
  if (view.byteLength < 36) {
    return;
  }

  const stats: Record<string, number> = {};

  for (let i = 0; i < STAT_KEYS.length; i++) {
    stats[STAT_KEYS[i]] = view.getUint32(i * 4, true);
  }

  const chCount = view.getUint8(32);
  const channels: { name: string; id: number; events: number }[] = [];
  const dynamic: { name: string; id: number; flags: number }[] = [];

  for (let i = 0; i < chCount; i++) {
    const o = 36 + i * 20;

    if (o + 20 > view.byteLength) {
      break;
    }

    const id = view.getUint8(o);
    const flags = view.getUint8(o + 1);
    const nameBytes = new Uint8Array(view.buffer, view.byteOffset + o + 2, 14);
    let nameLen = 0;

    while (nameLen < 14 && nameBytes[nameLen] !== 0) {
      nameLen++;
    }

    const name = new TextDecoder().decode(nameBytes.subarray(0, nameLen));
    const events = view.getUint32(o + 16, true);

    channels.push({ name, id, events });

    if (flags & 0x20) {
      dynamic.push({ name, id, flags });
    }
  }

  updateStatsUi(stats, channels, dynamic);
}

function handleChannels(view: DataView) {
  if (view.byteLength < 2) {
    return;
  }

  let offset = 0;
  const nameLen = view.getUint8(offset);

  offset += 1;
  const name = new TextDecoder().decode(
    new Uint8Array(view.buffer, view.byteOffset + offset, nameLen),
  );

  offset += nameLen;

  if (offset + 4 > view.byteLength) {
    return;
  }

  const dataLen = view.getUint32(offset, true);

  offset += 4;
  const data = Array.from(
    new Uint8Array(view.buffer, view.byteOffset + offset, dataLen),
  );

  updateChannelUi(name, data);
}

function handleDisconnected() {
  doDisconnect();
}

function handleError(view: DataView) {
  if (view.byteLength > 0) {
    const msg = new TextDecoder().decode(view);

    console.error("Worker error:", msg);
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
  {
    id: "pinout-viewer",
    label: "Pinout Viewer",
    defaults: [{ meta: true, key: "p" }],
    action: openPinoutViewer,
  },
] as ShortcutBinding[]);

initShortcuts(editor);
initResize();
setUiScale(state.uiScale);

// --- Resource update indicator ---

function showUpdateIndicator() {
  const el = document.getElementById("status-updates");
  if (el) {
    el.style.display = "";
  }
}

function hideUpdateIndicator() {
  const el = document.getElementById("status-updates");
  if (el) {
    el.style.display = "none";
  }
}

document.getElementById("status-updates")?.addEventListener("click", async () => {
  const downloaded = await openResourceWindow("update", state.resourceChannel);
  if (downloaded) {
    hideUpdateIndicator();
    await relaunch();
  }
});

listen("channel-changed", () => {
  invoke<ResourceStatus[]>("cmd_fetch_manifest", {
    channel: state.resourceChannel,
  })
    .then((freshStatus) => {
      if (freshStatus.some((s) => s.needs_update)) {
        showUpdateIndicator();
      } else {
        hideUpdateIndicator();
      }
    })
    .catch(() => {});
});

// --- Load settings then finalize UI ---

loadSettings().then(async () => {
  setUiScale(state.uiScale);
  applyTheme(state.currentThemeSetting);

  // Check if resources need downloading (first run)
  const status = await invoke<ResourceStatus[]>("cmd_check_resources", {
    channel: state.resourceChannel,
  });
  const needsSetup = status.some((s) => s.needs_update);

  if (needsSetup) {
    const downloaded = await openResourceWindow("setup", state.resourceChannel);
    if (downloaded) {
      await relaunch();
    }
    return;
  }

  renderTabs();
  startFileWatching();
  updateRecentMenu();

  if (!state.filterExamples) {
    loadExamples();
  }

  if (state.showLog) {
    enableLog();
  }

  // Check for resource updates in the background (non-blocking)
  invoke<ResourceStatus[]>("cmd_fetch_manifest", {
    channel: state.resourceChannel,
  })
    .then((freshStatus) => {
      if (freshStatus.some((s) => s.needs_update)) {
        showUpdateIndicator();
      }
    })
    .catch(() => {
      // Network unavailable - silently ignore
    });
});

// --- Close request ---

listen("request-close", async () => {
  for (const f of openFiles) {
    if (!f.modified) {
      continue;
    }

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

// --- About dialog ---

let aboutWin: WebviewWindow | null = null;

async function openAboutDialog() {
  if (aboutWin) {
    return;
  }

  const scale = state.uiScale;
  const win = new WebviewWindow("about", {
    url: "about.html",
    title: "About OpenMV Studio",
    width: Math.round(380 * scale),
    height: Math.round(340 * scale),
    resizable: false,
    center: true,
    alwaysOnTop: true,
    parent: "main",
  });

  aboutWin = win;

  try {
    await new Promise<void>((resolve, reject) => {
      win.once("tauri://created", () => resolve());
      win.once("tauri://error", (e) => reject(e));
    });
  } catch {
    aboutWin = null;
    return;
  }

  const readyUnlisten = await listen("about-ready", async () => {
    readyUnlisten();
    const version = await getVersion();
    const theme = document.documentElement.getAttribute("data-theme") || "dark";

    win.emit("about-init", { version, theme });
  });

  win.once("tauri://destroyed", () => {
    aboutWin = null;
  });
}

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
    case "reset-device":
      invoke("cmd_reset");
      break;
    case "bootloader":
      invoke("cmd_bootloader");
      break;
    case "erase-fs":
      eraseFilesystem();
      break;
    case "pinout-viewer":
      openPinoutViewer();
      break;
    case "docs":
      invoke("cmd_open_url", { url: "https://docs.openmv.io/" });
      break;
    case "about":
      openAboutDialog();
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
