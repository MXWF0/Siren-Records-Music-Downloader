mod api;
mod filesystem;
mod manifest;
mod proxy;
mod security;
mod stream;

use api::{fetch_catalog_json, fetch_song};
use filesystem::{atomic_replace, resolve_download_directory, validate_directory};
use manifest::{verify_manifest, write_record};
use proxy::build_http_client;
use security::{audio_extension, safe_component, valid_song_id};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, State};
use tokio::{fs, sync::Mutex};
use tokio_util::sync::CancellationToken;

pub(crate) const CANCELLED: &str = "__SIREN_DOWNLOAD_CANCELLED__";

#[derive(Clone, Default)]
pub struct DownloadManager {
    active: Arc<Mutex<HashMap<String, CancellationToken>>>,
    manifest: Arc<Mutex<()>>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadRequest {
    pub id: String,
    pub download_directory: String,
    pub separate_directory: bool,
}

#[derive(Clone, Serialize)]
struct DownloadComplete {
    id: String,
}

#[derive(Clone, Serialize)]
struct DownloadFailure {
    id: String,
    message: String,
}

#[derive(Clone, Serialize)]
struct DownloadCancelled {
    id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartResult {
    started: bool,
}

#[derive(Serialize)]
pub struct CatalogResponse {
    pub albums: Value,
    pub songs: Value,
}

#[tauri::command]
pub async fn fetch_catalog() -> Result<CatalogResponse, String> {
    let client = build_http_client()?;
    let (albums, songs) = tokio::try_join!(
        fetch_catalog_json(&client, "/albums"),
        fetch_catalog_json(&client, "/songs"),
    )?;
    Ok(CatalogResponse { albums, songs })
}

#[tauri::command]
pub async fn fetch_song_detail(id: String) -> Result<Value, String> {
    if !valid_song_id(&id) {
        return Err("歌曲编号无效".into());
    }
    let client = build_http_client()?;
    let mut song = fetch_song(&client, &id, None).await?;
    if let Some(object) = song.as_object_mut() {
        object.remove("sourceUrl");
    }
    Ok(song)
}

#[tauri::command]
pub async fn start_download(
    app: AppHandle,
    state: State<'_, DownloadManager>,
    mut request: DownloadRequest,
) -> Result<StartResult, String> {
    request.id = request.id.trim().to_owned();
    if !valid_song_id(&request.id) {
        return Err("歌曲编号无效".into());
    }
    request.download_directory = resolve_download_directory(&app, &request.download_directory)?;
    validate_directory(&request.download_directory).await?;

    let token = CancellationToken::new();
    {
        let mut active = state.active.lock().await;
        if active.contains_key(&request.id) {
            return Err("该歌曲正在下载".into());
        }
        active.insert(request.id.clone(), token.clone());
    }

    let manager = state.inner().clone();
    let app_handle = app.clone();
    let id = request.id.clone();
    tauri::async_runtime::spawn(async move {
        let result = perform_download(&app_handle, &request, &token).await;
        manager.active.lock().await.remove(&id);
        match result {
            Ok(record) => {
                let _guard = manager.manifest.lock().await;
                match write_record(&app_handle, record).await {
                    Ok(()) => {
                        let _ = app_handle.emit("download-complete", DownloadComplete { id });
                    }
                    Err(message) => {
                        let _ = app_handle.emit("download-failed", DownloadFailure { id, message });
                    }
                }
            }
            Err(error) if token.is_cancelled() || error == CANCELLED => {
                let _ = app_handle.emit("download-cancelled", DownloadCancelled { id });
            }
            Err(message) => {
                let _ = app_handle.emit("download-failed", DownloadFailure { id, message });
            }
        }
    });
    Ok(StartResult { started: true })
}

#[tauri::command]
pub async fn cancel_download(
    state: State<'_, DownloadManager>,
    id: String,
) -> Result<bool, String> {
    if let Some(token) = state.active.lock().await.get(&id).cloned() {
        token.cancel();
        Ok(true)
    } else {
        Ok(false)
    }
}

#[tauri::command]
pub async fn recover_downloads(app: AppHandle, download_directory: String) -> Result<(), String> {
    let root = PathBuf::from(resolve_download_directory(&app, &download_directory)?)
        .join(".siren-download");
    // Valid `.part` files are intentionally preserved for Range recovery.
    stream::recover_partial_downloads(&root).await
}

#[tauri::command]
pub async fn verify_download_manifest(
    app: AppHandle,
    state: State<'_, DownloadManager>,
) -> Result<Vec<String>, String> {
    let _guard = state.manifest.lock().await;
    verify_manifest(&app).await
}

#[tauri::command]
pub async fn validate_download_directory(download_directory: String) -> Result<(), String> {
    validate_directory(&download_directory).await
}

async fn perform_download(
    app: &AppHandle,
    request: &DownloadRequest,
    token: &CancellationToken,
) -> Result<manifest::DownloadRecord, String> {
    let client = build_http_client()?;
    let output_root = PathBuf::from(&request.download_directory);
    fs::create_dir_all(&output_root)
        .await
        .map_err(|error| format!("无法创建下载目录：{error}"))?;
    let job_directory = output_root
        .join(".siren-download")
        .join(safe_component(&request.id, "track"));
    fs::create_dir_all(&job_directory)
        .await
        .map_err(|error| format!("无法创建临时目录：{error}"))?;

    let mut song = fetch_song(&client, &request.id, Some(token)).await?;
    let mut source_url = song
        .get("sourceUrl")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or("歌曲没有可用音频地址")?;
    let album_cid = song
        .get("albumCid")
        .map(api::value_to_string)
        .unwrap_or_else(|| "unknown".into());
    let album = api::fetch_album(&client, &album_cid, token)
        .await
        .unwrap_or(Value::Null);
    let album_name = album
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or(&album_cid);
    let song_name = song
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("未命名歌曲");
    let safe_album = safe_component(album_name, &album_cid);
    let safe_song = safe_component(song_name, &request.id);
    let output_directory = if request.separate_directory {
        output_root.join(&safe_album)
    } else {
        output_root
    };
    fs::create_dir_all(&output_directory)
        .await
        .map_err(|error| format!("无法创建专辑目录：{error}"))?;
    let final_base = output_directory.join(format!("[{safe_album}] {safe_song}"));
    let part_path = job_directory.join("audio.part");

    let downloaded =
        match stream::download_audio(app, &client, &source_url, &part_path, &request.id, token)
            .await
        {
            Ok(value) => value,
            Err(error) if stream::should_refresh_audio_url(&error) => {
                song = fetch_song(&client, &request.id, Some(token)).await?;
                source_url = song
                    .get("sourceUrl")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .ok_or("刷新后的歌曲没有可用音频地址")?;
                stream::download_audio(app, &client, &source_url, &part_path, &request.id, token)
                    .await?
            }
            Err(error) => return Err(error),
        };

    if let Some(url) = song.get("lyricUrl").and_then(Value::as_str) {
        if let Some(lyrics) = stream::download_optional_text(&client, url, token).await? {
            filesystem::write_atomic(&final_base.with_extension("lrc"), lyrics.as_bytes()).await?;
        }
    }
    let extension = audio_extension(downloaded.content_type.as_deref(), &source_url);
    let final_audio = final_base.with_extension(extension);
    atomic_replace(&part_path, &final_audio).await?;
    let file_size = fs::metadata(&final_audio)
        .await
        .map_err(|error| format!("无法读取已下载文件信息：{error}"))?
        .len();
    let completed_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let _ = fs::remove_file(job_directory.join("resume.json")).await;
    let _ = fs::remove_dir(&job_directory).await;
    Ok(manifest::DownloadRecord {
        cid: request.id.clone(),
        file_path: final_audio.to_string_lossy().into_owned(),
        file_size,
        completed_at,
    })
}

#[cfg(test)]
mod tests {
    use super::security::{audio_extension, safe_component, valid_song_id};

    #[test]
    fn preserves_the_official_audio_extension() {
        assert_eq!(
            audio_extension(Some("audio/flac"), "https://res01.hycdn.cn/a.wav"),
            "flac"
        );
        assert_eq!(
            audio_extension(
                Some("application/octet-stream"),
                "https://res01.hycdn.cn/a.mp3?sign=1"
            ),
            "mp3"
        );
    }

    #[test]
    fn sanitizes_download_path_components() {
        assert_eq!(safe_component("Album:/Track", "fallback"), "Album Track");
    }

    #[test]
    fn rejects_invalid_song_identifiers() {
        assert!(valid_song_id("779442"));
        assert!(!valid_song_id("../albums"));
    }
}
