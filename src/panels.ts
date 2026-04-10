// Right-panel tools: memory stats, protocol stats, histogram,
// examples tree, sidebar navigation, and board info tab.

import { invoke } from "@tauri-apps/api/core";
import { state } from "./state";
import { wglCtx, wglWidth, wglHeight } from "./gl";
import { hideWelcome } from "./welcome";
import { createFile, switchToFile, openFiles } from "./files";

// --- Init and tab switching ---

export function initPanels() {
  document.querySelectorAll(".tools-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const tool = (tab as HTMLElement).dataset.tool!;

      document
        .querySelectorAll(".tools-tab")
        .forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");

      document
        .querySelectorAll(".tools-body")
        .forEach((b) => ((b as HTMLElement).style.display = "none"));

      const body = document.querySelector(
        `.tools-body[data-tool="${tool}"]`,
      ) as HTMLElement;

      if (body) {
        body.style.display = "";
        body.scrollTop = 0;
      }

      if (tool === "memory") {
        startMemPolling();
      } else {
        stopMemPolling();
      }

      if (tool === "protocol") {
        startProtoPolling();
      } else {
        stopProtoPolling();
      }
    });
  });

  // Memory poll rate slider
  const memSlider = document.getElementById("mem-poll-slider") as HTMLInputElement;
  const memLabel = document.getElementById("mem-poll-value")!;

  memSlider?.addEventListener("input", () => {
    memPollInterval = parseInt(memSlider.value, 10);
    memLabel.textContent = `${memPollInterval} ms`;

    if (memPollTimer !== null) {
      startMemPolling();
    }
  });

  // Protocol poll rate slider
  const protoSlider = document.getElementById("proto-poll-slider") as HTMLInputElement;
  const protoLabel = document.getElementById("proto-poll-value")!;

  protoSlider?.addEventListener("input", () => {
    protoPollInterval = parseInt(protoSlider.value, 10);
    protoLabel.textContent = `${protoPollInterval} ms`;

    if (protoPollTimer !== null) {
      startProtoPolling();
    }
  });

  initSidebar();
}

export function isMemTabActive(): boolean {
  const tab = document.querySelector('.tools-tab[data-tool="memory"]');
  return tab?.classList.contains("active") || false;
}

export function isProtoTabActive(): boolean {
  const tab = document.querySelector('.tools-tab[data-tool="protocol"]');
  return tab?.classList.contains("active") || false;
}

export function isHistTabActive(): boolean {
  const tab = document.querySelector('.tools-tab[data-tool="histogram"]');
  return tab?.classList.contains("active") || false;
}

// --- Memory stats ---

const MEM_HISTORY_MAX = 120;

const UMA_FLAG_NAMES: [number, string][] = [
  [1 << 0, "FAST"],
  [1 << 1, "ITCM"],
  [1 << 2, "DTCM"],
  [1 << 3, "DMA_D1"],
  [1 << 4, "DMA_D2"],
  [1 << 5, "DMA_D3"],
  [1 << 6, "TRANSIENT"],
];

let memHistory: Map<string, { used: number; total: number }[]> = new Map();
let memPeak: Map<string, number> = new Map();
let memPollTimer: number | null = null;
let memPollInFlight = false;
let memPollInterval = 500;

export function startMemPolling(delay = 0) {
  stopMemPolling();

  if (delay > 0) {
    memPollTimer = window.setTimeout(() => {
      fetchMemoryStats();
      memPollTimer = window.setInterval(fetchMemoryStats, memPollInterval);
    }, delay);
  } else {
    fetchMemoryStats();
    memPollTimer = window.setInterval(fetchMemoryStats, memPollInterval);
  }
}

export function stopMemPolling() {
  if (memPollTimer !== null) {
    clearInterval(memPollTimer);
    memPollTimer = null;
  }
}

export function resetMemState() {
  memHistory.clear();
  memPeak.clear();

  const content = document.getElementById("memory-content");

  if (content) {
    content.innerHTML =
      '<div style="padding:8px;color:var(--text-muted)">Connect to view memory</div>';
  }
}

