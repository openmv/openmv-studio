// Copyright (C) 2026 OpenMV, LLC.
//
// This software is licensed under terms that can be found in the
// LICENSE file in the root directory of this software component.
//
// ML training pipeline: project management, frame capture, auto-annotation,
// and model training via Python subprocesses.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandEvent;

use crate::resolve_resource;

// -- Types ------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone)]
pub struct ProjectConfig {
    pub name: String,
    pub classes: Vec<String>,
    pub imgsz: u32,
    pub created: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct ProjectInfo {
    pub name: String,
    pub classes: Vec<String>,
    pub imgsz: u32,
    pub model: Option<String>,
    pub image_count: usize,
    pub label_count: usize,
    pub reviewed_count: usize,
    pub has_trained_model: bool,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct AnnotationEvent {
    pub image: String,
    pub detections: usize,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct TrainProgressEvent {
    pub epoch: u32,
    pub epochs: u32,
    pub box_loss: f64,
    pub cls_loss: f64,
    #[serde(rename = "mAP50")]
    pub map50: f64,
    #[serde(default)]
    pub epoch_secs: f64,
    #[serde(default)]
    pub elapsed_secs: f64,
    #[serde(default)]
    pub eta_secs: f64,
}

/// Holds the PID of a running annotator, training, or export subprocess
/// so it can be stopped on demand.
pub struct MlProcessState {
    pub annotator_pid: Mutex<Option<u32>>,
    pub training_pid: Mutex<Option<u32>>,
    pub export_pid: Mutex<Option<u32>>,
    pub import_running: AtomicBool,
}

impl MlProcessState {
    pub fn new() -> Self {
        Self {
            annotator_pid: Mutex::new(None),
            training_pid: Mutex::new(None),
            export_pid: Mutex::new(None),
            import_running: AtomicBool::new(false),
        }
    }
}

// -- Helpers ----------------------------------------------------------------

fn kill_process(pid: u32) {
    #[cfg(unix)]
    {
        let output = std::process::Command::new("pgrep")
            .args(&["-P", &pid.to_string()])
            .output();
        if let Ok(out) = output {
            for line in String::from_utf8_lossy(&out.stdout).lines() {
                if let Ok(child_pid) = line.trim().parse::<u32>() {
                    kill_process(child_pid);
                }
            }
        }
        let _ = std::process::Command::new("kill")
            .args(&["-KILL", &pid.to_string()])
            .output();
    }
    #[cfg(windows)]
    {
        let _ = std::process::Command::new("taskkill")
            .args(&["/PID", &pid.to_string(), "/T", "/F"])
            .output();
    }
}

fn training_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?
        .join("training");
    Ok(dir)
}

fn project_dir(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let dir = training_dir(app)?.join(name);
    Ok(dir)
}

fn python_path(app: &AppHandle) -> Result<String, String> {
    let resources = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?
        .join("resources")
        .join("tools");

    // Platform-aware Python path
    let python = if cfg!(target_os = "windows") {
        resources.join("python").join("python.exe")
    } else {
        resources.join("python").join("bin").join("python3")
    };

    if python.exists() {
        Ok(python.to_string_lossy().to_string())
    } else {
        Err(format!("Python not found at: {}", python.display()))
    }
}

fn models_dir(app: &AppHandle) -> Result<String, String> {
    let dir = resolve_resource(app, "models");
    if !dir.exists() {
        return Err(format!(
            "Models resource not found at {}. Download resources from Settings.",
            dir.display()
        ));
    }
    Ok(dir.to_string_lossy().to_string())
}

fn stedgeai_dir(app: &AppHandle) -> Result<String, String> {
    let dir = resolve_resource(app, "tools/stedgeai");
    if !dir.exists() {
        return Err(format!(
            "stedgeai not found at {}. Download resources from Settings.",
            dir.display()
        ));
    }
    Ok(dir.to_string_lossy().to_string())
}

fn script_path(app: &AppHandle, script: &str) -> Result<String, String> {
    let path = app
        .path()
        .resolve(
            format!("scripts/{}", script),
            tauri::path::BaseDirectory::Resource,
        )
        .map_err(|e| format!("Failed to resolve script path: {}", e))?;

    if path.exists() {
        Ok(path.to_string_lossy().to_string())
    } else {
        Err(format!("Script not found: {}", path.display()))
    }
}

fn count_files(dir: &PathBuf, ext: &str) -> usize {
    if !dir.exists() {
        return 0;
    }
    std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .filter_map(|e| e.ok())
                .filter(|e| {
                    e.path()
                        .extension()
                        .and_then(|x| x.to_str())
                        .map(|x| x == ext)
                        .unwrap_or(false)
                })
                .count()
        })
        .unwrap_or(0)
}

