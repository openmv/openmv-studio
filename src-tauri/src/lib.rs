// Copyright (C) 2026 OpenMV, LLC.
//
// This software is licensed under terms that can be found in the
// LICENSE file in the root directory of this software component.

mod backend;
mod camera;
mod checksum;
mod dfu;
mod protocol;
mod resources;
mod romfs;
mod training;
mod transport;

use std::sync::{Arc, Mutex, mpsc};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{Emitter, Manager, State};

use camera::{Camera, Command};
use protocol::{SystemInfo, VersionInfo};

#[derive(Clone)]
pub(crate) struct Board {
    pub(crate) vid: u16,
    pub(crate) pid: u16,
    pub(crate) board_type: String,
    pub(crate) display: String,
    pub(crate) bootloader_vid_pid: Option<String>,
    pub(crate) fs_partition: Option<Vec<String>>,
    pub(crate) romfs_partition: Option<Vec<String>>,
    pub(crate) romfs_size: Option<Vec<usize>>,
    pub(crate) in_firmware_mode: bool,
}

pub(crate) struct AppState {
    pub(crate) boards: Vec<Board>,
    pub(crate) sensors: serde_json::Value,
    pub(crate) cmd_tx: Option<mpsc::Sender<Command>>,
    pub(crate) worker_thread: Option<std::thread::JoinHandle<()>>,
    pub(crate) sysinfo: Option<SystemInfo>,
    pub(crate) verinfo: Option<VersionInfo>,
}

struct SetupComplete(AtomicBool);

struct ConnectRunning(AtomicBool);

struct DfuRunning(AtomicBool);

#[tauri::command]
fn cmd_setup_done(app: tauri::AppHandle) {
    let flag = app.state::<Arc<SetupComplete>>();
    flag.0.store(true, Ordering::SeqCst);
}

pub(crate) fn resolve_resource(app: &tauri::AppHandle, name: &str) -> std::path::PathBuf {
    // Check app data dir first for runtime-downloaded resources
    let top = name.split('/').next().unwrap_or("");
    if resources::DOWNLOADED_RESOURCES.contains(&top) {
        if let Ok(data_dir) = app.path().app_data_dir() {
            let p = data_dir.join("resources").join(name);
            if p.exists() {
                return p;
            }
        }
    }

    // Fallback: bundled resources (boards.json, sensors.json)
    let path = format!("resources/{}", name);
    app.path()
        .resolve(&path, tauri::path::BaseDirectory::Resource)
        .unwrap_or_else(|_| std::path::PathBuf::from(&path))
}

fn parse_hex16(s: &str) -> u16 {
    u16::from_str_radix(s.trim_start_matches("0x"), 16).unwrap_or(0)
}

fn load_boards(app: &tauri::AppHandle) -> Vec<Board> {
    let path = resolve_resource(app, "boards/boards.json");
    let json = std::fs::read_to_string(&path)
        .ok()
        .and_then(|data| serde_json::from_str::<serde_json::Value>(&data).ok());
    let Some(entries) = json.as_ref().and_then(|j| j["boards"].as_array()) else {
        return vec![];
    };
    entries
        .iter()
        .filter_map(|b| {
            let vid = parse_hex16(b["vid"].as_str()?);
            let pid = parse_hex16(b["pid"].as_str()?);
            if vid == 0 {
                return None;
            }
            Some(Board {
                vid,
                pid,
                board_type: b["type"].as_str().unwrap_or("Unknown").to_string(),
                display: b["display"].as_str().unwrap_or("Unknown").to_string(),
                bootloader_vid_pid: b["bootloader_vid_pid"].as_str().map(|s| s.to_string()),
                fs_partition: b["fs_partition"].as_array().map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(|s| s.to_string()))
                        .collect()
                }),
                romfs_partition: b["romfs_partition"].as_array().map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(|s| s.to_string()))
                        .collect()
                }),
                romfs_size: b["romfs_size"].as_array().map(|arr| {
                    arr.iter()
                        .filter_map(|v| {
                            v.as_str().and_then(|s| {
                                let s = s.trim_start_matches("0x");
                                usize::from_str_radix(s, 16).ok()
                            })
                        })
                        .collect()
                }),
                in_firmware_mode: false,
            })
        })
        .collect()
}

fn load_sensors(app: &tauri::AppHandle) -> serde_json::Value {
    let path = resolve_resource(app, "boards/sensors.json");
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|data| serde_json::from_str::<serde_json::Value>(&data).ok())
        .unwrap_or(serde_json::json!({}))
}

#[tauri::command]
fn cmd_open_url(url: String) -> Result<(), String> {
    open::that(&url).map_err(|e| e.to_string())
}

fn list_known_ports(boards: &[Board], all: bool) -> Vec<String> {
    serialport::available_ports()
        .unwrap_or_default()
        .into_iter()
        .filter(|p| !p.port_name.contains("/tty."))
        .filter(|p| {
            if all {
                return true;
            }
            if let serialport::SerialPortType::UsbPort(info) = &p.port_type {
                boards.iter().any(|b| b.vid == info.vid && b.pid == info.pid)
            } else {
                false
            }
        })
        .map(|p| p.port_name)
        .collect()
}

#[tauri::command(async)]
fn cmd_list_ports(all: Option<bool>, state: State<Arc<Mutex<AppState>>>) -> Vec<String> {
    let st = state.lock().unwrap();
    list_known_ports(&st.boards, all.unwrap_or(false))
}

