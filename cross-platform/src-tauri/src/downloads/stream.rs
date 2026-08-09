use super::{
    filesystem::{remove_if_exists, write_atomic},
    security::{validate_resource_url, MAX_AUDIO_BYTES, MAX_LYRIC_BYTES},
    CANCELLED,
};
use futures_util::StreamExt;
use reqwest::{
    header::{CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, ETAG, IF_RANGE, LAST_MODIFIED, RANGE},
    StatusCode,
};
use serde::{Deserialize, Serialize};
use std::{
    path::Path,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter};
use tokio::{fs, io::AsyncWriteExt};
use tokio_util::sync::CancellationToken;

const IDLE_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    id: String,
    loaded: u64,
    total: Option<u64>,
    rate: f64,
    eta_seconds: Option<u64>,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ResumeMetadata {
    downloaded: u64,
    etag: Option<String>,
    last_modified: Option<String>,
}

pub struct DownloadedAudio {
    pub content_type: Option<String>,
}

pub fn should_refresh_audio_url(error: &str) -> bool {
    error.contains("HTTP 401") || error.contains("HTTP 403") || error.contains("HTTP 404")
}

pub async fn download_audio(
    app: &AppHandle,
    client: &reqwest::Client,
    url: &str,
    destination: &Path,
    id: &str,
    token: &CancellationToken,
) -> Result<DownloadedAudio, String> {
    let url = validate_resource_url(url)?;
    let metadata_path = destination.with_file_name("resume.json");
    let existing = fs::metadata(destination)
        .await
        .map(|value| value.len())
        .unwrap_or(0);
    let resume = read_resume(&metadata_path).await.unwrap_or_default();
    // Resume only when durable metadata exactly matches the part file. A crash
    // between writing a chunk and syncing metadata must restart safely.
    let resume_from = safe_resume_offset(existing, resume.downloaded);
    let mut request = client.get(url);
    if resume_from > 0 {
        request = request.header(RANGE, format!("bytes={resume_from}-"));
        if let Some(validator) = resume.etag.as_deref().or(resume.last_modified.as_deref()) {
            request = request.header(IF_RANGE, validator);
        }
    }
    let response = tokio::select! {
        _ = token.cancelled() => { cleanup_cancelled(destination, &metadata_path).await; return Err(CANCELLED.into()); },
        result = request.send() => result.map_err(|error| format!("音频网络请求失败：{error}"))?,
    };
    if !response.status().is_success() {
        return Err(format!("音频请求失败：HTTP {}", response.status().as_u16()));
    }
    let append = can_resume(resume_from, response.status());
    let offset = if append { resume_from } else { 0 };
    let declared = response
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());
    let total = response
        .headers()
        .get(CONTENT_RANGE)
        .and_then(|value| value.to_str().ok())
        .and_then(parse_content_range_total)
        .or_else(|| declared.map(|length| offset.saturating_add(length)));
    if total.is_some_and(|length| length > MAX_AUDIO_BYTES) {
        return Err("音频文件超过允许的最大大小".into());
    }
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let current_resume = ResumeMetadata {
        downloaded: offset,
        etag: response
            .headers()
            .get(ETAG)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned),
        last_modified: response
            .headers()
            .get(LAST_MODIFIED)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned),
    };
    write_resume(&metadata_path, &current_resume).await?;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(append)
        .truncate(!append)
        .open(destination)
        .await
        .map_err(|error| format!("无法创建临时音频：{error}"))?;
    let mut stream = response.bytes_stream();
    let mut downloaded = offset;
    let mut last_downloaded = downloaded;
    let mut last_report = Instant::now();
    while let Some(chunk) = tokio::select! {
        _ = token.cancelled() => { cleanup_cancelled(destination, &metadata_path).await; return Err(CANCELLED.into()); },
        result = tokio::time::timeout(IDLE_TIMEOUT, stream.next()) => result.map_err(|_| "音频读取超时，请检查网络后重试".to_string())?,
    } {
        let chunk = chunk.map_err(|error| format!("音频下载中断：{error}"))?;
        downloaded = checked_audio_size(downloaded, chunk.len())?;
        file.write_all(&chunk)
            .await
            .map_err(|error| format!("无法写入临时音频：{error}"))?;
        let elapsed = last_report.elapsed();
        if elapsed.as_millis() >= 250 || total.is_some_and(|size| downloaded >= size) {
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
            write_resume(
                &metadata_path,
                &ResumeMetadata {
                    downloaded,
                    etag: current_resume.etag.clone(),
                    last_modified: current_resume.last_modified.clone(),
                },
            )
            .await?;
            last_report = Instant::now();
            last_downloaded = downloaded;
        }
    }
    file.flush()
        .await
        .map_err(|error| format!("无法刷新临时音频：{error}"))?;
    file.sync_all()
        .await
        .map_err(|error| format!("无法同步临时音频：{error}"))?;
    if let Some(expected) = total {
        if downloaded != expected {
            return Err(format!(
                "音频下载不完整：应为 {expected} 字节，实际为 {downloaded} 字节"
            ));
        }
    }
    remove_if_exists(&metadata_path).await?;
    Ok(DownloadedAudio { content_type })
}

