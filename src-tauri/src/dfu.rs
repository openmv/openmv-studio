// Copyright (C) 2026 OpenMV, LLC.
//
// This software is licensed under terms that can be found in the
// LICENSE file in the root directory of this software component.

use tauri::{AppHandle, Emitter};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandEvent;
use crate::resolve_resource;

pub struct DfuConfig {
    pub vid_pid: String,
    pub fs_partition: Vec<String>,
}

fn parse_dfu_args(cmd: &str) -> Vec<String> {
    cmd.split_whitespace().map(|s| s.to_string()).collect()
}

pub fn erase_filesystem(app: &AppHandle, config: &DfuConfig) -> Result<(), String> {
    let _ = app.emit("dfu-progress", "Creating temporary erase file...");

    // Create temp file (4096 bytes of 0xFF)
    let temp_dir = std::env::temp_dir();
    let temp_path = temp_dir.join("openmv_erase.bin");
    let erase_data = vec![0xFFu8; 4096];
    std::fs::write(&temp_path, &erase_data)
        .map_err(|e| format!("Failed to create temp file: {}", e))?;

    let total = config.fs_partition.len();

    for (i, cmd) in config.fs_partition.iter().enumerate() {
        let is_last = i == total - 1;

        let mut args = vec![
            "-w".to_string(),
            "-d".to_string(),
            format!(",{}", config.vid_pid),
        ];
        args.extend(parse_dfu_args(cmd));
        args.push("-D".to_string());
        args.push(temp_path.to_string_lossy().to_string());

        if is_last {
            args.push("--reset".to_string());
        }

        let msg = format!("Running dfu-util ({}/{})...", i + 1, total);
        let _ = app.emit("dfu-progress", &msg);
        log::debug!("dfu-util {:?}", args);

        let dfu_name = format!("tools/dfu-util{}", std::env::consts::EXE_SUFFIX);
        let dfu_path = resolve_resource(app, &dfu_name);
        let sidecar = app
            .shell()
            .command(&dfu_path)
            .args(&args);

        let (mut rx, _child) = sidecar
            .spawn()
            .map_err(|e| format!("Failed to spawn dfu-util: {}", e))?;

        // Block on output events until the process exits
        let status = tauri::async_runtime::block_on(async {
            let mut exit_code: Option<i32> = None;
            while let Some(event) = rx.recv().await {
                match event {
                    CommandEvent::Stdout(line) => {
                        let text = String::from_utf8_lossy(&line);
                        log::debug!("dfu-util: {}", text);
                        let _ = app.emit("dfu-progress", text.as_ref());
                    }
                    CommandEvent::Stderr(line) => {
                        let text = String::from_utf8_lossy(&line);
                        log::debug!("dfu-util: {}", text);
                        let _ = app.emit("dfu-progress", text.as_ref());
                    }
                    CommandEvent::Terminated(payload) => {
                        exit_code = payload.code;
                    }
                    _ => {}
                }
            }
            exit_code
        });

        if status != Some(0) {
            let _ = std::fs::remove_file(&temp_path);
            let msg = format!("dfu-util exited with status {}", status.unwrap_or(-1));
            let _ = app.emit("dfu-progress", msg.as_str());
            let _ = app.emit("dfu-done", ());
            return Err(msg);
        }
    }

    let _ = std::fs::remove_file(&temp_path);
    let _ = app.emit("dfu-progress", "Erase complete.");
    let _ = app.emit("dfu-done", ());
    Ok(())
}
