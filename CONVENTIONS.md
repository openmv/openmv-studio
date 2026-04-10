# Coding Conventions

## TypeScript / JavaScript

### Braces

Always use multi-line if/else blocks. Never put the body on the same line as
the condition:

```typescript
// Bad
if (!el) { return; }
if (cls) { div.className = cls; }

// Good
if (!el) {
  return;
}

if (cls) {
  div.className = cls;
}
```

The same applies to `continue`, `break`, and any other single-statement body:

```typescript
// Bad
if (t === tab) { continue; }

// Good
if (t === tab) {
  continue;
}
```

### Blank lines

Add a blank line after variable declarations before logic:

```typescript
const t = e.target as HTMLElement;

if (t.closest(".terminal-content")) {
  return;
}
```

Add blank lines between logical blocks to let code breathe:

```typescript
const content = document.getElementById("memory-content");

if (!content) {
  return;
}

if (!isConnected) {
  content.innerHTML = "...";
  return;
}
```

### Naming

Exported functions and variables use camelCase: `doConnect`, `openFileDialog`,
`switchToFile`, `scheduleSaveSettings`.

### Characters

Use plain ASCII only in code, comments, and strings. No Unicode arrows,
em-dashes, fancy quotes, or other non-ASCII symbols.

### HTML templates

Large HTML strings used as templates should be declared as constants at the top
of their module, not inline in functions.

## Rust

Use `rustfmt` defaults. No additional style rules beyond what `rustfmt` enforces.

- Tauri commands use `cmd_` prefix (`cmd_connect`, `cmd_list_ports`)
- Plain ASCII only in code and comments (same as TypeScript)
