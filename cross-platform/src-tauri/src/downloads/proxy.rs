use std::time::Duration;

pub fn build_http_client() -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(60))
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

pub(crate) fn configured_proxy_url() -> Option<String> {
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

pub(crate) fn normalize_proxy_url(value: &str) -> String {
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

#[cfg(test)]
mod tests {
    use super::normalize_proxy_url;
    #[test]
    fn normalizes_proxy_addresses() {
        assert_eq!(
            normalize_proxy_url("127.0.0.1:7890"),
            "http://127.0.0.1:7890"
        );
        assert_eq!(
            normalize_proxy_url("https://proxy.test"),
            "https://proxy.test"
        );
    }
}
