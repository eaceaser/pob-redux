//! First-party MCP server. Exposes the build that is open in the app to AI
//! clients over Streamable HTTP on localhost. Off until enabled in Options.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use pob_engine::EngineHandle;
use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, Implementation, JsonObject,
    ListToolsResult, PaginatedRequestParams, ServerCapabilities, ServerInfo, Tool, ToolAnnotations,
};
use rmcp::service::RequestContext;
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::{StreamableHttpServerConfig, StreamableHttpService};
use rmcp::{ErrorData, RoleServer, ServerHandler};
use serde::Serialize;
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::AppState;

pub const DEFAULT_PORT: u16 = 7315;

const INSTRUCTIONS: &str = "This server drives the build that is open in PoB Redux (Path of Building for \
Path of Exile 2). Every number comes from Path of Building's own calculation engine, and every change is \
shown in the app immediately. Start with get_character and get_stats to see what is loaded, or load_build \
to open a share code, a pobb.in / Maxroll / poe.ninja / poe2db.tw / Pastebin / Rentry link, a local .xml \
or .build file, or raw PoB XML. Inspect with get_stats / list_stat_keys / get_sidebar / get_tree_state / \
get_items / get_skills / get_config / sanity_check. Explore the passive tree with search_tree, node_info and \
node_path_cost. Change the build with alloc_node / dealloc_node / select_class / set_level, equip_item_raw / \
unequip_item, add_gem / set_gem / remove_gem / set_main_skill, and set_config. Manage alternate trees and \
gear sets with the list/select/create/copy/rename/delete _spec and _item_set tools. Mutations return a \
short `stats` summary; call get_stats for anything else. Use save_build or export_build to persist the \
result. The user is watching the app while you work.";

const HEADLINE: &[&str] = &[
    "Life",
    "EnergyShield",
    "Mana",
    "Spirit",
    "Armour",
    "Evasion",
    "TotalEHP",
    "TotalDPS",
    "CombinedDPS",
    "FullDPS",
    "FireResist",
    "ColdResist",
    "LightningResist",
    "ChaosResist",
    "Str",
    "Dex",
    "Int",
];

#[derive(Serialize, Clone)]
pub struct McpStatus {
    pub running: bool,
    pub port: u16,
    pub url: Option<String>,
    pub error: Option<String>,
    pub calls: u64,
}

struct Running {
    port: u16,
    task: tauri::async_runtime::JoinHandle<()>,
}

pub struct McpState {
    running: Mutex<Option<Running>>,
    port: Mutex<u16>,
    error: Mutex<Option<String>>,
    calls: Arc<AtomicU64>,
}

