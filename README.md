# OpenMV IDE

Custom IDE for OpenMV cameras built on Tauri 2 + Monaco Editor.

Replaces the legacy Qt Creator-based IDE with a modern, lightweight app.

## Source Tree

```
openmv-ide/
|
|-- index.html              # App HTML layout (sidebar, panels, editor, terminal, framebuffer)
|-- package.json            # npm deps (vite, monaco-editor, @tauri-apps/api)
|-- tsconfig.json           # TypeScript config
|
|-- src/                    # FRONTEND (runs in the webview)
|   |-- main.ts             # Monaco editor, UI event handlers, polling, IPC calls
|   |-- style.css           # Dark theme CSS (from openmv-redesign.html mockup)
|
|-- src-tauri/              # BACKEND (native Rust app)
|   |-- Cargo.toml          # Rust deps: tauri, serialport, bitflags, serde, log
|   |-- build.rs            # Tauri codegen build script
|   |-- tauri.conf.json     # Tauri config (window size, app name, security)
|   |-- capabilities/       # Tauri permission system
|   |-- icons/              # App icons (all platforms)
|   |-- gen/                # Auto-generated schemas (don't touch)
|   |-- src/
|       |-- main.rs         # Entry point (calls lib.rs)
|       |-- lib.rs          # Tauri command handlers (cmd_connect, cmd_poll, etc.)
|       |-- protocol/       # OpenMV Protocol V2 implementation
|           |-- mod.rs      # Module declarations
|           |-- constants.rs # Opcodes, flags (bitflags), status codes, VID/PIDs
|           |-- crc.rs      # CRC-16 (poly 0xF94F) + CRC-32 (poly 0xFA567D89)
|           |-- buffer.rs   # Ring buffer for packet parsing
|           |-- transport.rs # State machine (SYNC/HEADER/PAYLOAD), TX/RX, fragmentation
|           |-- camera.rs   # I/O thread + command/response queues, high-level Camera API
```

## Architecture

### Two halves

**Frontend** (`src/`) -- HTML/CSS/TypeScript running in native OS webview
(WebKit on macOS, WebView2 on Windows, WebKitGTK on Linux). Monaco editor,
canvas framebuffer, serial terminal, all UI.

**Backend** (`src-tauri/src/`) -- Native Rust. Serial port, protocol, file I/O.

### I/O Thread + Command Queues

```
Frontend (JS)              Tauri IPC                I/O Thread (Rust)
                                                    (owns serial port)
invoke('cmd_poll') ----->  cmd_tx.send(Poll) -----> poll_all() {
                                                      read_stdout_soft()
                                                      read_frame()
                                                    }
                <---------  resp_rx.recv()  <------- Response::PollResult { stdout, frame }
```

- Dedicated I/O thread owns the serial port
- Main thread sends commands via mpsc channel
- I/O thread sends responses back via mpsc channel
- No shared mutable state -- just message passing
- Thread auto-respawns if it panics

### Protocol V2 Summary

- Serial USB at 921600 baud
- Packet: SYNC(0xD5AA) + Header(8B) + CRC-16 + Payload(0-4096B) + CRC-32
- Flags: ACK, NAK, RTX, ACK_REQ, FRAGMENT, EVENT
- Capability negotiation (CRC, SEQ, ACK, EVENTS)
- Channel-based: stdin (script), stdout (text), stream (framebuffer)
- Channel ops: LIST, POLL, LOCK, UNLOCK, SIZE, READ, WRITE, IOCTL
- JPEG-preferred streaming mode for bandwidth efficiency

### Binary IPC for Frames

`cmd_poll` returns `tauri::ipc::Response` (raw binary, not JSON) to avoid
serializing large frame data as JSON arrays. Format:

```
[stdout_len: u32 LE] [stdout_bytes]
[width: u32 LE] [height: u32 LE]
[format_len: u8] [format_str] [is_jpeg: u8] [frame_data...]
```

If no frame: width=0, height=0.

## Current Status

