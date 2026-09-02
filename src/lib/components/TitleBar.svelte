<script lang="ts">
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { onMount } from "svelte";
  import { build, type ViewId } from "$lib/state/build.svelte";
  import logo from "$lib/assets/logo.png";

  const win = getCurrentWindow();
  let maximized = $state(false);

  const tabs: { id: ViewId; label: string; key: string }[] = [
    { id: "tree", label: "Tree", key: "1" },
    { id: "skills", label: "Skills", key: "2" },
    { id: "items", label: "Items", key: "3" },
    { id: "calcs", label: "Calcs", key: "4" },
    { id: "config", label: "Config", key: "5" },
    { id: "notes", label: "Notes", key: "6" },
    { id: "party", label: "Party", key: "7" },
    { id: "import", label: "Import / Export", key: "8" },
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
  <div class="brand" data-tauri-drag-region>
    <img class="mark" src={logo} alt="" draggable="false" />
    <span class="name">PoB <span class="thin">Redux</span></span>
  </div>

  <div class="tabs" role="tablist">
    {#each tabs as t}
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
    grid-template-columns: var(--sidebar-w) auto 1fr auto;
    align-items: stretch;
    background: var(--bg-1);
    border-bottom: 1px solid var(--line-0);
    -webkit-app-region: drag;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 14px;
    border-right: 1px solid var(--line-0);
  }
  .mark {
    width: 16px;
    height: 16px;
    pointer-events: none;
    user-select: none;
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
  .wc.close:hover {
    background: #c42b1c;
    color: #fff;
  }
</style>