impl McpState {
    pub fn new() -> Self {
        Self {
            running: Mutex::new(None),
            port: Mutex::new(DEFAULT_PORT),
            error: Mutex::new(None),
            calls: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn status(&self) -> McpStatus {
        let running = self.running.lock().unwrap();
        let port = running.as_ref().map(|r| r.port).unwrap_or(*self.port.lock().unwrap());
        McpStatus {
            running: running.is_some(),
            port,
            url: running.as_ref().map(|r| format!("http://127.0.0.1:{}/mcp", r.port)),
            error: self.error.lock().unwrap().clone(),
            calls: self.calls.load(Ordering::Relaxed),
        }
    }

    fn stop(&self) {
        if let Some(r) = self.running.lock().unwrap().take() {
            r.task.abort();
            log::info!("mcp server stopped");
        }
    }

    async fn start(&self, ctx: Arc<ToolContext>, port: u16) -> Result<(), String> {
        self.stop();
        *self.port.lock().unwrap() = port;
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
            .await
            .map_err(|e| format!("cannot listen on 127.0.0.1:{port}: {e}"))?;
        // Host header validation (DNS-rebinding protection) is rmcp's default:
        // only localhost hosts are accepted.
        let service = StreamableHttpService::new(
            move || Ok(PobMcp { ctx: ctx.clone() }),
            Arc::new(LocalSessionManager::default()),
            StreamableHttpServerConfig::default(),
        );
        let router = axum::Router::new().nest_service("/mcp", service);
        let task = tauri::async_runtime::spawn(async move {
            if let Err(e) = axum::serve(listener, router).await {
                log::error!("mcp server: {e}");
            }
        });
        *self.running.lock().unwrap() = Some(Running { port, task });
        *self.error.lock().unwrap() = None;
        log::info!("mcp server listening on http://127.0.0.1:{port}/mcp");
        Ok(())
    }
}

#[tauri::command]
pub fn mcp_status(state: State<'_, AppState>) -> McpStatus {
    state.mcp.status()
}

#[tauri::command]
pub async fn mcp_start(app: AppHandle, port: u16) -> Result<McpStatus, String> {
    start_with_handle(&app, port).await
}

/// Start (or restart) the server on `port`. Also used by the `POB_REDUX_MCP`
/// launch hook, which brings the server up without the UI.
pub async fn start_with_handle(app: &AppHandle, port: u16) -> Result<McpStatus, String> {
    if port < 1024 {
        return Err("port must be 1024 or higher".into());
    }
    let state = app.state::<AppState>();
    let ctx = Arc::new(ToolContext {
        engine: state.engine.clone(),
        user_dir: state.user_dir.clone(),
        app: app.clone(),
        calls: state.mcp.calls.clone(),
    });
    let result = state.mcp.start(ctx, port).await;
    if let Err(e) = &result {
        *state.mcp.error.lock().unwrap() = Some(e.clone());
    }
    let status = state.mcp.status();
    let _ = app.emit("mcp:status", status.clone());
    result.map(|_| status)
}

#[tauri::command]
pub fn mcp_stop(app: AppHandle, state: State<'_, AppState>) -> McpStatus {
    state.mcp.stop();
    *state.mcp.error.lock().unwrap() = None;
    let status = state.mcp.status();
    let _ = app.emit("mcp:status", status.clone());
    status
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

pub struct ToolContext {
    engine: EngineHandle,
    user_dir: PathBuf,
    app: AppHandle,
    calls: Arc<AtomicU64>,
}

enum ToolError {
    /// Bad arguments: reported as a JSON-RPC invalid-params error.
    Invalid(String),
    /// The engine rejected the operation: reported as a tool error the model can read.
    Failed(String),
}

impl ToolContext {
    fn call(&self, method: &str, params: Value) -> Result<Value, ToolError> {
        self.engine
            .call(method, params)
            .map(|o| o.result)
            .map_err(|e| ToolError::Failed(clean_error(&e.to_string())))
    }

    fn headline(&self) -> Value {
        self.call("get_stats", json!({ "fields": HEADLINE }))
            .ok()
            .and_then(|v| v.get("stats").cloned())
            .unwrap_or(Value::Null)
    }

    fn with_stats(&self, mut v: Value) -> Value {
        match &mut v {
            Value::Object(m) => {
                m.insert("stats".into(), self.headline());
                v
            }
            _ => json!({ "result": v, "stats": self.headline() }),
        }
    }
}

#[derive(Clone)]
struct PobMcp {
    ctx: Arc<ToolContext>,
}

impl ServerHandler for PobMcp {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("pob-redux", env!("CARGO_PKG_VERSION")))
            .with_instructions(INSTRUCTIONS)
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        Ok(ListToolsResult::with_all_items(tool_list()))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let name = request.name.to_string();
        let mut args = request.arguments.unwrap_or_default();
        // Share links need the network; resolve them here so the blocking
        // tool body only ever sees a code.
        if name == "load_build" {
            let url = args
                .get("source")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| s.starts_with("http://") || s.starts_with("https://"))
                .map(str::to_string);
            if let Some(url) = url {
                match crate::fetch_code(&url).await {
                    Ok(f) => {
                        args.insert("source".into(), Value::String(f.code));
                        args.insert("site".into(), Value::String(f.site));
                    }
                    Err(e) => return Ok(CallToolResult::error(vec![ContentBlock::text(e)]).into()),
                }
            }
        }
        let ctx = self.ctx.clone();
        let tool = name.clone();
        let out = tokio::task::spawn_blocking(move || run_tool(&ctx, &tool, &args))
            .await
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        self.ctx.calls.fetch_add(1, Ordering::Relaxed);
        match out {
            Ok((value, mutated)) => {
                if mutated {
                    let _ = self.ctx.app.emit("mcp:changed", json!({ "tool": name }));
                }
                Ok(CallToolResult::structured(value).into())
            }
            Err(ToolError::Invalid(msg)) => Err(ErrorData::invalid_params(msg, None)),
            Err(ToolError::Failed(msg)) => Ok(CallToolResult::error(vec![ContentBlock::text(msg)]).into()),
        }
    }
}

// ---------------------------------------------------------------------------
// Tool table
// ---------------------------------------------------------------------------

struct ToolDef {
    name: &'static str,
    description: String,
    schema: Value,
    read_only: bool,
    destructive: bool,
}

fn obj(props: Value, required: &[&str]) -> Value {
    let mut m = Map::new();
    m.insert("type".into(), json!("object"));
    m.insert("properties".into(), props);
    if !required.is_empty() {
        m.insert("required".into(), json!(required));
    }
    Value::Object(m)
}

fn prop(ty: &str, desc: &str) -> Value {
    json!({ "type": ty, "description": desc })
}

fn none() -> Value {
    obj(json!({}), &[])
}

