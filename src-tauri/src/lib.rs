use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

mod mcp;
mod tools;
mod library;
mod ai;
mod sites;

use std::sync::Arc;

use pob_engine::{EngineConfig, EngineHandle, EnginePool, EngineStatus, PoolStatus};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{Manager, State};

pub(crate) struct AppState {
    pub(crate) engine: EngineHandle,
    pub(crate) pool: Arc<EnginePool>,
    pob_root: PathBuf,
    pub(crate) user_dir: PathBuf,
    pub(crate) mcp: mcp::McpState,
}

/// Worker engines for parallel scoring: half the cores, capped — each is a
/// ~120 MB Lua state. `POB_REDUX_POOL=n` overrides.
fn pool_size() -> usize {
    if let Some(n) = std::env::var("POB_REDUX_POOL").ok().and_then(|v| v.parse::<usize>().ok()) {
        return n.clamp(1, 16);
    }
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    (cores / 2).clamp(1, 8)
}

#[tauri::command]
fn pool_status(state: State<'_, AppState>) -> PoolStatus {
    state.pool.status()
}

/// Push the current build to the workers while the user is idle, so the
/// next parallel scan skips its sync. Fire-and-forget from the frontend.
#[tauri::command]
async fn pool_presync(state: State<'_, AppState>) -> Result<(), String> {
    let engine = state.engine.clone();
    let pool = state.pool.clone();
    if pool.status().ready < pool.size() {
        return Ok(());
    }
    tauri::async_runtime::spawn_blocking(move || pob_engine::pool::sync_from(&engine, &pool).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

/// Collect garbage in every engine once the user has been idle for a while.
/// A scan leaves each worker holding a few hundred MB of dead calc state,
/// and only freed memory goes back to the OS.
#[tauri::command]
async fn pool_trim(state: State<'_, AppState>) -> Result<(), String> {
    let engine = state.engine.clone();
    let pool = state.pool.clone();
    tauri::async_runtime::spawn_blocking(move || {
        pool.trim();
        engine.call("gc", Value::Null).map(|_| ()).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Node power scored across the worker pool; falls back to PoB's own
/// sequential PowerBuilder if the pool is unavailable.
#[tauri::command]
async fn power_scan_parallel(
    state: State<'_, AppState>,
    stat: Option<String>,
    max_depth: Option<f64>,
) -> Result<CallResult, String> {
    let engine = state.engine.clone();
    let pool = state.pool.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let t0 = std::time::Instant::now();
        let result = match pob_engine::pool::power_scan(&engine, &pool, stat.as_deref(), max_depth) {
            Ok(v) => v,
            Err(e) => {
                log::warn!("parallel power scan failed ({e}); falling back to PowerBuilder");
                engine
                    .call("tree_power", json!({ "stat": stat, "maxDepth": max_depth }))
                    .map_err(|e| e.to_string())?
                    .result
            }
        };
        Ok(CallResult { result, elapsed_ms: t0.elapsed().as_secs_f64() * 1000.0 })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Fill the gem DPS cache for a socket group across the pool so the next
/// DPS-sorted gem search is instant. Best effort: errors leave the
/// sequential path in place.
#[tauri::command]
async fn gem_dps_parallel(state: State<'_, AppState>, group_index: u32) -> Result<CallResult, String> {
    let engine = state.engine.clone();
    let pool = state.pool.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let t0 = std::time::Instant::now();
        let result = pob_engine::pool::gem_dps_fill(&engine, &pool, group_index).map_err(|e| e.to_string())?;
        Ok(CallResult { result, elapsed_ms: t0.elapsed().as_secs_f64() * 1000.0 })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
struct CallResult {
    result: Value,
    elapsed_ms: f64,
}

#[tauri::command]
async fn engine_call(
    state: State<'_, AppState>,
    method: String,
    params: Option<Value>,
) -> Result<CallResult, String> {
    let engine = state.engine.clone();
    let out = tauri::async_runtime::spawn_blocking(move || {
        engine.call(&method, params.unwrap_or(Value::Null))
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    Ok(CallResult { result: out.result, elapsed_ms: out.elapsed_ms })
}

#[tauri::command]
fn engine_status(state: State<'_, AppState>) -> EngineStatus {
    state.engine.status()
}

#[derive(Serialize)]
struct AppPaths {
    pob_root: String,
    user_dir: String,
    builds_dir: String,
    sync: Option<Value>,
    /// A build file to open once the engine is ready: first CLI argument
    /// ending in .xml (file association / drag onto the exe) or POB_REDUX_OPEN.
    open_on_start: Option<String>,
    /// Dev hook: initial tab (POB_REDUX_VIEW), used by the screenshot harness.
    initial_view: Option<String>,
    /// Dev hook: open the assistant panel on boot (POB_REDUX_CHAT).
    /// Set it to "settings" to open the provider sheet too.
    chat_open: Option<String>,
    /// Dev hook: send one message on boot (POB_REDUX_CHAT_ASK). Costs API credit.
    chat_ask: Option<String>,
    /// Dev hook: skip the write-approval gate for that run (POB_REDUX_CHAT_ALLOW).
    chat_allow: Option<String>,
    /// Dev hook: write the transcript here when a run ends (POB_REDUX_CHAT_LOG).
    chat_log: Option<String>,
    /// Dev hooks: provider id and model to select on boot (POB_REDUX_CHAT_PROVIDER, POB_REDUX_CHAT_MODEL).
    chat_provider: Option<String>,
    chat_model: Option<String>,
}

fn open_on_start() -> Option<String> {
    std::env::args()
        .skip(1)
        .find(|a| a.to_ascii_lowercase().ends_with(".xml") && Path::new(a).is_file())
        .or_else(|| std::env::var("POB_REDUX_OPEN").ok().filter(|p| Path::new(p).is_file()))
}

#[tauri::command]
fn app_paths(state: State<'_, AppState>) -> AppPaths {
    let sync = std::fs::read_to_string(state.pob_root.join("SYNC.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok());
    AppPaths {
        pob_root: state.pob_root.to_string_lossy().to_string(),
        user_dir: state.user_dir.to_string_lossy().to_string(),
        builds_dir: builds_dir(&state.user_dir).to_string_lossy().to_string(),
        sync,
        open_on_start: open_on_start(),
        initial_view: std::env::var("POB_REDUX_VIEW").ok(),
        chat_open: std::env::var("POB_REDUX_CHAT").ok(),
        chat_ask: std::env::var("POB_REDUX_CHAT_ASK").ok(),
        chat_allow: std::env::var("POB_REDUX_CHAT_ALLOW").ok(),
        chat_log: std::env::var("POB_REDUX_CHAT_LOG").ok(),
        chat_provider: std::env::var("POB_REDUX_CHAT_PROVIDER").ok(),
        chat_model: std::env::var("POB_REDUX_CHAT_MODEL").ok(),
    }
}

pub(crate) fn builds_dir(user_dir: &Path) -> PathBuf {
    user_dir.join("Path of Building (PoE2)").join("Builds")
}

#[tauri::command]
fn read_tree_json(state: State<'_, AppState>, version: String) -> Result<String, String> {
    if !version.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err("invalid tree version".into());
    }
    let path = state.pob_root.join("TreeData").join(&version).join("tree.json");
    std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))
}

#[derive(Serialize)]
pub(crate) struct BuildEntry {
    pub(crate) path: String,
    pub(crate) name: String,
    pub(crate) folder: String,
    pub(crate) class_name: Option<String>,
    pub(crate) ascend_class_name: Option<String>,
    pub(crate) level: Option<u32>,
    pub(crate) modified: f64,
}

#[tauri::command]
fn list_builds(state: State<'_, AppState>) -> Result<Vec<BuildEntry>, String> {
    scan_builds(&builds_dir(&state.user_dir))
}

pub(crate) fn scan_builds(root: &Path) -> Result<Vec<BuildEntry>, String> {
    let mut out = Vec::new();
    if !root.is_dir() {
        return Ok(out);
    }
    for entry in walkdir::WalkDir::new(root).into_iter().flatten() {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("xml") {
            continue;
        }
        let md = entry.metadata().map_err(|e| e.to_string())?;
        let modified = md
            .modified()
            .ok()
            .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs_f64())
            .unwrap_or(0.0);
        let head = read_head(path, 8192);
        // Attributes of the <Build> element only; gems further down also carry level="".
        let tag: &str = head
            .find("<Build ")
            .map(|i| {
                let rest = &head[i..];
                &rest[..rest.find('>').unwrap_or(rest.len())]
            })
            .unwrap_or("");
        let attr = |name: &str| -> Option<String> {
            let key = format!(" {name}=\"");
            let i = tag.find(&key)? + key.len();
            let j = tag[i..].find('"')? + i;
            Some(tag[i..j].to_string())
        };
        let folder = path
            .parent()
            .and_then(|p| p.strip_prefix(root).ok())
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();
        out.push(BuildEntry {
            path: path.to_string_lossy().to_string(),
            name: path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(),
            folder,
            class_name: attr("className"),
            ascend_class_name: attr("ascendClassName").filter(|s| s != "None"),
            level: attr("level").and_then(|l| l.parse().ok()),
            modified,
        });
    }
    out.sort_by(|a, b| b.modified.partial_cmp(&a.modified).unwrap_or(std::cmp::Ordering::Equal));
    Ok(out)
}

fn read_head(path: &Path, max: usize) -> String {
    use std::io::Read;
    let mut buf = vec![0u8; max];
    let n = std::fs::File::open(path)
        .and_then(|mut f| f.read(&mut buf))
        .unwrap_or(0);
    String::from_utf8_lossy(&buf[..n]).to_string()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FetchedCode {
    pub(crate) site: String,
    pub(crate) code: String,
}

/// Fetch a raw PoB build code from a share link (pobb.in, Maxroll, poe.ninja, …).
/// The result feeds the bridge's `load_build_code`, PoB's own decode path.
#[tauri::command]
async fn fetch_build_code(url: String) -> Result<FetchedCode, String> {
    fetch_code(&url).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SharedLink {
    site: String,
    url: String,
}

/// Upload a build code to a sharing site and return the link, as PoB's
/// Import/Export tab does with its "Share" button.
#[tauri::command]
async fn share_build_code(site: String, code: String) -> Result<SharedLink, String> {
    let target = sites::upload_target(&site).ok_or_else(|| {
        format!("Unknown share site {site:?}. Sites: {}.", sites::UPLOAD_TARGETS.iter().map(|t| t.label).collect::<Vec<_>>().join(", "))
    })?;
    let code = code.trim();
    if code.is_empty() {
        return Err("nothing to share: the build code is empty".into());
    }
    let client = reqwest::Client::builder()
        .user_agent("pob-redux/0.1 Path of Building")
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let body = format!("{}{}", target.post_fields, code);
    let content_type = if target.post_fields.is_empty() { "text/plain" } else { "application/x-www-form-urlencoded" };
    let resp = client
        .post(target.post_url)
        .header("content-type", content_type)
        .body(body)
        .send()
        .await
        .map_err(|e| format!("{}: {e}", target.label))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| format!("{}: {e}", target.label))?;
    if !status.is_success() {
        let detail = text.trim();
        let detail = if detail.is_empty() { String::new() } else { format!(": {}", detail.chars().take(200).collect::<String>()) };
        return Err(format!("{} returned HTTP {status}{detail}", target.label));
    }
    let id = text.trim();
    if id.is_empty() || id.contains('<') {
        return Err(format!("{} did not return a link", target.label));
    }
    Ok(SharedLink { site: target.label.to_string(), url: format!("{}{}", target.code_out, id) })
}

pub(crate) async fn fetch_code(url: &str) -> Result<FetchedCode, String> {
    let (site, download) =
        sites::download_url(url).ok_or_else(|| format!("Unrecognised build link. Supported sites: {}.", sites::SUPPORTED))?;
    let client = reqwest::Client::builder()
        .user_agent("pob-redux/0.1 Path of Building")
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client.get(&download).send().await.map_err(|e| format!("{site}: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("{site} returned HTTP {status}"));
    }
    let text = resp.text().await.map_err(|e| format!("{site}: {e}"))?;
    let code = text.trim().to_string();
    if code.is_empty() {
        return Err(format!("{site} returned an empty response"));
    }
    Ok(FetchedCode { site: site.to_string(), code })
}

fn ensure_in_builds(root: &Path, path: &Path) -> Result<(), String> {
    let canon = path.canonicalize().map_err(|e| format!("{}: {e}", path.display()))?;
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    if canon.starts_with(&root) {
        Ok(())
    } else {
        Err("path is outside the builds folder".into())
    }
}

fn safe_name(name: &str) -> Result<&str, String> {
    let name = name.trim();
    if name.is_empty() || name.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|']) || name == "." || name == ".." {
        return Err(format!("invalid name: {name:?}"));
    }
    Ok(name)
}

fn safe_folder(root: &Path, folder: &str) -> Result<PathBuf, String> {
    let mut dir = root.to_path_buf();
    for seg in folder.split('/').filter(|s| !s.is_empty()) {
        dir.push(safe_name(seg)?);
    }
    Ok(dir)
}

#[tauri::command]
fn rename_build(state: State<'_, AppState>, path: String, new_name: String) -> Result<String, String> {
    let src = PathBuf::from(&path);
    ensure_in_builds(&builds_dir(&state.user_dir), &src)?;
    let dst = src.with_file_name(format!("{}.xml", safe_name(&new_name)?));
    if dst.exists() {
        return Err(format!("{} already exists", dst.display()));
    }
    std::fs::rename(&src, &dst).map_err(|e| e.to_string())?;
    Ok(dst.to_string_lossy().to_string())
}

#[tauri::command]
fn move_build(state: State<'_, AppState>, path: String, folder: String) -> Result<String, String> {
    let root = builds_dir(&state.user_dir);
    let src = PathBuf::from(&path);
    ensure_in_builds(&root, &src)?;
    let dir = safe_folder(&root, &folder)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dst = dir.join(src.file_name().ok_or("bad path")?);
    if dst == src {
        return Ok(path);
    }
    if dst.exists() {
        return Err(format!("{} already exists", dst.display()));
    }
    std::fs::rename(&src, &dst).map_err(|e| e.to_string())?;
    Ok(dst.to_string_lossy().to_string())
}

#[tauri::command]
fn delete_build(state: State<'_, AppState>, path: String) -> Result<(), String> {
    let src = PathBuf::from(&path);
    ensure_in_builds(&builds_dir(&state.user_dir), &src)?;
    if src.extension().and_then(|e| e.to_str()) != Some("xml") {
        return Err("only .xml builds can be deleted".into());
    }
    std::fs::remove_file(&src).map_err(|e| e.to_string())
}

#[tauri::command]
fn create_build_folder(state: State<'_, AppState>, folder: String) -> Result<(), String> {
    let dir = safe_folder(&builds_dir(&state.user_dir), &folder)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())
}

#[tauri::command]
fn list_build_folders(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let root = builds_dir(&state.user_dir);
    let mut out = Vec::new();
    if !root.is_dir() {
        return Ok(out);
    }
    for entry in walkdir::WalkDir::new(&root).min_depth(1).into_iter().flatten() {
        if entry.file_type().is_dir() {
            if let Ok(rel) = entry.path().strip_prefix(&root) {
                out.push(rel.to_string_lossy().replace('\\', "/"));
            }
        }
    }
    out.sort();
    Ok(out)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GameBuildList {
    dir: String,
    exists: bool,
    builds: Vec<GameBuildEntry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GameBuildEntry {
    path: String,
    name: String,
    author: Option<String>,
    modified: f64,
}

/// List the game's Build Planner files (*.build). `dir` overrides the default
/// `Documents\My Games\Path of Exile 2\BuildPlanner`.
#[tauri::command]
fn list_game_builds(state: State<'_, AppState>, dir: Option<String>) -> Result<GameBuildList, String> {
    let dir = dir
        .filter(|d| !d.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            // user_dir is the Documents folder (PoB appends its own subdir)
            state.user_dir.join("My Games").join("Path of Exile 2").join("BuildPlanner")
        });
    let mut builds = Vec::new();
    let exists = dir.is_dir();
    if exists {
        for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("build") {
                continue;
            }
            let modified = entry
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs_f64())
                .unwrap_or(0.0);
            let stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            // name and author live in the JSON; the filename is the game's
            // truncated copy of the name
            let (name, author) = read_text_lossy(&path.to_string_lossy())
                .ok()
                .and_then(|text| serde_json::from_str::<Value>(&text).ok())
                .map(|v| {
                    let name = v
                        .get("name")
                        .and_then(|n| n.as_str())
                        .filter(|n| !n.trim().is_empty())
                        .map(|n| n.to_string());
                    let author = v
                        .get("author")
                        .and_then(|a| a.as_str())
                        .filter(|a| !a.trim().is_empty())
                        .map(|a| a.to_string());
                    (name, author)
                })
                .unwrap_or((None, None));
            builds.push(GameBuildEntry {
                path: path.to_string_lossy().to_string(),
                name: name.unwrap_or(stem),
                author,
                modified,
            });
        }
        builds.sort_by(|a, b| b.modified.partial_cmp(&a.modified).unwrap_or(std::cmp::Ordering::Equal));
    }
    Ok(GameBuildList { dir: dir.to_string_lossy().to_string(), exists, builds })
}

/// Set the `name` and/or `author` of a game Build Planner file in place;
/// an empty author clears it. The rest of the JSON is kept as the game wrote
/// it, so a later import sees the same build. The file keeps its own name:
/// the game shows the name inside the JSON.
#[tauri::command]
fn set_game_build_meta(path: String, name: Option<String>, author: Option<String>) -> Result<(), String> {
    if Path::new(&path).extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case("build")) != Some(true) {
        return Err("not a .build file".into());
    }
    let text = read_text_lossy(&path)?;
    let mut v: Value = serde_json::from_str(&text).map_err(|e| format!("{path}: not a valid .build file: {e}"))?;
    let obj = v.as_object_mut().ok_or_else(|| format!("{path}: not a valid .build file"))?;
    if let Some(name) = name {
        let name = name.trim();
        if name.is_empty() {
            return Err("a build needs a name".into());
        }
        obj.insert("name".into(), Value::String(name.to_string()));
    }
    if let Some(author) = author {
        let author = author.trim();
        if author.is_empty() {
            obj.remove("author");
        } else {
            obj.insert("author".into(), Value::String(author.to_string()));
        }
    }
    let out = serde_json::to_string(&v).map_err(|e| e.to_string())?;
    std::fs::write(&path, out).map_err(|e| format!("{path}: {e}"))
}

/// Read a text file tolerantly: UTF-16 (either BOM) is converted, a UTF-8 BOM
/// is stripped, and invalid UTF-8 bytes are replaced rather than failing.
pub(crate) fn read_text_lossy(path: &str) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("{path}: {e}"))?;
    let text = if bytes.starts_with(&[0xFF, 0xFE]) {
        let utf16: Vec<u16> = bytes[2..].chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        String::from_utf16_lossy(&utf16)
    } else if bytes.starts_with(&[0xFE, 0xFF]) {
        let utf16: Vec<u16> = bytes[2..].chunks_exact(2).map(|c| u16::from_be_bytes([c[0], c[1]])).collect();
        String::from_utf16_lossy(&utf16)
    } else {
        let b = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF][..]).unwrap_or(&bytes);
        String::from_utf8_lossy(b).into_owned()
    };
    Ok(text)
}

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    read_text_lossy(&path)
}

