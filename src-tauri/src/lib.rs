mod camera;
mod protocol;
mod transport;

use std::sync::Mutex;
use tauri::ipc;
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{Emitter, Manager, State};

use camera::Camera;

struct AppState {
    camera: Camera,
}

fn load_known_vid_pids(app: &tauri::AppHandle) -> Vec<(u16, u16)> {
    let res_dir = app
        .path()
        .resource_dir()
        .ok()
        .map(|p| p.join("resources").join("boards.json"));
    let dev_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("resources")
        .join("boards.json");
    let path = match res_dir {
        Some(ref p) if p.exists() => p.clone(),
        _ => dev_path,
    };
    let mut pairs = Vec::new();
    if let Ok(data) = std::fs::read_to_string(&path)
        && let Ok(json) = serde_json::from_str::<serde_json::Value>(&data)
        && let Some(boards) = json["boards"].as_array()
    {
        for b in boards {
            if let (Some(vs), Some(ps)) = (b["vid"].as_str(), b["pid"].as_str()) {
                let vid = u16::from_str_radix(vs.trim_start_matches("0x"), 16).unwrap_or(0);
                let pid = u16::from_str_radix(ps.trim_start_matches("0x"), 16).unwrap_or(0);
                if vid != 0 {
                    pairs.push((vid, pid));
                }
            }
        }
    }
    pairs
}

#[tauri::command]
fn cmd_list_ports(app: tauri::AppHandle) -> Vec<String> {
    let known = load_known_vid_pids(&app);
    serialport::available_ports()
        .unwrap_or_default()
        .into_iter()
        .filter(|p| {
            if let serialport::SerialPortType::UsbPort(info) = &p.port_type {
                known
                    .iter()
                    .any(|(vid, pid)| info.vid == *vid && info.pid == *pid)
            } else {
                false
            }
        })
        .map(|p| p.port_name)
        .collect()
}

#[tauri::command]
fn cmd_connect(port: String, state: State<Mutex<AppState>>) -> Result<(), String> {
    let mut st = state.lock().map_err(|e| e.to_string())?;
    st.camera.connect(&port, 921600).map_err(|e| e.to_string())
}

#[tauri::command]
fn cmd_disconnect(state: State<Mutex<AppState>>) -> Result<(), String> {
    let mut st = state.lock().map_err(|e| e.to_string())?;
    st.camera.disconnect();
    Ok(())
}

#[tauri::command]
fn cmd_get_version(state: State<Mutex<AppState>>) -> Result<serde_json::Value, String> {
    let st = state.lock().map_err(|e| e.to_string())?;
    let v = st.camera.verinfo.as_ref().ok_or("Not connected")?;
    Ok(serde_json::json!({
        "protocol": v.protocol,
        "bootloader": v.bootloader,
        "firmware": v.firmware,
    }))
}

#[tauri::command]
fn cmd_get_sysinfo(
    app: tauri::AppHandle,
    state: State<Mutex<AppState>>,
) -> Result<serde_json::Value, String> {
    let st = state.lock().map_err(|e| e.to_string())?;
    let info = st.camera.sysinfo.as_ref().ok_or("Not connected")?;
    let (board_type, board_name) = lookup_board(&app, info.usb_vid, info.usb_pid);
    let sensors: Vec<serde_json::Value> = info
        .chip_ids
        .iter()
        .filter(|&&id| id != 0)
        .map(|&id| {
            let name = lookup_sensor(&app, id);
            serde_json::json!({ "chip_id": id, "name": name })
        })
        .collect();
    Ok(serde_json::json!({
        "cpu_id": info.cpu_id,
        "usb_vid": info.usb_vid,
        "usb_pid": info.usb_pid,
        "board_type": board_type,
        "board_name": board_name,
        "flash_size_kb": info.flash_size_kb,
        "ram_size_kb": info.ram_size_kb,
        "npu_present": info.npu_present,
        "pmu_present": info.pmu_present,
        "sensors": sensors,
    }))
}

fn lookup_board(app: &tauri::AppHandle, vid: u16, pid: u16) -> (String, String) {
    let res_dir = app
        .path()
        .resource_dir()
        .ok()
        .map(|p| p.join("resources").join("boards.json"));
    let dev_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("resources")
        .join("boards.json");
    let path = match res_dir {
        Some(ref p) if p.exists() => p.clone(),
        _ => dev_path,
    };
    let vid_str = format!("0x{:04X}", vid);
    let pid_str = format!("0x{:04X}", pid);
    if let Ok(data) = std::fs::read_to_string(&path)
        && let Ok(json) = serde_json::from_str::<serde_json::Value>(&data)
        && let Some(boards) = json["boards"].as_array()
    {
        for b in boards {
            if b["vid"].as_str() == Some(&vid_str) && b["pid"].as_str() == Some(&pid_str) {
                return (
                    b["type"].as_str().unwrap_or("Unknown").to_string(),
                    b["display"].as_str().unwrap_or("Unknown").to_string(),
                );
            }
        }
    }
    (
        format!("{:04X}:{:04X}", vid, pid),
        "Unknown Board".to_string(),
    )
}

