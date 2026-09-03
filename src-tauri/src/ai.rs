//! Providers, keys, and the request proxy for the in-app chat panel.
//!
//! Keys live in the OS credential store and are never sent to the webview. The
//! webview asks for a stream by provider id and path; this module resolves the
//! base URL and key, makes the request from Rust, and pushes the response back
//! in chunks. A compromised frontend can spend a key but cannot read one.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

const SERVICE: &str = "dev.pobredux.desktop";

/// How a provider expects to be talked to.
#[derive(Serialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum ApiKind {
    /// `x-api-key` + `anthropic-version`, `/v1/messages`.
    Anthropic,
    /// `Authorization: Bearer`, `/chat/completions`, `/models`.
    OpenAiCompatible,
}

pub struct Provider {
    pub id: &'static str,
    pub label: &'static str,
    pub kind: ApiKind,
    pub default_base: &'static str,
    /// Local Ollama needs no key.
    pub needs_key: bool,
    /// Where to get a key, shown in the settings sheet.
    pub keys_url: Option<&'static str>,
}

pub const PROVIDERS: &[Provider] = &[
    Provider {
        id: "anthropic",
        label: "Anthropic",
        kind: ApiKind::Anthropic,
        default_base: "https://api.anthropic.com",
        needs_key: true,
        keys_url: Some("https://console.anthropic.com/settings/keys"),
    },
    Provider {
        id: "openai",
        label: "OpenAI",
        kind: ApiKind::OpenAiCompatible,
        default_base: "https://api.openai.com/v1",
        needs_key: true,
        keys_url: Some("https://platform.openai.com/api-keys"),
    },
    Provider {
        id: "openrouter",
        label: "OpenRouter",
        kind: ApiKind::OpenAiCompatible,
        default_base: "https://openrouter.ai/api/v1",
        needs_key: true,
        keys_url: Some("https://openrouter.ai/keys"),
    },
    Provider {
        id: "opencode",
        label: "OpenCode Zen",
        kind: ApiKind::OpenAiCompatible,
        default_base: "https://opencode.ai/zen/v1",
        needs_key: true,
        keys_url: Some("https://opencode.ai/auth"),
    },
    Provider {
        id: "ollama-cloud",
        label: "Ollama (Cloud)",
        kind: ApiKind::OpenAiCompatible,
        default_base: "https://ollama.com/v1",
        needs_key: true,
        keys_url: Some("https://ollama.com/settings/keys"),
    },
    Provider {
        id: "ollama-local",
        label: "Ollama (Local)",
        kind: ApiKind::OpenAiCompatible,
        default_base: "http://localhost:11434/v1",
        needs_key: false,
        keys_url: None,
    },
];

fn find(id: &str) -> Result<&'static Provider, String> {
    PROVIDERS.iter().find(|p| p.id == id).ok_or_else(|| format!("unknown provider {id}"))
}

/// Base URL overrides, for self-hosted Ollama or a gateway in front of a
/// provider. Stored app-side (not secret); keys stay in the credential store.
#[derive(Default)]
pub struct AiState {
    bases: Mutex<HashMap<String, String>>,
}

impl AiState {
    pub fn new(app: &AppHandle) -> Self {
        Self { bases: Mutex::new(read_bases(app).unwrap_or_default()) }
    }
}

fn bases_path(app: &AppHandle) -> Option<PathBuf> {
    Some(app.path().app_config_dir().ok()?.join("providers.json"))
}

fn read_bases(app: &AppHandle) -> Option<HashMap<String, String>> {
    serde_json::from_str(&std::fs::read_to_string(bases_path(app)?).ok()?).ok()
}

