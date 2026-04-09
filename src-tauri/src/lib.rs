mod camera;
mod protocol;
mod transport;

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::ipc::{self, Channel, InvokeResponseBody};
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{Emitter, Manager, State};

use camera::Camera;

struct Board {
    vid: u16,
    pid: u16,
    board_type: String,
    display: String,
}

struct AppState {
    camera: Camera,
    boards: Vec<Board>,
    sensors: serde_json::Value,
    poll_running: Arc<AtomicBool>,
    poll_interval_ms: Arc<AtomicU64>,
}

fn resolve_resource(app: &tauri::AppHandle, name: &str) -> std::path::PathBuf {
    let res_dir = app
        .path()
        .resource_dir()
        .ok()
        .map(|p| p.join("resources").join(name));
    let dev_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("resources")
        .join(name);
    match res_dir {
        Some(ref p) if p.exists() => p.clone(),
        _ => dev_path,
    }
}

fn parse_hex16(s: &str) -> u16 {
    u16::from_str_radix(s.trim_start_matches("0x"), 16).unwrap_or(0)
}

fn load_boards(app: &tauri::AppHandle) -> Vec<Board> {
    let path = resolve_resource(app, "boards.json");
    let json = std::fs::read_to_string(&path)
        .ok()
        .and_then(|data| serde_json::from_str::<serde_json::Value>(&data).ok());
    let Some(entries) = json.as_ref().and_then(|j| j["boards"].as_array()) else {
        return vec![];
    };
    entries.iter().filter_map(|b| {
        let vid = parse_hex16(b["vid"].as_str()?);
        let pid = parse_hex16(b["pid"].as_str()?);
        if vid == 0 { return None; }
        Some(Board {
            vid,
            pid,
            board_type: b["type"].as_str().unwrap_or("Unknown").to_string(),
            display: b["display"].as_str().unwrap_or("Unknown").to_string(),
        })
    }).collect()
}

fn load_sensors(app: &tauri::AppHandle) -> serde_json::Value {
    let path = resolve_resource(app, "sensors.json");
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|data| serde_json::from_str::<serde_json::Value>(&data).ok())
        .unwrap_or(serde_json::json!({}))
}

#[tauri::command]
fn cmd_open_url(url: String) -> Result<(), String> {
    open::that(&url).map_err(|e| e.to_string())
}

#[tauri::command]
fn cmd_list_ports(state: State<Arc<Mutex<AppState>>>) -> Vec<String> {
    let st = state.lock().unwrap();
    serialport::available_ports()
        .unwrap_or_default()
        .into_iter()
        .filter(|p| {
            if let serialport::SerialPortType::UsbPort(info) = &p.port_type {
                st.boards.iter().any(|b| b.vid == info.vid && b.pid == info.pid)
            } else {
                false
            }
        })
        .map(|p| p.port_name)
        .collect()
}

#[tauri::command]
fn cmd_connect(port: String, state: State<Arc<Mutex<AppState>>>) -> Result<(), String> {
    log::info!("Connecting to {}", port);
    let mut st = state.lock().map_err(|e| e.to_string())?;
    let result = st.camera.connect(&port, 921600).map_err(|e| e.to_string());
    match &result {
        Ok(_) => log::info!("Connected to {}", port),
        Err(e) => log::error!("Connect failed: {}", e),
    }
    result
}

#[tauri::command]
fn cmd_disconnect(state: State<Arc<Mutex<AppState>>>) -> Result<(), String> {
    log::info!("Disconnecting");
    let mut st = state.lock().map_err(|e| e.to_string())?;
    st.camera.disconnect();
    Ok(())
}

#[tauri::command]
fn cmd_get_version(state: State<Arc<Mutex<AppState>>>) -> Result<serde_json::Value, String> {
    let st = state.lock().map_err(|e| e.to_string())?;
    let v = st.camera.verinfo.as_ref().ok_or("Not connected")?;
    Ok(serde_json::json!({
        "protocol": v.protocol,
        "bootloader": v.bootloader,
        "firmware": v.firmware,
    }))
}

#[tauri::command]
fn cmd_get_sysinfo(state: State<Arc<Mutex<AppState>>>) -> Result<serde_json::Value, String> {
    let st = state.lock().map_err(|e| e.to_string())?;
    let info = st.camera.sysinfo.as_ref().ok_or("Not connected")?;
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
    boards.iter()
        .find(|b| b.vid == vid && b.pid == pid)
        .map(|b| (b.board_type.clone(), b.display.clone()))
        .unwrap_or_else(|| (format!("{:04X}:{:04X}", vid, pid), "Unknown Board".to_string()))
}

