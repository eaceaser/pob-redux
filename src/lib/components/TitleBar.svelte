<script lang="ts">
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { onMount } from "svelte";
  import { build, type ViewId } from "$lib/state/build.svelte";
  import { ui } from "$lib/state/ui.svelte";
  import { appOptions } from "$lib/state/options.svelte";
  import { game, GAME_SHORT, GAME_LABEL } from "$lib/state/game.svelte";
  import Icon from "$lib/components/Icon.svelte";

  const otherGame = $derived(game.isPoe2 ? "poe1" : "poe2");
  import logo from "$lib/assets/logo.png";

  const win = getCurrentWindow();
  let maximized = $state(false);

  const tabs: { id: ViewId; label: string; key: string }[] = [
    { id: "import", label: "Builds", key: "1" },
    { id: "tree", label: "Tree", key: "2" },
    { id: "skills", label: "Skills", key: "3" },
    { id: "items", label: "Items", key: "4" },
    { id: "calcs", label: "Calcs", key: "5" },
    { id: "config", label: "Config", key: "6" },
    { id: "notes", label: "Notes", key: "7" },
    { id: "party", label: "Party", key: "8" },
    { id: "optimise", label: "Optimise", key: "9" },
  ];

  // the build name lives in the sidebar; the OS title carries it for the taskbar
  $effect(() => {
    const name = build.info?.name;
    win.setTitle(name ? `${name}${build.info?.unsaved ? " •" : ""} — PoB Redux` : "PoB Redux").catch(() => {});
  });

  onMount(() => {
    win.isMaximized().then((m) => (maximized = m));
    const un = win.onResized(async () => (maximized = await win.isMaximized()));
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.shiftKey && !e.altKey) {
        const t = tabs.find((t) => t.key === e.key);
        if (t && build.loaded) {
          build.view = t.id;
          e.preventDefault();
        }
        if (e.key === "z") {
          build.undo();
          e.preventDefault();
        }
        if (e.key === "y") {
          build.redo();
          e.preventDefault();
        }
        if (e.key === "b") {
          ui.toggleSidebar();
          e.preventDefault();
        }
        if (e.key === ",") {
          appOptions.open = true;
          e.preventDefault();
        }
        if (e.key === "=" || e.key === "+") {
          ui.stepScale(1);
          e.preventDefault();
        }
        if (e.key === "-") {
          ui.stepScale(-1);
          e.preventDefault();
        }
        if (e.key === "0") {
          ui.setScale(1);
          e.preventDefault();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      un.then((f) => f());
      window.removeEventListener("keydown", onKey);
    };
  });
</script>

