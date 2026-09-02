<script lang="ts">
  import { poolStatus, telemetry, type EngineStatus, type AppPaths, type PoolStatus } from "$lib/engine.svelte";
  import { build } from "$lib/state/build.svelte";
  import { appOptions } from "$lib/state/options.svelte";
  import { mcp } from "$lib/state/mcp.svelte";

  let { status, paths }: { status: EngineStatus | null; paths: AppPaths | null } = $props();

  // worker engines boot in the background after the main engine; poll until all are up
  let pool = $state<PoolStatus | null>(null);
  $effect(() => {
    if (status?.state !== "ready") return;
    let timer = 0;
    const tick = async () => {
      try {
        pool = await poolStatus();
      } catch {
        pool = null;
        return;
      }
      if (pool.ready < pool.size) timer = window.setTimeout(tick, 1500);
    };
    tick();
    return () => clearTimeout(timer);
  });

  const stateColor = $derived(
    status?.state === "ready" ? "var(--ok)" : status?.state === "error" ? "var(--bad)" : "var(--warn)",
  );
</script>

<footer class="statusbar">
  <div class="seg">
    <span class="dot" style:background={stateColor} class:pulse={status?.state === "booting" || telemetry.inflight > 0}></span>
    <span>engine {status?.state ?? "…"}</span>
    {#if status?.boot_ms != null}<span class="dim num">{status.boot_ms} ms boot</span>{/if}
  </div>
  {#if pool && pool.size > 0}
    <div class="seg dim" title="Extra PoB engines that share node-power and gem-DPS scoring">
      <span>workers</span>
      <span class="num" class:pulse={pool.ready < pool.size}>{pool.ready}/{pool.size}</span>
    </div>
  {/if}
  {#if paths?.sync}
    <div class="seg">
      <span class="dim">PoB</span>
      <span class="num">{paths.sync.upstream_version}</span>
      <span class="dim num" title={paths.sync.upstream_commit}>{paths.sync.upstream_commit.slice(0, 8)}</span>
    </div>
  {/if}
  {#if mcp.status?.running}
    <div class="seg" title="MCP server for AI clients is on (configure in Options)">
      <span class="dim">mcp</span>
      <span class="num">:{mcp.status.port}</span>
    </div>
  {/if}
  <div class="grow"></div>
  {#if build.error}
    <button class="seg err" onclick={() => build.clearError()} title="Dismiss">
      <span>{build.error}</span>
    </button>
  {/if}
  {#if telemetry.lastMethod}
    <div class="seg dim">
      <span class="mono">{telemetry.lastMethod}</span>
      <span class="num">{telemetry.lastMs.toFixed(1)} ms</span>
    </div>
  {/if}
  {#if build.info}
    <div class="seg dim"><span>rev</span><span class="num">{build.info.rev}</span></div>
  {/if}
  <button class="seg gear" onclick={() => (appOptions.open = true)} title="Options" disabled={!appOptions.values}>⚙</button>
</footer>

<style>
  .statusbar {
    height: var(--statusbar-h);
    display: flex;
    align-items: stretch;
    background: var(--bg-1);
    border-top: 1px solid var(--line-0);
    font-size: var(--fs-2xs);
    color: var(--fg-2);
    letter-spacing: 0.02em;
  }
  .seg {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 10px;
    border-right: 1px solid var(--line-0);
    white-space: nowrap;
    appearance: none;
    background: none;
    border-top: 0;
    border-bottom: 0;
    border-left: 0;
    color: inherit;
    font: inherit;
  }
  .grow {
    flex: 1;
  }
  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
  }
  .pulse {
    animation: pulse 1.2s ease-in-out infinite;
  }
  .gear {
    cursor: pointer;
    border-left: 1px solid var(--line-0);
    border-right: 0;
  }
  .gear:hover:not(:disabled) {
    color: var(--fg-0);
    background: var(--bg-2);
  }
  .err {
    color: var(--bad);
    border-left: 1px solid var(--line-0);
    cursor: pointer;
    max-width: 50vw;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
