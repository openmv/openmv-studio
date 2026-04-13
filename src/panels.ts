// Right-panel tools: memory stats, protocol stats, histogram,
// examples tree, sidebar navigation, and board info tab.

import { invoke } from "@tauri-apps/api/core";
import { decode as cborDecode } from "cbor-x";
import { DataChannel } from "./channel";
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

      if (tool === "channels") {
        startChannelsPolling();
      } else {
        stopChannelsPolling();
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

  // Channels poll rate slider
  const chSlider = document.getElementById("ch-poll-slider") as HTMLInputElement;
  const chLabel = document.getElementById("ch-poll-value")!;

  chSlider?.addEventListener("input", () => {
    chPollInterval = parseInt(chSlider.value, 10);
    chLabel.textContent = `${chPollInterval} ms`;

    if (chPollTimer !== null) {
      startChannelsPolling();
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

export function isChannelsTabActive(): boolean {
  const tab = document.querySelector('.tools-tab[data-tool="channels"]');
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
let memPollInterval = 500;

const memChannel = new DataChannel();

memChannel.onmessage = (raw: ArrayBuffer) => {
  const content = document.getElementById("memory-content");

  if (!content || !state.isConnected || raw.byteLength < 4) {
    return;
  }

  const view = new DataView(raw);
  const count = view.getUint8(0);
  const entries: any[] = [];

  for (let i = 0; i < count; i++) {
    const o = 4 + i * 24;

    if (o + 24 > raw.byteLength) {
      break;
    }

    const memType = view.getUint8(o) === 0 ? "gc" : "uma";
    const flags = view.getUint16(o + 2, true);
    const total = view.getUint32(o + 4, true);
    const used = view.getUint32(o + 8, true);
    const free = view.getUint32(o + 12, true);
    const persist = view.getUint32(o + 16, true);
    const peak = view.getUint32(o + 20, true);

    entries.push({ mem_type: memType, flags, total, used, free, persist, peak });
  }

  updateMemUi(content, entries);
};

export function startMemPolling(delay = 0) {
  stopMemPolling();

  const poll = () => memChannel.request("cmd_get_memory");

  if (delay > 0) {
    memPollTimer = window.setTimeout(() => {
      poll();
      memPollTimer = window.setInterval(poll, memPollInterval);
    }, delay);
  } else {
    poll();
    memPollTimer = window.setInterval(poll, memPollInterval);
  }
}

export function stopMemPolling() {
  if (memPollTimer !== null) {
    clearInterval(memPollTimer);
    memPollTimer = null;
  }

  memChannel.reset();
}

export function resetMemGraphCache() {
  cachedBgDeep = "";
  cachedFont = "";
}

export function resetMemState() {
  memHistory.clear();
  memPeak.clear();
  resetMemGraphCache();

  const content = document.getElementById("memory-content");

  if (content) {
    content.innerHTML =
      '<div style="padding:8px;color:var(--text-muted)">Connect to view memory</div>';
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

// Cached style values to avoid getComputedStyle per frame.
let cachedBgDeep = "";
let cachedFont = "";

function drawMemGraph(
  canvas: HTMLCanvasElement,
  history: { used: number; total: number }[],
  peak: number = 0,
) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const bw = Math.round(w * dpr);
  const bh = Math.round(h * dpr);

  const ctx = canvas.getContext("2d")!;

  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
    ctx.scale(dpr, dpr);
  } else {
    ctx.clearRect(0, 0, w, h);
  }

  if (!cachedBgDeep) {
    const cs = getComputedStyle(canvas);
    cachedBgDeep = cs.getPropertyValue("--bg-deep").trim() || "#0a0a0c";
    cachedFont = "9px " + (cs.fontFamily || "monospace");
  }

  ctx.fillStyle = cachedBgDeep;
  ctx.fillRect(0, 0, w, h);

  if (history.length < 2) {
    return;
  }

  let maxTotal = 0;
  for (let i = 0; i < history.length; i++) {
    if (history[i].total > maxTotal) {
      maxTotal = history[i].total;
    }
  }

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

  // Build used path once, use for both fill and stroke.
  const usedPath = new Path2D();
  const fillPath = new Path2D();
  let lastX = 0;

  for (let i = 0; i < history.length; i++) {
    const x = (i / (MEM_HISTORY_MAX - 1)) * w;
    const y = h - (history[i].used / maxTotal) * h;

    if (i === 0) {
      usedPath.moveTo(x, y);
      fillPath.moveTo(x, y);
    } else {
      usedPath.lineTo(x, y);
      fillPath.lineTo(x, y);
    }
    lastX = x;
  }

  fillPath.lineTo(lastX, h);
  fillPath.lineTo(0, h);
  fillPath.closePath();

  ctx.fillStyle = "rgba(91,156,245,0.2)";
  ctx.fill(fillPath);

  ctx.strokeStyle = "#5b9cf5";
  ctx.lineWidth = 1.5;
  ctx.stroke(usedPath);

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
    ctx.font = cachedFont;
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
let protoPollInterval = 500;
let protoBuilt = false;

const statsChannel = new DataChannel();

statsChannel.onmessage = (raw: ArrayBuffer) => {
  const content = document.getElementById("proto-content");

  if (!content || !state.isConnected || raw.byteLength < 36) {
    return;
  }

  const view = new DataView(raw);

  // Parse 8 x u32 stat fields
  const stats: Record<string, number> = {};

  for (let i = 0; i < PROTO_STAT_KEYS.length; i++) {
    stats[PROTO_STAT_KEYS[i]] = view.getUint32(i * 4, true);
  }

  // Parse channel list at offset 32
  const chCount = view.getUint8(32);
  const channels: { name: string; id: number }[] = [];

  for (let i = 0; i < chCount; i++) {
    const o = 36 + i * 16;

    if (o + 16 > raw.byteLength) {
      break;
    }

    const id = view.getUint8(o);
    // name is 14 bytes at o+2, null-padded
    const nameBytes = new Uint8Array(raw, o + 2, 14);
    let nameLen = 0;

    while (nameLen < 14 && nameBytes[nameLen] !== 0) {
      nameLen++;
    }

    const name = new TextDecoder().decode(nameBytes.subarray(0, nameLen));

    channels.push({ name, id });
  }

  if (!protoBuilt) {
    buildProtoDom(content, channels);
  }

  for (const key of PROTO_STAT_KEYS) {
    const el = document.getElementById(`proto-${key}`);

    if (el) {
      el.textContent = String(stats[key]);
    }
  }
};

export function startProtoPolling() {
  stopProtoPolling();

  const poll = () => statsChannel.request("cmd_get_stats");

  poll();
  protoPollTimer = window.setInterval(poll, protoPollInterval);
}

export function stopProtoPolling() {
  if (protoPollTimer !== null) {
    clearInterval(protoPollTimer);
    protoPollTimer = null;
  }

  statsChannel.reset();
}

export function resetProtoState() {
  protoBuilt = false;

  const content = document.getElementById("proto-content");

  if (content) {
    content.innerHTML =
      '<div style="padding:8px;color:var(--text-muted)">Connect to view protocol stats</div>';
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

// --- Channels ---

// SenML-compatible CBOR integer keys
const CBOR_KEY_BN = -2;  // base name
const CBOR_KEY_N = 0;    // name
const CBOR_KEY_U = 1;    // unit
const CBOR_KEY_V = 2;    // numeric value
const CBOR_KEY_VS = 3;   // string value
const CBOR_KEY_VB = 4;   // boolean value
const CBOR_KEY_VD = 8;   // data value (binary)

// Custom 2D data extension keys
const CBOR_KEY_W = -20;    // width
const CBOR_KEY_H = -21;    // height
const CBOR_KEY_FMT = -22;  // format
const CBOR_KEY_MIN = -23;  // min
const CBOR_KEY_MAX = -24;  // max

let chPollTimer: number | null = null;
let chPollInterval = 500;


const chChannel = new DataChannel();

chChannel.onmessage = (raw: ArrayBuffer) => {
  const content = document.getElementById("channels-content");

  if (!content || !state.isConnected || raw.byteLength < 4) {
    return;
  }

  const view = new DataView(raw);
  const count = view.getUint8(0);

  if (count === 0) {
    content.innerHTML =
      '<div style="padding:8px;color:var(--text-muted)">No custom channels</div>';

    return;
  }

  const channels: { name: string; data: number[] }[] = [];
  let offset = 4;

  for (let i = 0; i < count; i++) {
    if (offset >= raw.byteLength) {
      break;
    }

    const nameLen = view.getUint8(offset);

    offset += 1;
    const name = new TextDecoder().decode(new Uint8Array(raw, offset, nameLen));

    offset += nameLen;
    const dataLen = view.getUint32(offset, true);

    offset += 4;
    const data = Array.from(new Uint8Array(raw, offset, dataLen));

    offset += dataLen;
    channels.push({ name, data });
  }

  renderChannels(content, channels);
};

export function startChannelsPolling() {
  stopChannelsPolling();

  const poll = () => chChannel.request("cmd_get_channels");

  poll();
  chPollTimer = window.setInterval(poll, chPollInterval);
}

export function stopChannelsPolling() {
  if (chPollTimer !== null) {
    clearInterval(chPollTimer);
    chPollTimer = null;
  }

  chChannel.reset();
}

export function resetChannelsState() {

  const content = document.getElementById("channels-content");

  if (content) {
    content.innerHTML =
      '<div style="padding:8px;color:var(--text-muted)">Connect to view channels</div>';
  }
}

function renderChannels(
  content: HTMLElement,
  channels: { name: string; data: number[] }[],
) {
  channels.sort((a, b) => a.name.localeCompare(b.name));
  let html = "";

  for (const ch of channels) {
    html += `<div class="ch-channel-label">${ch.name}</div>`;

    const bytes = new Uint8Array(ch.data);
    let records: any[];

    try {
      records = cborDecode(bytes) as any[];
    } catch {
      html += '<div class="ch-record"><span class="ch-record-name">decode error</span></div>';
      continue;
    }

    if (!Array.isArray(records)) {
      html += '<div class="ch-record"><span class="ch-record-name">unexpected format</span></div>';
      continue;
    }

    let baseName = "";

    for (const rec of records) {
      if (rec[CBOR_KEY_BN] !== undefined) {
        baseName = rec[CBOR_KEY_BN];
      }

      const name = baseName + (rec[CBOR_KEY_N] || "");

      if (rec[CBOR_KEY_V] !== undefined) {
        // Scalar value
        const val = rec[CBOR_KEY_V];
        const unit = rec[CBOR_KEY_U] || "";
        html += `<div class="ch-record">` +
          `<span class="ch-record-name">${name}</span>` +
          `<span><span class="ch-record-value">${typeof val === "number" ? val.toFixed(1) : val}</span>` +
          `<span class="ch-record-unit">${unit}</span></span></div>`;
      } else if (rec[CBOR_KEY_VS] !== undefined) {
        // String value
        html += `<div class="ch-record">` +
          `<span class="ch-record-name">${name}</span>` +
          `<span class="ch-record-value">${rec[CBOR_KEY_VS]}</span></div>`;
      } else if (rec[CBOR_KEY_VB] !== undefined) {
        // Boolean value
        html += `<div class="ch-record">` +
          `<span class="ch-record-name">${name}</span>` +
          `<span class="ch-record-value">${rec[CBOR_KEY_VB] ? "true" : "false"}</span></div>`;
      } else if (rec[CBOR_KEY_VD] !== undefined) {
        // Binary data
        const fmt = rec[CBOR_KEY_FMT];
        const w = rec[CBOR_KEY_W];
        const h = rec[CBOR_KEY_H];

        if (fmt === "depth" && w && h) {
          const vmin = rec[CBOR_KEY_MIN] || 0;
          const vmax = rec[CBOR_KEY_MAX] || 1;
          const id = `ch-depth-${name.replace(/[^a-zA-Z0-9]/g, "_")}`;
          html += `<div class="ch-record" style="flex-direction:column;align-items:stretch">` +
            `<span class="ch-record-name">${name} (${w}x${h}, ${vmin.toFixed(0)}-${vmax.toFixed(0)}mm)</span>` +
            `<canvas class="ch-depth-canvas" id="${id}" width="${w}" height="${h}"></canvas></div>`;
        } else if (fmt === "jpeg" || fmt === "rgb565" || fmt === "grayscale") {
          html += `<div class="ch-record">` +
            `<span class="ch-record-name">${name} (${fmt} ${w}x${h})</span></div>`;
        } else {
          const data = rec[CBOR_KEY_VD] as Uint8Array;
          html += `<div class="ch-record">` +
            `<span class="ch-record-name">${name}</span>` +
            `<span class="ch-record-value">${data.length} bytes</span></div>`;
        }
      }
    }
  }

  content.innerHTML = html;

  // Second pass: draw depth canvases
  for (const ch of channels) {
    const bytes = new Uint8Array(ch.data);
    let records: any[];

    try {
      records = cborDecode(bytes) as any[];
    } catch {
      continue;
    }

    if (!Array.isArray(records)) {
      continue;
    }

    let baseName = "";

    for (const rec of records) {
      if (rec[CBOR_KEY_BN] !== undefined) {
        baseName = rec[CBOR_KEY_BN];
      }

      if (rec[CBOR_KEY_VD] === undefined || rec[CBOR_KEY_FMT] !== "depth") {
        continue;
      }

      const name = baseName + (rec[CBOR_KEY_N] || "");
      const w = rec[CBOR_KEY_W];
      const h = rec[CBOR_KEY_H];
      const vmin = rec[CBOR_KEY_MIN] || 0;
      const vmax = rec[CBOR_KEY_MAX] || 1;
      const data = rec[CBOR_KEY_VD] as Uint8Array;
      const id = `ch-depth-${name.replace(/[^a-zA-Z0-9]/g, "_")}`;
      const canvas = document.getElementById(id) as HTMLCanvasElement | null;

      if (canvas) {
        drawDepthMap(canvas, data, w, h, vmin, vmax);
      }
    }
  }
}

// Attempt to reproduce the Turbo colormap by Anton Mikhailov (Google).
// 6-stop linear gradient: red (close) -> yellow -> green -> cyan -> blue -> dark blue (far).
const TURBO_STOPS: [number, number, number, number][] = [
  [0.00, 200, 36, 12],
  [0.20, 252, 192, 12],
  [0.40, 100, 236, 28],
  [0.60, 24, 220, 180],
  [0.80, 40, 120, 252],
  [1.00, 24, 32, 112],
];

function turboColor(t: number): [number, number, number] {
  let i = 0;

  while (i < TURBO_STOPS.length - 2 && t > TURBO_STOPS[i + 1][0]) {
    i++;
  }

  const [t0, r0, g0, b0] = TURBO_STOPS[i];
  const [t1, r1, g1, b1] = TURBO_STOPS[i + 1];
  const f = (t - t0) / (t1 - t0);

  return [
    Math.round(r0 + f * (r1 - r0)),
    Math.round(g0 + f * (g1 - g0)),
    Math.round(b0 + f * (b1 - b0)),
  ];
}

function drawDepthMap(
  canvas: HTMLCanvasElement,
  data: Uint8Array,
  w: number,
  h: number,
  vmin: number,
  vmax: number,
) {
  const ctx = canvas.getContext("2d");

  if (!ctx) {
    return;
  }

  canvas.width = w;
  canvas.height = h;

  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const nFloats = data.byteLength >> 2;
  const img = ctx.createImageData(w, h);
  const range = vmax - vmin || 1;

  for (let i = 0; i < nFloats && i < w * h; i++) {
    const t = Math.max(0, Math.min(1, (dv.getFloat32(i * 4, true) - vmin) / range));

    // Turbo-style palette: dark blue (close) -> cyan -> green -> yellow -> red (far)
    const [r, g, b] = turboColor(t);

    img.data[i * 4] = r;
    img.data[i * 4 + 1] = g;
    img.data[i * 4 + 2] = b;
    img.data[i * 4 + 3] = 255;
  }

  ctx.putImageData(img, 0, 0);
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
