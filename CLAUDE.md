# OpenMV IDE

Tauri desktop app: TypeScript frontend (Monaco editor) + Rust backend (serial protocol).

## Coding conventions

Read and follow CONVENTIONS.md before writing any code.

Key rules:
- Never use one-line if statements. Always use multi-line braces.
- Plain ASCII only -- no Unicode arrows, em-dashes, fancy quotes.
- Rust uses rustfmt defaults. Tauri commands use `cmd_` prefix.