<header class="titlebar" data-tauri-drag-region>
  <div class="brand" class:wide={!ui.sidebarCollapsed} data-tauri-drag-region>
    <img class="mark" src={logo} alt="" draggable="false" />
    <span class="name">PoB <span class="thin">Redux</span></span>
    <button
      class="sb"
      class:on={!ui.sidebarCollapsed}
      aria-label={ui.sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
      title={`${ui.sidebarCollapsed ? "Show" : "Hide"} sidebar (Ctrl+B)`}
      onclick={() => ui.toggleSidebar()}
    >
      <svg width="14" height="12" viewBox="0 0 14 12" fill="none" stroke="currentColor" stroke-width="1">
        <rect x="0.5" y="0.5" width="13" height="11" rx="1.5" />
        <path d="M5 0.5v11" />
      </svg>
    </button>
  </div>

  <div class="game">
    <button
      class="gswitch"
      role="switch"
      aria-checked={game.isPoe2}
      aria-label="Game"
      disabled={game.switching || build.busy > 0 || !game.has(otherGame)}
      title={game.has(otherGame) ? `Switch to ${GAME_LABEL[otherGame]}` : `${GAME_LABEL[otherGame]} is not installed`}
      onclick={() => game.choose(otherGame)}
    >
      <span class="glabel" class:on={game.isPoe1}>{GAME_SHORT.poe1}</span>
      <span class="track" class:right={game.isPoe2}><span class="thumb"></span></span>
      <span class="glabel" class:on={game.isPoe2}>{GAME_SHORT.poe2}</span>
    </button>
  </div>

  <div class="tabs" role="tablist">
    {#each tabs as t (t.id)}
      <button
        role="tab"
        class="tab"
        class:active={build.view === t.id}
        aria-selected={build.view === t.id}
        disabled={!build.loaded && t.id !== "import"}
        onclick={() => (build.view = t.id)}
        title={`Ctrl+${t.key}`}
      >
        {t.label}
      </button>
    {/each}
  </div>

  <div class="spacer" data-tauri-drag-region></div>

  <div class="controls">
    <button class="wc opts" aria-label="Options" title="Options (Ctrl+,)" onclick={() => (appOptions.open = true)}>
      <Icon name="gear" size={15} />
    </button>
    <button class="wc" aria-label="Minimize" onclick={() => win.minimize()}>
      <svg width="10" height="10" viewBox="0 0 10 10"><path d="M0 5.5h10" stroke="currentColor" stroke-width="1" /></svg>
    </button>
    <button class="wc" aria-label="Maximize" onclick={() => win.toggleMaximize()}>
      {#if maximized}
        <svg width="10" height="10" viewBox="0 0 10 10"
          ><path d="M2.5 0.5h7v7M0.5 2.5h7v7h-7z" fill="none" stroke="currentColor" stroke-width="1" /></svg
        >
      {:else}
        <svg width="10" height="10" viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1" /></svg>
      {/if}
    </button>
    <button class="wc close" aria-label="Close" onclick={() => win.close()}>
      <svg width="10" height="10" viewBox="0 0 10 10"><path d="M0.5 0.5l9 9M9.5 0.5l-9 9" stroke="currentColor" stroke-width="1.1" /></svg>
    </button>
  </div>
</header>

<style>
  .titlebar {
    height: var(--titlebar-h);
    display: grid;
    grid-template-columns: auto auto auto 1fr auto;
    align-items: stretch;
    background: var(--bg-1);
    border-bottom: 1px solid var(--line-0);
    -webkit-app-region: drag;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 10px 0 14px;
    border-right: 1px solid var(--line-0);
  }
  .brand.wide {
    width: var(--sidebar-w);
  }
  .sb {
    appearance: none;
    border: 0;
    background: transparent;
    color: var(--fg-3);
    margin-left: auto;
    padding: 4px;
    border-radius: var(--r-1);
    display: grid;
    place-items: center;
    cursor: pointer;
    -webkit-app-region: no-drag;
  }
  .sb:hover {
    color: var(--fg-0);
    background: var(--bg-hover);
  }
  .sb.on {
    color: var(--fg-2);
  }
  .mark {
    width: 16px;
    height: 16px;
    pointer-events: none;
    user-select: none;
  }
  :global(:root[data-theme="light"]) .mark {
    filter: invert(1);
  }
  .name {
    font-size: var(--fs-sm);
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--fg-0);
  }
  .thin {
    font-weight: 400;
    color: var(--fg-2);
  }
  .game {
    display: flex;
    align-items: center;
    padding: 0 10px;
    border-right: 1px solid var(--line-0);
    -webkit-app-region: no-drag;
  }
  .gswitch {
    appearance: none;
    display: inline-flex;
    align-items: center;
    gap: 7px;
    border: 0;
    background: transparent;
    padding: 3px 2px;
    border-radius: var(--r-1);
    cursor: pointer;
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    letter-spacing: 0.06em;
  }
  .gswitch:hover:not(:disabled) {
    background: var(--bg-hover);
  }
  .gswitch:disabled {
    cursor: default;
    opacity: 0.6;
  }
  .glabel {
    color: var(--fg-2);
  }
  .glabel.on {
    color: var(--ok);
  }
  .track {
    position: relative;
    width: 26px;
    height: 14px;
    border: 1px solid var(--line-1);
    border-radius: 999px;
    background: var(--bg-0);
  }
  .thumb {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--ok);
    transition: transform 120ms ease;
  }
  .track.right .thumb {
    transform: translateX(12px);
  }
  .tabs {
    display: flex;
    align-items: stretch;
    -webkit-app-region: no-drag;
  }
  .tab {
    appearance: none;
    border: 0;
    border-right: 1px solid var(--line-0);
    background: transparent;
    color: var(--fg-2);
    font-size: var(--fs-sm);
    padding: 0 16px;
    cursor: pointer;
    position: relative;
    letter-spacing: 0.01em;
  }
  .tab:hover:not(:disabled) {
    color: var(--fg-0);
    background: var(--bg-2);
  }
  .tab.active {
    color: var(--fg-0);
    background: var(--bg-0);
  }
  .tab.active::after {
    content: "";
    position: absolute;
    left: 0;
    right: 0;
    bottom: -1px;
    height: 1px;
    background: var(--bg-0);
  }
  .tab.active::before {
    content: "";
    position: absolute;
    left: 0;
    right: 0;
    top: 0;
    height: 1px;
    background: var(--fg-0);
  }
  .tab:disabled {
    color: var(--fg-4);
    cursor: default;
  }
  .spacer {
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 0;
  }
  .controls {
    display: flex;
    -webkit-app-region: no-drag;
  }
  .wc {
    appearance: none;
    width: 46px;
    border: 0;
    background: transparent;
    color: var(--fg-2);
    cursor: default;
    display: grid;
    place-items: center;
  }
  .wc:hover {
    background: var(--bg-hover);
    color: var(--fg-0);
  }
  .wc.opts {
    width: 40px;
    margin-right: 6px;
    border-right: 1px solid var(--line-0);
    cursor: pointer;
  }
  .wc.close:hover {
    background: #c42b1c;
    color: #fff;
  }
</style>