async function fetchMemoryStats() {
  const content = document.getElementById("memory-content");

  if (!content) {
    return;
  }

  if (!state.isConnected) {
    content.innerHTML =
      '<div style="padding:8px;color:var(--text-muted)">Connect to view memory</div>';
    return;
  }

  if (memPollInFlight) {
    return;
  }

  memPollInFlight = true;

  try {
    const entries = await invoke<any[]>("cmd_get_memory");
    updateMemUi(content, entries);
  } catch {
    content.innerHTML =
      '<div style="padding:8px;color:var(--text-muted)">Failed to read memory</div>';
  } finally {
    memPollInFlight = false;
  }
}

function updateMemUi(content: HTMLElement, entries: any[]) {
  const existing = content.querySelectorAll(".mem-card");

  if (existing.length !== entries.length) {
    content.innerHTML = entries.map((e, i) => renderMemEntry(e, i)).join("");
  }

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const key = memKey(e, i);
    let hist = memHistory.get(key);

    if (!hist) {
      hist = [];
      memHistory.set(key, hist);
    }

    const u = memUsed(e);

    hist.push({ used: u, total: e.total });

    if (hist.length > MEM_HISTORY_MAX) {
      hist.shift();
    }

    const prev = memPeak.get(key) || 0;

    if (u > prev) {
      memPeak.set(key, u);
    }
  }

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const key = memKey(e, i);
    const used = memUsed(e);
    const pct = e.total > 0 ? Math.round((used / e.total) * 100) : 0;

    const card = content
      .querySelector(`#mem-graph-${key}`)
      ?.closest(".mem-card");

    if (card) {
      const rows = card.querySelectorAll(".mem-row");

      if (rows[0]) {
        rows[0].querySelector("span:last-child")!.textContent =
          `${formatBytes(used)} / ${formatBytes(e.total)} (${pct}%)`;
      }
      if (rows[1]) {
        rows[1].querySelector("span:last-child")!.textContent =
          formatBytes(e.free);
      }

      if (e.mem_type !== "gc") {
        if (rows[2]) {
          rows[2].querySelector("span:last-child")!.textContent =
            formatBytes(e.persist);
        }
        if (rows[3]) {
          rows[3].querySelector("span:last-child")!.textContent =
            formatBytes(e.peak);
        }
      }
    }

    const canvas = document.getElementById(
      `mem-graph-${key}`,
    ) as HTMLCanvasElement | null;

    if (canvas) {
      drawMemGraph(canvas, memHistory.get(key) || [], memPeak.get(key) || 0);
    }
  }
}

function renderMemEntry(e: any, i: number): string {
  const key = memKey(e, i);
  const used = memUsed(e);
  const pct = e.total > 0 ? Math.round((used / e.total) * 100) : 0;
  const flagStr = e.mem_type !== "gc" ? decodeUmaFlags(e.flags) : "";

  const label =
    e.mem_type === "gc"
      ? "GC Heap"
      : `UMA Pool ${i}` + (flagStr ? ` (${flagStr})` : "");

  let details =
    `<div class="mem-row"><span>Used / Total</span><span>${formatBytes(used)} / ${formatBytes(e.total)} (${pct}%)</span></div>` +
    `<div class="mem-row"><span>Free</span><span>${formatBytes(e.free)}</span></div>`;

  if (e.mem_type !== "gc") {
    details +=
      `<div class="mem-row"><span>Persist</span><span>${formatBytes(e.persist)}</span></div>` +
      `<div class="mem-row"><span>Peak</span><span>${formatBytes(e.peak)}</span></div>`;
  }

  return (
    `<div class="mem-card">` +
    `<div class="mem-card-header">${label}</div>` +
    `<canvas class="mem-graph" id="mem-graph-${key}" width="300" height="80"></canvas>` +
    details +
    `</div>`
  );
}

