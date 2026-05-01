// Copyright (C) 2026 OpenMV, LLC.
//
// This software is licensed under terms that can be found in the
// LICENSE file in the root directory of this software component.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};

const MANIFEST_URL: &str = "https://download.openmv.io/studio/manifest.json";

// Resource names that live in app_data_dir instead of the bundle.
pub const DOWNLOADED_RESOURCES: &[&str] = &["boards", "examples", "firmware", "stubs", "tools"];

// -- Manifest types ----------------------------------------------------------

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Manifest {
    pub schema_version: u32,
    pub boards: HashMap<String, ResourceEntry>,
    pub examples: HashMap<String, ResourceEntry>,
    pub firmware: HashMap<String, ResourceEntry>,
    pub stubs: HashMap<String, ResourceEntry>,
    pub tools: ToolsEntry,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ResourceEntry {
    pub version: String,
    pub url: String,
    pub sha256: String,
    pub size: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ToolsEntry {
    pub version: String,
    pub platforms: HashMap<String, PlatformAsset>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PlatformAsset {
    pub url: String,
    pub sha256: String,
    pub size: u64,
}

// -- Status types (returned to frontend) -------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct ResourceStatus {
    pub name: String,
    pub installed_version: Option<String>,
    pub available_version: Option<String>,
    pub needs_update: bool,
}

// -- Progress event (emitted to frontend) ------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct DownloadProgress {
    pub resource: String,
    pub bytes_downloaded: u64,
    pub bytes_total: u64,
    pub phase: String,
    pub message: String,
}

// -- Helpers -----------------------------------------------------------------

fn resources_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?
        .join("resources");
    if !dir.exists() {
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("Failed to create resources dir: {}", e))?;
    }
    Ok(dir)
}

fn installed_version(dir: &Path, name: &str) -> Option<String> {
    let version_file = dir.join(name).join("version");
    std::fs::read_to_string(version_file).ok().map(|s| s.trim().to_string())
}

/// Detect channel from a version string.
/// "v4.8.1-483" (has dash after semver) -> "development"
/// "v4.8.1" (clean semver) -> "stable"
fn version_channel(version: &str) -> &str {
    if version.trim_start_matches('v').contains('-') {
        "development"
    } else {
        "stable"
    }
}

fn detect_platform() -> Result<String, String> {
    let os = std::env::consts::OS;
    let arch = std::env::consts::ARCH;
    match (os, arch) {
        ("linux", "x86_64") => Ok("linux-x86_64".to_string()),
        ("macos", "aarch64") => Ok("darwin-arm64".to_string()),
        ("windows", "x86_64") => Ok("windows-x86_64".to_string()),
        _ => Err(format!("Unsupported platform: {}-{}", os, arch)),
    }
}

fn emit_progress(app: &AppHandle, resource: &str, phase: &str, msg: &str, dl: u64, total: u64) {
    let _ = app.emit(
        "resource-progress",
        DownloadProgress {
            resource: resource.to_string(),
            bytes_downloaded: dl,
            bytes_total: total,
            phase: phase.to_string(),
            message: msg.to_string(),
        },
    );
}

/// Remove leftover temp artifacts from interrupted downloads.
fn cleanup_stale(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.filter_map(|e| e.ok()) {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.ends_with(".download") || name.ends_with(".staging") || name.ends_with(".old") {
            let path = entry.path();
            if path.is_dir() {
                let _ = std::fs::remove_dir_all(&path);
            } else {
                let _ = std::fs::remove_file(&path);
            }
            log::info!("Cleaned up stale artifact: {}", name);
        }
    }
}

// -- Download pipeline -------------------------------------------------------

async fn fetch_manifest() -> Result<Manifest, String> {
    let client = reqwest::Client::new();
    let resp = client
        .get(MANIFEST_URL)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch manifest: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("Manifest fetch returned HTTP {}", resp.status()));
    }
    let manifest: Manifest = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse manifest: {}", e))?;
    Ok(manifest)
}

