use super::{security::valid_song_id, CANCELLED};
use serde_json::Value;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

const API_ROOT: &str = "https://monster-siren.hypergryph.com/api";

pub async fn fetch_catalog_json(client: &reqwest::Client, path: &str) -> Result<Value, String> {
    let response = client
        .get(format!("{API_ROOT}{path}"))
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

pub async fn fetch_song(
    client: &reqwest::Client,
    id: &str,
    token: Option<&CancellationToken>,
) -> Result<Value, String> {
    if !valid_song_id(id) {
        return Err("歌曲编号无效".into());
    }
    let payload = fetch_json(client, &format!("{API_ROOT}/song/{id}"), token).await?;
    payload
        .get("data")
        .cloned()
        .ok_or_else(|| "歌曲信息为空".into())
}

pub async fn fetch_album(
    client: &reqwest::Client,
    id: &str,
    token: &CancellationToken,
) -> Result<Value, String> {
    if !valid_song_id(id) {
        return Err("专辑编号无效".into());
    }
    let payload = fetch_json(client, &format!("{API_ROOT}/album/{id}/data"), Some(token)).await?;
    Ok(payload.get("data").cloned().unwrap_or(Value::Null))
}

async fn fetch_json(
    client: &reqwest::Client,
    url: &str,
    token: Option<&CancellationToken>,
) -> Result<Value, String> {
    let request = client.get(url).timeout(Duration::from_secs(20));
    let response = if let Some(token) = token {
        tokio::select! { _ = token.cancelled() => return Err(CANCELLED.into()), result = request.send() => result }
    } else { request.send().await }
        .map_err(|error| format!("网络请求失败：{error}"))?
        .error_for_status().map_err(|error| format!("服务请求失败：{error}"))?;
    if let Some(token) = token {
        tokio::select! { _ = token.cancelled() => Err(CANCELLED.into()), result = response.json::<Value>() => result.map_err(|error| format!("无法读取服务数据：{error}")) }
    } else {
        response
            .json::<Value>()
            .await
            .map_err(|error| format!("无法读取服务数据：{error}"))
    }
}

pub fn value_to_string(value: &Value) -> String {
    value
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| value.to_string())
}