fn lookup_sensor(app: &tauri::AppHandle, chip_id: u32) -> String {
    let res_dir = app
        .path()
        .resource_dir()
        .ok()
        .map(|p| p.join("resources").join("sensors.json"));
    let dev_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("resources")
        .join("sensors.json");
    let path = match res_dir {
        Some(ref p) if p.exists() => p.clone(),
        _ => dev_path,
    };
    let key = format!("0x{:X}", chip_id);
    if let Ok(data) = std::fs::read_to_string(&path)
        && let Ok(json) = serde_json::from_str::<serde_json::Value>(&data)
        && let Some(name) = json["sensors"][&key].as_str()
    {
        return name.to_string();
    }
    format!("Unknown (0x{:X})", chip_id)
}

#[tauri::command]
fn cmd_get_memory(state: State<Mutex<AppState>>) -> Result<serde_json::Value, String> {
    let mut st = state.lock().map_err(|e| e.to_string())?;
    let entries = st.camera.memory_stats().map_err(|e| e.to_string())?;
    serde_json::to_value(&entries).map_err(|e| e.to_string())
}

#[tauri::command]
fn cmd_set_stream_source(chip_id: u32, state: State<Mutex<AppState>>) -> Result<(), String> {
    let mut st = state.lock().map_err(|e| e.to_string())?;
    st.camera
        .set_stream_source(chip_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn cmd_run_script(script: String, state: State<Mutex<AppState>>) -> Result<(), String> {
    let mut st = state.lock().map_err(|e| e.to_string())?;
    st.camera.exec_script(&script).map_err(|e| e.to_string())
}

#[tauri::command]
fn cmd_stop_script(state: State<Mutex<AppState>>) -> Result<(), String> {
    let mut st = state.lock().map_err(|e| e.to_string())?;
    st.camera.stop_script().map_err(|e| e.to_string())
}

#[tauri::command]
fn cmd_enable_streaming(enable: bool, state: State<Mutex<AppState>>) -> Result<(), String> {
    let mut st = state.lock().map_err(|e| e.to_string())?;
    st.camera
        .enable_streaming(enable)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn cmd_poll(state: State<Mutex<AppState>>) -> Result<ipc::Response, String> {
    let mut st = state.lock().map_err(|e| e.to_string())?;
    let result = st.camera.poll();

    let stdout_bytes = result.stdout.unwrap_or_default().into_bytes();
    let mut buf = Vec::with_capacity(stdout_bytes.len() + 256);

    // Script running flag
    buf.push(result.script_running as u8);

    buf.extend_from_slice(&(stdout_bytes.len() as u32).to_le_bytes());
    buf.extend_from_slice(&stdout_bytes);

    if let Some(f) = result.frame {
        buf.extend_from_slice(&f.width.to_le_bytes());
        buf.extend_from_slice(&f.height.to_le_bytes());
        let fmt = f.format_str.as_bytes();
        buf.push(fmt.len() as u8);
        buf.extend_from_slice(fmt);
        buf.push(f.is_jpeg as u8);
        buf.extend_from_slice(&f.data);
    } else {
        buf.extend_from_slice(&0u32.to_le_bytes());
        buf.extend_from_slice(&0u32.to_le_bytes());
    }

    Ok(ipc::Response::new(buf))
}

#[tauri::command]
fn cmd_list_examples(
    app: tauri::AppHandle,
    board: Option<String>,
    sensor: Option<String>,
) -> Result<serde_json::Value, String> {
    let res_dir = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("resources")
        .join("examples");

    // Fallback for dev mode
    let examples_dir = if res_dir.exists() {
        res_dir
    } else {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("resources")
            .join("examples")
    };

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
        .manage(Mutex::new(AppState {
            camera: Camera::new(),
        }))
        .invoke_handler(tauri::generate_handler![
            cmd_list_ports,
            cmd_connect,
            cmd_disconnect,
            cmd_get_version,
            cmd_get_sysinfo,
            cmd_get_memory,
            cmd_run_script,
            cmd_stop_script,
            cmd_enable_streaming,
            cmd_set_stream_source,
            cmd_poll,
            cmd_list_examples,
            cmd_read_file,
            cmd_write_file,
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
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