#[tauri::command]
fn write_text_file(path: String, contents: String) -> Result<(), String> {
    if let Some(parent) = Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, contents).map_err(|e| format!("{path}: {e}"))
}

/// The assistant's log file: one JSON line per run, written by the panel so
/// a failure can be reported with its context. Lives next to providers.json.
fn ai_log_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?.join("logs");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("assistant.log"))
}

/// Append one line to the assistant log, rotating once it passes 4 MB so it
/// never grows without bound. Returns the log path.
#[tauri::command]
fn ai_log_append(app: tauri::AppHandle, line: String) -> Result<String, String> {
    use std::io::Write;
    let path = ai_log_path(&app)?;
    if std::fs::metadata(&path).map(|m| m.len() > 4 * 1024 * 1024).unwrap_or(false) {
        let _ = std::fs::rename(&path, path.with_extension("log.1"));
    }
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    let line = line.replace(['\n', '\r'], " ");
    writeln!(f, "{line}").map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

/// Show the assistant log in the file manager.
#[tauri::command]
fn ai_log_reveal(app: tauri::AppHandle) -> Result<String, String> {
    use tauri_plugin_opener::OpenerExt;
    let path = ai_log_path(&app)?;
    if !path.is_file() {
        std::fs::write(&path, "").map_err(|e| e.to_string())?;
    }
    app.opener().reveal_item_in_dir(&path).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

/// The system instructions for the chat panel: the same text the MCP server
/// sends to external clients.
#[tauri::command]
fn ai_instructions() -> &'static str {
    tools::INSTRUCTIONS
}

/// The tool registry as JSON Schema, for the in-app chat panel. Same list the
/// MCP server serves over `tools/list`.
#[tauri::command]
fn ai_tools() -> Vec<tools::ToolDef> {
    tools::defs()
}

/// Run one tool against the open build. Goes through `tools::dispatch`, so it
/// behaves exactly as the same call would over MCP and emits `mcp:changed`.
#[tauri::command]
async fn ai_call_tool(
    app: tauri::AppHandle,
    name: String,
    args: Option<serde_json::Map<String, serde_json::Value>>,
) -> Result<serde_json::Value, String> {
    let ctx = mcp::tool_context(&app);
    tools::dispatch(ctx, name, args.unwrap_or_default())
        .await
        .map(|(value, _)| value)
        .map_err(|e| match e {
            tools::ToolError::Invalid(m) | tools::ToolError::Failed(m) => m,
        })
}

/// Locate the vendored PoB program: an explicit override, the bundled
/// resources, or (dev builds) the pob-sync output next to this crate.
fn find_pob_root(app: &tauri::AppHandle) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(p) = std::env::var("POB_REDUX_POB_ROOT") {
        candidates.push(PathBuf::from(p));
    }
    if let Ok(res) = app.path().resource_dir() {
        candidates.push(res.join("pob"));
        candidates.push(res.join("resources").join("pob"));
    }
    if cfg!(debug_assertions) {
        candidates.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("resources").join("pob"));
    }
    candidates.into_iter().find(|p| p.join("Launch.lua").is_file())
}