/// Download, verify, extract, and atomically install a resource.
async fn download_resource(
    app: &AppHandle,
    name: &str,
    url: &str,
    sha256_expected: &str,
    size: u64,
    version: &str,
) -> Result<(), String> {
    let dir = resources_dir(app)?;

    let download_path = dir.join(format!("{}.download", name));
    let staging_path = dir.join(format!("{}.staging", name));
    let final_path = dir.join(name);
    let old_path = dir.join(format!("{}.old", name));
    let version_file = final_path.join("version");

    // Phase 1: Download with streaming hash
    emit_progress(app, name, "downloading", "Starting download...", 0, size);

    let client = reqwest::Client::new();
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Download failed: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("Download returned HTTP {}", resp.status()));
    }

    let mut file = std::fs::File::create(&download_path)
        .map_err(|e| format!("Failed to create download file: {}", e))?;
    let mut hasher = Sha256::new();
    let mut downloaded: u64 = 0;
    let mut stream = resp.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Download stream error: {}", e))?;
        file.write_all(&chunk)
            .map_err(|e| format!("Failed to write download: {}", e))?;
        hasher.update(&chunk);
        downloaded += chunk.len() as u64;
        emit_progress(app, name, "downloading", "Downloading...", downloaded, size);
    }
    drop(file);

    // Phase 2: Verify checksum
    emit_progress(app, name, "verifying", "Verifying checksum...", downloaded, size);

    let hash = format!("{:x}", hasher.finalize());
    if hash != sha256_expected {
        let _ = std::fs::remove_file(&download_path);
        return Err(format!(
            "Checksum mismatch for {}: expected {}, got {}",
            name, sha256_expected, hash
        ));
    }

    // Phase 3: Extract to staging
    emit_progress(app, name, "extracting", "Extracting...", downloaded, size);

    if staging_path.exists() {
        std::fs::remove_dir_all(&staging_path)
            .map_err(|e| format!("Failed to clean staging dir: {}", e))?;
    }
    std::fs::create_dir_all(&staging_path)
        .map_err(|e| format!("Failed to create staging dir: {}", e))?;

    extract_tar_xz(&download_path, &staging_path, name, app)?;

    // Phase 4: Atomic swap
    emit_progress(app, name, "installing", "Installing...", downloaded, size);

    if final_path.exists() {
        // Rename current to .old, then swap staging in
        if old_path.exists() {
            std::fs::remove_dir_all(&old_path)
                .map_err(|e| format!("Failed to remove old dir: {}", e))?;
        }
        std::fs::rename(&final_path, &old_path)
            .map_err(|e| format!("Failed to move old resource: {}", e))?;
    }

    std::fs::rename(&staging_path, &final_path)
        .map_err(|e| format!("Failed to install resource: {}", e))?;

    // Write version marker
    std::fs::write(&version_file, version)
        .map_err(|e| format!("Failed to write version file: {}", e))?;

    // Cleanup
    let _ = std::fs::remove_file(&download_path);
    if old_path.exists() {
        let _ = std::fs::remove_dir_all(&old_path);
    }

    emit_progress(app, name, "done", "Complete.", downloaded, size);
    Ok(())
}

/// Extract a .tar.xz archive. For tools, flatten the SDK directory structure.
fn extract_tar_xz(archive: &Path, dest: &Path, name: &str, app: &AppHandle) -> Result<(), String> {
    let file = std::fs::File::open(archive)
        .map_err(|e| format!("Failed to open archive {}: {}", archive.display(), e))?;
    let decompressed = xz2::read::XzDecoder::new(file);
    let mut tar = tar::Archive::new(decompressed);

    if name == "tools" {
        // Tools archive has a top-level directory like tools-<plat>/.
        // We flatten it: extract bin/dfu-util*, stedgeai/, python/ into dest root.
        extract_tools_archive(&mut tar, dest, app, name)?;
    } else {
        // Examples and stubs: strip one directory level (the archive root)
        let mut count: u64 = 0;
        for entry in tar.entries().map_err(|e| format!("Tar read error: {}", e))? {
            let mut entry = entry.map_err(|e| format!("Tar entry error: {}", e))?;
            let path = entry
                .path()
                .map_err(|e| format!("Tar path error: {}", e))?
                .into_owned();

            // Strip the top-level directory
            let components: Vec<_> = path.components().collect();
            if components.len() <= 1 {
                continue;
            }
            let stripped: PathBuf = components[1..].iter().collect();
            let out_path = dest.join(&stripped);

            if entry.header().entry_type().is_dir() {
                let _ = std::fs::create_dir_all(&out_path);
            } else {
                if let Some(parent) = out_path.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                entry
                    .unpack(&out_path)
                    .map_err(|e| format!("Failed to extract {}: {}", stripped.display(), e))?;
                count += 1;
                if count % 50 == 0 {
                    emit_progress(
                        app, name, "extracting",
                        &format!("Extracting ({} files)...", count), 0, 0,
                    );
                }
            }
        }
    }

    Ok(())
}