#[tauri::command(async)]
fn cmd_connect(
    address: Option<String>,
    transport: String,
    channel: Channel,
    io_interval_ms: u64,
    state: State<Arc<Mutex<AppState>>>,
    connect_running: State<Arc<ConnectRunning>>,
) -> Result<(), String> {
    if connect_running
        .0
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("Connect already in progress".into());
    }
    struct Guard<'a>(&'a AtomicBool);
    impl Drop for Guard<'_> {
        fn drop(&mut self) {
            self.0.store(false, Ordering::SeqCst);
        }
    }
    let _guard = Guard(&connect_running.0);

    let address = match address {
        Some(addr) => addr,
        None => {
            let st = state.lock().map_err(|e| e.to_string())?;
            if st.sysinfo.is_some() {
                return Ok(());
            }
            list_known_ports(&st.boards, false)
                .into_iter()
                .next()
                .ok_or("No board found")?
        }
    };

    log::info!("Connecting to {} via {}", address, transport);

    // Stop existing worker
    {
        let mut st = state.lock().map_err(|e| e.to_string())?;
        if let Some(tx) = st.cmd_tx.take() {
            let _ = tx.send(Command::Disconnect);
        }
        let old_thread = st.worker_thread.take();
        drop(st);
        if let Some(handle) = old_thread {
            let _ = handle.join();
        }
    }

    // Connect (no lock held -- I/O can block)
    let mut camera = Camera::new();
    camera.connect(&address, &transport).map_err(|e| {
        log::error!("Connect failed: {}", e);
        e.to_string()
    })?;

    let (verinfo, sysinfo) = camera.get_sys_info().map_err(|e| {
        log::error!("get_sys_info failed: {}", e);
        e.to_string()
    })?;

    let mut st = state.lock().map_err(|e| e.to_string())?;
    st.sysinfo = Some(sysinfo);
    st.verinfo = Some(verinfo);

    let (tx, rx) = mpsc::channel();
    let interval = Duration::from_millis(io_interval_ms);

    let handle = std::thread::spawn(move || {
        camera.run(rx, &channel, interval);
    });

    st.cmd_tx = Some(tx);
    st.worker_thread = Some(handle);

    log::info!("Connected to {} via {}", address, transport);
    Ok(())
}

#[tauri::command(async)]
fn cmd_disconnect(state: State<Arc<Mutex<AppState>>>) -> Result<(), String> {
    log::info!("Disconnecting");
    let mut st = state.lock().map_err(|e| e.to_string())?;
    if let Some(tx) = st.cmd_tx.take() {
        let _ = tx.send(Command::Disconnect);
    }
    let old_thread = st.worker_thread.take();
    st.sysinfo = None;
    st.verinfo = None;
    drop(st);

    if let Some(handle) = old_thread {
        let _ = handle.join();
    }
    Ok(())
}

#[tauri::command]
fn cmd_get_version(state: State<Arc<Mutex<AppState>>>) -> Result<serde_json::Value, String> {
    let st = state.lock().map_err(|e| e.to_string())?;
    let v = st.verinfo.as_ref().ok_or("Not connected")?;
    Ok(serde_json::json!({
        "protocol": v.protocol,
        "bootloader": v.bootloader,
        "firmware": v.firmware,
    }))
}

#[tauri::command]
fn cmd_get_sysinfo(state: State<Arc<Mutex<AppState>>>) -> Result<serde_json::Value, String> {
    let st = state.lock().map_err(|e| e.to_string())?;
    let info = st.sysinfo.as_ref().ok_or("Not connected")?;
    let (board_type, board_name) = lookup_board(&st.boards, info.usb_vid, info.usb_pid);
    let sensors: Vec<serde_json::Value> = info
        .chip_ids
        .iter()
        .filter(|&&id| id != 0)
        .map(|&id| {
            let name = lookup_sensor(&st.sensors, id);
            serde_json::json!({ "chip_id": id, "name": name })
        })
        .collect();
    let mut val = serde_json::to_value(info).map_err(|e| e.to_string())?;
    let obj = val.as_object_mut().unwrap();
    obj.insert("board_type".into(), board_type.into());
    obj.insert("board_name".into(), board_name.into());
    obj.insert("sensors".into(), sensors.into());
    Ok(val)
}

fn lookup_board(boards: &[Board], vid: u16, pid: u16) -> (String, String) {
    boards
        .iter()
        .find(|b| b.vid == vid && b.pid == pid)
        .map(|b| (b.board_type.clone(), b.display.clone()))
        .unwrap_or_else(|| {
            (
                format!("{:04X}:{:04X}", vid, pid),
                "Unknown Board".to_string(),
            )
        })
}

fn lookup_sensor(sensors: &serde_json::Value, chip_id: u32) -> String {
    let key = format!("0x{:X}", chip_id);
    sensors["sensors"][&key]
        .as_str()
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("Unknown (0x{:X})", chip_id))
}

// Commands that push to the worker queue and return immediately.

#[tauri::command]
fn cmd_run_script(script: String, state: State<Arc<Mutex<AppState>>>) -> Result<(), String> {
    let st = state.lock().map_err(|e| e.to_string())?;
    if let Some(ref tx) = st.cmd_tx {
        let _ = tx.send(Command::RunScript(script));
    }
    Ok(())
}

#[tauri::command]
fn cmd_stop_script(state: State<Arc<Mutex<AppState>>>) -> Result<(), String> {
    let st = state.lock().map_err(|e| e.to_string())?;
    if let Some(ref tx) = st.cmd_tx {
        let _ = tx.send(Command::StopScript);
    }
    Ok(())
}

#[tauri::command]
fn cmd_reset(state: State<Arc<Mutex<AppState>>>) -> Result<(), String> {
    let st = state.lock().map_err(|e| e.to_string())?;
    if let Some(ref tx) = st.cmd_tx {
        let _ = tx.send(Command::Reset);
    }
    Ok(())
}