fn read_review_status(proj: &PathBuf) -> serde_json::Value {
    let status_path = proj.join("status.json");
    if status_path.exists() {
        std::fs::read_to_string(&status_path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    }
}

// -- Commands ---------------------------------------------------------------

#[tauri::command]
pub fn cmd_ml_create_project(
    app: AppHandle,
    name: String,
    classes: Vec<String>,
    imgsz: Option<u32>,
) -> Result<(), String> {
    let proj = project_dir(&app, &name)?;
    if proj.exists() {
        return Err(format!("Project already exists: {}", name));
    }

    std::fs::create_dir_all(proj.join("images"))
        .map_err(|e| format!("Failed to create images dir: {}", e))?;
    std::fs::create_dir_all(proj.join("labels"))
        .map_err(|e| format!("Failed to create labels dir: {}", e))?;

    let config = ProjectConfig {
        name: name.clone(),
        classes,
        imgsz: imgsz.unwrap_or(192),
        created: chrono_now(),
        model: None,
    };

    let json = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;
    std::fs::write(proj.join("project.json"), json)
        .map_err(|e| format!("Failed to write project.json: {}", e))?;
    std::fs::write(proj.join("status.json"), "{}")
        .map_err(|e| format!("Failed to write status.json: {}", e))?;

    Ok(())
}

fn chrono_now() -> String {
    let now = time::OffsetDateTime::now_utc();
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        now.year(),
        now.month() as u8,
        now.day(),
        now.hour(),
        now.minute(),
        now.second()
    )
}

#[tauri::command]
pub fn cmd_ml_list_projects(app: AppHandle) -> Result<Vec<ProjectInfo>, String> {
    let dir = training_dir(&app)?;
    if !dir.exists() {
        return Ok(vec![]);
    }

    let mut projects = Vec::new();
    let entries = std::fs::read_dir(&dir)
        .map_err(|e| format!("Failed to read training dir: {}", e))?;

    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let config_path = path.join("project.json");
        if !config_path.exists() {
            continue;
        }
        let config_str = std::fs::read_to_string(&config_path)
            .map_err(|e| format!("Failed to read project.json: {}", e))?;
        let config: ProjectConfig = serde_json::from_str(&config_str)
            .map_err(|e| format!("Failed to parse project.json: {}", e))?;

        let image_count = count_files(&path.join("images"), "jpg");
        let label_count = count_files(&path.join("labels"), "txt");
        let status = read_review_status(&path);
        let reviewed_count = status
            .as_object()
            .map(|m| {
                m.values()
                    .filter(|v| v.as_str() == Some("accepted"))
                    .count()
            })
            .unwrap_or(0);
        let has_trained_model = path
            .join("runs")
            .join("train")
            .join("weights")
            .join("best.pt")
            .exists();

        projects.push(ProjectInfo {
            name: config.name,
            classes: config.classes,
            imgsz: config.imgsz,
            model: config.model,
            image_count,
            label_count,
            reviewed_count,
            has_trained_model,
        });
    }

    projects.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(projects)
}

#[tauri::command]
pub fn cmd_ml_has_trained_model(
    app: AppHandle,
    project: String,
) -> Result<bool, String> {
    let proj = project_dir(&app, &project)?;
    Ok(proj
        .join("runs")
        .join("train")
        .join("weights")
        .join("best.pt")
        .exists())
}

