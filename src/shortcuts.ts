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
    parts.push("Cmd");
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
  parts.push(s.key.length === 1 ? s.key.toUpperCase() : s.key);

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

  return (
    keyMatch &&
    !!s.meta === e.metaKey &&
    !!s.ctrl === e.ctrlKey &&
    !!s.shift === e.shiftKey &&
    !!s.alt === e.altKey
  );
}
