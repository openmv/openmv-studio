// Copyright (C) 2026 OpenMV, LLC.
//
// ML tools: opens the ML training window.

import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { state } from "./state";

export async function openTrainingWindow(): Promise<void> {
  const existing = await WebviewWindow.getByLabel("training");
  if (existing) {
    await existing.setFocus();
    return;
  }

  const scale = state.uiScale;
  const w = new WebviewWindow("training", {
    url: "training.html",
    title: "ML Tools",
    width: Math.round(800 * scale),
    height: Math.round(600 * scale),
    center: true,
    alwaysOnTop: true,
    parent: "main",
  });

  w.once("tauri://created", () => {
    w.setZoom(scale);
  });
  w.once("tauri://error", (e) => {
    console.error("ML tools window error:", e);
  });
}
