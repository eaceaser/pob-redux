<script lang="ts">
  import type { TooltipLine } from "$lib/engine.svelte";
  import PobText from "./PobText.svelte";

  let { lines, x, y, width = 540 }: { lines: TooltipLine[]; x: number; y: number; width?: number } = $props();

  function style(l: TooltipLine): string {
    if (l.size >= 20) return "font-size:13px;font-weight:600";
    if (l.size >= 16) return "font-size:12px";
    return "font-size:11px";
  }
</script>

<div class="ptt" style:left={`${x}px`} style:top={`${y}px`} style:width={`${width}px`}>
  {#each lines as l}
    {#if l.sep}
      <div class="sep"></div>
    {:else}
      <div class="line" class:center={l.center} style={style(l)}><PobText text={l.text} /></div>
    {/if}
  {/each}
</div>

<style>
  .ptt {
    position: fixed;
    max-height: 70vh;
    overflow: hidden;
    padding: 10px 14px;
    background: color-mix(in srgb, var(--bg-1) 96%, transparent);
    border: 1px solid var(--line-1);
    border-radius: var(--r-2);
    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.55);
    pointer-events: none;
    backdrop-filter: blur(8px);
    z-index: 10;
    line-height: 1.45;
  }
  .line {
    color: var(--fg-1);
    white-space: pre-wrap;
  }
  .center {
    text-align: center;
  }
  .sep {
    height: 1px;
    background: var(--line-1);
    margin: 6px 0;
  }
</style>