#[tauri::command(async)]
pub fn cmd_ml_delete_project(app: AppHandle, name: String) -> Result<(), String> {
    let proj = project_dir(&app, &name)?;
    if !proj.exists() {
        return Err(format!("Project not found: {}", name));
    }
    std::fs::remove_dir_all(&proj)
        .map_err(|e| format!("Failed to delete project: {}", e))?;
    Ok(())
}

/// Import images from filesystem paths into a project.
/// Copies each file into the project's images/ directory with a
/// sequential name (img_00001.jpg, ...).  Supports jpg, jpeg, png,
/// and bmp source files.
#[tauri::command(async)]
pub fn cmd_ml_import_images(
    app: AppHandle,
    state: State<'_, Arc<MlProcessState>>,
    project: String,
    paths: Vec<String>,
) -> Result<usize, String> {
    if state
        .import_running
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("Import already in progress".into());
    }
    struct Guard<'a>(&'a AtomicBool);
    impl Drop for Guard<'_> {
        fn drop(&mut self) {
            self.0.store(false, Ordering::SeqCst);
        }
    }
    let _guard = Guard(&state.import_running);

    log::info!("Importing {} images into project: {}", paths.len(), project);
    let proj = project_dir(&app, &project)?;
    let images_dir = proj.join("images");
    if !images_dir.exists() {
        std::fs::create_dir_all(&images_dir)
            .map_err(|e| format!("Failed to create images dir: {}", e))?;
    }

    // Find next available index
    let existing = count_files(&images_dir, "jpg");
    let mut idx = existing as u32;
    let mut imported = 0usize;

    for src in &paths {
        let src_path = std::path::Path::new(src);
        if !src_path.exists() {
            continue;
        }
        let ext = src_path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        if !matches!(ext.as_str(), "jpg" | "jpeg" | "png" | "bmp") {
            continue;
        }

        let dest = images_dir.join(format!("img_{:05}.jpg", idx));
        std::fs::copy(src_path, &dest)
            .map_err(|e| format!("Failed to copy {}: {}", src, e))?;
        idx += 1;
        imported += 1;
    }

    Ok(imported)
}

#[tauri::command]
pub async fn cmd_ml_start_annotator(
    app: AppHandle,
    state: State<'_, Arc<MlProcessState>>,
    project: String,
    conf: Option<f32>,
) -> Result<(), String> {
    {
        let mut pid = state.annotator_pid.lock().unwrap();
        if let Some(p) = pid.take() {
            kill_process(p);
        }
    }

    let proj = project_dir(&app, &project)?;
    let images_dir = proj.join("images");
    let labels_dir = proj.join("labels");
    log::info!("Starting annotator for project: {}", project);
    std::fs::create_dir_all(&labels_dir)
        .map_err(|e| format!("Failed to create labels dir: {}", e))?;

    let py = python_path(&app)?;
    let script = script_path(&app, "annotate.py")?;
    let models_dir = models_dir(&app)?;
    let conf_str = format!("{:.2}", conf.unwrap_or(0.25));

    // Read project classes for COCO class filtering/remapping
    let config_str = std::fs::read_to_string(proj.join("project.json"))
        .map_err(|e| format!("Failed to read project.json: {}", e))?;
    let config: ProjectConfig = serde_json::from_str(&config_str)
        .map_err(|e| format!("Failed to parse project.json: {}", e))?;
    let classes_csv = config.classes.join(",");

    let sidecar = app
        .shell()
        .command(&py)
        .env("PYTHONUNBUFFERED", "1")
        .args(&[
            &script,
            "--input",
            &images_dir.to_string_lossy(),
            "--output",
            &labels_dir.to_string_lossy(),
            "--models-dir",
            &models_dir,
            "--conf",
            &conf_str,
            "--classes",
            &classes_csv,
        ]);

    let (mut rx, child) = sidecar
        .spawn()
        .map_err(|e| format!("Failed to spawn annotator: {}", e))?;

    {
        let mut pid = state.annotator_pid.lock().unwrap();
        *pid = Some(child.pid());
    }

    let app_clone = app.clone();
    let state_clone = Arc::clone(&state);
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let text = String::from_utf8_lossy(&line);
                    let trimmed = text.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    // Try to parse as JSON annotation event; otherwise
                    // forward any other JSON object as a status event.
                    if let Ok(evt) = serde_json::from_str::<AnnotationEvent>(trimmed) {
                        let _ = app_clone.emit("ml-annotate", &evt);
                    } else if let Ok(val) =
                        serde_json::from_str::<serde_json::Value>(trimmed)
                    {
                        let _ = app_clone.emit("ml-annotate-status", &val);
                    } else {
                        log::info!("annotator: {}", trimmed);
                    }
                }
                CommandEvent::Stderr(line) => {
                    let text = String::from_utf8_lossy(&line);
                    log::warn!("annotator stderr: {}", text.trim());
                }
                CommandEvent::Terminated(payload) => {
                    log::info!(
                        "annotator exited with code {:?}",
                        payload.code
                    );
                    let mut pid = state_clone.annotator_pid.lock().unwrap();
                    *pid = None;
                    let _ = app_clone.emit("ml-annotate-done", ());
                    break;
                }
                _ => {}
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub fn cmd_ml_stop_annotator(
    app: AppHandle,
    state: State<'_, Arc<MlProcessState>>,
) -> Result<(), String> {
    let mut pid = state.annotator_pid.lock().unwrap();
    if let Some(p) = pid.take() {
        // Send SIGTERM/TerminateProcess
        kill_process(p);
        let _ = app.emit("ml-annotate-done", ());
    }
    Ok(())
}

