mod downloads;

use downloads::{
    cancel_download, fetch_catalog, fetch_song_detail, recover_downloads, start_download,
    validate_download_directory, verify_download_manifest, DownloadManager,
};
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlatformInfo {
    os: &'static str,
    arch: &'static str,
    app_version: String,
    runtime: &'static str,
}

#[tauri::command]
fn platform_info(_app: tauri::AppHandle) -> PlatformInfo {
    PlatformInfo {
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        app_version: format!("v{}", env!("CARGO_PKG_VERSION")),
        runtime: "Tauri 2",
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(DownloadManager::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            platform_info,
            start_download,
            cancel_download,
            recover_downloads,
            validate_download_directory,
            fetch_catalog,
            fetch_song_detail,
            verify_download_manifest
        ])
        .run(tauri::generate_context!())
        .expect("failed to run the Siren Records application");
}
