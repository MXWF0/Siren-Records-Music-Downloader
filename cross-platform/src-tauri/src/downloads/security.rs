use reqwest::Url;

pub const MAX_AUDIO_BYTES: u64 = 2 * 1024 * 1024 * 1024;
pub const MAX_LYRIC_BYTES: u64 = 4 * 1024 * 1024;

pub fn valid_song_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

pub fn validate_resource_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "资源地址格式无效".to_string())?;
    if url.scheme() != "https" {
        return Err("资源地址必须使用 HTTPS".into());
    }
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    if host != "monster-siren.hypergryph.com" && host != "hycdn.cn" && !host.ends_with(".hycdn.cn")
    {
        return Err("资源地址不在允许的官方域名中".into());
    }
    Ok(url)
}

pub fn audio_extension(content_type: Option<&str>, source_url: &str) -> &'static str {
    let content_type = content_type.unwrap_or_default().to_ascii_lowercase();
    for (needle, extension) in [
        ("flac", "flac"),
        ("mpeg", "mp3"),
        ("mp3", "mp3"),
        ("ogg", "ogg"),
        ("aac", "aac"),
        ("mp4", "m4a"),
        ("m4a", "m4a"),
    ] {
        if content_type.contains(needle) {
            return extension;
        }
    }
    let path = source_url.to_ascii_lowercase();
    let path = path.split(['?', '#']).next().unwrap_or_default();
    ["wav", "flac", "mp3", "ogg", "aac", "m4a"]
        .into_iter()
        .find(|extension| path.ends_with(&format!(".{extension}")))
        .unwrap_or("wav")
}

pub fn safe_component(value: &str, fallback: &str) -> String {
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
    use super::validate_resource_url;

    #[test]
    fn accepts_only_https_official_resources() {
        assert!(validate_resource_url("https://res01.hycdn.cn/siren/a.wav").is_ok());
        assert!(validate_resource_url("http://res01.hycdn.cn/siren/a.wav").is_err());
        assert!(validate_resource_url("https://example.com/a.wav").is_err());
    }
}