#[tauri::command]
pub fn cmd_ml_get_annotations(
    app: AppHandle,
    project: String,
) -> Result<serde_json::Value, String> {
    let proj = project_dir(&app, &project)?;
    let images_dir = proj.join("images");
    let labels_dir = proj.join("labels");
    let status = read_review_status(&proj);

    let mut results = Vec::new();

    if !images_dir.exists() {
        return Ok(serde_json::json!([]));
    }

    let mut entries: Vec<_> = std::fs::read_dir(&images_dir)
        .map_err(|e| format!("Failed to read images dir: {}", e))?
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.path()
                .extension()
                .and_then(|x| x.to_str())
                .map(|x| x == "jpg")
                .unwrap_or(false)
        })
        .collect();
    entries.sort_by_key(|e| e.file_name());

    for entry in entries {
        let img_name = entry.file_name().to_string_lossy().to_string();
        let stem = entry
            .path()
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();

        let label_path = labels_dir.join(format!("{}.txt", stem));
        let labels = if label_path.exists() {
            std::fs::read_to_string(&label_path).unwrap_or_default()
        } else {
            String::new()
        };

        let review = status
            .get(&stem)
            .and_then(|v| v.as_str())
            .unwrap_or("pending")
            .to_string();

        results.push(serde_json::json!({
            "image": img_name,
            "labels": labels,
            "status": review,
        }));
    }

    Ok(serde_json::json!(results))
}