function drawMemGraph(
  canvas: HTMLCanvasElement,
  history: { used: number; total: number }[],
  peak: number = 0,
) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;

  canvas.width = w * dpr;
  canvas.height = h * dpr;

  const ctx = canvas.getContext("2d")!;

  ctx.scale(dpr, dpr);

  ctx.fillStyle =
    getComputedStyle(canvas).getPropertyValue("--bg-deep").trim() || "#0a0a0c";
  ctx.fillRect(0, 0, w, h);

  if (history.length < 2) {
    return;
  }

  const maxTotal = Math.max(...history.map((s) => s.total));

  if (maxTotal === 0) {
    return;
  }

  // Grid lines at 25%, 50%, 75%
  ctx.strokeStyle = "rgba(255,255,255,0.05)";
  ctx.lineWidth = 1;

  for (const frac of [0.25, 0.5, 0.75]) {
    const y = h - frac * h;

    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  // Total line (dimmed)
  ctx.strokeStyle = "rgba(255,255,255,0.15)";
  ctx.lineWidth = 1;
  ctx.beginPath();

  for (let i = 0; i < history.length; i++) {
    const x = (i / (MEM_HISTORY_MAX - 1)) * w;
    const y = h - (history[i].total / maxTotal) * h;

    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  }

  ctx.stroke();

  // Used fill
  ctx.beginPath();

  for (let i = 0; i < history.length; i++) {
    const x = (i / (MEM_HISTORY_MAX - 1)) * w;
    const y = h - (history[i].used / maxTotal) * h;

    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  }

  const lastX = ((history.length - 1) / (MEM_HISTORY_MAX - 1)) * w;

  ctx.lineTo(lastX, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fillStyle = "rgba(91,156,245,0.2)";
  ctx.fill();

  // Used line
  ctx.strokeStyle = "#5b9cf5";
  ctx.lineWidth = 1.5;
  ctx.beginPath();

  for (let i = 0; i < history.length; i++) {
    const x = (i / (MEM_HISTORY_MAX - 1)) * w;
    const y = h - (history[i].used / maxTotal) * h;

    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  }

  ctx.stroke();

  // Peak line
  if (peak > 0 && peak < maxTotal * 0.95) {
    const peakY = h - (peak / maxTotal) * h;

    ctx.strokeStyle = "rgba(240,85,85,0.5)";
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(0, peakY);
    ctx.lineTo(w, peakY);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = "rgba(240,85,85,0.7)";
    ctx.font = "9px " + (getComputedStyle(canvas).fontFamily || "monospace");
    ctx.textAlign = "right";
    ctx.fillText("peak", w - 2, peakY - 3);
    ctx.textAlign = "start";
  }
}

function memUsed(e: any): number {
  return e.used + e.persist;
}

function memKey(e: any, i?: number): string {
  return e.mem_type === "gc" ? "gc" : `uma_${i ?? 0}`;
}

function decodeUmaFlags(flags: number): string {
  const names = UMA_FLAG_NAMES.filter(([bit]) => flags & bit).map(
    ([, name]) => name,
  );

  return names.length > 0 ? names.join("|") : "";
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }

  if (bytes >= 1024) {
    return (bytes / 1024).toFixed(1) + " KB";
  }
  return bytes + " B";
}

// --- Protocol stats ---

const PROTO_STAT_KEYS = [
  "sent", "received", "checksum", "sequence",
  "retransmit", "transport", "sent_events", "max_ack_queue_depth",
];

const PROTO_STAT_LABELS = [
  "Sent", "Received", "Checksum Errors", "Sequence Errors",
  "Retransmits", "Transport Errors", "Events Sent", "Max ACK Queue",
];

let protoPollTimer: number | null = null;
let protoPollInFlight = false;
let protoPollInterval = 500;
let protoBuilt = false;

export function startProtoPolling() {
  stopProtoPolling();
  fetchProtoStats();
  protoPollTimer = window.setInterval(fetchProtoStats, protoPollInterval);
}

export function stopProtoPolling() {
  if (protoPollTimer !== null) {
    clearInterval(protoPollTimer);
    protoPollTimer = null;
  }
}