pub async fn download_optional_text(
    client: &reqwest::Client,
    url: &str,
    token: &CancellationToken,
) -> Result<Option<String>, String> {
    let url = validate_resource_url(url)?;
    let response = tokio::select! { _ = token.cancelled() => return Err(CANCELLED.into()), result = client.get(url).send() => match result { Ok(value) => value, Err(_) => return Ok(None) } };
    if !response.status().is_success() {
        return Ok(None);
    }
    if response
        .content_length()
        .is_some_and(|value| value > MAX_LYRIC_BYTES)
    {
        return Err("歌词文件超过允许的最大大小".into());
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = tokio::select! { _ = token.cancelled() => return Err(CANCELLED.into()), result = tokio::time::timeout(IDLE_TIMEOUT, stream.next()) => result.map_err(|_| "歌词读取超时".to_string())? }
    {
        let chunk = chunk.map_err(|error| format!("歌词下载中断：{error}"))?;
        if bytes.len().saturating_add(chunk.len()) > MAX_LYRIC_BYTES as usize {
            return Err("歌词实际大小超过允许的最大值".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(String::from_utf8(bytes).ok())
}

pub async fn recover_partial_downloads(root: &Path) -> Result<(), String> {
    let mut entries = match fs::read_dir(root).await {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("无法检查未完成下载：{error}")),
    };
    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|error| format!("无法读取临时下载目录：{error}"))?
    {
        if !entry
            .file_type()
            .await
            .map_err(|error| format!("无法读取临时文件类型：{error}"))?
            .is_dir()
        {
            continue;
        }
        let directory = entry.path();
        let part = directory.join("audio.part");
        let resume = directory.join("resume.json");
        let part_size = fs::metadata(&part)
            .await
            .map(|value| value.len())
            .unwrap_or(0);
        let metadata = read_resume(&resume).await;
        if part_size == 0
            || metadata
                .as_ref()
                .map_or(true, |value| value.downloaded < part_size)
        {
            let _ = remove_if_exists(&part).await;
            let _ = remove_if_exists(&resume).await;
            let _ = fs::remove_dir(&directory).await;
        }
    }
    Ok(())
}

fn parse_content_range_total(value: &str) -> Option<u64> {
    value.rsplit('/').next()?.parse().ok()
}

fn can_resume(offset: u64, status: StatusCode) -> bool {
    offset > 0 && status == StatusCode::PARTIAL_CONTENT
}

fn safe_resume_offset(part_size: u64, recorded_size: u64) -> u64 {
    if part_size > 0 && part_size == recorded_size {
        part_size
    } else {
        0
    }
}

fn checked_audio_size(current: u64, chunk_size: usize) -> Result<u64, String> {
    let next = current
        .checked_add(chunk_size as u64)
        .ok_or("音频大小溢出")?;
    if next > MAX_AUDIO_BYTES {
        Err("音频实际大小超过允许的最大值".into())
    } else {
        Ok(next)
    }
}

async fn read_resume(path: &Path) -> Result<ResumeMetadata, String> {
    let bytes = fs::read(path).await.map_err(|error| error.to_string())?;
    serde_json::from_slice(&bytes).map_err(|error| error.to_string())
}

async fn write_resume(path: &Path, metadata: &ResumeMetadata) -> Result<(), String> {
    let bytes =
        serde_json::to_vec(metadata).map_err(|error| format!("无法生成断点记录：{error}"))?;
    write_atomic(path, &bytes)
        .await
        .map_err(|error| format!("无法保存断点记录：{error}"))
}

async fn cleanup_cancelled(part: &Path, resume: &Path) {
    let _ = remove_if_exists(part).await;
    let _ = remove_if_exists(resume).await;
}

#[cfg(test)]
mod tests {
    use super::{
        can_resume, checked_audio_size, cleanup_cancelled, parse_content_range_total,
        safe_resume_offset,
    };
    use reqwest::StatusCode;
    use std::{
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };
    #[test]
    fn parses_range_total() {
        assert_eq!(parse_content_range_total("bytes 100-199/1000"), Some(1000));
        assert_eq!(parse_content_range_total("invalid"), None);
    }

    #[test]
    fn resumes_only_after_a_partial_content_response() {
        assert!(can_resume(1024, StatusCode::PARTIAL_CONTENT));
        assert!(!can_resume(1024, StatusCode::OK));
        assert!(!can_resume(0, StatusCode::PARTIAL_CONTENT));
    }

    #[test]
    fn restarts_when_part_and_resume_metadata_disagree() {
        assert_eq!(safe_resume_offset(4096, 4096), 4096);
        assert_eq!(safe_resume_offset(4096, 2048), 0);
        assert_eq!(safe_resume_offset(2048, 4096), 0);
    }

    #[test]
    fn rejects_audio_bytes_above_the_runtime_limit() {
        assert!(checked_audio_size(super::MAX_AUDIO_BYTES, 1).is_err());
    }

    #[tokio::test]
    async fn cancellation_removes_partial_state() {
        let root = std::env::temp_dir().join(format!(
            "siren-cancel-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let part = root.join("audio.part");
        let resume = root.join("resume.json");
        fs::write(&part, b"partial").unwrap();
        fs::write(&resume, b"{}").unwrap();
        cleanup_cancelled(&part, &resume).await;
        assert!(!part.exists() && !resume.exists());
        let _ = fs::remove_dir_all(root);
    }
}