fn lookup_sensor(sensors: &serde_json::Value, chip_id: u32) -> String {
    let key = format!("0x{:X}", chip_id);
    sensors["sensors"][&key].as_str()
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("Unknown (0x{:X})", chip_id))
}

#[tauri::command]
fn cmd_get_memory(state: State<Arc<Mutex<AppState>>>) -> Result<serde_json::Value, String> {
    let mut st = state.lock().map_err(|e| e.to_string())?;
    let entries = st.camera.memory_stats().map_err(|e| e.to_string())?;
    serde_json::to_value(&entries).map_err(|e| e.to_string())
}

#[tauri::command]
fn cmd_get_stats(state: State<Arc<Mutex<AppState>>>) -> Result<serde_json::Value, String> {
    let mut st = state.lock().map_err(|e| e.to_string())?;
    let stats = st.camera.device_stats().map_err(|e| e.to_string())?;
    let channels: Vec<serde_json::Value> = st.camera.get_channels()
        .into_iter()
        .map(|(name, id)| serde_json::json!({"name": name, "id": id}))
        .collect();
    Ok(serde_json::json!({
        "stats": stats,
        "channels": channels,
    }))
}

#[tauri::command]
fn cmd_set_stream_source(chip_id: u32, state: State<Arc<Mutex<AppState>>>) -> Result<(), String> {
    let mut st = state.lock().map_err(|e| e.to_string())?;
    st.camera
        .set_stream_source(chip_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn cmd_run_script(script: String, state: State<Arc<Mutex<AppState>>>) -> Result<(), String> {
    let mut st = state.lock().map_err(|e| e.to_string())?;
    st.camera.exec_script(&script).map_err(|e| e.to_string())
}

#[tauri::command]
fn cmd_stop_script(state: State<Arc<Mutex<AppState>>>) -> Result<(), String> {
    let mut st = state.lock().map_err(|e| e.to_string())?;
    st.camera.stop_script().map_err(|e| e.to_string())
}

#[tauri::command]
fn cmd_enable_streaming(enable: bool, raw: bool, state: State<Arc<Mutex<AppState>>>) -> Result<(), String> {
    let mut st = state.lock().map_err(|e| e.to_string())?;
    st.camera
        .enable_streaming(enable, raw)
        .map_err(|e| e.to_string())
}

// Channel message format (single binary message per poll iteration):
// [flags:u8] [stdout_len:u32] [stdout_bytes] [width:u32] [height:u32] [format:u32] [pixel_data]
// If no frame: width and height are both 0, no format or pixel_data follows.

#[tauri::command]
fn cmd_start_polling(
    interval_ms: u64,
    channel: Channel,
    app: tauri::AppHandle,
    state: State<Arc<Mutex<AppState>>>,
) -> Result<(), String> {
    let mut st = state.lock().map_err(|e| e.to_string())?;

    // Stop any existing poll thread (its Arc becomes orphaned)
    st.poll_running.store(false, Ordering::Relaxed);

    // Fresh stop flag for the new thread -- the old thread's
    // cleanup can't clobber this since it holds a different Arc.
    let running = Arc::new(AtomicBool::new(true));
    st.poll_running = running.clone();
    st.poll_interval_ms.store(interval_ms, Ordering::Relaxed);

    let interval = st.poll_interval_ms.clone();
    let state_mtx = app.state::<Arc<Mutex<AppState>>>().inner().clone();
    drop(st);

    std::thread::spawn(move || {
        poll_loop(&state_mtx, &channel, &running, &interval);
    });

    Ok(())
}

fn poll_loop(
    state: &Arc<Mutex<AppState>>,
    channel: &Channel,
    running: &AtomicBool,
    interval: &AtomicU64,
) {
    while running.load(Ordering::Relaxed) {
        let sleep_ms = interval.load(Ordering::Relaxed);

        // Single lock: poll() does poll_status + stdout + read_frame with
        // proper resync error recovery, then we drop the lock before sending.
        let poll_result = {
            let mut st = match state.lock() {
                Ok(st) => st,
                Err(_) => break,
            };
            st.camera.poll()
        };

        // Build single binary message:
        // [flags:u8] [stdout_len:u32] [stdout] [w:u32] [h:u32] [fmt:u32] [pixels]
        let stdout_bytes = poll_result.stdout.unwrap_or_default().into_bytes();
        let flags = (poll_result.script_running as u8)
            | ((poll_result.connected as u8) << 1);

        let frame_size = poll_result.frame.as_ref()
            .map(|f| 12 + f.data.len()).unwrap_or(8);
        let mut buf = Vec::with_capacity(5 + stdout_bytes.len() + frame_size);

        buf.push(flags);
        buf.extend_from_slice(&(stdout_bytes.len() as u32).to_le_bytes());
        buf.extend_from_slice(&stdout_bytes);

        if let Some(f) = poll_result.frame {
            buf.extend_from_slice(&f.width.to_le_bytes());
            buf.extend_from_slice(&f.height.to_le_bytes());
            buf.extend_from_slice(&f.format.to_le_bytes());
            buf.extend_from_slice(&f.data);
        } else {
            buf.extend_from_slice(&0u32.to_le_bytes());
            buf.extend_from_slice(&0u32.to_le_bytes());
        }

        let _ = channel.send(InvokeResponseBody::Raw(buf));

        if !poll_result.connected {
            break;
        }

        std::thread::sleep(std::time::Duration::from_millis(sleep_ms));
    }

    running.store(false, Ordering::Relaxed);
}

#[tauri::command]
fn cmd_stop_polling(state: State<Arc<Mutex<AppState>>>) -> Result<(), String> {
    let st = state.lock().map_err(|e| e.to_string())?;
    st.poll_running.store(false, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
fn cmd_set_poll_interval(interval_ms: u64, state: State<Arc<Mutex<AppState>>>) -> Result<(), String> {
    let st = state.lock().map_err(|e| e.to_string())?;
    st.poll_interval_ms.store(interval_ms, Ordering::Relaxed);
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
            let na = a["name"].as_str().unwrap_or("");
            let nb = b["name"].as_str().unwrap_or("");
            na.to_ascii_lowercase().cmp(&nb.to_ascii_lowercase())
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
fn cmd_write_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, &content).map_err(|e| format!("{}: {}", path, e))
}

fn build_menu(
    app: &tauri::App,
) -> Result<tauri::menu::Menu<tauri::Wry>, Box<dyn std::error::Error>> {
    // macOS app menu (first submenu becomes the app name menu)
    let app_menu = SubmenuBuilder::new(app, "OpenMV IDE")
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
            &MenuItemBuilder::with_id("quit", "Quit OpenMV IDE")
                .accelerator("CmdOrCtrl+Q")
                .build(app)?,
        )
        .build()?;

    let file = SubmenuBuilder::new(app, "File")
        .text("new", "New")
        .text("open", "Open...")
        .text("open-recent", "Open Recent")
        .separator()
        .text("save", "Save")
        .text("save-as", "Save As...")
        .separator()
        .close_window()
        .build()?;

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
        .text("threshold-editor", "Threshold Editor")
        .text("apriltag-gen", "AprilTag Generator")
        .separator()
        .text("save-image", "Save Image")
        .text("save-template", "Save Template")
        .text("save-descriptor", "Save Descriptor")
        .separator()
        .text("model-zoo", "Model Zoo")
        .text("edge-impulse", "Edge Impulse")
        .separator()
        .text("dataset-editor", "Dataset Editor")
        .text("video-tools", "Video Tools")
        .build()?;

    let device = SubmenuBuilder::new(app, "Device")
        .text("fw-update", "Update Firmware")
        .text("romfs-editor", "ROMFS Editor")
        .separator()
        .text("wifi-settings", "WiFi Settings")
        .text("camera-settings", "Camera Settings")
        .separator()
        .text("reset-device", "Reset Device")
        .text("bootloader", "Enter Bootloader")
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
        .text("examples", "Examples")
        .separator()
        .text("about", "About OpenMV IDE")
        .build()?;

    let menu = MenuBuilder::new(app)
        .items(&[&app_menu, &file, &edit, &tools, &device, &view, &help])
        .build()?;

    Ok(menu)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .manage(Arc::new(Mutex::new(AppState {
            camera: Camera::new(),
            boards: vec![],
            sensors: serde_json::json!({}),
            poll_running: Arc::new(AtomicBool::new(false)),
            poll_interval_ms: Arc::new(AtomicU64::new(50)),
        })))
        .invoke_handler(tauri::generate_handler![
            cmd_open_url,
            cmd_list_ports,
            cmd_connect,
            cmd_disconnect,
            cmd_get_version,
            cmd_get_sysinfo,
            cmd_get_memory,
            cmd_get_stats,
            cmd_run_script,
            cmd_stop_script,
            cmd_enable_streaming,
            cmd_set_stream_source,
            cmd_start_polling,
            cmd_stop_polling,
            cmd_set_poll_interval,
            cmd_list_examples,
            cmd_read_file,
            cmd_write_file,
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .target(tauri_plugin_log::Target::new(
                            tauri_plugin_log::TargetKind::Stderr,
                        ))
                        .build(),
                )?;
            }

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
            app.set_menu(menu)?;

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
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.emit("request-close", ());
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