### Phase 1 -- Done
- [x] Connect/disconnect (USB serial, VID/PID auto-detect)
- [x] Run/stop scripts (single toggle button, Cmd+R / Ctrl+E)
- [x] Serial terminal (stdout polling)
- [x] Framebuffer viewer (JPEG + RGB565, binary IPC)
- [x] Protocol V2 in Rust (transport state machine, CRC, channels, fragmentation)
- [x] I/O thread with mpsc command/response queues
- [x] Auto-resync on protocol errors
- [x] Monaco editor with Python highlighting
- [x] Resizable panels with magnetic snap (terminal/tools alignment)

### Phase 2 -- Done
- [x] File management (new, open, save, save-as, close, tabs)
- [x] Settings persistence (tauri-plugin-store, saves to settings.json)
- [x] Dark + Light themes with System option
- [x] macOS native menu bar (File, Edit, Tools, Device, View, Help)
- [x] macOS-style settings dialog (General, Editor, Connection, FB, Shortcuts tabs)
- [x] Configurable keyboard shortcuts with rebinding UI
- [x] UI scaling slider (50-200%) with zoom compensation
- [x] Welcome screen when no files open
- [x] Reopen files on startup from saved settings
- [x] Panel sizes persisted (grid layout, FB/tools ratio)
- [x] Tabbed tools panel (Histogram, Controls, Performance, Stats mockups)
- [x] Sidebar panels (Files, Examples, Docs mockups)
- [x] Connect stops running script, disconnect cleans up properly
- [x] Run button disabled when not connected
- [x] Right-click context menu disabled
- [x] NAK FAILED handled as short read in transport
- [x] Fragment overflow cap at 10MB
- [x] Poll interval configurable (default 50ms)

### Known Issues / Pending
- Protocol can lose sync during rapid frame changes (causes brief resync freeze)
- NAK FAILED returns partial data -- currently treated as error, could return
  the payload for channel reads specifically (trade-off: transport layer doesn't
  know what command was issued)
- Windows: serial port may need keep-alive writes (10ms null byte) to prevent
  read stalls -- not implemented yet, macOS/Linux unaffected
- Histogram/Controls/Performance/Stats tabs are mockups (not wired to data)
- Side panels (Files, Examples, Docs) are mockups
- No file watcher (external edits not detected)
- No "save before close?" dialog (uses confirm() placeholder)

### Phase 3 -- Next
- [ ] Wire histogram to actual frame data
- [ ] Wire camera controls to camera attributes
- [ ] Wire performance/stats tabs to real data
- [ ] Actual file tree (camera storage + local files)
- [ ] Actual examples browser (load from scripts/examples/)
- [ ] ROI selection on framebuffer
- [ ] File watcher for external changes

### Phase 4+
- [ ] Firmware update (DFU, IMX, Alif bootloaders)
- [ ] ROMFS editor
- [ ] Machine vision tools (threshold editor, AprilTag generator)
- [ ] Model zoo + Edge Impulse integration
- [ ] Profiler (PMU data display)
- [ ] Dataset editor
- [ ] Video recording
- [ ] WiFi/TCP transport (for iPad support)
- [ ] iOS/iPad build

## Development

```bash
# Prerequisites
brew install rust          # Rust toolchain
cargo install tauri-cli    # Tauri CLI (first time only)
npm install                # Frontend deps (first time or after clean)

# Run
cargo tauri dev            # Dev mode with hot-reload

# Build distributable
cargo tauri build          # Produces DMG (macOS), MSI (Windows), AppImage (Linux)

# Clean
cd src-tauri && cargo clean  # Rust build cache
rm -rf dist                  # Vite frontend output
```

## Dependencies

**System:**
- Rust (brew install rust)
- Node.js + npm (for Vite and frontend packages)
- Tauri CLI (cargo install tauri-cli)

**Rust crates:** serialport, bitflags, serde, tauri, tauri-plugin-dialog,
tauri-plugin-store, tauri-plugin-fs, tauri-plugin-log

**npm packages:** monaco-editor, @tauri-apps/api, @tauri-apps/plugin-dialog,
@tauri-apps/plugin-store, vite
