// Draggable resize handles for the IDE layout panels.
// Handles horizontal (editor/right-panel), vertical (editor/terminal),
// and vertical (framebuffer/tools) splits with snap-to-align behavior.

import { state, scheduleSaveSettings } from "./state";

// Distance in pixels at which panels snap to align
const SNAP_PX = 15;

const layout = document.querySelector(".ide-layout") as HTMLElement;
const mainArea = document.querySelector(".main-area") as HTMLElement;
const sidePanel = document.getElementById("side-panel")!;

export function initResize() {
  initHorizontalResize();
  initVerticalResize();
  initFbToolsResize();
}

// --- Horizontal: between editor area and right panel ---

function initHorizontalResize() {
  setupHandle("resize-h", "col", (delta) => {
    const rp = document.querySelector(".right-panel") as HTMLElement;
    const w = Math.max(
      200,
      Math.min(800, rp.getBoundingClientRect().width / state.uiScale - delta),
    );
    const spW = sidePanel.classList.contains("visible") ? "220px" : "0px";

    layout.style.gridTemplateColumns = `56px ${spW} 1fr 4px ${w}px`;
  });
}

// --- Vertical: between editor and terminal ---

function initVerticalResize() {
  const handle = document.getElementById("resize-v");

  if (!handle) {
    return;
  }

  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    handle.classList.add("active");

    const tp = document.querySelector(".terminal-panel") as HTMLElement;
    const startY = e.clientY / state.uiScale;
    const startH = tp.getBoundingClientRect().height / state.uiScale;
    const maBottom = mainArea.getBoundingClientRect().bottom / state.uiScale;

    const onMove = (ev: MouseEvent) => {
      const delta = startY - ev.clientY / state.uiScale;
      let h = Math.max(60, Math.min(600, startH + delta));

      const termTop = maBottom - h;
      const toolsTop = getToolsTopY();

      if (Math.abs(termTop - toolsTop) < SNAP_PX) {
        h = maBottom - toolsTop;
      }

      mainArea.style.gridTemplateRows = `32px 1fr 4px ${h}px`;
    };

    const onUp = () => {
      handle.classList.remove("active");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      scheduleSaveSettings();
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

// --- Vertical: between framebuffer and tools panel ---

function initFbToolsResize() {
  const handle = document.getElementById("resize-fb-hist");

  if (!handle) {
    return;
  }

  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    handle.classList.add("active");

    const fb = document.querySelector(".fb-section") as HTMLElement;
    const tools = document.querySelector(".tools-panel") as HTMLElement;
    const startY = e.clientY / state.uiScale;
    const startFbH = fb.getBoundingClientRect().height / state.uiScale;
    const startToolsH = tools.getBoundingClientRect().height / state.uiScale;
    const totalH = startFbH + startToolsH;

    const onMove = (e: MouseEvent) => {
      const delta = e.clientY / state.uiScale - startY;
      const fbH = Math.max(80, Math.min(totalH - 80, startFbH + delta));
      const toolsH = snapToolsToTerminal(totalH - fbH);
      const adjFbH = totalH - toolsH;

      fb.style.flex = "none";
      tools.style.flex = "none";
      fb.style.height = adjFbH + "px";
      tools.style.height = toolsH + "px";
    };

    const onUp = () => {
      handle.classList.remove("active");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      scheduleSaveSettings();
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

// --- Shared helpers ---

function setupHandle(
  handleId: string,
  axis: "col" | "row",
  onDelta: (delta: number) => void,
) {
  const handle = document.getElementById(handleId);

  if (!handle) {
    return;
  }

  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    handle.classList.add("active");

    const startPos = (axis === "col" ? e.clientX : e.clientY) / state.uiScale;
    let lastPos = startPos;

    const onMove = (e: MouseEvent) => {
      const pos = (axis === "col" ? e.clientX : e.clientY) / state.uiScale;
      onDelta(pos - lastPos);
      lastPos = pos;
    };

    const onUp = () => {
      handle.classList.remove("active");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      scheduleSaveSettings();
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

function getToolsTopY(): number {
  const tools = document.querySelector(".tools-panel") as HTMLElement;
  return tools.getBoundingClientRect().top / state.uiScale;
}

function getTerminalTopY(): number {
  const tp = document.querySelector(".terminal-panel") as HTMLElement;
  return tp.getBoundingClientRect().top / state.uiScale;
}

function snapToolsToTerminal(toolsH: number): number {
  const rp = document.querySelector(".right-panel") as HTMLElement;
  const rpRect = rp.getBoundingClientRect();
  const toolsTop = rpRect.bottom / state.uiScale - toolsH;
  const termTop = getTerminalTopY();

  if (Math.abs(toolsTop - termTop) < SNAP_PX) {
    return rpRect.bottom / state.uiScale - termTop;
  }

  return toolsH;
}