fn defs() -> Vec<ToolDef> {
    let ro = |name, description: &str, schema| ToolDef { name, description: description.into(), schema, read_only: true, destructive: false };
    let rw = |name, description: &str, schema| ToolDef { name, description: description.into(), schema, read_only: false, destructive: false };
    let del = |name, description: &str, schema| ToolDef { name, description: description.into(), schema, read_only: false, destructive: true };
    let index = |what: &str| prop("integer", &format!("1-based index of the {what}"));
    let group_index = || prop("integer", "1-based socket group index (see get_skills)");
    let gem_index = || prop("integer", "1-based gem index within the group (see get_skills)");
    let node_id = || prop("integer", "Passive tree node id");
    let title = || prop("string", "Display name");
    let activates = "The new one becomes active.";

    vec![
        // Build
        rw(
            "load_build",
            "Open a build in the app, replacing the one that is open. `source` may be a PoB share code, a pobb.in / Maxroll / poe.ninja / poe2db.tw / Pastebin / Rentry link, a local path to a .xml build or a GGG .build planner file, or raw PoB build XML.",
            obj(json!({ "source": prop("string", "Share code, link, file path, or XML"), "name": prop("string", "Build name to use (optional)") }), &["source"]),
        ),
        rw("new_build", "Start a blank build (default class, no items or skills). Replaces the open build.", obj(json!({ "name": prop("string", "Build name") }), &[])),
        ro("list_local_builds", "List the .xml builds in the user's Path of Building builds folder. Paths can be passed to load_build.", none()),
        rw(
            "save_build",
            "Save the open build to disk as PoB XML. Uses the build's own file unless `path` is given.",
            obj(json!({ "path": prop("string", "Absolute path of the .xml file to write (optional)") }), &[]),
        ),
        ro(
            "export_build",
            "Export the open build as a shareable PoB code (default) or as full PoB XML.",
            obj(json!({ "format": { "type": "string", "enum": ["code", "xml"], "description": "Output format (default: code)" } }), &[]),
        ),
        // Character
        ro("get_character", "Class, ascendancy, level, passive points used, main skill group, and file name of the open build.", none()),
        rw("set_level", "Set the character level (1 to 100).", obj(json!({ "level": prop("integer", "Character level") }), &["level"])),
        ro("list_classes", "Every class and its ascendancies with ids for select_class.", none()),
        rw(
            "select_class",
            "Change class and/or ascendancy. Omit an id to leave it unchanged. Changing class deallocates nodes the new class cannot reach. An invalid id leaves the build untouched.",
            obj(json!({ "class_id": prop("integer", "Class id from list_classes"), "ascend_class_id": prop("integer", "Ascendancy id from list_classes (0 for none)") }), &[]),
        ),
        // Stats
        ro(
            "get_stats",
            "Calculated stats (life, ES, mana, resistances, DPS, EHP, and hundreds more) from PoB's engine. Pass `fields` to get only those keys; omit it for every scalar stat. Key names vary by build; list_stat_keys shows what exists.",
            obj(json!({ "fields": { "type": "array", "items": { "type": "string" }, "description": "Stat keys to return" } }), &[]),
        ),
        ro("list_stat_keys", "Every stat key get_stats can return for the open build.", none()),
        ro("get_sidebar", "The stat panel exactly as the app shows it: labelled rows plus PoB's warnings. Good for a quick human-style summary.", none()),
        ro("sanity_check", "Heuristic warnings about the open build: uncapped or negative resistances, low life for the level, and similar. An empty list is not proof the build is sound.", none()),
        // Tree
        ro("get_tree_state", "Allocated passive nodes of the active tree: node ids, points used, class ids, and node overrides. Use node_info for details on any id.", none()),
        ro(
            "search_tree",
            "Search the passive tree of the open build by name or stat text, with optional type and ascendancy filters.",
            obj(
                json!({
                    "query": prop("string", "Case-insensitive substring matched against node names and stats"),
                    "node_type": { "type": "string", "enum": ["Normal", "Notable", "Keystone", "Mastery", "Socket", "ClassStart", "AscendClassStart"], "description": "Only nodes of this type" },
                    "ascendancy_name": prop("string", "Only nodes of this ascendancy"),
                    "main_tree_only": prop("boolean", "Exclude every ascendancy node"),
                    "limit": prop("integer", "Maximum results (default 200)")
                }),
                &[],
            ),
        ),
        ro("node_info", "Name, type, stats, mods, allocation state, and path cost of one node.", obj(json!({ "node_id": node_id() }), &["node_id"])),
        ro("node_path_cost", "How many points allocating a node would cost from the current tree, and the path PoB would take. Does not allocate.", obj(json!({ "node_id": node_id() }), &["node_id"])),
        rw("alloc_node", "Allocate a node and the shortest path to it, exactly as clicking it in the tree would, then recalculate.", obj(json!({ "node_id": node_id() }), &["node_id"])),
        rw("dealloc_node", "Deallocate a node and every node that depended on it for connectivity, then recalculate.", obj(json!({ "node_id": node_id() }), &["node_id"])),
        rw("tree_undo", "Undo the last tree change.", none()),
        ro("export_tree_url", "The pathofexile.com passive tree URL for the active tree.", none()),
        rw("import_tree_url", "Replace the active tree's allocation from a pathofexile.com passive tree URL.", obj(json!({ "url": prop("string", "Passive tree URL") }), &["url"])),
        // Specs
        ro("list_specs", "The build's passive tree specs (alternate trees) and which one is active.", none()),
        rw("select_spec", "Switch the active tree spec. Every tree tool then works on it.", obj(json!({ "index": index("spec (see list_specs)") }), &["index"])),
        rw("create_spec", &format!("Create a blank tree spec with the current class. {activates}"), obj(json!({ "title": title() }), &[])),
        rw("copy_spec", &format!("Duplicate a tree spec (default: the active one). {activates}"), obj(json!({ "index": index("spec to copy"), "title": title() }), &[])),
        rw("rename_spec", "Rename a tree spec.", obj(json!({ "index": index("spec"), "title": title() }), &["index", "title"])),
        del("delete_spec", "Delete a tree spec. Fails if it is the only one.", obj(json!({ "index": index("spec") }), &["index"])),
        // Items
        ro("get_items", "Every visible equipment, flask, charm and jewel slot with the item in it (if any). Hidden and inactive slots are left out.", none()),
        ro("list_items", "Every item the build owns, equipped or not, with its id and slot.", none()),
        rw(
            "equip_item_raw",
            "Parse in-game item text (as copied from the game or written in PoB's item format) and equip it. Without `slot`, the first slot the item fits is used.",
            obj(json!({ "item_text": prop("string", "Raw item text"), "slot": prop("string", "Slot name from get_items") }), &["item_text"]),
        ),
        rw("equip_item", "Equip an item the build already owns (see list_items) into a slot.", obj(json!({ "item_id": prop("integer", "Item id from list_items"), "slot": prop("string", "Slot name from get_items") }), &["item_id", "slot"])),
        rw("unequip_item", "Empty a slot. The item stays in the build's item list.", obj(json!({ "slot": prop("string", "Slot name from get_items") }), &["slot"])),
        del("delete_item", "Remove an item from the build entirely.", obj(json!({ "item_id": prop("integer", "Item id from list_items") }), &["item_id"])),
        ro(
            "search_item_db",
            "Search PoB's unique item database (or its rare templates) by name or base. Paged: `total` says how many matched.",
            obj(
                json!({
                    "query": prop("string", "Case-insensitive substring of the item or base name"),
                    "item_type": prop("string", "Only this item type, e.g. Boots"),
                    "db": { "type": "string", "enum": ["unique", "rare"], "description": "Database to search (default: unique)" },
                    "limit": prop("integer", "Maximum results (default 50)"),
                    "offset": prop("integer", "Skip this many results")
                }),
                &[],
            ),
        ),
        rw(
            "equip_from_item_db",
            "Equip an item from PoB's unique database (or a rare template) by its exact name.",
            obj(json!({ "name": prop("string", "Exact item name from search_item_db"), "db": { "type": "string", "enum": ["unique", "rare"] }, "slot": prop("string", "Slot name from get_items (optional)") }), &["name"]),
        ),
        // Item sets
        ro("list_item_sets", "The build's gear sets and which one is active.", none()),
        rw("select_item_set", "Switch the active gear set.", obj(json!({ "id": prop("integer", "Item set id from list_item_sets") }), &["id"])),
        rw("create_item_set", &format!("Create an empty gear set. {activates}"), obj(json!({ "title": title() }), &[])),
        rw("copy_item_set", &format!("Duplicate a gear set (default: the active one). {activates}"), obj(json!({ "id": prop("integer", "Item set id to copy"), "title": title() }), &[])),
        rw("rename_item_set", "Rename a gear set.", obj(json!({ "id": prop("integer", "Item set id"), "title": title() }), &["id", "title"])),
        del("delete_item_set", "Delete a gear set. Fails if it is the only one.", obj(json!({ "id": prop("integer", "Item set id") }), &["id"])),
        // Skills
        ro("get_skills", "Socket groups, the gems in each (name, level, quality, enabled), and which group is the main skill.", none()),
        rw("add_socket_group", "Create an empty socket group. The first group of a build becomes the main skill.", obj(json!({ "label": prop("string", "Group label"), "slot": prop("string", "Item slot the group is socketed in") }), &[])),
        del("remove_socket_group", "Delete a socket group and its gems.", obj(json!({ "index": group_index() }), &["index"])),
        rw(
            "set_socket_group",
            "Change a socket group's label, slot, enabled state, Full DPS inclusion, or main active skill. Omit a field to leave it unchanged.",
            obj(
                json!({
                    "index": group_index(),
                    "enabled": prop("boolean", "Enable or disable the group"),
                    "label": prop("string", "Group label"),
                    "slot": prop("string", "Item slot, or empty string for none"),
                    "include_in_full_dps": prop("boolean", "Count this group in Full DPS"),
                    "main_active_skill": prop("integer", "1-based index of the active skill within the group")
                }),
                &["index"],
            ),
        ),
        rw("set_main_skill", "Choose which socket group is the main skill for DPS.", obj(json!({ "group_index": group_index() }), &["group_index"])),
        rw(
            "add_gem",
            "Add a gem to a socket group. Identify it by gem_id (internal id such as Metadata/Items/Gems/SkillGemFireball, from list_gems), by skill_id, or by name_spec (display name). Level defaults to the build's default gem level.",
            obj(
                json!({
                    "group_index": group_index(),
                    "gem_id": prop("string", "Gem id from list_gems"),
                    "skill_id": prop("string", "Skill id, for skills without a gem entry"),
                    "name_spec": prop("string", "Gem display name"),
                    "level": prop("integer", "Gem level"),
                    "quality": prop("integer", "Gem quality (0 to 20)")
                }),
                &["group_index"],
            ),
        ),
        rw(
            "set_gem",
            "Change a gem's level, quality, enabled state, or swap it for another gem id. Omit a field to leave it unchanged.",
            obj(
                json!({
                    "group_index": group_index(),
                    "gem_index": gem_index(),
                    "level": prop("integer", "Gem level"),
                    "quality": prop("integer", "Gem quality"),
                    "enabled": prop("boolean", "Enable or disable the gem"),
                    "gem_id": prop("string", "Replace with this gem id")
                }),
                &["group_index", "gem_index"],
            ),
        ),
        del("remove_gem", "Remove a gem from a socket group.", obj(json!({ "group_index": group_index(), "gem_index": gem_index() }), &["group_index", "gem_index"])),
        ro(
            "list_gems",
            "Find gem ids for add_gem. Matches the query against display names and ids.",
            obj(json!({ "query": prop("string", "Case-insensitive substring"), "only_supports": prop("boolean", "true: support gems only; false: active gems only"), "limit": prop("integer", "Maximum results (default 50)") }), &[]),
        ),
        ro("list_valid_supports", "Support gems PoB considers valid for a group's main active skill.", obj(json!({ "group_index": group_index() }), &["group_index"])),
        // Config
        ro("list_config_options", "Every configuration option (var, label, type, section, and list values) for set_config.", none()),
        ro("get_config", "Current configuration values of the active config set (buffs, enemy stats, map mods, and similar assumptions).", none()),
        rw(
            "set_config",
            "Set a configuration option. Pass null to reset it to its default. See list_config_options for var names and value types.",
            obj(json!({ "var": prop("string", "Option var from list_config_options"), "value": { "type": ["boolean", "number", "string", "null"], "description": "New value, or null to reset" } }), &["var"]),
        ),
        // Notes and loadouts
        ro("get_notes", "The build's notes text.", none()),
        rw("set_notes", "Replace the build's notes text.", obj(json!({ "text": prop("string", "Notes text") }), &["text"])),
        ro("get_loadouts", "The build's loadouts (named tree + items + skills + config combinations) and which one is active.", none()),
        rw("select_loadout", "Activate a loadout by name.", obj(json!({ "name": prop("string", "Loadout name from get_loadouts") }), &["name"])),
    ]
}