export function resetProtoState() {
  protoBuilt = false;

  const content = document.getElementById("proto-content");

  if (content) {
    content.innerHTML =
      '<div style="padding:8px;color:var(--text-muted)">Connect to view protocol stats</div>';
  }
}

async function fetchProtoStats() {
  if (!state.isConnected) {
    return;
  }

  if (protoPollInFlight) {
    return;
  }

  protoPollInFlight = true;

  try {
    const result = await invoke<any>("cmd_get_stats");
    const content = document.getElementById("proto-content");

    if (!content) {
      return;
    }

    if (!protoBuilt) {
      buildProtoDom(content, result.channels);
    }

    const s = result.stats;

    for (const key of PROTO_STAT_KEYS) {
      const el = document.getElementById(`proto-${key}`);

      if (el) {
        el.textContent = s[key];
      }
    }
  } catch {
    const content = document.getElementById("proto-content");

    if (content) {
      content.innerHTML =
        '<div style="padding:8px;color:var(--text-muted)">Failed to read stats</div>';
    }

    protoBuilt = false;
  } finally {
    protoPollInFlight = false;
  }
}

function buildProtoDom(
  content: HTMLElement,
  channels: { name: string; id: number }[],
) {
  let html = '<div class="proto-section-label">Statistics</div>';

  for (let i = 0; i < PROTO_STAT_LABELS.length; i++) {
    html += `<div class="proto-row"><span>${PROTO_STAT_LABELS[i]}</span><span id="proto-${PROTO_STAT_KEYS[i]}">0</span></div>`;
  }

  html += '<div class="proto-section-label">Channels</div>';

  channels.sort((a, b) => a.id - b.id);
  for (const ch of channels) {
    html += `<div class="proto-row"><span>${ch.name}</span><span>${ch.id}</span></div>`;
  }

  content.innerHTML = html;
  protoBuilt = true;
}

// --- Histogram ---

const histCanvas = document.getElementById("hist-canvas") as HTMLCanvasElement;
const histMean = document.getElementById("hist-mean")!;
const histMedian = document.getElementById("hist-median")!;
const histStdev = document.getElementById("hist-stdev")!;
const histMin = document.getElementById("hist-min")!;
const histMax = document.getElementById("hist-max")!;
const histMode = document.getElementById("hist-mode")!;

let histReadback = new Uint8Array(0);

export function updateHistogram(format: number, frameBuf: ArrayBuffer) {
  if (!isHistTabActive()) {
    return;
  }

  const glW = wglWidth();
  const glH = wglHeight();

  if (frameBuf.byteLength === 0 || glW === 0 || glH === 0) {
    return;
  }

  const rect = histCanvas.getBoundingClientRect();
  const w = rect.width;
  const h = rect.height;

  if (w === 0 || h === 0) {
    return;
  }

  const isRGB565 = format === 0x0c030002;
  const isGray = format === 0x08020001;
  const isJPEG = format === 0x06060000;
  const binCount = isRGB565 ? 32 : 256;

  const binsR = new Uint32Array(binCount);
  const binsG = new Uint32Array(binCount);
  const binsB = new Uint32Array(binCount);
  const binsL = new Uint32Array(256);
  let n = 0;

  if (isRGB565) {
    const px = new Uint16Array(frameBuf, 0, glW * glH);

    n = px.length;

    for (let i = 0; i < n; i++) {
      const v = px[i];
      const r5 = (v >> 11) & 0x1f;
      const g6 = (v >> 5) & 0x3f;
      const b5 = v & 0x1f;

      binsR[r5]++;
      binsG[g6 >> 1]++;
      binsB[b5]++;

      const r8 = ((r5 * 255) / 31) | 0;
      const g8 = ((g6 * 255) / 63) | 0;
      const b8 = ((b5 * 255) / 31) | 0;

      binsL[(r8 * 77 + g8 * 150 + b8 * 29) >> 8]++;
    }
  } else if (isGray) {
    const px = new Uint8Array(frameBuf, 0, glW * glH);

    n = px.length;

    for (let i = 0; i < n; i++) {
      binsR[px[i]]++;
      binsL[px[i]]++;
    }
  } else if (isJPEG) {
    const gl = wglCtx();
    const needed = glW * glH * 4;

    if (histReadback.length < needed) {
      histReadback = new Uint8Array(needed);
    }

    gl.readPixels(0, 0, glW, glH, gl.RGBA, gl.UNSIGNED_BYTE, histReadback);

    n = histReadback.length / 4;

    for (let i = 0; i < histReadback.length; i += 4) {
      binsR[histReadback[i]]++;
      binsG[histReadback[i + 1]]++;
      binsB[histReadback[i + 2]]++;
      binsL[(histReadback[i] * 77 + histReadback[i + 1] * 150 + histReadback[i + 2] * 29) >> 8]++;
    }
  }

  if (n === 0) {
    return;
  }

  drawHistogram(w, h, binsR, binsG, binsB, binsL, n, isGray);
}