#[tauri::command]
fn cmd_bootloader(state: State<Arc<Mutex<AppState>>>) -> Result<(), String> {
    let st = state.lock().map_err(|e| e.to_string())?;
    if let Some(ref tx) = st.cmd_tx {
        let _ = tx.send(Command::Bootloader);
    }
    Ok(())
}

#[tauri::command(async)]
fn cmd_erase_filesystem(
    app: tauri::AppHandle,
    state: State<Arc<Mutex<AppState>>>,
    dfu_running: State<Arc<DfuRunning>>,
) -> Result<(), String> {
    if dfu_running
        .0
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("DFU already in progress".into());
    }
    struct Guard<'a>(&'a AtomicBool);
    impl Drop for Guard<'_> {
        fn drop(&mut self) {
            self.0.store(false, Ordering::SeqCst);
        }
    }
    let _guard = Guard(&dfu_running.0);

    let (vid_pid, fs_partition) = {
        let st = state.lock().map_err(|e| e.to_string())?;
        let info = st.sysinfo.as_ref().ok_or("Not connected")?;
        let board = st
            .boards
            .iter()
            .find(|b| b.vid == info.usb_vid && b.pid == info.usb_pid)
            .ok_or("Unknown board")?;
        let vid_pid = board
            .bootloader_vid_pid
            .clone()
            .ok_or("Board does not support DFU")?;
        let fs_partition = board
            .fs_partition
            .clone()
            .ok_or("Board does not support filesystem erase")?;
        (vid_pid, fs_partition)
    };

    // Enter bootloader (disconnects the camera)
    {
        let st = state.lock().map_err(|e| e.to_string())?;
        if let Some(ref tx) = st.cmd_tx {
            let _ = tx.send(Command::Bootloader);
        }
    }

    // Wait for worker to finish and USB re-enumeration
    std::thread::sleep(Duration::from_secs(3));

    let config = dfu::DfuConfig {
        vid_pid,
        fs_partition,
    };
    dfu::erase_filesystem(&app, &config)
}

#[tauri::command]
fn cmd_romfs_read_file_bytes(path: String) -> Result<Vec<u8>, String> {
    std::fs::read(&path).map_err(|e| format!("Failed to read {}: {}", path, e))
}