fn write_bases(app: &AppHandle, bases: &HashMap<String, String>) -> Result<(), String> {
    let path = bases_path(app).ok_or("no config dir")?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, serde_json::to_string_pretty(bases).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

fn base_url(app: &AppHandle, p: &Provider) -> String {
    app.state::<AiState>()
        .bases
        .lock()
        .unwrap()
        .get(p.id)
        .cloned()
        .unwrap_or_else(|| p.default_base.to_string())
}

fn entry(id: &str) -> Result<keyring::Entry, String> {
    find(id)?;
    keyring::Entry::new(SERVICE, id).map_err(|e| e.to_string())
}

fn stored_key(id: &str) -> Option<String> {
    entry(id).ok().and_then(|e| e.get_password().ok())
}

#[derive(Serialize)]
pub struct ProviderStatus {
    id: &'static str,
    label: &'static str,
    kind: ApiKind,
    needs_key: bool,
    keys_url: Option<&'static str>,
    base_url: String,
    default_base: &'static str,
    has_key: bool,
    /// Last four characters, so the user can tell which key is stored.
    hint: Option<String>,
    /// Usable now: either no key is needed, or one is stored.
    ready: bool,
}

#[tauri::command]
pub fn ai_providers(app: AppHandle) -> Vec<ProviderStatus> {
    PROVIDERS
        .iter()
        .map(|p| {
            let key = stored_key(p.id);
            ProviderStatus {
                id: p.id,
                label: p.label,
                kind: p.kind,
                needs_key: p.needs_key,
                keys_url: p.keys_url,
                base_url: base_url(&app, p),
                default_base: p.default_base,
                has_key: key.is_some(),
                hint: key
                    .as_ref()
                    .map(|k| k.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect()),
                ready: !p.needs_key || key.is_some(),
            }
        })
        .collect()
}

#[tauri::command]
pub fn ai_key_set(provider: String, key: String) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("key is empty".into());
    }
    entry(&provider)?.set_password(key).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn ai_key_clear(provider: String) -> Result<(), String> {
    match entry(&provider)?.delete_credential() {
        Ok(()) => Ok(()),
        // Clearing a key that was never stored is a success from the UI's side.
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Override a provider's base URL. An empty string resets it to the default.
#[tauri::command]
pub fn ai_base_set(app: AppHandle, provider: String, base_url: String) -> Result<(), String> {
    let p = find(&provider)?;
    let url = base_url.trim().trim_end_matches('/').to_string();
    if !url.is_empty() && !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("base URL must start with http:// or https://".into());
    }
    let state = app.state::<AiState>();
    let snapshot = {
        let mut bases = state.bases.lock().unwrap();
        if url.is_empty() || url == p.default_base {
            bases.remove(p.id);
        } else {
            bases.insert(p.id.to_string(), url);
        }
        bases.clone()
    };
    write_bases(&app, &snapshot)
}

#[derive(Serialize)]
pub struct ModelInfo {
    id: String,
    label: String,
    /// Whether to offer the effort selector for this model.
    supports_effort: bool,
    /// Current-generation, or one generation back. The UI groups these first.
    recommended: bool,
}

#[derive(Deserialize)]
struct ModelList {
    data: Vec<RawModel>,
}

/// Covers every provider's shape: OpenAI-compatible lists use `id` + numeric
/// `created`; Anthropic uses `display_name` + an RFC 3339 `created_at`.
#[derive(Deserialize)]
struct RawModel {
    id: String,
    #[serde(default)]
    created: Option<i64>,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    display_name: Option<String>,
}

impl RawModel {
    /// A sortable timestamp. Anthropic's RFC 3339 string is compared by its
    /// date prefix, which orders correctly without pulling in a date crate.
    fn sort_key(&self) -> i64 {
        if let Some(c) = self.created {
            return c;
        }
        if let Some(s) = &self.created_at {
            let digits: String = s.chars().filter(|c| c.is_ascii_digit()).take(8).collect();
            if let Ok(n) = digits.parse::<i64>() {
                return n; // YYYYMMDD, larger is newer
            }
        }
        0
    }
}

/// Endpoints that are not chat models. Provider lists mix in embeddings,
/// speech, image and moderation models that would only clutter the picker.
fn is_chat_model(id: &str) -> bool {
    let l = id.to_ascii_lowercase();
    const EXCLUDE: &[&str] = &[
        "embed", "whisper", "tts", "dall-e", "moderation", "rerank", "image", "audio", "transcribe",
        "realtime", "search", "codex", "guard", "vision-preview", "clip", "bge-", "nomic",
    ];
    !EXCLUDE.iter().any(|bad| l.contains(bad))
}

/// Current generation or one back, per provider family. Anything matching is
/// grouped at the top of the picker; everything else stays available below.
fn is_recommended(id: &str) -> bool {
    let l = id.to_ascii_lowercase();
    const CURRENT: &[&str] = &[
        // Anthropic: Claude 5 family and the 4.x generation before it
        "claude-opus-5",
        "claude-sonnet-5",
        "claude-fable-5",
        "claude-haiku-4-5",
        "claude-opus-4",
        "claude-sonnet-4",
        // OpenAI: GPT-5 line and the o-series reasoning models
        "gpt-5",
        "gpt-4.1",
        "o3",
        "o4-mini",
        // Widely used open models
        "llama-4",
        "llama3.3",
        "llama-3.3",
        "deepseek-v3",
        "deepseek-r1",
        "qwen3",
        "qwen-3",
        "mistral-large",
        "gemini-2.5",
        "gemini-3",
        "grok-4",
        "kimi-k2",
        "glm-4",
    ];
    CURRENT.iter().any(|c| l.contains(c))
}

/// Reasoning models take an effort setting. Matched on id because no provider
/// advertises the capability in its model list.
fn effort_capable(id: &str) -> bool {
    let l = id.to_ascii_lowercase();
    l.contains("claude-opus-5")
        || l.contains("claude-sonnet-5")
        || l.contains("gpt-5")
        || l.starts_with("o1")
        || l.starts_with("o3")
        || l.starts_with("o4")
        || l.contains("deepseek-r")
        || l.contains("qwq")
        || l.contains("thinking")
}

/// Models a provider offers, newest first. Every provider here publishes a
/// list endpoint, including Anthropic — Anthropic's just lives at `/v1/models`
/// and wants its own auth header.
///
/// OpenRouter alone returns several hundred entries, so the list is filtered to
/// chat models and the current generations are flagged `recommended` for the UI
/// to group at the top.
#[tauri::command]
pub async fn ai_models(app: AppHandle, provider: String) -> Result<Vec<ModelInfo>, String> {
    let p = find(&provider)?;
    let base = base_url(&app, p);
    let key = stored_key(p.id);
    if p.needs_key && key.is_none() {
        return Err(format!("no {} key stored", p.label));
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;

    // The OpenAI-compatible bases already end in /v1; Anthropic's does not.
    let url = match p.kind {
        ApiKind::Anthropic => format!("{base}/v1/models?limit=100"),
        ApiKind::OpenAiCompatible => format!("{base}/models"),
    };
    let mut req = client.get(url);
    if let Some(k) = key {
        req = match p.kind {
            ApiKind::Anthropic => req.header("x-api-key", k).header("anthropic-version", "2023-06-01"),
            ApiKind::OpenAiCompatible => req.header("authorization", format!("Bearer {k}")),
        };
    }
    let res = req.send().await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("{} returned {}", p.label, res.status()));
    }
    let text = res.text().await.map_err(|e| e.to_string())?;
    let list: ModelList =
        serde_json::from_str(&text).map_err(|e| format!("unexpected model list from {}: {e}", p.label))?;

    let mut raw: Vec<RawModel> = list.data.into_iter().filter(|m| is_chat_model(&m.id)).collect();
    // Newest first; ties fall back to the id so the order is stable.
    raw.sort_by(|a, b| b.sort_key().cmp(&a.sort_key()).then_with(|| a.id.cmp(&b.id)));

    Ok(raw
        .into_iter()
        .map(|m| ModelInfo {
            supports_effort: effort_capable(&m.id),
            recommended: is_recommended(&m.id),
            label: m.display_name.unwrap_or_else(|| m.id.clone()),
            id: m.id,
        })
        .collect())
}

