import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { build } from "$lib/state/build.svelte";

const KEY = "pob-redux:mcp";
export const MCP_DEFAULT_PORT = 7315;

export interface McpStatus {
  running: boolean;
  port: number;
  url: string | null;
  error: string | null;
  calls: number;
}

/**
 * First-party MCP server. An AI client (Claude Code, Claude Desktop, Cursor)
 * reads and edits the build that is open in the app over Streamable HTTP on
 * localhost. Off by default; the toggle and port persist app-side and are
 * re-applied on boot.
 */
class McpStore {
  enabled = $state(false);
  port = $state(MCP_DEFAULT_PORT);
  status = $state<McpStatus | null>(null);
  busy = $state(false);

  private syncTimer: ReturnType<typeof setTimeout> | undefined;

  /** Called once the engine is ready. */
  async init() {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}");
      if (typeof saved.enabled === "boolean") this.enabled = saved.enabled;
      if (Number.isInteger(saved.port)) this.port = saved.port;
    } catch {}
    await listen<{ tool: string }>("mcp:changed", () => {
      // a client changed the build; re-pull so every view shows PoB's new state
      clearTimeout(this.syncTimer);
      this.syncTimer = setTimeout(() => {
        build.run(async () => {}).then(() => {
          if (build.view === "import" && build.loaded) build.view = "tree";
        });
      }, 60);
    });
    await listen<McpStatus>("mcp:status", (e) => {
      this.status = e.payload;
      this.enabled = e.payload.running;
    });
    if (this.enabled) await this.start();
    else await this.refresh();
    // POB_REDUX_MCP may have started it before the UI was up
    if (this.status?.running) {
      this.enabled = true;
      this.port = this.status.port;
    }

  }

  private persist() {
    try {
      localStorage.setItem(KEY, JSON.stringify({ enabled: this.enabled, port: this.port }));
    } catch {}
  }

  async refresh() {
    this.status = await invoke<McpStatus>("mcp_status").catch(() => null);
  }

  async start() {
    this.busy = true;
    try {
      this.status = await invoke<McpStatus>("mcp_start", { port: this.port });
      this.enabled = this.status.running;
    } catch (e) {
      this.enabled = false;
      this.status = { running: false, port: this.port, url: null, error: String(e), calls: 0 };
    } finally {
      this.persist();
      this.busy = false;
    }
  }

  async stop() {
    this.busy = true;
    try {
      this.status = await invoke<McpStatus>("mcp_stop");
    } catch (e) {
      this.status = { running: false, port: this.port, url: null, error: String(e), calls: 0 };
    } finally {
      this.enabled = false;
      this.persist();
      this.busy = false;
    }
  }

  setEnabled(on: boolean) {
    return on ? this.start() : this.stop();
  }

  async setPort(port: number) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) return;
    if (port === this.port) return;
    this.port = port;
    this.persist();
    if (this.enabled) {
      await this.stop();
      await this.start();
    }
  }
}

export const mcp = new McpStore();