#[tauri::command]
pub fn cmd_ml_save_annotation(
    app: AppHandle,
    project: String,
    image: String,
    labels: String,
) -> Result<(), String> {
    let proj = project_dir(&app, &project)?;
    let stem = image
        .strip_suffix(".jpg")
        .unwrap_or(&image);
    let label_path = proj.join("labels").join(format!("{}.txt", stem));
    std::fs::write(&label_path, &labels)
        .map_err(|e| format!("Failed to write label: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn cmd_ml_set_review_status(
    app: AppHandle,
    project: String,
    image: String,
    status: String,
) -> Result<(), String> {
    let proj = project_dir(&app, &project)?;
    let status_path = proj.join("status.json");
    let mut current = read_review_status(&proj);

    let stem = image
        .strip_suffix(".jpg")
        .unwrap_or(&image);

    if let Some(obj) = current.as_object_mut() {
        obj.insert(stem.to_string(), serde_json::json!(status));
    }

    let json = serde_json::to_string_pretty(&current)
        .map_err(|e| format!("Failed to serialize status: {}", e))?;
    std::fs::write(&status_path, json)
        .map_err(|e| format!("Failed to write status.json: {}", e))?;

    Ok(())
}

#[tauri::command]
pub fn cmd_ml_delete_image(
    app: AppHandle,
    project: String,
    image: String,
) -> Result<(), String> {
    let proj = project_dir(&app, &project)?;
    let stem = image.strip_suffix(".jpg").unwrap_or(&image);

    // Remove image file
    let img_path = proj.join("images").join(&image);
    if img_path.exists() {
        std::fs::remove_file(&img_path)
            .map_err(|e| format!("Failed to delete image: {}", e))?;
    }

    // Remove label file
    let label_path = proj.join("labels").join(format!("{}.txt", stem));
    if label_path.exists() {
        let _ = std::fs::remove_file(&label_path);
    }

    // Remove from status.json
    let status_path = proj.join("status.json");
    let mut current = read_review_status(&proj);
    if let Some(obj) = current.as_object_mut() {
        obj.remove(stem);
    }
    let json = serde_json::to_string_pretty(&current)
        .map_err(|e| format!("Failed to serialize status: {}", e))?;
    std::fs::write(&status_path, json)
        .map_err(|e| format!("Failed to write status.json: {}", e))?;

    Ok(())
}

#[tauri::command]
pub async fn cmd_ml_train(
    app: AppHandle,
    state: State<'_, Arc<MlProcessState>>,
    project: String,
    epochs: Option<u32>,
    imgsz: Option<u32>,
    model: Option<String>,
) -> Result<(), String> {
    let proj = project_dir(&app, &project)?;
    log::info!(
        "Starting training: project={}, epochs={:?}, imgsz={:?}, model={:?}",
        project, epochs, imgsz, model
    );

    // Clear stale training artifacts so a stopped/aborted run can't leave
    // an old best.pt or dataset split lying around for export to pick up.
    for sub in ["runs", "dataset", "export"] {
        let p = proj.join(sub);
        if p.exists() {
            if let Err(e) = std::fs::remove_dir_all(&p) {
                log::warn!("Failed to clear {}: {}", p.display(), e);
            }
        }
    }

    let py = python_path(&app)?;
    let script = script_path(&app, "train.py")?;
    let models_dir = models_dir(&app)?;
    let epochs_str = format!("{}", epochs.unwrap_or(50));
    let imgsz_str = format!("{}", imgsz.unwrap_or(192));
    let model_arg = model.unwrap_or_else(|| "yolov8n".to_string());

    // Persist the model name into project.json so Export can build a
    // descriptive default filename.
    let config_path = proj.join("project.json");
    if let Ok(s) = std::fs::read_to_string(&config_path) {
        if let Ok(mut cfg) = serde_json::from_str::<ProjectConfig>(&s) {
            cfg.model = Some(model_arg.clone());
            if let Ok(json) = serde_json::to_string_pretty(&cfg) {
                let _ = std::fs::write(&config_path, json);
            }
        }
    }
    // Append .pt extension for the ultralytics model file name
    let model_str = if model_arg.ends_with(".pt") {
        model_arg
    } else {
        format!("{}.pt", model_arg)
    };

    let sidecar = app
        .shell()
        .command(&py)
        .env("PYTHONUNBUFFERED", "1")
        .args(&[
            &script,
            "--project",
            &proj.to_string_lossy(),
            "--models-dir",
            &models_dir,
            "--epochs",
            &epochs_str,
            "--imgsz",
            &imgsz_str,
            "--model",
            &model_str,
        ]);

    let (mut rx, child) = sidecar
        .spawn()
        .map_err(|e| format!("Failed to spawn training: {}", e))?;

    {
        let mut pid = state.training_pid.lock().unwrap();
        *pid = Some(child.pid());
    }

    let app_clone = app.clone();
    let state_clone = Arc::clone(&state);
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let text = String::from_utf8_lossy(&line);
                    let trimmed = text.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    if let Ok(evt) =
                        serde_json::from_str::<TrainProgressEvent>(trimmed)
                    {
                        let _ = app_clone.emit("ml-train-progress", &evt);
                    } else {
                        log::info!("training: {}", trimmed);
                        let _ = app_clone.emit("ml-train-log", trimmed);
                    }
                }
                CommandEvent::Stderr(line) => {
                    let text = String::from_utf8_lossy(&line);
                    let trimmed = text.trim();
                    if !trimmed.is_empty() {
                        log::warn!("training stderr: {}", trimmed);
                        let _ = app_clone.emit("ml-train-log", trimmed);
                    }
                }
                CommandEvent::Terminated(payload) => {
                    log::info!(
                        "training exited with code {:?}",
                        payload.code
                    );
                    let mut pid = state_clone.training_pid.lock().unwrap();
                    *pid = None;
                    let _ = app_clone.emit(
                        "ml-train-done",
                        payload.code.unwrap_or(-1),
                    );
                    break;
                }
                _ => {}
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub fn cmd_ml_stop_training(
    app: AppHandle,
    state: State<'_, Arc<MlProcessState>>,
) -> Result<(), String> {
    let mut pid = state.training_pid.lock().unwrap();
    if let Some(p) = pid.take() {
        kill_process(p);
        let _ = app.emit("ml-train-done", -1);
    }
    Ok(())
}

/// Map a deployment target to (required board_type, partition index).
/// `cpu` returns None -- it works on any ROMFS-capable board, partition 0.
pub fn target_to_partition(target: &str) -> Option<(&'static str, usize)> {
    match target {
        "cpu" => None,
        "ethos-u55-256" => Some(("OPENMV_AE3", 0)),
        "ethos-u55-128" => Some(("OPENMV_AE3", 1)),
        "st-neural-art" => Some(("OPENMV_N6", 0)),
        _ => None,
    }
}

const VALID_TARGETS: &[&str] = &["cpu", "ethos-u55-128", "ethos-u55-256", "st-neural-art"];

pub fn validate_target(target: &str) -> Result<(), String> {
    if VALID_TARGETS.contains(&target) {
        Ok(())
    } else {
        Err(format!("Invalid target: {}", target))
    }
}

/// Path to the export directory for a given project.
pub fn export_dir(app: &AppHandle, project: &str) -> Result<PathBuf, String> {
    Ok(project_dir(app, project)?.join("export"))
}

/// Read the .target sidecar written by export.py. Returns None if absent.
pub fn read_target_marker(app: &AppHandle, project: &str) -> Result<Option<String>, String> {
    let path = export_dir(app, project)?.join(".target");
    if !path.exists() {
        return Ok(None);
    }
    Ok(Some(
        std::fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read .target marker: {}", e))?
            .trim()
            .to_string(),
    ))
}

/// Run the export pipeline to completion, streaming progress through
/// the `ml-export-progress` event channel. Returns the python exit code.
/// `target` is one of the strings in `VALID_TARGETS`.
pub async fn run_export(
    app: AppHandle,
    state: Arc<MlProcessState>,
    project: String,
    imgsz: u32,
    target: String,
) -> Result<i32, String> {
    validate_target(&target)?;
    let proj = project_dir(&app, &project)?;
    let py = python_path(&app)?;
    let script = script_path(&app, "export.py")?;
    let imgsz_str = format!("{}", imgsz);
    let proj_str = proj.to_string_lossy().into_owned();

    let mut args: Vec<String> = vec![
        script,
        "--project".into(),
        proj_str,
        "--imgsz".into(),
        imgsz_str,
        "--target".into(),
        target.clone(),
    ];
    if target != "cpu" {
        args.push("--models-dir".into());
        args.push(models_dir(&app)?);
    }
    if target == "st-neural-art" {
        args.push("--stedgeai-dir".into());
        args.push(stedgeai_dir(&app)?);
    }

    log::info!(
        "Starting export: project={}, imgsz={}, target={}",
        project,
        imgsz,
        target
    );

    let sidecar = app
        .shell()
        .command(&py)
        .env("PYTHONUNBUFFERED", "1")
        .args(args);

    let (mut rx, child) = sidecar
        .spawn()
        .map_err(|e| format!("Failed to spawn export: {}", e))?;

    {
        let mut pid = state.export_pid.lock().unwrap();
        *pid = Some(child.pid());
    }

    let mut exit_code: i32 = -1;
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(line) => {
                let text = String::from_utf8_lossy(&line);
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    log::info!("export: {}", trimmed);
                    let _ = app.emit("ml-export-progress", trimmed);
                }
            }
            CommandEvent::Stderr(line) => {
                let text = String::from_utf8_lossy(&line);
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    log::warn!("export stderr: {}", trimmed);
                    let _ = app.emit("ml-export-progress", trimmed);
                }
            }
            CommandEvent::Terminated(payload) => {
                exit_code = payload.code.unwrap_or(-1);
                log::info!("export exited with code {}", exit_code);
                break;
            }
            _ => {}
        }
    }

    {
        let mut pid = state.export_pid.lock().unwrap();
        *pid = None;
    }

    Ok(exit_code)
}