function drawHistogram(
  w: number,
  h: number,
  binsR: Uint32Array,
  binsG: Uint32Array,
  binsB: Uint32Array,
  binsL: Uint32Array,
  n: number,
  isGray: boolean,
) {
  const dpr = window.devicePixelRatio || 1;

  histCanvas.width = Math.round(w * dpr);
  histCanvas.height = Math.round(h * dpr);

  const hctx = histCanvas.getContext("2d")!;

  hctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const channels: [Uint32Array, string][] = isGray
    ? [[binsR, "rgba(180,190,200,0.5)"]]
    : [
        [binsR, "rgba(240,85,85,0.5)"],
        [binsG, "rgba(78,201,98,0.5)"],
        [binsB, "rgba(91,156,245,0.5)"],
      ];

  let maxVal = 1;

  for (const [bins] of channels) {
    for (let i = 0; i < bins.length; i++) {
      if (bins[i] > maxVal) {
        maxVal = bins[i];
      }
    }
  }

  for (const [bins, color] of channels) {
    const bc = bins.length;
    let draw: ArrayLike<number> = bins;

    // Smooth 256-bin histograms to avoid thin spikes
    if (bc === 256) {
      const sm = new Float32Array(256);

      sm[0] = (bins[0] * 2 + bins[1]) / 3;
      sm[255] = (bins[254] + bins[255] * 2) / 3;

      for (let i = 1; i < 255; i++) {
        sm[i] = (bins[i - 1] + bins[i] * 2 + bins[i + 1]) / 4;
      }

      draw = sm;
    }

    hctx.beginPath();
    hctx.moveTo(0, h);

    for (let i = 0; i < bc; i++) {
      const x = ((i + 0.5) * w) / bc;
      const y = h - (draw[i] / maxVal) * h;

      if (i === 0) {
        hctx.lineTo(0, y);
      }

      hctx.lineTo(x, y);

      if (i === bc - 1) {
        hctx.lineTo(w, y);
      }
    }

    hctx.lineTo(w, h);
    hctx.closePath();
    hctx.fillStyle = color;
    hctx.fill();
  }

  // Luminance stats
  let sum = 0;
  let min = 255;
  let max = 0;
  let modeVal = 0;
  let modeCount = 0;

  for (let i = 0; i < 256; i++) {
    sum += i * binsL[i];

    if (binsL[i] > 0 && i < min) {
      min = i;
    }

    if (binsL[i] > 0 && i > max) {
      max = i;
    }

    if (binsL[i] > modeCount) {
      modeCount = binsL[i];
      modeVal = i;
    }
  }

  const mean = sum / n;

  let cumul = 0;
  let median = 0;

  for (let i = 0; i < 256; i++) {
    cumul += binsL[i];

    if (cumul >= n / 2) {
      median = i;
      break;
    }
  }

  let variance = 0;

  for (let i = 0; i < 256; i++) {
    variance += binsL[i] * (i - mean) * (i - mean);
  }

  const stdev = Math.sqrt(variance / n);

  histMean.textContent = mean.toFixed(1);
  histMedian.textContent = median.toString();
  histStdev.textContent = stdev.toFixed(1);
  histMin.textContent = n > 0 ? min.toString() : "--";
  histMax.textContent = n > 0 ? max.toString() : "--";
  histMode.textContent = n > 0 ? modeVal.toString() : "--";
}