/// Extract SDK tools archive, flattening to just the tools we need.
fn extract_tools_archive(
    tar: &mut tar::Archive<xz2::read::XzDecoder<std::fs::File>>,
    dest: &Path,
    app: &AppHandle,
    name: &str,
) -> Result<(), String> {
    let mut count: u64 = 0;
    for entry in tar.entries().map_err(|e| format!("Tar read error: {}", e))? {
        let mut entry = entry.map_err(|e| format!("Tar entry error: {}", e))?;
        let path = entry
            .path()
            .map_err(|e| format!("Tar path error: {}", e))?
            .into_owned();

        // Path looks like: tools-<plat>/bin/dfu-util
        //                   tools-<plat>/stedgeai/...
        //                   tools-<plat>/python/...
        let components: Vec<_> = path.components().collect();
        if components.len() < 2 {
            continue;
        }

        // Second component is bin/, stedgeai/, or python/
        let second = components[1].as_os_str().to_string_lossy();

        let out_rel: PathBuf = match second.as_ref() {
            "bin" => {
                // bin/dfu-util* -> dfu-util* (flatten bin/ away)
                if components.len() < 3 {
                    continue;
                }
                let filename = components[2].as_os_str().to_string_lossy();
                if !filename.starts_with("dfu-util") {
                    continue;
                }
                PathBuf::from(filename.as_ref())
            }
            "stedgeai" | "python" => {
                // Keep directory structure: stedgeai/... or python/...
                components[1..].iter().collect()
            }
            _ => continue,
        };

        let out_path = dest.join(&out_rel);

        if entry.header().entry_type().is_dir() {
            let _ = std::fs::create_dir_all(&out_path);
        } else {
            if let Some(parent) = out_path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            entry
                .unpack(&out_path)
                .map_err(|e| format!("Failed to extract {}: {}", out_rel.display(), e))?;
            count += 1;
            if count % 100 == 0 {
                emit_progress(
                    app, name, "extracting",
                    &format!("Extracting ({} files)...", count), 0, 0,
                );
            }
        }
    }

    // Make dfu-util executable on Unix
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let Ok(entries) = std::fs::read_dir(dest) else {
            return Ok(());
        };
        for entry in entries.filter_map(|e| e.ok()) {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with("dfu-util") {
                let _ = std::fs::set_permissions(
                    entry.path(),
                    std::fs::Permissions::from_mode(0o755),
                );
            }
        }
    }

    Ok(())
}

// -- Tauri commands ----------------------------------------------------------

#[tauri::command]
pub async fn cmd_check_resources(
    app: AppHandle,
    channel: Option<String>,
) -> Result<Vec<ResourceStatus>, String> {
    let channel = channel.as_deref().unwrap_or("stable");
    let dir = resources_dir(&app)?;
    cleanup_stale(&dir);

    let mut statuses = Vec::new();
    for &name in DOWNLOADED_RESOURCES {
        let version = installed_version(&dir, name);
        // Tools have no channel split - only check if installed
        let needs_update = if name == "tools" {
            version.is_none()
        } else {
            match &version {
                None => true,
                Some(v) => version_channel(v) != channel,
            }
        };
        statuses.push(ResourceStatus {
            name: name.to_string(),
            installed_version: version,
            available_version: None,
            needs_update,
        });
    }

    Ok(statuses)
}

