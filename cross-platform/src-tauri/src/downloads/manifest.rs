use super::filesystem::write_atomic;
use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};
use tokio::fs;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadRecord {
    pub cid: String,
    pub file_path: String,
    pub file_size: u64,
    pub completed_at: u64,
}

#[derive(Default, Deserialize, Serialize)]
struct DownloadManifest {
    records: Vec<DownloadRecord>,
}

fn manifest_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join("downloads-manifest.json"))
        .map_err(|error| format!("无法定位下载记录目录：{error}"))
}

pub async fn read_manifest(app: &AppHandle) -> Result<Vec<DownloadRecord>, String> {
    let path = manifest_path(app)?;
    match fs::read(&path).await {
        Ok(bytes) => match serde_json::from_slice::<DownloadManifest>(&bytes) {
            Ok(manifest) => Ok(manifest.records),
            Err(_) => {
                backup_corrupt_manifest(&path).await?;
                Ok(Vec::new())
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(format!("无法读取下载记录：{error}")),
    }
}

pub async fn write_record(app: &AppHandle, record: DownloadRecord) -> Result<(), String> {
    let mut records = read_manifest(app).await?;
    records.retain(|item| item.cid != record.cid);
    records.push(record);
    write_manifest(app, &records).await
}

pub async fn verify_manifest(app: &AppHandle) -> Result<Vec<String>, String> {
    let records = read_manifest(app).await?;
    let original_len = records.len();
    let mut valid = Vec::with_capacity(original_len);
    for record in records {
        if fs::metadata(&record.file_path).await.is_ok_and(|metadata| {
            metadata.is_file() && metadata.len() == record.file_size && record.file_size > 0
        }) {
            valid.push(record);
        }
    }
    if valid.len() != original_len {
        write_manifest(app, &valid).await?;
    }
    Ok(valid.into_iter().map(|record| record.cid).collect())
}

async fn write_manifest(app: &AppHandle, records: &[DownloadRecord]) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(&DownloadManifest {
        records: records.to_vec(),
    })
    .map_err(|error| format!("无法生成下载记录：{error}"))?;
    write_atomic(&manifest_path(app)?, &bytes)
        .await
        .map_err(|error| format!("无法保存下载记录：{error}"))
}

async fn backup_corrupt_manifest(path: &std::path::Path) -> Result<(), String> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let backup = path.with_extension(format!("json.corrupt-{timestamp}"));
    fs::rename(path, backup)
        .await
        .map_err(|error| format!("下载记录损坏且无法备份：{error}"))
}

#[cfg(test)]
mod tests {
    use super::DownloadManifest;
    #[test]
    fn rejects_corrupt_manifest_json() {
        assert!(serde_json::from_slice::<DownloadManifest>(b"{broken").is_err());
    }
}