// --- Examples tree ---

export let examplesLoaded = false;

export async function loadExamples() {
  if (examplesLoaded) {
    return;
  }

  const container = document.getElementById("examples-tree");

  if (!container) {
    return;
  }

  container.innerHTML =
    '<div style="padding:8px;color:var(--text-tertiary)">Loading...</div>';

  try {
    const args: Record<string, any> = {};

    if (state.filterExamples && state.connectedBoard) {
      args.board = state.connectedBoard;
    }

    if (state.filterExamples && state.connectedSensor) {
      args.sensor = state.connectedSensor;
    }

    const tree = await invoke<any[]>("cmd_list_examples", args);

    container.innerHTML = "";

    if (!tree || tree.length === 0) {
      container.innerHTML =
        '<div style="padding:8px;color:var(--text-muted)">No examples found</div>';
      return;
    }

    renderTree(container, tree, 0);
    examplesLoaded = true;
  } catch (e: any) {
    container.innerHTML = `<div style="padding:8px;color:var(--accent-red)">Error: ${String(e)}</div>`;
  }
}

export function resetExamples() {
  examplesLoaded = false;
}

export function clearExamplesTree() {
  const exTree = document.getElementById("examples-tree");

  if (exTree) {
    exTree.innerHTML =
      '<div style="padding:8px;color:var(--text-muted)">Connect to load examples</div>';
  }
}

function renderTree(parent: HTMLElement, nodes: any[], depth: number) {
  for (const node of nodes) {
    if (node.type === "dir") {
      const section = document.createElement("div");

      section.className = "tree-section";

      const header = document.createElement("div");

      header.className = "tree-section-header";
      header.style.paddingLeft = 8 + depth * 12 + "px";
      header.innerHTML = `<svg class="tree-arrow" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg> ${node.name}`;

      const children = document.createElement("div");

      children.className = "tree-children";
      children.style.display = "none";
      renderTree(children, node.children, depth + 1);

      header.classList.add("collapsed");
      header.addEventListener("click", () => {
        header.classList.toggle("collapsed");
        children.style.display =
          children.style.display === "none" ? "" : "none";
      });

      section.appendChild(header);
      section.appendChild(children);
      parent.appendChild(section);
    } else {
      const item = document.createElement("div");

      item.className = "tree-item";
      item.style.paddingLeft = 8 + (depth + 1) * 12 + "px";
      item.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z"/><polyline points="13 2 13 9 20 9"/></svg> <span>${node.name}</span>`;
      item.addEventListener("click", async () => {
        try {
          const content = await invoke<string>("cmd_read_file", {
            path: node.path,
          });

          hideWelcome();
          createFile(node.path, content, true);
          switchToFile(openFiles.length - 1);
          closeSidePanel();
        } catch (e) {
          console.error("Failed to open example:", e);
        }
      });

      parent.appendChild(item);
    }
  }
}

// --- Sidebar navigation ---

const layout = document.querySelector(".ide-layout") as HTMLElement;
const sidePanel = document.getElementById("side-panel")!;
let activePanelName: string | null = null;

export function closeSidePanel() {
  document
    .querySelectorAll(".sidebar-btn[data-panel]")
    .forEach((b) => b.classList.remove("active"));
  sidePanel.classList.remove("visible");
  layout.style.gridTemplateColumns = "56px 0px 1fr 4px 40%";
  activePanelName = null;
}