#[tauri::command]
pub async fn cmd_ml_export(
    app: AppHandle,
    state: State<'_, Arc<MlProcessState>>,
    project: String,
    imgsz: Option<u32>,
    target: Option<String>,
) -> Result<(), String> {
    let imgsz_v = imgsz.unwrap_or(192);
    let target_v = target.unwrap_or_else(|| "cpu".to_string());
    validate_target(&target_v)?;

    let app_clone = app.clone();
    let state_clone = Arc::clone(&state);
    tauri::async_runtime::spawn(async move {
        let code = match run_export(
            app_clone.clone(),
            state_clone,
            project,
            imgsz_v,
            target_v,
        )
        .await
        {
            Ok(c) => c,
            Err(e) => {
                let _ = app_clone.emit("ml-export-progress", format!("error: {}", e));
                -1
            }
        };
        let _ = app_clone.emit("ml-export-done", code);
    });

    Ok(())
}

#[tauri::command]
pub fn cmd_ml_stop_export(
    app: AppHandle,
    state: State<'_, Arc<MlProcessState>>,
) -> Result<(), String> {
    let mut pid = state.export_pid.lock().unwrap();
    if let Some(p) = pid.take() {
        kill_process(p);
        let _ = app.emit("ml-export-done", -1);
    }
    Ok(())
}

