use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use regex::Regex;
use tauri::{AppHandle, Manager, Runtime};

const LOG_NAME: &str = "pob-redux";
const LOG_TAIL_LINES: usize = 600;

pub fn log_plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    use tauri_plugin_log::{RotationStrategy, Target, TargetKind, TimezoneStrategy};
    let level = match std::env::var("POB_REDUX_LOG").ok().as_deref() {
        Some("trace") => log::LevelFilter::Trace,
        Some("debug") => log::LevelFilter::Debug,
        Some("warn") => log::LevelFilter::Warn,
        Some("error") => log::LevelFilter::Error,
        _ => log::LevelFilter::Info,
    };
    tauri_plugin_log::Builder::new()
        .clear_targets()
        .target(Target::new(TargetKind::Stderr))
        .target(Target::new(TargetKind::LogDir { file_name: Some(LOG_NAME.into()) }))
        .rotation_strategy(RotationStrategy::KeepSome(3))
        .timezone_strategy(TimezoneStrategy::UseLocal)
        .max_file_size(4_000_000)
        .level(level)
        .level_for("pob", log::LevelFilter::Warn)
        .build()
}

pub fn install_panic_hook() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        log::error!("panic: {info}\n{}", std::backtrace::Backtrace::force_capture());
        default_hook(info);
    }));
}

#[tauri::command]
pub fn log_frontend(level: String, message: String) {
    let message: String = message.chars().take(4000).collect();
    match level.as_str() {
        "error" => log::error!(target: "webview", "{message}"),
        "warn" => log::warn!(target: "webview", "{message}"),
        _ => log::info!(target: "webview", "{message}"),
    }
}

#[tauri::command]
pub fn reveal_logs(app: AppHandle) -> Result<String, String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    let path = dir.join(format!("{LOG_NAME}.log"));
    if path.is_file() {
        app.opener().reveal_item_in_dir(&path).map_err(|e| e.to_string())?;
    } else {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        app.opener().open_path(dir.to_string_lossy(), None::<&str>).map_err(|e| e.to_string())?;
    }
    Ok(dir.to_string_lossy().to_string())
}

fn home_dir() -> Option<String> {
    std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).ok().filter(|h| h.len() > 3)
}

pub fn redact(text: &str, secrets: &[String]) -> String {
    static PATTERNS: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    let patterns = PATTERNS.get_or_init(|| {
        [
            (r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}", "$1 [masked]"),
            (r"\bsk-[A-Za-z0-9_-]{12,}", "[masked key]"),
            (r#"(?i)\b(x-api-key|authorization|api[_-]?key)(["']?\s*[:=]\s*["']?)[^\s"',&]+"#, "$1$2[masked]"),
            (r"(?i)\b(token|code|sig|secret|password|code_verifier|refresh_token|access_token)=[^&\s\x22]+", "$1=[masked]"),
        ]
        .into_iter()
        .filter_map(|(p, r)| Regex::new(p).ok().map(|re| (re, r)))
        .collect()
    });
    let mut out = text.to_string();
    for secret in secrets.iter().map(|s| s.trim()).filter(|s| s.len() >= 8) {
        out = out.replace(secret, "[masked]");
    }
    if let Some(home) = home_dir() {
        for variant in [home.clone(), home.replace('\\', "/")] {
            if let Ok(re) = Regex::new(&format!("(?i){}", regex::escape(&variant))) {
                out = re.replace_all(&out, "~").into_owned();
            }
        }
    }
    for (re, with) in patterns {
        out = re.replace_all(&out, *with).into_owned();
    }
    out
}

/// The assistant log holds whole conversations, so only run metadata goes in the report.
fn assistant_summary(text: &str) -> String {
    text.lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .map(|run| {
            let field = |k: &str| run.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
            let error = field("error");
            format!("{} {} {}{}", field("at"), field("provider"), field("model"), if error.is_empty() { String::new() } else { format!(" error: {error}") })
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn tail(path: &Path, lines: usize) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    let text = String::from_utf8_lossy(&bytes);
    let all: Vec<&str> = text.lines().collect();
    Some(all[all.len().saturating_sub(lines)..].join("\n"))
}

fn log_files(app: &AppHandle) -> Vec<PathBuf> {
    let mut app_logs: Vec<(std::time::SystemTime, PathBuf)> = app
        .path()
        .app_log_dir()
        .ok()
        .and_then(|dir| std::fs::read_dir(dir).ok())
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            name.starts_with(LOG_NAME) && name.ends_with(".log")
        })
        .map(|e| (e.metadata().and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH), e.path()))
        .collect();
    app_logs.sort_by_key(|(modified, _)| std::cmp::Reverse(*modified));
    let mut files: Vec<PathBuf> = app_logs.into_iter().take(2).map(|(_, p)| p).collect();
    if let Ok(dir) = app.path().app_config_dir() {
        let assistant = dir.join("logs").join("assistant.log");
        if assistant.is_file() {
            files.push(assistant);
        }
    }
    files
}

pub fn write_report(app: &AppHandle, path: &str, facts: &[(&str, String)], secrets: &[String]) -> Result<(), String> {
    let mut out = String::from("PoB Redux diagnostics\n\n");
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    out.push_str(&format!("{:<24}{}\n", "Written (unix time)", secs));
    for (label, value) in facts {
        out.push_str(&format!("{label:<24}{value}\n"));
    }
    for file in log_files(app) {
        let name = file.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let lines = if name == "assistant.log" { 40 } else { LOG_TAIL_LINES };
        out.push_str(&format!("\n===== {name} (last {lines} lines) =====\n"));
        let body = tail(&file, lines).map(|text| if name == "assistant.log" { assistant_summary(&text) } else { text });
        out.push_str(&body.unwrap_or_else(|| "(unreadable)".into()));
        out.push('\n');
    }
    std::fs::write(path, redact(&out, secrets)).map_err(|e| format!("{path}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::redact;

    #[test]
    fn masks_credentials() {
        let text = "auth: Bearer abcdef0123456789 key sk-or-v1-0123456789abcdef x-api-key: hunter2hunter2 url?token=abc123&x=1 mine=s3cr3tvalue";
        let out = redact(text, &["s3cr3tvalue".into()]);
        assert!(!out.contains("abcdef0123456789"), "{out}");
        assert!(!out.contains("sk-or-v1-0123456789abcdef"), "{out}");
        assert!(!out.contains("hunter2hunter2"), "{out}");
        assert!(!out.contains("token=abc123"), "{out}");
        assert!(!out.contains("s3cr3tvalue"), "{out}");
        assert!(out.contains("x=1"), "{out}");
    }
}
