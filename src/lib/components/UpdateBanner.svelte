<script lang="ts">
  import { appUpdate } from "$lib/state/update.svelte";
</script>

{#if appUpdate.showBanner}
  <div class="banner" role="status">
    {#if appUpdate.phase === "available"}
      <span class="txt">Version <span class="mono">{appUpdate.version}</span> is available.</span>
      {#if appUpdate.installable}
        <button class="btn sm" onclick={() => appUpdate.install()}>Update</button>
      {:else}
        <button class="btn sm" onclick={() => appUpdate.openReleases()} title="A package install is replaced by its package manager, not by the app">Download</button>
      {/if}
      <button class="btn sm ghost" onclick={() => appUpdate.dismiss()}>Later</button>
    {:else if appUpdate.phase === "downloading"}
      <span class="txt">
        Downloading <span class="mono">{appUpdate.version}</span>
        {#if appUpdate.progress !== null}<span class="mono">{appUpdate.progress}%</span>{/if}
      </span>
      <div class="bar"><div class="fill" style:width="{appUpdate.progress ?? 15}%" class:idle={appUpdate.progress === null}></div></div>
    {:else if appUpdate.phase === "ready"}
      <span class="txt">Update installed. Restart to finish.</span>
      <button class="btn sm" onclick={() => appUpdate.restart()}>Restart</button>
      <button class="btn sm ghost" onclick={() => appUpdate.dismiss()}>Later</button>
    {/if}
  </div>
{/if}

<style>
  .banner {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 12px;
    background: var(--bg-2);
    border-bottom: 1px solid var(--line-1);
    font-size: var(--fs-sm);
    color: var(--fg-1);
  }
  .txt {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .bar {
    width: 160px;
    height: 4px;
    border-radius: 2px;
    background: var(--bg-3);
    overflow: hidden;
  }
  .fill {
    height: 100%;
    background: var(--focus);
    transition: width 120ms linear;
  }
  /* No content-length from the server, so show motion instead of a false value. */
  .fill.idle {
    animation: creep 1.4s ease-in-out infinite;
  }
  @keyframes creep {
    0%,
    100% {
      opacity: 0.35;
    }
    50% {
      opacity: 1;
    }
  }
</style>
