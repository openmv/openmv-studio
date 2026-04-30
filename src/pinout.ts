/*
 * Copyright (C) 2026 OpenMV, LLC.
 *
 * This software is licensed under terms that can be found in the
 * LICENSE file in the root directory of this software component.
 */
import { state } from "./state";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

let pinoutWin: WebviewWindow | null = null;

export async function openPinoutViewer() {
  if (pinoutWin) {
    return;
  }

  const scale = state.uiScale;
  const win = new WebviewWindow("pinout", {
    url: "pinout.html",
    title: "Pinout Viewer",
    width: Math.round(704 * scale),
    height: Math.round(528 * scale),
    resizable: true,
    center: true,
    alwaysOnTop: true,
    parent: "main",
  });

  pinoutWin = win;

  try {
    await new Promise<void>((resolve, reject) => {
      win.once("tauri://created", () => resolve());
      win.once("tauri://error", (e) => reject(e));
    });
  } catch (e: any) {
    console.error("Failed to create pinout window:", e);
    pinoutWin = null;
    return;
  }

  win.setZoom(scale);

  const readyUnlisten = await listen("pinout-ready", async () => {
    readyUnlisten();
    let boardsPath = "";
    try {
      boardsPath = await invoke<string>("cmd_resource_path", { name: "boards" });
    } catch {
      // Fallback: not downloaded yet, will fail gracefully in pinout.html
    }
    win.emit("pinout-init", {
      connectedBoard: state.connectedBoard,
      resolvedTheme:
        document.documentElement.getAttribute("data-theme") || "dark",
      boardsPath,
    });
  });

  win.once("tauri://destroyed", () => {
    pinoutWin = null;
  });
}