fn tool_list() -> Vec<Tool> {
    defs()
        .into_iter()
        .map(|d| {
            let schema: JsonObject = d.schema.as_object().cloned().unwrap_or_default();
            let mut tool = Tool::new(d.name, d.description, Arc::new(schema));
            tool.annotations = Some(
                ToolAnnotations::new()
                    .read_only(d.read_only)
                    .destructive(d.destructive)
                    .idempotent(d.read_only)
                    .open_world(false),
            );
            tool
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Tool bodies
// ---------------------------------------------------------------------------

/// Engine errors carry a Lua traceback; the first line is the message.
fn clean_error(e: &str) -> String {
    let first = e.split("\nstack traceback").next().unwrap_or(e).trim();
    first.trim_start_matches("lua: ").trim_start_matches("runtime error: ").to_string()
}

fn arg_str(args: &JsonObject, key: &str) -> Option<String> {
    args.get(key).and_then(Value::as_str).map(str::to_string)
}

fn arg_i64(args: &JsonObject, key: &str) -> Result<Option<i64>, ToolError> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(n)) => n
            .as_i64()
            .or_else(|| n.as_f64().map(|f| f as i64))
            .map(Some)
            .ok_or_else(|| ToolError::Invalid(format!("{key} must be an integer"))),
        Some(Value::String(s)) => s
            .trim()
            .parse::<i64>()
            .map(Some)
            .map_err(|_| ToolError::Invalid(format!("{key} must be an integer"))),
        Some(_) => Err(ToolError::Invalid(format!("{key} must be an integer"))),
    }
}

