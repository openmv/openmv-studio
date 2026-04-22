# OpenMV Studio

A modern IDE for OpenMV cameras built on Tauri 2 + Monaco Editor.

> 🚧 This is an experimental rewrite of the OpenMV IDE that's not yet ready for general use.

## Architecture

TypeScript frontend with a Rust backend connected via Tauri IPC. The backend
runs a dedicated I/O thread that owns the serial/UDP connection and implements
the OpenMV Protocol V2 (CRC, sequencing, fragmentation, channels). Frontend
commands (connect, run script, read channel) are dispatched to the I/O thread
through an mpsc command queue.

Communication is hybrid event-driven and polling:

- **Event-driven:** The I/O thread reacts to protocol events from the camera
  (channel registration, soft reboots, stream data) and pushes frames, stdout,
  and stats to the frontend over a single binary channel with tag-based
  dispatch. The frontend renders frames on `requestAnimationFrame`, decoupling
  serial throughput from display refresh.
- **Polling:** The frontend independently polls for memory stats, protocol
  stats, and dynamic CBOR channels at user-configurable intervals. The I/O
  thread itself polls the serial port with a 1 ms timeout when no commands are
  queued, keeping latency low without busy-waiting.

## Status
 
### New Features
- [x] Multi-sensor CSI source selection
- [x] 3D interactive pinout viewer
- [x] Custom CBOR channel display (scalars, depth heatmaps)
- [x] Live memory usage graphs and statistics
- [x] Real-time camera FPS readout

### Implemented
- [x] Connect/disconnect (USB serial, VID/PID auto-detect)
- [x] Run/stop scripts (single toggle button, Cmd+R / Ctrl+E)
- [x] Serial terminal (stdout polling)
- [x] Framebuffer viewer (JPEG + RGB565, binary IPC)
- [x] Protocol V2 in Rust (transport state machine, CRC, channels, fragmentation)
- [x] I/O thread with mpsc command/response queues
- [x] Auto-resync on protocol errors
- [x] Monaco editor with Python highlighting
- [x] Pyright-based Python autocompletion
- [x] Resizable panels with magnetic snap (terminal/tools alignment)
- [x] File management (new, open, save, save-as, close, tabs)
- [x] File watching for external changes
- [x] Recent files tracking
- [x] Settings persistence (tauri-plugin-store, saves to settings.json)
- [x] Dark + Light themes with System option
- [x] macOS native menu bar (File, Edit, Tools, Device, View, Help)
- [x] macOS-style settings dialog (General, Editor, Connection, FB, Shortcuts tabs)
- [x] Configurable keyboard shortcuts with rebinding UI
- [x] UI scaling slider (50-200%) with zoom compensation
- [x] Welcome screen when no files open
- [x] Reopen files on startup from saved settings
- [x] Panel sizes persisted (grid layout, FB/tools ratio)
- [x] Histogram with live stats (mean, median, stdev, min, max, mode)
- [x] Board info tab
- [x] Memory stats polling tab
- [x] Protocol stats polling tab
- [x] Channels tab (polls dynamic CBOR channels, renders scalars and depth heatmaps)
- [x] Sidebar panels (Files, Examples, Docs)
- [x] Examples browser (loaded from device)

### Pending
- [ ] Firmware update (DFU, IMX, Alif bootloaders)
- [ ] ROMFS editor
- [ ] Machine vision tools (threshold editor, AprilTag generator)
- [ ] Model convesion tools
- [ ] Profiler (PMU data display)
- [ ] Video recording

## Development

```bash
# Prerequisites: Rust and Node.js
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh  # Rust toolchain
# Install Node.js via your preferred method (nvm, brew, etc.)

# Build and run
npm install              # Install all deps (including Tauri CLI)
npx tauri dev            # Dev mode with hot-reload
npx tauri build          # Build distributable (DMG/MSI/DEB)
```