#[tauri::command]
pub async fn cmd_fetch_manifest(
    app: AppHandle,
    channel: Option<String>,
) -> Result<Vec<ResourceStatus>, String> {
    let channel = channel.as_deref().unwrap_or("stable");
    let dir = resources_dir(&app)?;
    let manifest = fetch_manifest().await?;

    // Cache manifest locally
    let manifest_path = dir.join("manifest.json");
    let json = serde_json::to_string_pretty(&manifest)
        .map_err(|e| format!("Failed to serialize manifest: {}", e))?;
    let _ = std::fs::write(&manifest_path, json);

    let platform = detect_platform()?;
    let mut statuses = Vec::new();

    // Channeled resources: boards, examples, firmware, stubs
    let resources: &[(&str, &HashMap<String, ResourceEntry>)] = &[
        ("boards", &manifest.boards),
        ("examples", &manifest.examples),
        ("firmware", &manifest.firmware),
        ("stubs", &manifest.stubs),
    ];

    for &(name, entries) in resources {
        let installed = installed_version(&dir, name);
        let entry = entries.get(channel);
        statuses.push(ResourceStatus {
            name: name.to_string(),
            needs_update: match (&installed, &entry) {
                (Some(v), Some(e)) => v != &e.version,
                (None, Some(_)) => true,
                _ => false,
            },
            installed_version: installed,
            available_version: entry.map(|e| e.version.clone()),
        });
    }

    // Tools (no channel split)
    let installed = installed_version(&dir, "tools");
    let tools_available = manifest.tools.platforms.contains_key(&platform);
    statuses.push(ResourceStatus {
        name: "tools".to_string(),
        needs_update: if tools_available {
            installed.as_deref() != Some(&manifest.tools.version)
        } else {
            false
        },
        installed_version: installed,
        available_version: if tools_available {
            Some(manifest.tools.version)
        } else {
            None
        },
    });

    Ok(statuses)
}

#[tauri::command]
pub async fn cmd_download_resource(
    app: AppHandle,
    name: String,
    channel: Option<String>,
) -> Result<(), String> {
    let channel = channel.as_deref().unwrap_or("stable");
    let dir = resources_dir(&app)?;

    // Load cached manifest
    let manifest_path = dir.join("manifest.json");
    let manifest_json = std::fs::read_to_string(&manifest_path)
        .map_err(|_| "No cached manifest. Call cmd_fetch_manifest first.".to_string())?;
    let manifest: Manifest = serde_json::from_str(&manifest_json)
        .map_err(|e| format!("Failed to parse cached manifest: {}", e))?;

    match name.as_str() {
        "boards" | "examples" | "firmware" | "stubs" => {
            let entries = match name.as_str() {
                "boards" => &manifest.boards,
                "examples" => &manifest.examples,
                "firmware" => &manifest.firmware,
                "stubs" => &manifest.stubs,
                _ => unreachable!(),
            };
            let entry = entries
                .get(channel)
                .ok_or_else(|| format!("No {} entry for channel: {}", name, channel))?;
            download_resource(
                &app, &name, &entry.url, &entry.sha256, entry.size, &entry.version,
            )
            .await
        }
        "tools" => {
            let platform = detect_platform()?;
            let asset = manifest
                .tools
                .platforms
                .get(&platform)
                .ok_or_else(|| format!("No tools available for platform: {}", platform))?;
            download_resource(
                &app,
                "tools",
                &asset.url,
                &asset.sha256,
                asset.size,
                &manifest.tools.version,
            )
            .await
        }
        _ => Err(format!("Unknown resource: {}", name)),
    }
}

#[tauri::command]
pub fn cmd_resource_path(app: AppHandle, name: String) -> Result<String, String> {
    let dir = resources_dir(&app)?;
    let path = dir.join(&name);
    if path.exists() {
        Ok(path.to_string_lossy().to_string())
    } else {
        Err(format!("Resource not found: {}", name))
    }
}

#[tauri::command]
pub fn cmd_list_stubs(app: AppHandle) -> Result<Vec<String>, String> {
    let dir = resources_dir(&app)?;
    let stubs_dir = dir.join("stubs");
    if !stubs_dir.exists() {
        return Ok(vec![]);
    }

    let mut paths = Vec::new();
    let entries = std::fs::read_dir(&stubs_dir)
        .map_err(|e| format!("Failed to read stubs dir: {}", e))?;
    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("pyi") {
            paths.push(path.to_string_lossy().to_string());
        }
    }
    paths.sort();
    Ok(paths)
}
