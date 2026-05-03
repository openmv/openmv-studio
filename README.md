# OpenMV Studio

A modern IDE for OpenMV cameras built on Tauri 2 + Monaco Editor.

> 🚧 This is an experimental rewrite of the OpenMV IDE that's not yet ready for general use.

<p align="center"><img width="800" height="519" alt="openmv-studio" src="https://github.com/user-attachments/assets/78e1a322-6dc3-4cf9-b840-f912a58cc6e6" /></p>

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
- Multi-sensor CSI source selection
- 3D interactive pinout viewer
- Custom CBOR channel display (scalars, depth heatmaps)
- Live memory usage graphs and statistics
- Real-time camera FPS readout
- End-to-end ML training pipeline with support for YOLO v8/v11 object detection.
- One-click deploy of the compiled model + labels to the connected board's ROMFS partition over DFU.

### Missing Features
- [ ] Firmware update (DFU, IMX, Alif bootloaders)
- [ ] Firmware recovery
- [ ] Profiler (PMU data display)
- [ ] Video recording

## Development

### Prerequisites

- Rust toolchain (`rustup`)
- Node.js (v22+)
### Resources

Resources (examples, stubs, firmware, tools) are downloaded at runtime on
first launch. For development, only `resources/boards/` is checked in. The
`scripts/package-resources.sh` script packages resources for upload to R2.

### Build and run

```bash
npm install              # Install all deps (including Tauri CLI)
npx tauri dev            # Dev mode with hot-reload
npx tauri build          # Build distributable (DMG/MSI/DEB)
```