// Load the stock ROMFS image that ships with the firmware bundle for the
// resolved board's partition <partition_index>. Path:
//   <app_data_dir>/resources/firmware/<BOARD>/romfs<N>.img
#[tauri::command]
fn cmd_romfs_load_stock(
    partition_index: usize,
    app: tauri::AppHandle,
    state: State<Arc<Mutex<AppState>>>,
) -> Result<serde_json::Value, String> {
    let board = dfu::resolve_dfu_board(&app, state.inner())?;
    let parts = board.romfs_partition.as_ref().unwrap();
    let sizes = board.romfs_size.as_deref().unwrap_or(&[]);
    let part_size = sizes
        .get(partition_index)
        .copied()
        .ok_or("Missing partition size")?;
    if partition_index >= parts.len() {
        return Err("Invalid partition index".to_string());
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?
        .join("resources")
        .join("firmware")
        .join(&board.board_type);
    let img_path = dir.join(format!("romfs{}.img", partition_index));
    let raw = std::fs::read(&img_path)
        .map_err(|e| format!("No stock ROMFS image at {}: {}", img_path.display(), e))?;
    let entries = romfs::parse(&raw)?;
    let used = romfs::estimate_size(&entries);
    let entries_json: Vec<_> = entries
        .into_iter()
        .map(|e| {
            serde_json::json!({
                "name": e.name,
                "size": e.data.len(),
                "alignment": e.alignment,
                "data": e.data,
            })
        })
        .collect();
    Ok(serde_json::json!({
        "entries": entries_json,
        "used_bytes": used,
        "total_bytes": part_size,
    }))
}

#[tauri::command]
fn cmd_romfs_partitions(
    app: tauri::AppHandle,
    state: State<Arc<Mutex<AppState>>>,
) -> Result<Vec<serde_json::Value>, String> {
    let board = match dfu::resolve_dfu_board(&app, state.inner()) {
        Ok(b) => b,
        Err(_) => return Ok(vec![]),
    };
    let parts = board.romfs_partition.as_ref().unwrap();
    let sizes = board.romfs_size.as_deref().unwrap_or(&[]);
    Ok(parts
        .iter()
        .enumerate()
        .map(|(i, p)| {
            // Extract (alt_setting, base_address) from the dfu-util argument
            // string. STM32 boards typically only specify `-a N`. Arduino
            // DfuSe boards specify `-a N -s 0xADDR:0xSIZE`.
            let mut alt: Option<u32> = None;
            let mut base: Option<String> = None;
            let mut tokens = p.split_whitespace();
            while let Some(tok) = tokens.next() {
                if tok == "-a" {
                    if let Some(v) = tokens.next() {
                        alt = v.parse::<u32>().ok();
                    }
                } else if tok == "-s" {
                    if let Some(v) = tokens.next() {
                        let addr = v.split(':').next().unwrap_or(v);
                        base = Some(addr.to_string());
                    }
                }
            }
            serde_json::json!({
                "index": i,
                "label": match alt {
                    Some(a) => format!("Partition {} (alt {})", i, a),
                    None => format!("Partition {}", i),
                },
                "alt": alt,
                "base": base,
                "args": p,
                "size": sizes.get(i).copied().unwrap_or(0),
            })
        })
        .collect())
}

fn enter_dfu_mode(
    app: &tauri::AppHandle,
    state: &Arc<Mutex<AppState>>,
    partition_index: usize,
) -> Result<(String, String, usize), String> {
    let resolved = dfu::resolve_dfu_board(app, state)?;
    let part_args = resolved
        .romfs_partition
        .as_ref()
        .unwrap()
        .get(partition_index)
        .cloned()
        .ok_or("Invalid partition index")?;
    let part_size = resolved
        .romfs_size
        .as_deref()
        .unwrap_or(&[])
        .get(partition_index)
        .copied()
        .ok_or("Missing partition size")?;

    let bootloader_vid_pid = resolved.bootloader_vid_pid.unwrap();

    if resolved.in_firmware_mode {
        // Let firmware finish its soft reboot before SysBoot.
        std::thread::sleep(Duration::from_millis(500));

        let st = state.lock().map_err(|e| e.to_string())?;
        if let Some(ref tx) = st.cmd_tx {
            let _ = tx.send(Command::Bootloader);
            drop(st);
            let _ = app.emit("dfu-status", "Entering bootloader...");
            // Poll for bootloader vid:pid; cap at 5s.
            let target = bootloader_vid_pid.to_lowercase();
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            loop {
                if let Ok(devices) = dfu::list_devices(app) {
                    if devices.iter().any(|vp| *vp == target) {
                        break;
                    }
                }
                if std::time::Instant::now() >= deadline {
                    break;
                }
                std::thread::sleep(Duration::from_millis(250));
            }
        }
    }

    Ok((bootloader_vid_pid, part_args, part_size))
}

#[tauri::command]
async fn cmd_romfs_read(
    partition_index: usize,
    app: tauri::AppHandle,
    state: State<'_, Arc<Mutex<AppState>>>,
    dfu_running: State<'_, Arc<DfuRunning>>,
) -> Result<serde_json::Value, String> {
    let state_arc = state.inner().clone();
    let handle = app.clone();
    let running = dfu_running.inner().clone();
    running.0.store(true, Ordering::SeqCst);
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<serde_json::Value, String> {
        let (vid_pid, part_args, part_size) =
            enter_dfu_mode(&handle, &state_arc, partition_index)?;

        let raw = dfu::upload_partition(&handle, &vid_pid, &part_args, part_size)?;
        let _ = handle.emit("dfu-status", "Parsing ROMFS image...");
        let entries = romfs::parse(&raw)?;
        let used = romfs::estimate_size(&entries);

        let entries_json: Vec<_> = entries
            .into_iter()
            .map(|e| {
                serde_json::json!({
                    "name": e.name,
                    "size": e.data.len(),
                    "alignment": e.alignment,
                    "data": e.data,
                })
            })
            .collect();

        let _ = handle.emit("dfu-status", "ROMFS read complete.");
        let _ = handle.emit("dfu-done", ());

        Ok(serde_json::json!({
            "entries": entries_json,
            "used_bytes": used,
            "total_bytes": part_size,
        }))
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?;
    running.0.store(false, Ordering::SeqCst);
    result
}

#[tauri::command]
async fn cmd_romfs_write(
    partition_index: usize,
    entries: Vec<serde_json::Value>,
    app: tauri::AppHandle,
    state: State<'_, Arc<Mutex<AppState>>>,
    dfu_running: State<'_, Arc<DfuRunning>>,
) -> Result<(), String> {
    let state_arc = state.inner().clone();

    let mut romfs_entries: Vec<romfs::RomfsEntry> = Vec::with_capacity(entries.len());
    for e in entries {
        let name = e["name"]
            .as_str()
            .ok_or("Missing entry name")?
            .to_string();
        let alignment = e["alignment"].as_u64().unwrap_or(4) as u32;
        let data: Vec<u8> = e["data"]
            .as_array()
            .ok_or("Missing entry data")?
            .iter()
            .map(|v| v.as_u64().unwrap_or(0) as u8)
            .collect();
        romfs_entries.push(romfs::RomfsEntry {
            name,
            data,
            alignment,
        });
    }

    let handle = app.clone();
    let running = dfu_running.inner().clone();
    running.0.store(true, Ordering::SeqCst);
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let (vid_pid, part_args, part_size) =
            enter_dfu_mode(&handle, &state_arc, partition_index)?;
        let image = romfs::build(&romfs_entries, part_size)?;
        let _ = handle.emit("dfu-total", image.len() as u64);
        dfu::download_partition(&handle, &vid_pid, &part_args, &image, true)?;
        let _ = handle.emit("dfu-status", "ROMFS write complete.");
        let _ = handle.emit("dfu-done", ());
        Ok(())
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?;
    running.0.store(false, Ordering::SeqCst);
    result
}

// Deploy a trained model into the connected board's ROMFS. Validates that
// the connected board matches the requested target and that an export for
// that exact target is already on disk. The user is expected to click
// Export (with the desired target) before Deploy -- mismatches fail loud
// rather than silently re-running the pipeline.
#[tauri::command]
async fn cmd_ml_deploy(
    project: String,
    target: String,
    app: tauri::AppHandle,
    state: State<'_, Arc<Mutex<AppState>>>,
    dfu_running: State<'_, Arc<DfuRunning>>,
) -> Result<(), String> {
    training::validate_target(&target)?;

    let resolved = dfu::resolve_dfu_board(&app, state.inner())?;
    if let Some((required_board, _)) = training::target_to_partition(&target) {
        if resolved.board_type != required_board {
            return Err(format!(
                "Target {} requires {} but {} is connected",
                target, required_board, resolved.board_type
            ));
        }
    }
    let partition_index = training::target_to_partition(&target)
        .map(|(_, p)| p)
        .unwrap_or(0);
    if partition_index >= resolved.romfs_partition.as_ref().unwrap().len() {
        return Err(format!(
            "Board {} does not expose partition {} for target {}",
            resolved.board_type, partition_index, target
        ));
    }

    let export_dir = training::export_dir(&app, &project)?;
    // Pipeline writes a single descriptively-named .tflite per export.
    let tflite_src = std::fs::read_dir(&export_dir)
        .ok()
        .and_then(|rd| {
            rd.filter_map(|e| e.ok().map(|e| e.path()))
                .find(|p| p.extension().and_then(|s| s.to_str()) == Some("tflite"))
        })
        .ok_or_else(|| "No exported model found. Run Export first.".to_string())?;
    match training::read_target_marker(&app, &project)? {
        Some(t) if t == target => {}
        Some(t) => {
            return Err(format!(
                "Exported model targets {}, not {}. Re-run Export with the desired target.",
                t, target
            ));
        }
        None => {
            return Err(
                "Exported model has no target marker. Re-run Export with the desired target."
                    .to_string(),
            );
        }
    }

    let model_name = tflite_src
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or("Invalid tflite filename")?
        .to_string();
    let labels_name = tflite_src
        .file_stem()
        .and_then(|s| s.to_str())
        .map(|stem| format!("{}.txt", stem))
        .ok_or("Invalid tflite filename")?;

    let model_bytes = std::fs::read(&tflite_src)
        .map_err(|e| format!("Failed to read {}: {}", model_name, e))?;
    let labels_path = export_dir.join("labels.txt");
    let labels_bytes = if labels_path.exists() {
        Some(
            std::fs::read(&labels_path)
                .map_err(|e| format!("Failed to read labels.txt: {}", e))?,
        )
    } else {
        None
    };

    let state_arc = state.inner().clone();
    let handle = app.clone();
    let running = dfu_running.inner().clone();
    running.0.store(true, Ordering::SeqCst);
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let (vid_pid, part_args, part_size) =
            enter_dfu_mode(&handle, &state_arc, partition_index)?;

        let _ = handle.emit("dfu-total", part_size as u64);
        let raw = dfu::upload_partition(&handle, &vid_pid, &part_args, part_size)?;
        let _ = handle.emit("dfu-status", "Parsing ROMFS image...");
        let mut entries = romfs::parse(&raw)?;

        entries.retain(|e| e.name != model_name && e.name != labels_name);
        entries.push(romfs::RomfsEntry {
            name: model_name,
            data: model_bytes,
            alignment: 32,
        });
        if let Some(bytes) = labels_bytes {
            entries.push(romfs::RomfsEntry {
                name: labels_name,
                data: bytes,
                alignment: 4,
            });
        }

        let image = romfs::build(&entries, part_size)?;

        let _ = handle.emit("dfu-status", "Writing model to ROMFS...");
        let _ = handle.emit("dfu-total", image.len() as u64);
        dfu::download_partition(&handle, &vid_pid, &part_args, &image, true)?;
        let _ = handle.emit("dfu-status", "Deploy complete.");
        let _ = handle.emit("dfu-done", ());
        Ok(())
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?;
    running.0.store(false, Ordering::SeqCst);
    result
}

#[tauri::command]
async fn cmd_dfu_exit(
    app: tauri::AppHandle,
    dfu_running: State<'_, Arc<DfuRunning>>,
    dfu_child: State<'_, Arc<dfu::DfuChild>>,
) -> Result<(), String> {
    dfu_child.kill_running();

    let handle = app.clone();
    let running = dfu_running.inner().clone();
    running.0.store(true, Ordering::SeqCst);
    let result = tauri::async_runtime::spawn_blocking(move || dfu::exit_dfu(&handle))
        .await
        .map_err(|e| format!("Task failed: {}", e))?;
    running.0.store(false, Ordering::SeqCst);
    result
}

#[tauri::command]
fn cmd_enable_streaming(
    enable: bool,
    raw: bool,
    state: State<Arc<Mutex<AppState>>>,
) -> Result<(), String> {
    let st = state.lock().map_err(|e| e.to_string())?;
    if let Some(ref tx) = st.cmd_tx {
        let _ = tx.send(Command::EnableStreaming { enable, raw });
    }
    Ok(())
}

#[tauri::command]
fn cmd_set_stream_source(chip_id: u32, state: State<Arc<Mutex<AppState>>>) -> Result<(), String> {
    let st = state.lock().map_err(|e| e.to_string())?;
    if let Some(ref tx) = st.cmd_tx {
        let _ = tx.send(Command::SetStreamSource(chip_id));
    }
    Ok(())
}

#[tauri::command]
fn cmd_get_memory(state: State<Arc<Mutex<AppState>>>) -> Result<(), String> {
    let st = state.lock().map_err(|e| e.to_string())?;
    if let Some(ref tx) = st.cmd_tx {
        let _ = tx.send(Command::GetMemory);
    }
    Ok(())
}

#[tauri::command]
fn cmd_get_stats(state: State<Arc<Mutex<AppState>>>) -> Result<(), String> {
    let st = state.lock().map_err(|e| e.to_string())?;
    if let Some(ref tx) = st.cmd_tx {
        let _ = tx.send(Command::GetStats);
    }
    Ok(())
}

#[tauri::command]
fn cmd_read_channel(channel_id: u8, state: State<Arc<Mutex<AppState>>>) -> Result<(), String> {
    let st = state.lock().map_err(|e| e.to_string())?;
    if let Some(ref tx) = st.cmd_tx {
        let _ = tx.send(Command::ReadChannel(channel_id));
    }
    Ok(())
}

#[tauri::command]
fn cmd_write_channel(
    channel_id: u8,
    data: Vec<u8>,
    state: State<Arc<Mutex<AppState>>>,
) -> Result<(), String> {
    let st = state.lock().map_err(|e| e.to_string())?;
    if let Some(ref tx) = st.cmd_tx {
        let _ = tx.send(Command::WriteChannel {
            id: channel_id,
            data,
        });
    }
    Ok(())
}

#[tauri::command]
fn cmd_list_examples(
    app: tauri::AppHandle,
    board: Option<String>,
    sensor: Option<String>,
) -> Result<serde_json::Value, String> {
    let examples_dir = resolve_resource(&app, "examples");

    if !examples_dir.exists() {
        return Err(format!("Examples not found: {:?}", examples_dir));
    }

    // Load index.json for filtering and flatten info
    let index_path = examples_dir.join("index.json");
    let index_data = std::fs::read_to_string(&index_path).ok();
    let index: Option<serde_json::Value> = index_data
        .as_deref()
        .and_then(|d| serde_json::from_str(d).ok());

    let allowed_paths: Option<Vec<String>> = if board.is_some() || sensor.is_some() {
        index.as_ref().and_then(|idx| {
            let entries = idx["entries"].as_array();
            Some(filter_entries(
                entries,
                board.as_deref(),
                sensor.as_deref(),
                &examples_dir,
            ))
        })
    } else {
        None // no filter -- show all
    };

    // Collect flatten prefixes from "path" entries ending with /*
    // Only flatten when filtering is active -- unfiltered shows full tree
    let flatten_dirs: Vec<String> = if board.is_some() || sensor.is_some() {
        index
            .as_ref()
            .and_then(|idx| idx["entries"].as_array())
            .map(|entries| {
                entries
                    .iter()
                    .filter_map(|e| e["path"].as_str())
                    .filter_map(|p| p.strip_suffix("/*"))
                    .map(|p| p.to_string())
                    .collect()
            })
            .unwrap_or_default()
    } else {
        vec![]
    };

    // Scan directory tree recursively, filtering by allowed paths
    fn scan(
        dir: &std::path::Path,
        base: &std::path::Path,
        allowed: &Option<Vec<String>>,
        flatten_dirs: &[String],
    ) -> Vec<serde_json::Value> {
        let mut items = Vec::new();
        let Ok(rd) = std::fs::read_dir(dir) else {
            return items;
        };
        let mut entries: Vec<_> = rd.filter_map(|e| e.ok()).collect();
        entries.sort_by_key(|e| e.file_name());

        for entry in entries {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || name == "index.json" {
                continue;
            }
            if path.is_dir() {
                let rel = path.strip_prefix(base).unwrap_or(&path);
                let rel_str = rel.to_string_lossy().replace('\\', "/");

                // Check if this dir is a flatten target -- hoist its children
                if flatten_dirs.iter().any(|f| f == &rel_str) {
                    let children = scan(&path, base, allowed, flatten_dirs);
                    items.extend(children);
                } else {
                    // Check if this dir is an ancestor of a flatten target
                    // If so, scan into it but don't create a tree node -- inline results
                    let is_ancestor = flatten_dirs
                        .iter()
                        .any(|f| f.starts_with(&format!("{}/", rel_str)));
                    if is_ancestor {
                        let children = scan(&path, base, allowed, flatten_dirs);
                        items.extend(children);
                    } else {
                        let children = scan(&path, base, allowed, flatten_dirs);
                        if !children.is_empty() {
                            let display = name
                                .trim_start_matches(|c: char| c.is_ascii_digit() || c == '-')
                                .replace('-', " ");
                            items.push(serde_json::json!({
                                "name": if display.is_empty() { name.clone() } else { display },
                                "sort_key": &name,
                                "type": "dir",
                                "children": children,
                            }));
                        }
                    }
                }
            } else if name.ends_with(".py") {
                // Check if this file is allowed by the filter
                if let Some(allowed_list) = allowed {
                    let rel = path.strip_prefix(base).unwrap_or(&path);
                    let rel_str = rel.to_string_lossy();
                    if !allowed_list.iter().any(|a| rel_str.starts_with(a)) {
                        continue;
                    }
                }
                items.push(serde_json::json!({
                    "name": name.trim_end_matches(".py").replace('_', " "),
                    "type": "file",
                    "path": path.to_string_lossy(),
                }));
            }
        }
        items.sort_by(|a, b| {
            let ka = a["sort_key"]
                .as_str()
                .unwrap_or(a["name"].as_str().unwrap_or(""));
            let kb = b["sort_key"]
                .as_str()
                .unwrap_or(b["name"].as_str().unwrap_or(""));
            ka.to_ascii_lowercase().cmp(&kb.to_ascii_lowercase())
        });
        items
    }

    Ok(serde_json::Value::Array(scan(
        &examples_dir,
        &examples_dir,
        &allowed_paths,
        &flatten_dirs,
    )))
}

/// Filter index.json entries by board and sensor, return list of allowed paths.
/// Paths ending with /* are expanded to each subdirectory.
fn filter_entries(
    entries: Option<&Vec<serde_json::Value>>,
    board: Option<&str>,
    sensor: Option<&str>,
    examples_dir: &std::path::Path,
) -> Vec<String> {
    let Some(entries) = entries else {
        return vec![];
    };
    let mut allowed = Vec::new();

    for entry in entries {
        let Some(path) = entry["path"].as_str() else {
            continue;
        };

        // Check board filter
        if let Some(board) = board {
            let boards = entry["boards"].as_array();
            let exclude = entry["exclude_boards"].as_array();

            let board_ok = match boards {
                Some(list) => list
                    .iter()
                    .any(|b| b.as_str() == Some("*") || b.as_str() == Some(board)),
                None => true,
            };

            let excluded = match exclude {
                Some(list) => list.iter().any(|b| b.as_str() == Some(board)),
                None => false,
            };

            if !board_ok || excluded {
                continue;
            }
        }

        // Check sensor filter
        if let Some(sensor) = sensor {
            let sensors = entry["sensors"].as_array();
            let exclude = entry["exclude_sensors"].as_array();

            let sensor_ok = match sensors {
                Some(list) => list
                    .iter()
                    .any(|s| s.as_str() == Some("*") || s.as_str() == Some(sensor)),
                None => true,
            };

            let excluded = match exclude {
                Some(list) => list.iter().any(|s| s.as_str() == Some(sensor)),
                None => false,
            };

            if !sensor_ok || excluded {
                continue;
            }
        }

        // Expand glob: "some/path/*" -> each subdirectory under some/path/
        if let Some(prefix) = path.strip_suffix("/*") {
            let dir = examples_dir.join(prefix);
            if let Ok(rd) = std::fs::read_dir(&dir) {
                for child in rd.filter_map(|e| e.ok()) {
                    if child.path().is_dir() {
                        let child_path =
                            format!("{}/{}", prefix, child.file_name().to_string_lossy());
                        allowed.push(child_path);
                    }
                }
            }
        } else {
            allowed.push(path.to_string());
        }
    }

    allowed
}

#[tauri::command]
fn cmd_read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("{}: {}", path, e))
}