fn arg_bool(args: &JsonObject, key: &str) -> Option<bool> {
    args.get(key).and_then(Value::as_bool)
}

fn req_str(args: &JsonObject, key: &str) -> Result<String, ToolError> {
    arg_str(args, key)
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| ToolError::Invalid(format!("{key} is required")))
}

fn req_i64(args: &JsonObject, key: &str) -> Result<i64, ToolError> {
    arg_i64(args, key)?.ok_or_else(|| ToolError::Invalid(format!("{key} is required")))
}

/// Remove PoB colour escapes (`^7`, `^xRRGGBB`) from a display string.
fn strip_escapes(s: &str) -> String {
    let c: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < c.len() {
        if c[i] == '^' && i + 1 < c.len() {
            if c[i + 1] == 'x' && i + 8 <= c.len() && c[i + 2..i + 8].iter().all(|ch| ch.is_ascii_hexdigit()) {
                i += 8;
                continue;
            }
            if c[i + 1].is_ascii_digit() {
                i += 2;
                continue;
            }
        }
        out.push(c[i]);
        i += 1;
    }
    out
}

/// Runs one tool. Returns the result and whether the build changed.
fn run_tool(ctx: &ToolContext, name: &str, args: &JsonObject) -> Result<(Value, bool), ToolError> {
    let stats = |v: Value| Ok((ctx.with_stats(v), true));
    let read = |v: Value| Ok((v, false));
    let tree_summary = |state: Value| -> Value {
        let points = ctx
            .call("get_build", Value::Null)
            .ok()
            .and_then(|b| b.get("points").cloned())
            .unwrap_or(Value::Null);
        json!({
            "allocatedNodeCount": state.get("allocatedNodeCount").cloned().unwrap_or(Value::Null),
            "pointsUsed": state.get("pointsUsed").cloned().unwrap_or(Value::Null),
            "points": points,
        })
    };
    match name {
        // Build
        "load_build" => {
            let source = req_str(args, "source")?;
            let name = arg_str(args, "name");
            let src = source.trim();
            let lower = src.to_ascii_lowercase();
            let is_path = (lower.ends_with(".xml") || lower.ends_with(".build")) && Path::new(src).is_file();
            let info = if src.starts_with('<') {
                ctx.call("load_build_xml", json!({ "xml": src, "name": name }))?
            } else if is_path && lower.ends_with(".build") {
                let json = crate::read_text_lossy(src).map_err(ToolError::Failed)?;
                ctx.call("import_game_build", json!({ "json": json, "name": name }))?
            } else if is_path {
                ctx.call("load_build_file", json!({ "path": src }))?
            } else {
                ctx.call("load_build_code", json!({ "code": src, "name": name }))?
            };
            let mut out = json!({ "loaded": true, "build": info });
            if let Some(site) = arg_str(args, "site") {
                out["site"] = json!(site);
            }
            stats(out)
        }
        "new_build" => stats(ctx.call("new_build", json!({ "name": arg_str(args, "name") }))?),
        "list_local_builds" => {
            let dir = crate::builds_dir(&ctx.user_dir);
            let builds = crate::scan_builds(&dir).map_err(ToolError::Failed)?;
            read(json!({
                "directory": dir.to_string_lossy(),
                "builds": serde_json::to_value(builds).unwrap_or(Value::Null),
            }))
        }
        "save_build" => {
            let params = match arg_str(args, "path") {
                Some(p) => json!({ "path": p }),
                None => Value::Null,
            };
            Ok((ctx.call("save_build_file", params)?, true))
        }
        "export_build" => {
            let format = arg_str(args, "format").unwrap_or_else(|| "code".into());
            match format.as_str() {
                "code" => read(ctx.call("save_build_code", Value::Null)?),
                "xml" => read(ctx.call("save_build_xml", Value::Null)?),
                _ => Err(ToolError::Invalid("format must be \"code\" or \"xml\"".into())),
            }
        }
        // Character
        "get_character" => read(ctx.call("get_build", Value::Null)?),
        "set_level" => stats(ctx.call("set_level", json!({ "level": req_i64(args, "level")? }))?),
        "list_classes" => read(ctx.call("list_classes", Value::Null)?),
        "select_class" => {
            let class_id = arg_i64(args, "class_id")?;
            let ascend = arg_i64(args, "ascend_class_id")?;
            if class_id.is_none() && ascend.is_none() {
                return Err(ToolError::Invalid("class_id or ascend_class_id is required".into()));
            }
            stats(ctx.call("select_class", json!({ "classId": class_id, "ascendClassId": ascend }))?)
        }
        // Stats
        "get_stats" => {
            let params = match args.get("fields").filter(|v| v.is_array()).cloned() {
                Some(f) => json!({ "fields": f }),
                None => Value::Null,
            };
            read(ctx.call("get_stats", params)?)
        }
        "list_stat_keys" => read(ctx.call("list_stat_keys", Value::Null)?),
        "get_sidebar" => {
            let raw = ctx.call("get_sidebar", Value::Null)?;
            let rows: Vec<Value> = raw
                .get("rows")
                .and_then(Value::as_array)
                .map(|rows| {
                    rows.iter()
                        .filter_map(|r| {
                            let lhs = r.get("lhs").and_then(Value::as_str).map(strip_escapes);
                            let rhs = r.get("rhs").and_then(Value::as_str).map(strip_escapes);
                            match (lhs, rhs) {
                                (Some(l), Some(r)) if !l.trim().is_empty() => Some(json!({ "label": l.trim(), "value": r.trim() })),
                                (Some(l), None) if !l.trim().is_empty() => Some(json!({ "label": l.trim() })),
                                _ => None,
                            }
                        })
                        .collect()
                })
                .unwrap_or_default();
            let warnings: Vec<String> = raw
                .get("warnings")
                .and_then(Value::as_array)
                .map(|w| w.iter().filter_map(Value::as_str).map(strip_escapes).collect())
                .unwrap_or_default();
            read(json!({ "rows": rows, "warnings": warnings }))
        }
        "sanity_check" => read(ctx.call("sanity_check", Value::Null)?),
        // Tree
        "get_tree_state" => read(ctx.call("get_tree_state", Value::Null)?),
        "search_tree" => {
            let ascendancy = match (arg_str(args, "ascendancy_name"), arg_bool(args, "main_tree_only")) {
                (Some(a), _) if !a.trim().is_empty() => json!(a),
                (_, Some(true)) => json!(false),
                _ => Value::Null,
            };
            read(ctx.call(
                "search_tree",
                json!({
                    "query": arg_str(args, "query"),
                    "type": arg_str(args, "node_type"),
                    "ascendancyName": ascendancy,
                    "limit": arg_i64(args, "limit")?.unwrap_or(200),
                }),
            )?)
        }
        "node_info" => read(ctx.call("node_info", json!({ "id": req_i64(args, "node_id")? }))?),
        "node_path_cost" => read(ctx.call("node_path", json!({ "id": req_i64(args, "node_id")? }))?),
        "alloc_node" => {
            let state = ctx.call("alloc_node", json!({ "id": req_i64(args, "node_id")? }))?;
            stats(tree_summary(state))
        }
        "dealloc_node" => {
            let state = ctx.call("dealloc_node", json!({ "id": req_i64(args, "node_id")? }))?;
            stats(tree_summary(state))
        }
        "tree_undo" => {
            let state = ctx.call("tree_undo", Value::Null)?;
            stats(tree_summary(state))
        }
        "export_tree_url" => read(ctx.call("export_tree_url", Value::Null)?),
        "import_tree_url" => {
            let state = ctx.call("import_tree_url", json!({ "url": req_str(args, "url")? }))?;
            stats(tree_summary(state))
        }
        // Specs
        "list_specs" => read(ctx.call("list_specs", Value::Null)?),
        "select_spec" => stats(ctx.call("select_spec", json!({ "index": req_i64(args, "index")? }))?),
        "create_spec" => stats(ctx.call("create_spec", json!({ "title": arg_str(args, "title") }))?),
        "copy_spec" => stats(ctx.call("copy_spec", json!({ "index": arg_i64(args, "index")?, "title": arg_str(args, "title") }))?),
        "rename_spec" => Ok((
            ctx.call("rename_spec", json!({ "index": req_i64(args, "index")?, "title": req_str(args, "title")? }))?,
            true,
        )),
        "delete_spec" => stats(ctx.call("delete_spec", json!({ "index": req_i64(args, "index")? }))?),
        // Items
        "get_items" => {
            let mut v = ctx.call("list_slots", Value::Null)?;
            if let Some(slots) = v.get_mut("slots").and_then(Value::as_array_mut) {
                slots.retain(|s| s.get("shown") != Some(&Value::Bool(false)) && s.get("inactive") != Some(&Value::Bool(true)));
            }
            read(v)
        }

        "list_items" => read(ctx.call("get_items", Value::Null)?),
        "equip_item_raw" => stats(ctx.call(
            "equip_item_raw",
            json!({ "text": req_str(args, "item_text")?, "slot": arg_str(args, "slot") }),
        )?),
        "equip_item" => stats(ctx.call(
            "equip_item",
            json!({ "itemId": req_i64(args, "item_id")?, "slot": req_str(args, "slot")? }),
        )?),
        "unequip_item" => stats(ctx.call("unequip_item", json!({ "slot": req_str(args, "slot")? }))?),
        "delete_item" => stats(ctx.call("delete_item", json!({ "itemId": req_i64(args, "item_id")? }))?),
        "search_item_db" => read(ctx.call(
            "item_db_list",
            json!({
                "query": arg_str(args, "query"),
                "type": arg_str(args, "item_type"),
                "db": arg_str(args, "db"),
                "limit": arg_i64(args, "limit")?.unwrap_or(50).max(1),
                "offset": arg_i64(args, "offset")?.unwrap_or(0).max(0),
            }),
        )?),
        "equip_from_item_db" => stats(ctx.call(
            "item_db_equip",
            json!({ "name": req_str(args, "name")?, "db": arg_str(args, "db"), "slotName": arg_str(args, "slot") }),
        )?),
        // Item sets
        "list_item_sets" => read(ctx.call("list_item_sets", Value::Null)?),
        "select_item_set" => stats(ctx.call("select_item_set", json!({ "id": req_i64(args, "id")? }))?),
        "create_item_set" => stats(ctx.call("create_item_set", json!({ "title": arg_str(args, "title") }))?),
        "copy_item_set" => stats(ctx.call("copy_item_set", json!({ "id": arg_i64(args, "id")?, "title": arg_str(args, "title") }))?),
        "rename_item_set" => Ok((
            ctx.call("rename_item_set", json!({ "id": req_i64(args, "id")?, "title": req_str(args, "title")? }))?,
            true,
        )),
        "delete_item_set" => stats(ctx.call("delete_item_set", json!({ "id": req_i64(args, "id")? }))?),
        // Skills
        "get_skills" => read(ctx.call("get_skills", Value::Null)?),
        "add_socket_group" => stats(ctx.call(
            "add_socket_group",
            json!({ "label": arg_str(args, "label"), "slot": arg_str(args, "slot") }),
        )?),
        "remove_socket_group" => stats(ctx.call("remove_socket_group", json!({ "index": req_i64(args, "index")? }))?),
        "set_socket_group" => stats(ctx.call(
            "set_socket_group",
            json!({
                "index": req_i64(args, "index")?,
                "enabled": arg_bool(args, "enabled"),
                "label": arg_str(args, "label"),
                "slot": arg_str(args, "slot"),
                "includeInFullDPS": arg_bool(args, "include_in_full_dps"),
                "mainActiveSkill": arg_i64(args, "main_active_skill")?,
            }),
        )?),
        "set_main_skill" => stats(ctx.call("set_main_skill", json!({ "index": req_i64(args, "group_index")? }))?),
        "add_gem" => {
            let gem_id = arg_str(args, "gem_id");
            let skill_id = arg_str(args, "skill_id");
            let name_spec = arg_str(args, "name_spec");
            if gem_id.is_none() && skill_id.is_none() && name_spec.is_none() {
                return Err(ToolError::Invalid("gem_id, skill_id, or name_spec is required".into()));
            }
            stats(ctx.call(
                "add_gem",
                json!({
                    "groupIndex": req_i64(args, "group_index")?,
                    "gemId": gem_id,
                    "skillId": skill_id,
                    "nameSpec": name_spec,
                    "level": arg_i64(args, "level")?,
                    "quality": arg_i64(args, "quality")?,
                }),
            )?)
        }
        "set_gem" => stats(ctx.call(
            "set_gem",
            json!({
                "groupIndex": req_i64(args, "group_index")?,
                "gemIndex": req_i64(args, "gem_index")?,
                "level": arg_i64(args, "level")?,
                "quality": arg_i64(args, "quality")?,
                "enabled": arg_bool(args, "enabled"),
                "gemId": arg_str(args, "gem_id"),
            }),
        )?),
        "remove_gem" => stats(ctx.call(
            "remove_gem",
            json!({ "groupIndex": req_i64(args, "group_index")?, "gemIndex": req_i64(args, "gem_index")? }),
        )?),
        "list_gems" => read(ctx.call(
            "list_gems",
            json!({
                "query": arg_str(args, "query"),
                "onlySupports": arg_bool(args, "only_supports"),
                "limit": arg_i64(args, "limit")?.unwrap_or(50),
            }),
        )?),
        "list_valid_supports" => read(ctx.call("list_valid_supports", json!({ "groupIndex": req_i64(args, "group_index")? }))?),
        // Config
        "list_config_options" => read(ctx.call("list_config_options", Value::Null)?),
        "get_config" => read(ctx.call("get_config", Value::Null)?),
        "set_config" => stats(ctx.call(
            "set_config",
            json!({ "var": req_str(args, "var")?, "value": args.get("value").cloned().unwrap_or(Value::Null) }),
        )?),
        // Notes and loadouts
        "get_notes" => read(ctx.call("get_notes", Value::Null)?),
        "set_notes" => Ok((ctx.call("set_notes", json!({ "text": arg_str(args, "text").unwrap_or_default() }))?, true)),
        "get_loadouts" => read(ctx.call("get_loadouts", Value::Null)?),
        "select_loadout" => stats(ctx.call("select_loadout", json!({ "name": req_str(args, "name")? }))?),
        other => Err(ToolError::Invalid(format!("unknown tool {other}"))),
    }
}
