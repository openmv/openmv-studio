// Copyright (C) 2026 OpenMV, LLC.
//
// ROMFS Editor: opens the ROMFS editor window.

import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { childWindowSize, state } from "./state";

export async function openRomfsEditor(): Promise<void> {
  const existing = await WebviewWindow.getByLabel("romfs-editor");
  if (existing) {
    await existing.setFocus();
    return;
  }

  const scale = state.uiScale;
  const { width, height } = await childWindowSize();
  const w = new WebviewWindow("romfs-editor", {
    url: "romfs-editor.html",
    title: "ROMFS Editor",
    width,
    height,
    center: true,
    alwaysOnTop: true,
    parent: "main",
  });

  w.once("tauri://created", () => {
    w.setZoom(scale);
  });
  w.once("tauri://error", (e) => {
    console.error("ROMFS editor window error:", e);
  });
}