function initSidebar() {
  document.querySelectorAll(".sidebar-btn[data-panel]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const panel = (btn as HTMLElement).dataset.panel!;

      if (panel === "docs") {
        openDocsWindow();
        return;
      }

      if (activePanelName === panel) {
        closeSidePanel();
      } else {
        document
          .querySelectorAll(".sidebar-btn[data-panel]")
          .forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");

        document
          .querySelectorAll(".side-panel-content")
          .forEach((p) => ((p as HTMLElement).style.display = "none"));

        const content = sidePanel.querySelector(
          `[data-panel="${panel}"]`,
        ) as HTMLElement;

        if (content) {
          content.style.display = "";
        }

        sidePanel.classList.add("visible");
        layout.style.gridTemplateColumns = "56px 220px 1fr 4px 40%";
        activePanelName = panel;
      }
    });
  });
}

async function openDocsWindow() {
  await invoke("cmd_open_url", { url: "https://docs.openmv.io/" });
}

// --- Info tab ---

export function populateInfoTab(sysinfo: any, version: any, port: string) {
  const el = document.getElementById("info-content");

  if (!el) {
    return;
  }

  const ver = (a: number[]) => `${a[0]}.${a[1]}.${a[2]}`;
  const hex = (n: number) => n.toString(16).toUpperCase();
  const sensors = sysinfo.sensors.map((s: any) => s.name).join(", ") || "--";
  const kb = (n: number) => (n ? `${n} KB` : "--");
  const yn = (b: boolean) => (b ? "Yes" : "No");

  const rows: [string, string][] = [
    ["Board", sysinfo.board_name],
    ["Sensor", sensors],
    ["Port", port],
    ["Firmware", ver(version.firmware)],
    ["Protocol", ver(version.protocol)],
    ["Bootloader", ver(version.bootloader)],
    ["CPU ID", `0x${hex(sysinfo.cpu_id)}`],
    ["USB", `${hex(sysinfo.usb_vid)}:${hex(sysinfo.usb_pid)}`],
    ["Stream Buffer", kb(sysinfo.stream_buffer_size_kb)],
    ["GPU", yn(sysinfo.gpu_present)],
    ["NPU", yn(sysinfo.npu_present)],
    ["ISP", yn(sysinfo.isp_present)],
    ["Video Encoder", yn(sysinfo.venc_present)],
    ["JPEG", yn(sysinfo.jpeg_present)],
    ["DRAM", yn(sysinfo.dram_present)],
    ["CRC", yn(sysinfo.crc_present)],
    [
      "PMU",
      sysinfo.pmu_present ? `Yes (${sysinfo.pmu_eventcnt} counters)` : "No",
    ],
    ["WiFi", yn(sysinfo.wifi_present)],
    ["Bluetooth", yn(sysinfo.bt_present)],
    ["SD Card", yn(sysinfo.sd_present)],
    ["Ethernet", yn(sysinfo.eth_present)],
    ["USB High Speed", yn(sysinfo.usb_highspeed)],
    ["Multicore", yn(sysinfo.multicore_present)],
  ];

  el.innerHTML = rows
    .map(
      ([label, val]) =>
        `<div class="info-row"><span class="info-label">${label}</span><span class="info-val">${val}</span></div>`,
    )
    .join("");
}

export function clearInfoTab() {
  const el = document.getElementById("info-content");

  if (el) {
    el.innerHTML =
      '<div style="padding:8px;color:var(--text-muted)">Connect to view board info</div>';
  }
}

// --- Sensor select ---

export function populateSensorSelect(sensors: { chip_id: number; name: string }[]) {
  const select = document.getElementById("fb-source") as HTMLSelectElement;

  select.innerHTML = "";

  if (sensors.length === 0) {
    const opt = document.createElement("option");

    opt.value = "";
    opt.textContent = "No sensor";
    select.appendChild(opt);
    select.disabled = true;
    state.connectedSensor = null;
    return;
  }

  select.disabled = false;

  for (const s of sensors) {
    const opt = document.createElement("option");

    opt.value = s.chip_id.toString();
    opt.textContent = s.name;
    select.appendChild(opt);
  }

  state.connectedSensor = sensors[0].name;
}
