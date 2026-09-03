//! First-party MCP server. Exposes the build that is open in the app to AI
//! clients over Streamable HTTP on localhost. Off until enabled in Options.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, Implementation, JsonObject,
    ListToolsResult, PaginatedRequestParams, ServerCapabilities, ServerInfo, Tool, ToolAnnotations,
};
use rmcp::service::RequestContext;
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::{StreamableHttpServerConfig, StreamableHttpService};
use rmcp::{ErrorData, RoleServer, ServerHandler};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::AppState;
use crate::tools::{defs, dispatch, ToolContext, ToolError, INSTRUCTIONS};

pub const DEFAULT_PORT: u16 = 7315;

/// A tool context bound to the live engine. Shared by the MCP transport and by
/// the chat panel's `ai_call_tool`, so both drive the same build.
pub(crate) fn tool_context(app: &AppHandle) -> Arc<ToolContext> {
    let state = app.state::<AppState>();
    Arc::new(ToolContext {
        engine: state.engine.clone(),
        user_dir: state.user_dir.clone(),
        app: app.clone(),
        calls: state.mcp.calls.clone(),
    })
}


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
    let ctx = tool_context(app);
    let state = app.state::<AppState>();
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
        let args = request.arguments.unwrap_or_default();
        match dispatch(self.ctx.clone(), name, args).await {
            Ok((value, _)) => Ok(CallToolResult::structured(value).into()),
            Err(ToolError::Invalid(msg)) => Err(ErrorData::invalid_params(msg, None)),
            Err(ToolError::Failed(msg)) => Ok(CallToolResult::error(vec![ContentBlock::text(msg)]).into()),
        }
    }
}

// ---------------------------------------------------------------------------
// Tool table
// ---------------------------------------------------------------------------

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

