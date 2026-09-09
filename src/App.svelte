<script lang="ts">
  import { onMount } from "svelte";
  import TitleBar from "$lib/components/TitleBar.svelte";
  import Sidebar from "$lib/components/Sidebar.svelte";
  import StatusBar from "$lib/components/StatusBar.svelte";
  import TreeView from "$lib/views/TreeView.svelte";
  import SkillsView from "$lib/views/SkillsView.svelte";
  import ItemsView from "$lib/views/ItemsView.svelte";
  import CalcsView from "$lib/views/CalcsView.svelte";
  import ConfigView from "$lib/views/ConfigView.svelte";
  import NotesView from "$lib/views/NotesView.svelte";
  import PartyView from "$lib/views/PartyView.svelte";
  import OptimiseView from "$lib/views/OptimiseView.svelte";
  import ImportView from "$lib/views/ImportView.svelte";
  import OptionsModal from "$lib/components/OptionsModal.svelte";
  import ChatPanel from "$lib/components/ChatPanel.svelte";
  import UpdateBanner from "$lib/components/UpdateBanner.svelte";
  import logo from "$lib/assets/logo.png";
  import { engine, status as engineStatus, appPaths, type EngineStatus, type AppPaths } from "$lib/engine.svelte";
  import { build } from "$lib/state/build.svelte";
  import { appOptions } from "$lib/state/options.svelte";
  import { mcp } from "$lib/state/mcp.svelte";
  import { chat } from "$lib/state/chat.svelte";
  import { appUpdate } from "$lib/state/update.svelte";
  import { ui } from "$lib/state/ui.svelte";

  let status = $state<EngineStatus | null>(null);
  let paths = $state<AppPaths | null>(null);
  let bootDots = $state(0);

  onMount(() => {
    let timer = 0;
    const tick = window.setInterval(() => (bootDots = (bootDots + 1) % 4), 400);
    // Ctrl+K toggles the assistant. Single letters belong to the tree view.
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        chat.toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    const poll = async () => {
      try {
        status = await engineStatus();
      } catch (e) {
        status = { state: "error", message: String(e), boot_ms: null, pob_root: "", user_dir: "" };
        return;
      }
      if (status.state === "booting") {
        timer = window.setTimeout(poll, 150);
      } else if (status.state === "ready") {
        paths = await appPaths().catch(() => null);
        await appOptions.init().catch(() => {});
        await mcp.init().catch(() => {});
        await chat.init(paths?.chat_open).catch(() => {});
        if (paths?.chat_provider) await chat.setProvider(paths.chat_provider).catch(() => {});
        if (paths?.chat_model) chat.setModel(paths.chat_model);
        appUpdate.init();
        // shared items added in this app are ours to restore (PoB's own
        // settings file, which also holds shared items, is never written)
        try {
          const raws: string[] = JSON.parse(localStorage.getItem("pob-redux:shared-items") ?? "[]");
          for (const raw of raws) await engine.addSharedItem({ raw }).catch(() => {});
        } catch {}
        if (paths?.open_on_start) {
          await build.loadFile(paths.open_on_start);
        } else if (!(await build.reopenLast())) {
          await build.run(async () => {}, { sync: true });
        }
        build.view = (paths?.initial_view as typeof build.view) || "tree";
        if (paths?.chat_allow) chat.allowWrites = true;
        if (paths?.chat_log) chat.logPath = paths.chat_log;
        if (paths?.chat_ask) {
          chat.input = paths.chat_ask;
          // A value starting with "/" only fills the box, so the tool menu can
          // be inspected without spending a request.
          if (!paths.chat_ask.startsWith("/")) void chat.send();
        }
      }
    };
    poll();
    return () => {
      clearTimeout(timer);
      clearInterval(tick);
      window.removeEventListener("keydown", onKey);
    };
  });
</script>

<div class="app">
  <TitleBar />
  <UpdateBanner />
  <div class="body">
    {#if !ui.sidebarCollapsed}<Sidebar />{/if}
    <main class="view">
      {#if !status || status.state === "booting"}
        <div class="center">
          <div class="boot">
            <img class="bootlogo" src={logo} alt="" draggable="false" />
            <div class="label">Engine</div>
            <div class="big">Loading Path of Building{".".repeat(bootDots)}</div>
            <div class="dim mono small">{status?.pob_root ?? ""}</div>
          </div>
        </div>
      {:else if status.state === "error" || status.state === "stopped"}
        <div class="center">
          <div class="boot err">
            <div class="label" style:color="var(--bad)">Engine failed to start</div>
            <pre class="mono small selectable">{status.message}</pre>
            <div class="dim small">
              PoB program directory: <span class="mono">{status.pob_root || "(not found)"}</span><br />
              Run <span class="mono">cargo run -p pob-sync</span> to vendor Path of Building, then restart.
            </div>
          </div>
        </div>
      {:else if build.view === "tree"}
        <TreeView />
      {:else if build.view === "skills"}
        <SkillsView />
      {:else if build.view === "items"}
        <ItemsView />
      {:else if build.view === "calcs"}
        <CalcsView />
      {:else if build.view === "config"}
        <ConfigView />
      {:else if build.view === "notes"}
        <NotesView />
      {:else if build.view === "party"}
        <PartyView />
      {:else if build.view === "optimise"}
        <OptimiseView />
      {:else}
        <ImportView {paths} />
      {/if}
    </main>
    {#if chat.open && status?.state === "ready"}<ChatPanel />{/if}
  </div>
  <StatusBar {status} {paths} />
  <OptionsModal />
</div>

<style>
  .app {
    height: 100%;
    display: flex;
    flex-direction: column;
    background: var(--bg-0);
  }
  .body {
    flex: 1;
    display: flex;
    min-height: 0;
  }
  .view {
    flex: 1;
    min-width: 0;
    min-height: 0;
    position: relative;
    display: flex;
    flex-direction: column;
  }
  .center {
    flex: 1;
    display: grid;
    place-items: center;
  }
  .bootlogo {
    width: 40px;
    height: 40px;
    margin-bottom: 6px;
    user-select: none;
  }
  :global(:root[data-theme="light"]) .bootlogo {
    filter: invert(1);
  }
  .boot {
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-width: 640px;
    padding: 22px 26px;
    border: 1px solid var(--line-0);
    border-radius: var(--r-2);
    background: var(--bg-1);
  }
  .boot.err pre {
    margin: 0;
    white-space: pre-wrap;
    color: var(--fg-1);
    max-height: 40vh;
    overflow: auto;
  }
  .big {
    font-size: var(--fs-lg);
    color: var(--fg-0);
  }
  .small {
    font-size: var(--fs-xs);
  }
</style>
