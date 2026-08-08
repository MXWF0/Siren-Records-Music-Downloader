use futures_util::StreamExt;
use reqwest::header::CONTENT_TYPE;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::{fs, io::AsyncWriteExt, sync::Mutex};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const API_ROOT: &str = "https://monster-siren.hypergryph.com/api";
const CANCELLED: &str = "__SIREN_DOWNLOAD_CANCELLED__";

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
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    id: String,
    loaded: u64,
    total: Option<u64>,
    rate: f64,
    eta_seconds: Option<u64>,
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

struct DownloadedAudio {
    content_type: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadRecord {
    cid: String,
    file_path: String,
    file_size: u64,
    completed_at: u64,
}

#[derive(Default, Deserialize, Serialize)]
struct DownloadManifest {
    records: Vec<DownloadRecord>,
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

/// Fetches the same public catalogue used by the original application.
/// Keeping this request in the native layer avoids WebView/file-origin CORS differences.
#[tauri::command]
pub async fn fetch_catalog() -> Result<CatalogResponse, String> {
    let client = build_http_client()?;
    let albums_url = format!("{API_ROOT}/albums");
    let songs_url = format!("{API_ROOT}/songs");
    let (albums, songs) = tokio::try_join!(
        fetch_catalog_json(&client, &albums_url),
        fetch_catalog_json(&client, &songs_url),
    )?;
    Ok(CatalogResponse { albums, songs })
}

#[tauri::command]
pub async fn fetch_song_detail(id: String) -> Result<Value, String> {
    if !valid_song_id(&id) {
        return Err("歌曲编号无效".into());
    }
    let client = build_http_client()?;
    let mut payload = fetch_catalog_json(&client, &format!("{API_ROOT}/song/{id}")).await?;
    let data = payload.get_mut("data").ok_or("歌曲详情为空")?;
    if let Some(object) = data.as_object_mut() {
        object.remove("sourceUrl");
    }
    Ok(data.clone())
}

async fn fetch_catalog_json(client: &reqwest::Client, url: &str) -> Result<Value, String> {
    let response = client
        .get(url)
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|error| format!("官网目录请求失败：{error}"))?
        .error_for_status()
        .map_err(|error| format!("官网目录返回错误：{error}"))?;
    response
        .json::<Value>()
        .await
        .map_err(|error| format!("官网目录数据格式错误：{error}"))
}

#[tauri::command]
pub async fn start_download(
    app: AppHandle,
    state: State<'_, DownloadManager>,
    mut request: DownloadRequest,
) -> Result<StartResult, String> {
    let id = request.id.trim().to_owned();
    if !valid_song_id(&id) {
        return Err("歌曲编号无效".into());
    }
    if request.download_directory.trim().is_empty() {
        request.download_directory = resolve_download_directory(&app, "")?;
    }
    validate_download_directory(request.download_directory.clone()).await?;

    let token = CancellationToken::new();
    {
        let mut active = state.active.lock().await;
        if active.contains_key(&id) {
            return Err("该歌曲正在下载".into());
        }
        active.insert(id.clone(), token.clone());
    }

    let manager = state.inner().clone();
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = perform_download(&app_handle, &request, &token).await;
        manager.active.lock().await.remove(&id);
        match result {
            Ok(record) => {
                let _guard = manager.manifest.lock().await;
                match write_download_record(&app_handle, record).await {
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
            Err(error) => {
                let _ = app_handle.emit("download-failed", DownloadFailure { id, message: error });
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
    let token = state.active.lock().await.get(&id).cloned();
    if let Some(token) = token {
        token.cancel();
        Ok(true)
    } else {
        Ok(false)
    }
}

#[tauri::command]
pub async fn recover_downloads(app: AppHandle, download_directory: String) -> Result<(), String> {
    let temporary_root = PathBuf::from(resolve_download_directory(&app, &download_directory)?)
        .join(".siren-download");
    match fs::metadata(&temporary_root).await {
        Ok(metadata) if metadata.is_dir() => fs::remove_dir_all(&temporary_root)
            .await
            .map_err(|error| format!("无法清理上次未完成的临时文件：{error}")),
        Ok(_) => fs::remove_file(&temporary_root)
            .await
            .map_err(|error| format!("无法清理异常临时文件：{error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("无法检查临时文件：{error}")),
    }
}

/// Verify the desktop manifest against real files on every startup. Missing
/// files are removed so the UI returns those songs to the not-downloaded list.
#[tauri::command]
pub async fn verify_download_manifest(
    app: AppHandle,
    state: State<'_, DownloadManager>,
) -> Result<Vec<String>, String> {
    let _guard = state.manifest.lock().await;
    let mut manifest = read_download_manifest(&app).await?;
    let original_len = manifest.records.len();
    let mut valid = Vec::with_capacity(original_len);
    for record in manifest.records {
        if fs::metadata(&record.file_path)
            .await
            .is_ok_and(|metadata| metadata.is_file() && metadata.len() > 0)
        {
            valid.push(record);
        }
    }
    manifest.records = valid;
    if manifest.records.len() != original_len {
        write_download_manifest(&app, &manifest).await?;
    }
    Ok(manifest
        .records
        .iter()
        .map(|record| record.cid.clone())
        .collect())
}

fn manifest_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join("downloads-manifest.json"))
        .map_err(|error| format!("无法定位下载记录目录：{error}"))
}

async fn read_download_manifest(app: &AppHandle) -> Result<DownloadManifest, String> {
    let path = manifest_path(app)?;
    match fs::read(&path).await {
        Ok(bytes) => match serde_json::from_slice(&bytes) {
            Ok(manifest) => Ok(manifest),
            Err(error) => {
                let backup = path.with_extension("json.corrupt");
                let _ = fs::remove_file(&backup).await;
                fs::rename(&path, &backup).await.map_err(|move_error| {
                    format!("下载记录损坏且无法备份：{error}；{move_error}")
                })?;
                Ok(DownloadManifest::default())
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(DownloadManifest::default())
        }
        Err(error) => Err(format!("无法读取下载记录：{error}")),
    }
}

async fn write_download_manifest(
    app: &AppHandle,
    manifest: &DownloadManifest,
) -> Result<(), String> {
    let path = manifest_path(app)?;
    let parent = path.parent().ok_or("下载记录目录无效")?;
    fs::create_dir_all(parent)
        .await
        .map_err(|error| format!("无法创建下载记录目录：{error}"))?;
    let temporary = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(manifest)
        .map_err(|error| format!("无法生成下载记录：{error}"))?;
    fs::write(&temporary, bytes)
        .await
        .map_err(|error| format!("无法写入下载记录：{error}"))?;
    if fs::metadata(&path).await.is_ok() {
        fs::remove_file(&path)
            .await
            .map_err(|error| format!("无法更新下载记录：{error}"))?;
    }
    fs::rename(&temporary, &path)
        .await
        .map_err(|error| format!("无法保存下载记录：{error}"))
}

async fn write_download_record(app: &AppHandle, record: DownloadRecord) -> Result<(), String> {
    let mut manifest = read_download_manifest(app).await?;
    manifest.records.retain(|item| item.cid != record.cid);
    manifest.records.push(record);
    write_download_manifest(app, &manifest).await
}

/// 创建并删除一个仅用于校验的临时文件，以便在真正下载前反馈权限问题。
#[tauri::command]
pub async fn validate_download_directory(download_directory: String) -> Result<(), String> {
    let directory = download_directory.trim();
    if directory.is_empty() {
        return Err("请先选择下载目录".into());
    }
    let path = PathBuf::from(directory);
    fs::create_dir_all(&path)
        .await
        .map_err(|error| format!("无法创建下载目录，请检查路径和权限：{error}"))?;
    let probe = path.join(format!(".siren-write-test-{}", Uuid::new_v4()));
    let mut file = fs::File::create(&probe)
        .await
        .map_err(|error| format!("下载目录不可写，请选择其他目录或检查权限：{error}"))?;
    file.write_all(b"siren")
        .await
        .map_err(|error| format!("下载目录不可写，请选择其他目录或检查权限：{error}"))?;
    file.sync_all()
        .await
        .map_err(|error| format!("下载目录无法完成写入，请检查权限：{error}"))?;
    drop(file);
    fs::remove_file(&probe)
        .await
        .map_err(|error| format!("无法清理下载目录校验文件：{error}"))?;
    Ok(())
}

fn resolve_download_directory(app: &AppHandle, configured: &str) -> Result<String, String> {
    let configured = configured.trim();
    if !configured.is_empty() {
        return Ok(configured.to_owned());
    }
    app.path()
        .download_dir()
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|error| format!("无法获取系统默认下载目录：{error}"))
}

async fn perform_download(
    app: &AppHandle,
    request: &DownloadRequest,
    token: &CancellationToken,
) -> Result<DownloadRecord, String> {
    let output_root = PathBuf::from(request.download_directory.trim());
    fs::create_dir_all(&output_root)
        .await
        .map_err(|error| format!("无法创建下载目录：{error}"))?;
    let temporary_root = output_root.join(".siren-download");
    let job_directory = temporary_root.join(format!(
        "{}-{}",
        safe_component(&request.id, "track"),
        Uuid::new_v4()
    ));
    fs::create_dir_all(&job_directory)
        .await
        .map_err(|error| format!("无法创建临时目录：{error}"))?;

    let result = perform_download_inner(app, request, token, &output_root, &job_directory).await;
    let cleanup = fs::remove_dir_all(&job_directory).await;
    if let Err(error) = cleanup {
        eprintln!("Unable to remove temporary download directory: {error}");
    }
    result
}

async fn perform_download_inner(
    app: &AppHandle,
    request: &DownloadRequest,
    token: &CancellationToken,
    output_root: &Path,
    job_directory: &Path,
) -> Result<DownloadRecord, String> {
    let client = build_http_client()?;

    let song_payload =
        fetch_json(&client, &format!("{API_ROOT}/song/{}", request.id), token).await?;
    let mut song = song_payload.get("data").cloned().ok_or("歌曲信息为空")?;
    let mut source_url = song
        .get("sourceUrl")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .ok_or("歌曲没有可用音频地址")?;
    let album_cid = song
        .get("albumCid")
        .map(value_to_string)
        .unwrap_or_else(|| "unknown".to_string());
    let album_payload = match fetch_json(
        &client,
        &format!("{API_ROOT}/album/{album_cid}/data"),
        token,
    )
    .await
    {
        Ok(value) => value,
        Err(error) if error == CANCELLED => return Err(error),
        Err(error) => {
            eprintln!("Unable to read album metadata, using the album id: {error}");
            Value::Null
        }
    };
    let album = album_payload.get("data").cloned().unwrap_or(Value::Null);
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
        output_root.to_path_buf()
    };
    fs::create_dir_all(&output_directory)
        .await
        .map_err(|error| format!("无法创建专辑目录：{error}"))?;
    let final_base = output_directory.join(format!("[{safe_album}] {safe_song}"));

    let temporary_audio = job_directory.join("audio.source");
    let downloaded_audio = match download_audio(
        app,
        &client,
        &source_url,
        &temporary_audio,
        &request.id,
        token,
    )
    .await
    {
        Ok(value) => value,
        Err(error) if should_refresh_audio_url(&error) => {
            let refreshed_payload =
                fetch_json(&client, &format!("{API_ROOT}/song/{}", request.id), token).await?;
            song = refreshed_payload
                .get("data")
                .cloned()
                .ok_or("刷新后的歌曲信息为空")?;
            source_url = song
                .get("sourceUrl")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
                .ok_or("刷新后的歌曲没有可用音频地址")?;
            download_audio(
                app,
                &client,
                &source_url,
                &temporary_audio,
                &request.id,
                token,
            )
            .await?
        }
        Err(error) => return Err(error),
    };
    let lyrics = match song.get("lyricUrl").and_then(Value::as_str) {
        Some(url) => download_optional_text(&client, url, token).await?,
        None => None,
    };
    // Preserve the official source format. Decoding a lossy source into WAV
    // increases file size but cannot restore information lost by compression.
    let extension = audio_extension(downloaded_audio.content_type.as_deref(), &source_url);
    let final_audio = final_base.with_extension(extension);
    if fs::metadata(&final_audio).await.is_ok() {
        fs::remove_file(&final_audio)
            .await
            .map_err(|error| format!("无法覆盖已有音频文件：{error}"))?;
    }
    fs::rename(&temporary_audio, &final_audio)
        .await
        .map_err(|error| format!("无法保存 WAV 文件：{error}"))?;
    if let Some(lyrics) = lyrics {
        fs::write(final_base.with_extension("lrc"), lyrics)
            .await
            .map_err(|error| format!("无法写入歌词文件：{error}"))?;
    }
    let file_size = fs::metadata(&final_audio)
        .await
        .map_err(|error| format!("无法读取已下载文件信息：{error}"))?
        .len();
    let completed_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    Ok(DownloadRecord {
        cid: request.id.clone(),
        file_path: final_audio.to_string_lossy().into_owned(),
        file_size,
        completed_at,
    })
}

fn should_refresh_audio_url(error: &str) -> bool {
    error.contains("403") || error.contains("401") || error.contains("404")
}

async fn fetch_json(
    client: &reqwest::Client,
    url: &str,
    token: &CancellationToken,
) -> Result<Value, String> {
    let response = tokio::select! {
        _ = token.cancelled() => return Err(CANCELLED.into()),
        result = client.get(url).timeout(Duration::from_secs(20)).send() => result.map_err(|error| format!("网络请求失败：{error}"))?,
    };
    let response = response
        .error_for_status()
        .map_err(|error| format!("服务请求失败：{error}"))?;
    tokio::select! {
        _ = token.cancelled() => Err(CANCELLED.into()),
        result = response.json::<Value>() => result.map_err(|error| format!("无法读取服务数据：{error}")),
    }
}

async fn download_audio(
    app: &AppHandle,
    client: &reqwest::Client,
    url: &str,
    destination: &Path,
    id: &str,
    token: &CancellationToken,
) -> Result<DownloadedAudio, String> {
    let response = tokio::select! {
        _ = token.cancelled() => return Err(CANCELLED.into()),
        result = client.get(url).send() => result.map_err(|error| format!("无法下载音频：{error}"))?,
    }.error_for_status().map_err(|error| format!("音频请求失败：{error}"))?;
    let total = response.content_length();
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let mut stream = response.bytes_stream();
    let mut file = fs::File::create(destination)
        .await
        .map_err(|error| format!("无法创建临时音频：{error}"))?;
    let mut downloaded = 0_u64;
    let mut last_downloaded = 0_u64;
    let mut last_report = Instant::now();
    while let Some(chunk) = tokio::select! {
        _ = token.cancelled() => return Err(CANCELLED.into()),
        value = stream.next() => value,
    } {
        let chunk = chunk.map_err(|error| format!("音频下载中断：{error}"))?;
        file.write_all(&chunk)
            .await
            .map_err(|error| format!("无法写入临时音频：{error}"))?;
        downloaded += chunk.len() as u64;
        let elapsed = last_report.elapsed();
        if elapsed.as_millis() >= 150 || total.is_some_and(|size| downloaded >= size) {
            let seconds = elapsed.as_secs_f64().max(0.001);
            let rate = (downloaded - last_downloaded) as f64 / seconds;
            let eta_seconds = total.and_then(|size| {
                (rate > 0.0)
                    .then(|| ((size.saturating_sub(downloaded)) as f64 / rate).ceil() as u64)
            });
            let _ = app.emit(
                "download-progress",
                DownloadProgress {
                    id: id.to_owned(),
                    loaded: downloaded,
                    total,
                    rate,
                    eta_seconds,
                },
            );
            last_report = Instant::now();
            last_downloaded = downloaded;
        }
    }
    file.flush()
        .await
        .map_err(|error| format!("无法完成临时音频写入：{error}"))?;
    Ok(DownloadedAudio { content_type })
}

fn audio_extension(content_type: Option<&str>, source_url: &str) -> &'static str {
    let content_type = content_type.unwrap_or_default().to_ascii_lowercase();
    if content_type.contains("flac") {
        return "flac";
    }
    if content_type.contains("mpeg") || content_type.contains("mp3") {
        return "mp3";
    }
    if content_type.contains("ogg") {
        return "ogg";
    }
    if content_type.contains("aac") {
        return "aac";
    }
    if content_type.contains("mp4") || content_type.contains("m4a") {
        return "m4a";
    }
    let lower_url = source_url.to_ascii_lowercase();
    let path = lower_url.split(['?', '#']).next().unwrap_or_default();
    for extension in ["wav", "flac", "mp3", "ogg", "aac", "m4a"] {
        if path.ends_with(&format!(".{extension}")) {
            return extension;
        }
    }
    "wav"
}

async fn download_optional_text(
    client: &reqwest::Client,
    url: &str,
    token: &CancellationToken,
) -> Result<Option<String>, String> {
    let response = tokio::select! {
        _ = token.cancelled() => return Err(CANCELLED.into()),
        result = client.get(url).timeout(Duration::from_secs(20)).send() => match result { Ok(response) => response, Err(_) => return Ok(None) },
    };
    if !response.status().is_success() {
        return Ok(None);
    }
    tokio::select! {
        _ = token.cancelled() => Err(CANCELLED.into()),
        result = response.text() => Ok(result.ok()),
    }
}

fn build_http_client() -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .user_agent(format!(
            "Siren-Records-Cross-Platform/{}",
            env!("CARGO_PKG_VERSION")
        ));
    if let Some(proxy_url) = configured_proxy_url() {
        let proxy = reqwest::Proxy::all(&proxy_url)
            .map_err(|error| format!("系统代理地址无效：{error}"))?;
        builder = builder.proxy(proxy);
    }
    builder
        .build()
        .map_err(|error| format!("无法初始化网络连接：{error}"))
}

fn configured_proxy_url() -> Option<String> {
    [
        "SIREN_PROXY_URL",
        "HTTPS_PROXY",
        "https_proxy",
        "HTTP_PROXY",
        "http_proxy",
    ]
    .iter()
    .find_map(|key| {
        std::env::var(key)
            .ok()
            .filter(|value| !value.trim().is_empty())
    })
    .or_else(windows_system_proxy_url)
    .map(|value| normalize_proxy_url(&value))
}

fn normalize_proxy_url(value: &str) -> String {
    let value = value.trim();
    if value.contains("://") {
        value.to_owned()
    } else {
        format!("http://{value}")
    }
}

#[cfg(windows)]
fn windows_system_proxy_url() -> Option<String> {
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};

    let key = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings")
        .ok()?;
    let enabled: u32 = key.get_value("ProxyEnable").ok()?;
    if enabled == 0 {
        return None;
    }
    let configured: String = key.get_value("ProxyServer").ok()?;
    configured
        .split(';')
        .find_map(|entry| {
            entry
                .strip_prefix("https=")
                .or_else(|| entry.strip_prefix("http="))
        })
        .or_else(|| configured.split(';').find(|entry| !entry.contains('=')))
        .map(str::to_owned)
}

#[cfg(not(windows))]
fn windows_system_proxy_url() -> Option<String> {
    None
}

fn value_to_string(value: &Value) -> String {
    value
        .as_str()
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| value.to_string())
}

fn valid_song_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn safe_component(value: &str, fallback: &str) -> String {
    let mut result: String = value
        .chars()
        .map(|character| {
            if character.is_control()
                || matches!(
                    character,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                )
            {
                ' '
            } else {
                character
            }
        })
        .collect();
    result = result.split_whitespace().collect::<Vec<_>>().join(" ");
    result = result.trim_matches(['.', ' ']).to_string();
    if result.is_empty() {
        fallback.to_string()
    } else {
        result.chars().take(150).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::{audio_extension, safe_component, valid_song_id};

    #[test]
    fn preserves_the_official_audio_extension() {
        assert_eq!(
            audio_extension(Some("audio/flac"), "https://example.test/a.wav"),
            "flac"
        );
        assert_eq!(
            audio_extension(
                Some("application/octet-stream"),
                "https://example.test/a.mp3?sign=1"
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