/// Copy exported model to a user-chosen .tflite path. The labels file
/// is written alongside it with the same base name and a .txt extension.
#[tauri::command]
pub fn cmd_ml_save_export(
    app: AppHandle,
    project: String,
    dest_path: String,
) -> Result<String, String> {
    let proj = project_dir(&app, &project)?;
    let export_dir = proj.join("export");

    let tflite_src = export_dir.join("model.tflite");
    let labels_src = export_dir.join("labels.txt");

    if !tflite_src.exists() {
        return Err("No exported model found. Run export first.".to_string());
    }

    let tflite_dest = std::path::PathBuf::from(&dest_path);
    if let Some(parent) = tflite_dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create destination: {}", e))?;
    }

    std::fs::copy(&tflite_src, &tflite_dest)
        .map_err(|e| format!("Failed to copy model.tflite: {}", e))?;

    if labels_src.exists() {
        let labels_dest = tflite_dest.with_extension("txt");
        std::fs::copy(&labels_src, &labels_dest)
            .map_err(|e| format!("Failed to copy labels: {}", e))?;
    }

    log::info!("Saved export to: {}", tflite_dest.display());
    Ok(tflite_dest.to_string_lossy().to_string())
}

#[tauri::command]
pub fn cmd_ml_project_image_path(
    app: AppHandle,
    project: String,
) -> Result<String, String> {
    let proj = project_dir(&app, &project)?;
    let images_dir = proj.join("images");
    Ok(images_dir.to_string_lossy().to_string())
}
