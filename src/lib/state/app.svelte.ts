import { engine, status as engineStatus, appPaths, type EngineStatus, type AppPaths } from "$lib/engine.svelte";
import { build } from "$lib/state/build.svelte";
import { appOptions } from "$lib/state/options.svelte";
import { mcp } from "$lib/state/mcp.svelte";
import { chat, type Mode } from "$lib/state/chat.svelte";
import { appUpdate } from "$lib/state/update.svelte";
import { game } from "$lib/state/game.svelte";
import { links } from "$lib/state/links.svelte";

/**
 * The engine's boot state and the app's boot sequence. `boot()` runs once at
 * start and again after every game switch, since a switch replaces the
 * engine: it waits for the engine, then brings every store in line with it.
 */
class AppStore {
  status = $state<EngineStatus | null>(null);
  paths = $state<AppPaths | null>(null);
  private timer = 0;
  private booted = false;

  async boot() {
    clearTimeout(this.timer);
    this.status = null;
    await game.init().catch(() => {});
    const st = await new Promise<EngineStatus>((resolve) => {
      const poll = async () => {
        let s: EngineStatus;
        try {
          s = await engineStatus();
        } catch (e) {
          s = { state: "error", message: String(e), boot_ms: null, pob_root: "", user_dir: "" };
        }
        this.status = s;
        if (s.state === "booting") this.timer = window.setTimeout(poll, 150);
        else resolve(s);
      };
      poll();
    });
    if (st.state !== "ready") return;

    const first = !this.booted;
    this.booted = true;
    this.paths = await appPaths().catch(() => null);
    await appOptions.init().catch(() => {});
    // The MCP server and the assistant are PoE2 features.
    if (game.isPoe2) {
      await mcp.init().catch(() => {});
      await chat.init(this.paths?.chat_open).catch(() => {});
      if (first) {
        if (this.paths?.chat_provider) await chat.setProvider(this.paths.chat_provider).catch(() => {});
        if (this.paths?.chat_model) chat.setModel(this.paths.chat_model);
        if (this.paths?.chat_mode) await chat.setMode(this.paths.chat_mode as Mode).catch(() => {});
      }
    } else {
      chat.open = false;
      await mcp.refresh().catch(() => {});
    }
    if (first) appUpdate.init();
    // shared items added in this app are ours to restore (PoB's own
    // settings file, which also holds shared items, is never written)
    try {
      const raws: string[] = JSON.parse(localStorage.getItem("pob-redux:shared-items") ?? "[]");
      for (const raw of raws) await engine.addSharedItem({ raw }).catch(() => {});
    } catch {}
    const linked = first ? await links.init().catch(() => false) : false;
    if (linked) {
      // the build from the link the app was opened with is loaded
    } else if (first && this.paths?.open_on_start) {
      await build.loadFile(this.paths.open_on_start);
    } else if (!(await build.reopenLast())) {
      await build.run(async () => {}, { sync: true });
    }
    build.view = ((first && this.paths?.initial_view) as typeof build.view) || "tree";
    if (first && game.isPoe2) {
      if (this.paths?.chat_allow) chat.allowWrites = true;
      if (this.paths?.chat_log) chat.logPath = this.paths.chat_log;
      if (this.paths?.chat_ask) {
        chat.input = this.paths.chat_ask;
        // A value starting with "/" only fills the box, so the tool menu can
        // be inspected without spending a request.
        if (!this.paths.chat_ask.startsWith("/")) void chat.send();
      }
    }
  }
}

export const app = new AppStore();
