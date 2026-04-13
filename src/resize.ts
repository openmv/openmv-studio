// Draggable resize handles for the IDE layout panels.
// Handles horizontal (editor/right-panel), vertical (editor/terminal),
// and vertical (framebuffer/tools) splits with snap-to-align behavior.

import { state, scheduleSaveSettings } from "./state";
import { wglWidth, wglHeight } from "./gl";

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

    // Capture fb/tools state for locked mode.
    const rp = document.querySelector(".right-panel") as HTMLElement;
    const fb = document.querySelector(".fb-section") as HTMLElement;
    const tools = document.querySelector(".tools-panel") as HTMLElement;
    const startFbH = fb.getBoundingClientRect().height / state.uiScale;
    const rpH = rp.getBoundingClientRect().height / state.uiScale;
    const fbHandleH = 4;

    const onMove = (ev: MouseEvent) => {
      const delta = startY - ev.clientY / state.uiScale;
      let h = Math.max(60, Math.min(600, startH + delta));

      if (!state.splitLocked) {
        const termTop = maBottom - h;
        const toolsTop = getToolsTopY();

        if (Math.abs(termTop - toolsTop) < SNAP_PX) {
          h = maBottom - toolsTop;
        }
      }

      const maH = mainArea.getBoundingClientRect().height / state.uiScale;
      const pct = (h / maH) * 100;

      mainArea.style.gridTemplateRows = `32px 1fr 4px ${pct}%`;

      if (state.splitLocked) {
        const fbH = Math.max(80, Math.min(rpH - fbHandleH - 80,
          startFbH - delta));
        const toolsH = rpH - fbH - fbHandleH;
        fb.style.flex = "none";
        tools.style.flex = "none";
        fb.style.height = (fbH / rpH) * 100 + "%";
        tools.style.height = (toolsH / rpH) * 100 + "%";
      }
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

    const rp = document.querySelector(".right-panel") as HTMLElement;
    const fb = document.querySelector(".fb-section") as HTMLElement;
    const tools = document.querySelector(".tools-panel") as HTMLElement;
    const startY = e.clientY / state.uiScale;
    const startFbH = fb.getBoundingClientRect().height / state.uiScale;
    const rpH = rp.getBoundingClientRect().height / state.uiScale;
    const rpTop = rp.getBoundingClientRect().top / state.uiScale;
    const handleH = 4;

    const headerH = (fb.querySelector(".fb-header")
      ?.getBoundingClientRect().height ?? 0) / state.uiScale;
    const vpW = (fb.querySelector(".fb-viewport")
      ?.getBoundingClientRect().width ?? 0) / state.uiScale;

    // Capture terminal state for locked mode.
    const tp = document.querySelector(".terminal-panel") as HTMLElement;
    const startTermH = tp.getBoundingClientRect().height / state.uiScale;
    const maH = mainArea.getBoundingClientRect().height / state.uiScale;

    const onMove = (e: MouseEvent) => {
      const delta = e.clientY / state.uiScale - startY;
      let fbH = Math.max(80, Math.min(rpH - handleH - 80, startFbH + delta));

      if (!state.splitLocked) {
        // Snap to terminal alignment
        const toolsTop = rpTop + fbH + handleH;
        const termTop = getTerminalTopY();

        if (Math.abs(toolsTop - termTop) < SNAP_PX) {
          fbH = termTop - rpTop - handleH;
        }
      }

      // Snap to frame aspect ratio (no black bars)
      const fW = wglWidth();
      const fH = wglHeight();

      if (fW > 0 && fH > 0 && vpW > 0) {
        const fitH = (vpW / fW) * fH + headerH;

        if (Math.abs(fbH - fitH) < SNAP_PX) {
          fbH = fitH;
        }
      }

      const toolsH = rpH - fbH - handleH;

      const fbPct = (fbH / rpH) * 100;
      const toolsPct = (toolsH / rpH) * 100;

      fb.style.flex = "none";
      tools.style.flex = "none";
      fb.style.height = fbPct + "%";
      tools.style.height = toolsPct + "%";

      if (state.splitLocked) {
        const termH = Math.max(60, Math.min(600, startTermH - delta));
        const pct = (termH / maH) * 100;
        mainArea.style.gridTemplateRows = `32px 1fr 4px ${pct}%`;
      }
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

