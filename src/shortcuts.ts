/*
 * Copyright (C) 2026 OpenMV, LLC.
 *
 * This software is licensed under terms that can be found in the
 * LICENSE file in the root directory of this software component.
 */
// Keyboard shortcut system with rebindable keys.
// Handles parsing, matching, and dispatching of key combos.
// Shortcuts are recorded via the settings dialog and persisted.

export interface Shortcut {
  key: string;
  meta?: boolean;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
}

export interface ShortcutBinding {
  id: string;
  label: string;
  defaults: Shortcut[];
  action: () => void;
}

// On macOS the primary modifier is Command (metaKey), everywhere else Ctrl.
export const isMac = navigator.platform.startsWith("Mac");

// User overrides loaded from settings (shortcut id -> display string)
export let shortcutOverrides: Record<string, string> = {};

export function setShortcutOverrides(overrides: Record<string, string>) {
  shortcutOverrides = overrides;
}

// Populated by main.ts during init
export let shortcutBindings: ShortcutBinding[] = [];

export function setShortcutBindings(bindings: ShortcutBinding[]) {
  shortcutBindings = bindings;
}

export function initShortcuts(editor: any) {
  document.addEventListener("keydown", (e) => {
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

  // Let app shortcuts pass through Monaco to the document
  editor.onKeyDown((e: any) => {
    const ke = e.browserEvent;

    for (const binding of shortcutBindings) {
      const shortcuts = getActiveShortcuts(binding);

      for (const s of shortcuts) {
        if (matchesShortcut(ke, s)) {
          e.preventDefault();
          e.stopPropagation();
          binding.action();
          return;
        }
      }
    }
  });
}

export function getActiveShortcuts(binding: ShortcutBinding): Shortcut[] {
  const override = shortcutOverrides[binding.id];

  if (override) {
    return [parseShortcutString(override)];
  }

  return binding.defaults;
}

export function getShortcutDisplay(binding: ShortcutBinding): string {
  return getActiveShortcuts(binding).map(shortcutToString).join(" / ");
}

export function shortcutToString(s: Shortcut): string {
  const parts: string[] = [];

  if (s.meta) {
    parts.push(isMac ? "Cmd" : "Ctrl");
  }

  if (s.ctrl) {
    parts.push("Ctrl");
  }

  if (s.alt) {
    parts.push("Alt");
  }

  if (s.shift) {
    parts.push("Shift");
  }
  const keyDisplay: Record<string, string> = {
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
  };

  const key = s.key.length === 1 ? s.key.toUpperCase() : (keyDisplay[s.key] || s.key);
  parts.push(key);

  return parts.join("+");
}

export function parseShortcutString(str: string): Shortcut {
  const parts = str.split("+").map((s) => s.trim());
  const s: Shortcut = { key: "" };

  for (const p of parts) {
    const lower = p.toLowerCase();

    if (lower === "cmd" || lower === "meta") {
      s.meta = true;
    } else if (lower === "ctrl") {
      s.ctrl = true;
    } else if (lower === "shift") {
      s.shift = true;
    } else if (lower === "alt" || lower === "opt") {
      s.alt = true;
    } else {
      s.key = p.length === 1 ? p.toLowerCase() : p;
    }
  }

  return s;
}

function matchesShortcut(e: KeyboardEvent, s: Shortcut): boolean {
  const keyMatch =
    e.key.toLowerCase() === s.key.toLowerCase() || e.key === s.key;

  // "meta" means Cmd on macOS, Ctrl on Linux/Windows.
  // "ctrl" is always the physical Ctrl key -- on Linux/Windows a shortcut
  // with meta matches ctrlKey, so we must not double-match it as ctrl too.
  let metaMatch: boolean;
  let ctrlMatch: boolean;

  if (isMac) {
    metaMatch = !!s.meta === e.metaKey;
    ctrlMatch = !!s.ctrl === e.ctrlKey;
  } else {
    const wantCtrl = !!s.meta || !!s.ctrl;
    metaMatch = true;
    ctrlMatch = wantCtrl === e.ctrlKey;
  }

  return (
    keyMatch &&
    metaMatch &&
    ctrlMatch &&
    !!s.shift === e.shiftKey &&
    !!s.alt === e.altKey
  );
}
