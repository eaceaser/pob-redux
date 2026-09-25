<script lang="ts">
  import { tooltip } from "$lib/state/tooltip.svelte";

  const GAP = 6;
  const PAD = 8;

  let el = $state<HTMLDivElement | null>(null);
  let pos = $state<{ x: number; y: number; below: boolean } | null>(null);

  $effect(() => {
    const r = tooltip.rect;
    void tooltip.text;
    if (!el || !r) {
      pos = null;
      return;
    }
    const { width: w, height: h } = el.getBoundingClientRect();
    const below = r.top - h - GAP < PAD;
    const y = below ? Math.min(r.bottom + GAP, window.innerHeight - PAD - h) : r.top - h - GAP;
    const x = Math.min(Math.max(PAD, r.left + r.width / 2 - w / 2), window.innerWidth - PAD - w);
    pos = { x, y, below };
  });
</script>

{#if tooltip.open}
  <div
    class="tip"
    class:below={pos?.below}
    role="tooltip"
    aria-hidden="true"
    bind:this={el}
    style:left="{pos?.x ?? 0}px"
    style:top="{pos?.y ?? 0}px"
    style:visibility={pos ? "visible" : "hidden"}
  >
    {tooltip.text}
  </div>
{/if}

<style>
  .tip {
    position: fixed;
    z-index: 1000;
    width: max-content;
    max-width: 320px;
    padding: 5px 9px;
    border: 1px solid var(--line-2);
    border-radius: var(--r-2);
    background: var(--bg-3);
    box-shadow: var(--shadow-pop);
    color: var(--fg-0);
    font-size: var(--fs-xs);
    line-height: 1.45;
    white-space: pre-line;
    overflow-wrap: anywhere;
    pointer-events: none;
    animation: tip-in 90ms ease-out;
  }
  .tip.below {
    animation-name: tip-in-below;
  }
  @keyframes tip-in {
    from {
      opacity: 0;
      transform: translateY(3px);
    }
  }
  @keyframes tip-in-below {
    from {
      opacity: 0;
      transform: translateY(-3px);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .tip {
      animation: none;
    }
  }
</style>
