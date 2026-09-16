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
  import CompareView from "$lib/views/CompareView.svelte";
  import ImportView from "$lib/views/ImportView.svelte";
  import OptionsModal from "$lib/components/OptionsModal.svelte";
  import ConfirmModal from "$lib/components/ConfirmModal.svelte";
  import ChatPanel from "$lib/components/ChatPanel.svelte";
  import UpdateBanner from "$lib/components/UpdateBanner.svelte";
  import logo from "$lib/assets/logo.png";
  import { app } from "$lib/state/app.svelte";
  import { build } from "$lib/state/build.svelte";
  import { chat } from "$lib/state/chat.svelte";
  import { game, GAMES, GAME_LABEL } from "$lib/state/game.svelte";
  import { ui } from "$lib/state/ui.svelte";

  let bootDots = $state(0);
  const status = $derived(app.status);
  const paths = $derived(app.paths);

  $effect(() => {
    if (status && status.state !== "booting") return;
    const tick = window.setInterval(() => (bootDots = (bootDots + 1) % 4), 400);
    return () => clearInterval(tick);
  });

  onMount(() => {
    // Single-letter keys belong to the tree view.
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k" && game.isPoe2) {
        e.preventDefault();
        chat.toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    void app.boot();
    return () => {
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
            <div class="big">Loading Path of Building{game.isPoe1 ? "" : " (PoE2)"}{".".repeat(bootDots)}</div>
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
              Run <span class="mono">bun run sync</span> to vendor Path of Building, then restart.
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
      {:else if build.view === "compare"}
        <CompareView />
      {:else}
        <ImportView {paths} />
      {/if}
    </main>
    {#if chat.open && game.isPoe2 && status?.state === "ready"}<ChatPanel />{/if}
  </div>
  <StatusBar {status} {paths} />
  <OptionsModal />
  <ConfirmModal />
  {#if game.firstRun}
    <div class="pick-backdrop">
      <div class="pick">
        <div class="label">Welcome</div>
        <div class="big">Which game are you building for?</div>
        <div class="dim small">Each game runs its own Path of Building. You can switch any time from the title bar.</div>
        <div class="pick-row">
          {#each GAMES as g (g)}
            <button class="pick-btn" onclick={() => game.choose(g)} disabled={!game.has(g) || game.switching}>
              <span class="pick-name">{GAME_LABEL[g]}</span>
              <span class="dim small">{game.has(g) ? (g === "poe1" ? "Wraeclast, 3.x" : "Early access, 0.x") : "Not installed"}</span>
            </button>
          {/each}
        </div>
        {#if game.error}<div class="small" style:color="var(--bad)">{game.error}</div>{/if}
      </div>
    </div>
  {/if}
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
  .boot,
  .pick {
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
  .pick-backdrop {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    background: color-mix(in srgb, var(--bg-0) 72%, transparent);
    z-index: 40;
  }
  .pick {
    min-width: 440px;
  }
  .pick-row {
    display: flex;
    gap: 10px;
    margin-top: 10px;
  }
  .pick-btn {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
    padding: 14px 16px;
    border: 1px solid var(--line-0);
    border-radius: var(--r-2);
    background: var(--bg-0);
    color: var(--fg-0);
    cursor: pointer;
    text-align: left;
  }
  .pick-btn:hover:not(:disabled) {
    border-color: var(--fg-2);
    background: var(--bg-hover);
  }
  .pick-btn:disabled {
    color: var(--fg-4);
    cursor: default;
  }
  .pick-name {
    font-size: var(--fs-md);
    font-weight: 600;
  }
</style>
