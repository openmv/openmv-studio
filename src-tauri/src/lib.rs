mod camera;
mod protocol;
mod transport;

use std::sync::{Arc, Mutex, mpsc};
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{Emitter, Manager, State};

use camera::{Camera, Command};
use protocol::{SystemInfo, VersionInfo};

struct Board {
    vid: u16,
    pid: u16,
    board_type: String,
    display: String,
}

struct AppState {
    boards: Vec<Board>,
    sensors: serde_json::Value,
    cmd_tx: Option<mpsc::Sender<Command>>,
    worker_thread: Option<std::thread::JoinHandle<()>>,
    sysinfo: Option<SystemInfo>,
    verinfo: Option<VersionInfo>,
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
            })
        })
        .collect()
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
fn cmd_list_ports(all: Option<bool>, state: State<Arc<Mutex<AppState>>>) -> Vec<String> {
    let st = state.lock().unwrap();
    let all = all.unwrap_or(false);
    serialport::available_ports()
        .unwrap_or_default()
        .into_iter()
        .filter(|p| !p.port_name.contains("/tty."))
        .filter(|p| {
            if all {
                return true;
            }
            if let serialport::SerialPortType::UsbPort(info) = &p.port_type {
                st.boards
                    .iter()
                    .any(|b| b.vid == info.vid && b.pid == info.pid)
            } else {
                false
            }
        })
        .map(|p| p.port_name)
        .collect()
}

#[tauri::command]
fn cmd_connect(
    port: String,
    channel: Channel,
    poll_interval_ms: u64,
    state: State<Arc<Mutex<AppState>>>,
) -> Result<(), String> {
    log::info!("Connecting to {}", port);

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

    // Connect synchronously (no lock held -- serial I/O can block)
    let mut camera = Camera::new();
    camera.connect(&port, 921600).map_err(|e| {
        log::error!("Connect failed: {}", e);
        e.to_string()
    })?;

    // Cache info and spawn worker
    let mut st = state.lock().map_err(|e| e.to_string())?;
    st.sysinfo = camera.sysinfo.clone();
    st.verinfo = camera.verinfo.clone();

    let (tx, rx) = mpsc::channel();
    let interval = Duration::from_millis(poll_interval_ms);

    let handle = std::thread::spawn(move || {
        camera.run(rx, &channel, interval);
    });

    st.cmd_tx = Some(tx);
    st.worker_thread = Some(handle);

    log::info!("Connected to {}", port);
    Ok(())
}

#[tauri::command]
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

    let open_recent = SubmenuBuilder::with_id(app, "open-recent", "Open Recent")
        .text("recent-none", "(No recent files)")
        .build()?;

    let file = SubmenuBuilder::new(app, "File")
        .text("new", "New")
        .text("open", "Open...")
        .item(&open_recent)
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
        .text("romfs-editor", "ROMFS Editor")
        .separator()
        .text("model-zoo", "Model Zoo")
        .text("apriltag-gen", "AprilTag Generator")
        .build()?;

    let device = SubmenuBuilder::new(app, "Device")
        .text("reset-device", "Reset Device")
        .text("bootloader", "Enter Bootloader")
        .text("fw-update", "Update Firmware")
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
            cmd_enable_streaming,
            cmd_set_stream_source,
            cmd_get_memory,
            cmd_get_stats,
            cmd_read_channel,
            cmd_list_examples,
            cmd_read_file,
            cmd_write_file,
            cmd_file_mtime,
            cmd_update_recent_menu,
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .targets([tauri_plugin_log::Target::new(
                            tauri_plugin_log::TargetKind::Stderr,
                        )])
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