#[tauri::command]
fn cmd_file_mtime(path: String) -> Result<u64, String> {
    let meta = std::fs::metadata(&path).map_err(|e| format!("{}: {}", path, e))?;
    let mtime = meta
        .modified()
        .map_err(|e| format!("{}: {}", path, e))?
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    Ok(mtime)
}

#[tauri::command]
fn cmd_write_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, &content).map_err(|e| format!("{}: {}", path, e))
}

#[tauri::command]
fn find_submenu_by_id(
    menu: &tauri::menu::Menu<tauri::Wry>,
    id: &str,
) -> Option<tauri::menu::Submenu<tauri::Wry>> {
    for item in menu.items().ok()? {
        if let Some(sub) = item.as_submenu() {
            if sub.id().0 == id {
                return Some(sub.clone());
            }

            // Search one level deeper
            for child in sub.items().ok()? {
                if let Some(child_sub) = child.as_submenu() {
                    if child_sub.id().0 == id {
                        return Some(child_sub.clone());
                    }
                }
            }
        }
    }
    None
}

#[tauri::command]
fn cmd_update_recent_menu(paths: Vec<String>, app: tauri::AppHandle) -> Result<(), String> {
    let menu = app
        .menu()
        .or_else(|| app.get_webview_window("main").and_then(|w| w.menu()));

    let Some(menu) = menu else {
        log::warn!("No menu found");
        return Ok(());
    };

    let Some(recent) = find_submenu_by_id(&menu, "open-recent") else {
        log::warn!("Open Recent submenu not found");
        return Ok(());
    };

    // Clear existing items
    // Submenu doesn't have a clear method, so remove items one by one
    loop {
        match recent.items() {
            Ok(items) if !items.is_empty() => {
                for item in &items {
                    let _ = recent.remove(item);
                }
            }
            _ => break,
        }
    }

    if paths.is_empty() {
        recent
            .append(
                &MenuItemBuilder::with_id("recent-none", "(No recent files)")
                    .enabled(false)
                    .build(&app)
                    .map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
    } else {
        for (i, path) in paths.iter().enumerate() {
            let label = path.rsplit('/').next().unwrap_or(path);
            recent
                .append(
                    &MenuItemBuilder::with_id(format!("recent:{}", i), label)
                        .build(&app)
                        .map_err(|e| e.to_string())?,
                )
                .map_err(|e| e.to_string())?;
        }

        recent
            .append(&tauri::menu::PredefinedMenuItem::separator(&app).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        recent
            .append(
                &MenuItemBuilder::with_id("recent-clear", "Clear Recent Files")
                    .build(&app)
                    .map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

fn build_menu(
    app: &tauri::App,
) -> Result<tauri::menu::Menu<tauri::Wry>, Box<dyn std::error::Error>> {
    // macOS app menu (first submenu becomes the app name menu).
    // On Linux/Windows this menu is skipped -- Quit goes into File instead.
    #[cfg(target_os = "macos")]
    let app_menu = SubmenuBuilder::new(app, "OpenMV Studio")
        .about(None)
        .separator()
        .text("settings", "Settings...")
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .item(
            &MenuItemBuilder::with_id("quit", "Quit OpenMV Studio")
                .accelerator("CmdOrCtrl+Q")
                .build(app)?,
        )
        .build()?;

    let open_recent = SubmenuBuilder::with_id(app, "open-recent", "Open Recent")
        .text("recent-none", "(No recent files)")
        .build()?;

    let mut file_builder = SubmenuBuilder::new(app, "File");
    file_builder = file_builder
        .text("new", "New")
        .text("open", "Open...")
        .item(&open_recent)
        .separator()
        .text("save", "Save")
        .text("save-as", "Save As...")
        .separator()
        .close_window();

    #[cfg(not(target_os = "macos"))]
    {
        file_builder = file_builder
            .separator()
            .item(
                &MenuItemBuilder::with_id("quit", "Quit")
                    .accelerator("CmdOrCtrl+Q")
                    .build(app)?,
            );
    }

    let file = file_builder.build()?;

    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .separator()
        .text("find", "Find")
        .text("replace", "Replace")
        .build()?;

    let tools = SubmenuBuilder::new(app, "Tools")
        .text("model-zoo", "Model Zoo")
        .text("apriltag-gen", "AprilTag Generator")
        .text("romfs-editor", "ROMFS Editor")
        .text("pinout-viewer", "Pinout Viewer")
        .build()?;

    let device = SubmenuBuilder::new(app, "Device")
        .text("reset-device", "Reset Device")
        .text("bootloader", "Enter Bootloader")
        .text("fw-update", "Update Firmware")
        .text("erase-fs", "Erase Filesystem")
        .build()?;

    let view = SubmenuBuilder::new(app, "View")
        .text("zoom-in", "Zoom In")
        .text("zoom-out", "Zoom Out")
        .text("zoom-reset", "Reset Zoom")
        .separator()
        .text("toggle-terminal", "Toggle Terminal")
        .text("toggle-fb", "Toggle Frame Buffer")
        .text("toggle-histogram", "Toggle Histogram")
        .separator()
        .text("settings", "Settings...")
        .build()?;

    let help = SubmenuBuilder::new(app, "Help")
        .text("docs", "Documentation")
        .text("about", "About OpenMV Studio")
        .build()?;

    #[cfg(target_os = "macos")]
    let menu = MenuBuilder::new(app)
        .items(&[&app_menu, &file, &edit, &tools, &device, &view, &help])
        .build()?;

    #[cfg(not(target_os = "macos"))]
    let menu = MenuBuilder::new(app)
        .items(&[&file, &edit, &tools, &device, &view, &help])
        .build()?;

    Ok(menu)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Focus the existing window when a second instance is launched
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .manage(Arc::new(SetupComplete(AtomicBool::new(false))))
        .manage(Arc::new(ConnectRunning(AtomicBool::new(false))))
        .manage(Arc::new(DfuRunning(AtomicBool::new(false))))
        .manage(Arc::new(dfu::DfuChild::new()))
        .manage(Arc::new(training::MlProcessState::new()))
        .manage(Arc::new(Mutex::new(AppState {
            boards: vec![],
            sensors: serde_json::json!({}),
            cmd_tx: None,
            worker_thread: None,
            sysinfo: None,
            verinfo: None,
        })))
        .invoke_handler(tauri::generate_handler![
            cmd_open_url,
            cmd_list_ports,
            cmd_connect,
            cmd_disconnect,
            cmd_get_version,
            cmd_get_sysinfo,
            cmd_run_script,
            cmd_stop_script,
            cmd_reset,
            cmd_bootloader,
            cmd_erase_filesystem,
            cmd_romfs_partitions,
            cmd_romfs_read,
            cmd_romfs_write,
            cmd_romfs_read_file_bytes,
            cmd_romfs_load_stock,
            cmd_dfu_exit,
            cmd_enable_streaming,
            cmd_set_stream_source,
            cmd_get_memory,
            cmd_get_stats,
            cmd_read_channel,
            cmd_write_channel,
            cmd_list_examples,
            cmd_read_file,
            cmd_write_file,
            cmd_file_mtime,
            cmd_update_recent_menu,
            cmd_setup_done,
            resources::cmd_check_resources,
            resources::cmd_fetch_manifest,
            resources::cmd_download_resource,
            resources::cmd_resource_path,
            resources::cmd_list_stubs,
            training::cmd_ml_create_project,
            training::cmd_ml_list_projects,
            training::cmd_ml_delete_project,
            training::cmd_ml_import_images,
            training::cmd_ml_start_annotator,
            training::cmd_ml_stop_annotator,
            training::cmd_ml_get_annotations,
            training::cmd_ml_save_annotation,
            training::cmd_ml_set_review_status,
            training::cmd_ml_delete_image,
            training::cmd_ml_train,
            training::cmd_ml_stop_training,
            training::cmd_ml_export,
            training::cmd_ml_stop_export,
            training::cmd_ml_save_export,
            training::cmd_ml_has_trained_model,
            training::cmd_ml_project_image_path,
            cmd_ml_deploy,
        ])
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(log::LevelFilter::Info)
                    .format(|out, message, record| {
                        let target = record
                            .target()
                            .strip_prefix("openmv_studio_lib::")
                            .unwrap_or(record.target());
                        let now = time::OffsetDateTime::now_utc();
                        let (h, m, s) = now.to_hms();
                        out.finish(format_args!(
                            "[{:02}:{:02}:{:02}][{}][{}] {}",
                            h, m, s, target, record.level(), message
                        ))
                    })
                    .targets([
                        tauri_plugin_log::Target::new(
                            tauri_plugin_log::TargetKind::Stderr,
                        ),
                        tauri_plugin_log::Target::new(
                            tauri_plugin_log::TargetKind::Webview,
                        ),
                    ])
                    .build(),
            )?;

            // Load resource files once at startup
            {
                let handle = app.handle();
                let boards = load_boards(handle);
                let sensors = load_sensors(handle);
                let state = app.state::<Arc<Mutex<AppState>>>();
                let mut st = state.lock().unwrap();
                st.boards = boards;
                st.sensors = sensors;
            }

            let menu = build_menu(app)?;
            // On macOS the menu bar is app-level. On Linux, setting it
            // per-window prevents child windows from duplicating it.
            #[cfg(target_os = "macos")]
            app.set_menu(menu)?;
            #[cfg(not(target_os = "macos"))]
            if let Some(main_win) = app.get_webview_window("main") {
                main_win.set_menu(menu)?;
            }

            // Handle menu events -- emit to frontend
            let handle = app.handle().clone();
            app.on_menu_event(move |_app, event| {
                let id = event.id().0.clone();
                if let Some(window) = handle.get_webview_window("main") {
                    if id == "quit" {
                        let _ = window.emit("request-close", ());
                    } else {
                        let _ = window.emit("menu-action", id);
                    }
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.emit("request-close", ());
                } else if window.label() == "resources" {
                    let done = window.state::<Arc<SetupComplete>>();
                    if !done.0.load(Ordering::SeqCst) {
                        window.app_handle().exit(0);
                    }
                } else if window.label() == "dfu-progress" {
                    let running = window.state::<Arc<AtomicBool>>();
                    if running.load(Ordering::SeqCst) {
                        api.prevent_close();
                    }
                }
            }
            tauri::WindowEvent::Destroyed => {
                if window.label() == "main" {
                    window.app_handle().exit(0);
                }
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