fn find_user_dir(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(p) = std::env::var("POB_REDUX_USER_DIR") {
        return PathBuf::from(p);
    }
    app.path()
        .document_dir()
        .or_else(|_| app.path().app_data_dir())
        .unwrap_or_else(|_| std::env::temp_dir().join("pob-redux"))
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

/// Serves files from the vendored PoB directory to the webview as
/// `pob://localhost/<relative path>` (Windows: `http://pob.localhost/...`).
/// Used for tree sprite sheets, which are too large to ship over IPC.
fn serve_pob_asset(
    ctx: tauri::UriSchemeContext<'_, tauri::Wry>,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<std::borrow::Cow<'static, [u8]>> {
    use tauri::http::{header, Response, StatusCode};
    let respond = |status: StatusCode, body: Vec<u8>, mime: &str| {
        Response::builder()
            .status(status)
            .header(header::CONTENT_TYPE, mime)
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .header(header::CACHE_CONTROL, "max-age=3600")
            .body(std::borrow::Cow::Owned(body))
            .unwrap()
    };
    let state = ctx.app_handle().state::<AppState>();
    let rel = percent_decode(request.uri().path().trim_start_matches('/'));
    if rel.contains("..") {
        return respond(StatusCode::FORBIDDEN, Vec::new(), "text/plain");
    }
    let path = state.pob_root.join(&rel);
    let mime = match path.extension().and_then(|e| e.to_str()) {
        Some("png") => "image/png",
        Some("webp") => "image/webp",
        Some("json") => "application/json",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        _ => "application/octet-stream",
    };
    match std::fs::read(&path) {
        Ok(bytes) => respond(StatusCode::OK, bytes, mime),
        Err(_) => respond(StatusCode::NOT_FOUND, Vec::new(), "text/plain"),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info,pob=warn")).init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_process::init())
        .register_uri_scheme_protocol("pob", serve_pob_asset)
        .setup(|app| {
            #[cfg(desktop)]
            app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
            let handle = app.handle();
            let pob_root = find_pob_root(handle).unwrap_or_else(|| {
                log::error!("no PoB program found; run `cargo run -p pob-sync` first");
                PathBuf::from("resources/pob")
            });
            let user_dir = find_user_dir(handle);
            log::info!("pob root: {}", pob_root.display());
            log::info!("user dir: {}", user_dir.display());
            let cfg = EngineConfig {
                pob_root: pob_root.clone(),
                user_dir: user_dir.clone(),
            };
            let engine = EngineHandle::spawn(cfg.clone());
            let pool = Arc::new(EnginePool::new(cfg, pool_size()));
            // boot the workers once the main engine has had the CPU to itself
            let warm = pool.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(1500));
                warm.warm();
            });
            app.manage(AppState { engine, pool, pob_root, user_dir, mcp: mcp::McpState::new() });
            app.manage(ai::AiState::new(&app.handle().clone()));
            // POB_REDUX_MCP=<port> brings the MCP server up at launch (scripts, tests)
            if let Some(port) = std::env::var("POB_REDUX_MCP").ok().and_then(|v| v.parse::<u16>().ok()) {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = mcp::start_with_handle(&handle, port).await {
                        log::error!("mcp autostart: {e}");
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            engine_call,
            engine_status,
            pool_status,
            pool_presync,
            pool_trim,
            power_scan_parallel,
            gem_dps_parallel,
            app_paths,
            read_tree_json,
            list_builds,
            list_game_builds,
            read_text_file,
            write_text_file,
            fetch_build_code,
            share_build_code,
            set_game_build_meta,
            rename_build,
            move_build,
            delete_build,
            create_build_folder,
            list_build_folders,
            mcp::mcp_status,
            mcp::mcp_start,
            mcp::mcp_stop,
            ai_tools,
            ai_instructions,
            ai_log_append,
            ai_log_reveal,
            ai_call_tool,
            ai::ai_providers,
            ai::ai_key_set,
            ai::ai_key_clear,
            ai::ai_base_set,
            ai::ai_models,
            ai::ai_warm_model,
            ai::ai_chat_stream,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
