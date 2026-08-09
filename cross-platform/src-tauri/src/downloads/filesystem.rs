use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use tokio::{fs, io::AsyncWriteExt};
use uuid::Uuid;

pub fn resolve_download_directory(app: &AppHandle, configured: &str) -> Result<String, String> {
    let configured = configured.trim();
    if !configured.is_empty() {
        return Ok(configured.to_owned());
    }
    app.path()
        .download_dir()
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|error| format!("无法获取系统默认下载目录：{error}"))
}

pub async fn validate_directory(directory: &str) -> Result<(), String> {
    if directory.trim().is_empty() {
        return Err("请先选择下载目录".into());
    }
    let path = PathBuf::from(directory.trim());
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
    file.flush()
        .await
        .map_err(|error| format!("下载目录无法完成写入，请检查权限：{error}"))?;
    file.sync_all()
        .await
        .map_err(|error| format!("下载目录无法同步写入，请检查权限：{error}"))?;
    drop(file);
    fs::remove_file(&probe)
        .await
        .map_err(|error| format!("无法清理下载目录校验文件：{error}"))
}

pub async fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("目标文件目录无效")?;
    fs::create_dir_all(parent)
        .await
        .map_err(|error| format!("无法创建目标目录：{error}"))?;
    let temporary = temporary_path(path, "tmp");
    let mut file = fs::File::create(&temporary)
        .await
        .map_err(|error| format!("无法创建临时文件：{error}"))?;
    file.write_all(bytes)
        .await
        .map_err(|error| format!("无法写入临时文件：{error}"))?;
    file.flush()
        .await
        .map_err(|error| format!("无法刷新临时文件：{error}"))?;
    file.sync_all()
        .await
        .map_err(|error| format!("无法同步临时文件：{error}"))?;
    drop(file);
    atomic_replace(&temporary, path).await
}

pub async fn atomic_replace(source: &Path, destination: &Path) -> Result<(), String> {
    sync_file(source).await?;
    let backup = temporary_path(destination, "bak");
    remove_if_exists(&backup).await?;
    let had_destination = fs::metadata(destination).await.is_ok();
    if had_destination {
        fs::rename(destination, &backup)
            .await
            .map_err(|error| format!("无法备份已有文件：{error}"))?;
    }
    if let Err(error) = fs::rename(source, destination).await {
        if had_destination {
            let _ = fs::rename(&backup, destination).await;
        }
        return Err(format!("无法原子替换目标文件：{error}"));
    }
    sync_parent(destination).await?;
    if had_destination {
        remove_if_exists(&backup).await?;
    }
    Ok(())
}

pub async fn remove_if_exists(path: &Path) -> Result<(), String> {
    match fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("无法删除临时文件：{error}")),
    }
}

fn temporary_path(path: &Path, suffix: &str) -> PathBuf {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("siren-file");
    path.with_file_name(format!(".{name}.{suffix}"))
}

async fn sync_file(path: &Path) -> Result<(), String> {
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .await
        .map_err(|error| format!("无法打开待保存文件：{error}"))?;
    file.sync_all()
        .await
        .map_err(|error| format!("无法同步待保存文件：{error}"))
}

async fn sync_parent(_path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        let parent = _path.parent().ok_or("目标文件目录无效")?;
        let directory = fs::File::open(parent)
            .await
            .map_err(|error| format!("无法打开目标目录：{error}"))?;
        directory
            .sync_all()
            .await
            .map_err(|error| format!("无法同步目标目录：{error}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::atomic_replace;
    use std::{
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    #[tokio::test]
    async fn atomically_replaces_existing_files() {
        let root = std::env::temp_dir().join(format!(
            "siren-atomic-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let source = root.join("source.part");
        let target = root.join("track.wav");
        fs::write(&source, b"new").unwrap();
        fs::write(&target, b"old").unwrap();
        atomic_replace(&source, &target).await.unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"new");
        let _ = fs::remove_dir_all(root);
    }
}
