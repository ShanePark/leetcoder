use reqwest::header::HeaderValue;
use serde_json::{json, Value};
use std::fmt;
use std::fs;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use tempfile::NamedTempFile;

const KEY_FILE: &str = "ai-credentials.json";

/// An API key. It deliberately implements neither `Serialize` nor `Display`, so
/// it can only leave this type through `expose`.
pub(super) struct ApiKey(String);

impl ApiKey {
    pub(super) fn new(raw: &str) -> Result<Self, String> {
        // Keys never contain whitespace, so a space or line break can only come
        // from copying, including a key wrapped across lines.
        let key: String = raw.split_whitespace().collect();
        if key.is_empty() {
            return Err("Enter an API key.".to_string());
        }
        // Rejecting this here keeps every later header construction infallible
        // in practice, and the message never repeats the input.
        if HeaderValue::from_str(&key).is_err() {
            return Err("The API key contains invalid characters.".to_string());
        }
        Ok(Self(key))
    }

    pub(super) fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for ApiKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ApiKey(<redacted>)")
    }
}

fn key_path(config_dir: &Path) -> PathBuf {
    config_dir.join(KEY_FILE)
}

/// Parse errors from `serde_json` can quote the input, so they are replaced with
/// a fixed message rather than passed along.
pub(super) fn load(config_dir: &Path) -> Result<Option<ApiKey>, String> {
    const UNREADABLE: &str = "The saved API key could not be read. Save the key again.";
    let bytes = match fs::read(key_path(config_dir)) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(UNREADABLE.to_string()),
    };
    let document: Value = serde_json::from_slice(&bytes).map_err(|_| UNREADABLE.to_string())?;
    let raw = document
        .pointer("/anthropic/apiKey")
        .and_then(Value::as_str)
        .ok_or_else(|| UNREADABLE.to_string())?;
    ApiKey::new(raw)
        .map(Some)
        .map_err(|_| UNREADABLE.to_string())
}

pub(super) fn save(config_dir: &Path, key: &ApiKey) -> Result<(), String> {
    let failed = |error: std::io::Error| format!("Could not save the API key: {error}");
    fs::create_dir_all(config_dir).map_err(failed)?;
    let document = json!({ "anthropic": { "kind": "apiKey", "apiKey": key.expose() } });
    let mut temporary = NamedTempFile::new_in(config_dir).map_err(failed)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        temporary
            .as_file()
            .set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(failed)?;
    }
    temporary
        .write_all(document.to_string().as_bytes())
        .map_err(failed)?;
    temporary.flush().map_err(failed)?;
    temporary
        .persist(key_path(config_dir))
        .map_err(|error| failed(error.error))?;
    Ok(())
}

pub(super) fn clear(config_dir: &Path) -> Result<(), String> {
    match fs::remove_file(key_path(config_dir)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Could not remove the API key: {error}")),
    }
}
