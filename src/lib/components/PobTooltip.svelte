<script lang="ts">
  import type { TooltipHeader, TooltipLine } from "$lib/engine.svelte";
  import ItemFrame from "./ItemFrame.svelte";
  import PobText from "./PobText.svelte";

  let {
    lines,
    header = null,
    runic = false,
    uniqueGem = false,
    x,
    y,
    width = 540,
  }: { lines: TooltipLine[]; header?: TooltipHeader; runic?: boolean; uniqueGem?: boolean; x: number; y: number; width?: number } = $props();

  // Placed at the pointer, then slid up and left as far as needed to stay on
  // screen once its size is known.
  let el = $state<HTMLDivElement | null>(null);
  let left = $state(0);
  let top = $state(0);
  $effect(() => {
    lines;
    const h = el?.offsetHeight ?? 0;
    const w = el?.offsetWidth ?? 0;
    top = Math.max(8, Math.min(y, window.innerHeight - h - 8));
    left = Math.max(8, Math.min(x, window.innerWidth - w - 8));
  });

  function style(l: TooltipLine): string {
    if (l.size >= 20) return "font-size:13px;font-weight:600";
    if (l.size >= 16) return "font-size:12px";
    return "font-size:11px";
  }
</script>

{#if header}
  <div class="game" bind:this={el} style:left={`${left}px`} style:top={`${top}px`} style:max-width={`${width}px`}>
    <ItemFrame {lines} {header} {runic} {uniqueGem} />
  </div>
{:else}
  <div class="ptt" bind:this={el} style:left={`${left}px`} style:top={`${top}px`} style:width={`${width}px`}>
    {#each lines as l}
      {#if l.sep}
        <div class="sep"></div>
      {:else}
        <div class="line" class:center={l.center} style={style(l)}><PobText text={l.text} /></div>
      {/if}
    {/each}
  </div>
{/if}

<style>
  .ptt,
  .game {
    position: fixed;
    max-height: calc(100vh - 16px);
    overflow: hidden;
    pointer-events: none;
    box-shadow: var(--shadow-pop);
    z-index: 10;
  }
  .game {
    width: max-content;
  }
  .ptt {
    padding: 10px 14px;
    background: color-mix(in srgb, var(--bg-1) 96%, transparent);
    border: 1px solid var(--line-1);
    border-radius: var(--r-2);
    backdrop-filter: blur(8px);
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