/// One event in a streamed response. The webview reassembles these into a
/// `Response` so the AI SDK sees an ordinary `fetch`.
#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum StreamEvent {
    Head { status: u16 },
    /// A run of response body text, split on UTF-8 boundaries rather than on
    /// SSE events: the client buffers and splits on a blank line itself.
    Chunk { text: String },
    Done,
    Error { message: String },
}

/// Request headers the webview may set. Anything else is dropped so the panel
/// cannot smuggle in a second auth header or rewrite the host.
const FORWARDABLE: &[&str] = &[
    "content-type",
    "accept",
    "anthropic-version",
    "anthropic-beta",
    "openai-beta",
    "http-referer",
    "x-title",
];

/// Make a request to `provider` at `path`, injecting the stored key, and stream
/// the response body back over `on_event`.
///
/// `path` is joined to the provider's configured base URL. The webview never
/// supplies a host, so it cannot aim a key at a server of its choosing.
#[tauri::command]
pub async fn ai_chat_stream(
    app: AppHandle,
    provider: String,
    path: String,
    body: String,
    headers: Vec<(String, String)>,
    on_event: Channel<StreamEvent>,
) -> Result<(), String> {
    let p = find(&provider)?;
    if !path.starts_with('/') || path.starts_with("//") || path.contains("://") || path.contains("..") {
        return Err(format!("bad path {path}"));
    }
    let base = base_url(&app, p);
    let key = stored_key(p.id);
    if p.needs_key && key.is_none() {
        return Err(format!("no {} key stored", p.label));
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|e| e.to_string())?;

    // The base and the caller's path are concatenated, so exactly one of them
    // carries the version segment. Collapse it if both do: the request would
    // otherwise 404 with nothing to say why.
    let url = format!("{base}{path}").replace("/v1/v1/", "/v1/");
    let mut req = client.post(url).body(body);
    for (name, value) in headers {
        if FORWARDABLE.contains(&name.to_ascii_lowercase().as_str()) {
            req = req.header(name, value);
        }
    }
    if let Some(k) = key {
        req = match p.kind {
            ApiKind::Anthropic => req.header("x-api-key", k),
            ApiKind::OpenAiCompatible => req.header("authorization", format!("Bearer {k}")),
        };
    }

    let mut res = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            let _ = on_event.send(StreamEvent::Error { message: e.to_string() });
            return Ok(());
        }
    };

    on_event
        .send(StreamEvent::Head { status: res.status().as_u16() })
        .map_err(|e| e.to_string())?;

    // Chunk boundaries can land mid-character, so hold the tail until it completes.
    let mut pending: Vec<u8> = Vec::new();
    loop {
        match res.chunk().await {
            Ok(Some(bytes)) => {
                pending.extend_from_slice(&bytes);
                let valid = match std::str::from_utf8(&pending) {
                    Ok(s) => s.len(),
                    Err(e) => e.valid_up_to(),
                };
                if valid > 0 {
                    let text = String::from_utf8_lossy(&pending[..valid]).into_owned();
                    pending.drain(..valid);
                    if on_event.send(StreamEvent::Chunk { text }).is_err() {
                        return Ok(()); // receiver dropped: the user navigated away
                    }
                }
            }
            Ok(None) => break,
            Err(e) => {
                let _ = on_event.send(StreamEvent::Error { message: e.to_string() });
                return Ok(());
            }
        }
    }
    let _ = on_event.send(StreamEvent::Done);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{effort_capable, find, ApiKind, PROVIDERS};

    #[test]
    fn only_known_providers_resolve() {
        assert!(find("anthropic").is_ok());
        assert!(find("ollama-local").is_ok());
        assert!(find("evil.example.com").is_err());
        assert!(find("").is_err());
    }

    #[test]
    fn every_provider_has_an_absolute_default_base() {
        for p in PROVIDERS {
            assert!(
                p.default_base.starts_with("http://") || p.default_base.starts_with("https://"),
                "{} has a relative base",
                p.id
            );
            assert!(!p.default_base.ends_with('/'), "{} base has a trailing slash", p.id);
        }
    }

    #[test]
    fn local_ollama_is_the_only_keyless_provider() {
        let keyless: Vec<&str> = PROVIDERS.iter().filter(|p| !p.needs_key).map(|p| p.id).collect();
        assert_eq!(keyless, vec!["ollama-local"]);
    }

    #[test]
    fn anthropic_is_the_only_non_openai_shape() {
        let anthropic: Vec<&str> =
            PROVIDERS.iter().filter(|p| p.kind == ApiKind::Anthropic).map(|p| p.id).collect();
        assert_eq!(anthropic, vec!["anthropic"]);
    }

    #[test]
    fn non_chat_endpoints_are_filtered_out() {
        for id in [
            "text-embedding-3-large",
            "whisper-1",
            "tts-1-hd",
            "dall-e-3",
            "omni-moderation-latest",
            "nomic-embed-text",
            "bge-m3",
        ] {
            assert!(!super::is_chat_model(id), "{id} should be filtered");
        }
        for id in ["claude-sonnet-5", "gpt-5.2", "llama3.3:70b", "deepseek-v3"] {
            assert!(super::is_chat_model(id), "{id} should be kept");
        }
    }

    #[test]
    fn recommended_covers_current_and_previous_generation() {
        for id in ["claude-opus-5", "claude-sonnet-4-5", "gpt-5.2", "anthropic/claude-haiku-4-5"] {
            assert!(super::is_recommended(id), "{id} should be recommended");
        }
        for id in ["gpt-3.5-turbo", "claude-2.1", "llama2"] {
            assert!(!super::is_recommended(id), "{id} should not be recommended");
        }
    }

    #[test]
    fn newest_sorts_first_across_both_timestamp_shapes() {
        let numeric = super::RawModel {
            id: "a".into(),
            created: Some(1_700_000_000),
            created_at: None,
            display_name: None,
        };
        let older = super::RawModel { id: "b".into(), created: Some(1_600_000_000), created_at: None, display_name: None };
        assert!(numeric.sort_key() > older.sort_key());

        // Anthropic's RFC 3339 string reduces to YYYYMMDD.
        let iso = super::RawModel {
            id: "c".into(),
            created: None,
            created_at: Some("2025-10-01T00:00:00Z".into()),
            display_name: None,
        };
        let iso_older = super::RawModel {
            id: "d".into(),
            created: None,
            created_at: Some("2024-06-20T00:00:00Z".into()),
            display_name: None,
        };
        assert_eq!(iso.sort_key(), 20_251_001);
        assert!(iso.sort_key() > iso_older.sort_key());
    }

    #[test]
    fn a_doubled_version_segment_collapses() {
        let join = |base: &str, path: &str| format!("{base}{path}").replace("/v1/v1/", "/v1/");
        assert_eq!(
            join("http://localhost:11434/v1", "/v1/chat/completions"),
            "http://localhost:11434/v1/chat/completions"
        );
        // The correct shapes are left alone.
        assert_eq!(
            join("http://localhost:11434/v1", "/chat/completions"),
            "http://localhost:11434/v1/chat/completions"
        );
        assert_eq!(
            join("https://api.anthropic.com", "/v1/messages"),
            "https://api.anthropic.com/v1/messages"
        );
    }

    #[test]
    fn effort_matches_reasoning_models_only() {
        assert!(effort_capable("claude-opus-5"));
        assert!(effort_capable("gpt-5.2"));
        assert!(effort_capable("deepseek-r1:70b"));
        assert!(!effort_capable("claude-haiku-4-5-20251001"));
        assert!(!effort_capable("llama3.2"));
        assert!(!effort_capable("gpt-4o"));
    }

    /// The OS credential store is reachable and round-trips. Uses a throwaway
    /// service name so it can never touch a key the user actually stored.
    #[test]
    fn os_store_round_trips() {
        let e = keyring::Entry::new("dev.pobredux.desktop.selftest", "probe").expect("open entry");
        let _ = e.delete_credential();
        e.set_password("secret-value-1234").expect("set");
        assert_eq!(e.get_password().expect("get"), "secret-value-1234");
        e.delete_credential().expect("delete");
        assert!(matches!(e.get_password(), Err(keyring::Error::NoEntry)));
    }
}
