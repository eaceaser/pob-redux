<script lang="ts">
  import { engine } from "$lib/engine.svelte";
  import { build } from "$lib/state/build.svelte";
  import PobText from "$lib/components/PobText.svelte";

  let text = $state("");
  let loadedFor = -1;
  let timer = 0;
  let area = $state<HTMLTextAreaElement | null>(null);
  let preview = $state(false);

  // PoB's own notes palette, from Data/Global.lua.
  const COLOURS: [string, string][] = [
    ["NORMAL", "^xC8C8C8"],
    ["MAGIC", "^x8888FF"],
    ["RARE", "^xFFFF77"],
    ["UNIQUE", "^xAF6025"],
    ["FIRE", "^xB97123"],
    ["COLD", "^x3F6DB3"],
    ["LIGHTNING", "^xADAA47"],
    ["CHAOS", "^xD02090"],
    ["STRENGTH", "^xE05030"],
    ["DEXTERITY", "^x70FF70"],
    ["INTELLIGENCE", "^x7070FF"],
    ["DEFAULT", "^7"],
  ];

  /** Drop a colour code at the cursor, the way PoB's buttons do. */
  function insert(code: string) {
    const el = area;
    if (!el) return;
    const at = el.selectionStart ?? text.length;
    const to = el.selectionEnd ?? at;
    text = text.slice(0, at) + code + text.slice(to);
    onInput();
    queueMicrotask(() => {
      el.focus();
      el.selectionStart = el.selectionEnd = at + code.length;
    });
  }

  $effect(() => {
    const key = build.info ? build.info.name + build.info.file : null;
    if (key === null) return;
    // The engine restarts rev on load, so a drop means another build was opened.
    const rev = build.rev;
    if (loadedFor === -1 || rev < loadedFor) {
      engine.getNotes().then((r) => (text = r.text));
    }
    loadedFor = rev;
  });

  function onInput() {
    clearTimeout(timer);
    timer = window.setTimeout(() => build.run(() => engine.setNotes(text), { sync: false }), 400);
  }
</script>

<div class="page">
  <div class="toolbar">
    {#each COLOURS as [name, code] (name)}
      <button class="swatch" disabled={preview} title={`Insert ${name} (${code})`} onclick={() => insert(code)}>
        <PobText text={code + name} />
      </button>
    {/each}
    <span class="vr"></span>
    <button class="btn sm ghost" class:on={preview} aria-pressed={preview} title="Show the notes with the colour codes applied" onclick={() => (preview = !preview)}>Preview</button>
  </div>
  {#if preview}
    <div class="notes preview selectable"><PobText text={text} /></div>
  {:else}
    <textarea class="notes selectable" bind:this={area} bind:value={text} oninput={onInput} placeholder="Notes are saved with the build."></textarea>
  {/if}
</div>

<style>
  .page {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .toolbar {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 4px;
    padding: 6px 10px;
    border-bottom: 1px solid var(--line-0);
    background: var(--bg-1);
  }
  .swatch {
    appearance: none;
    background: none;
    border: 1px solid var(--line-1);
    border-radius: var(--r-2);
    padding: 2px 7px;
    font-size: var(--fs-xs);
    letter-spacing: 0.04em;
    cursor: pointer;
  }
  .swatch:hover:not(:disabled) {
    border-color: var(--line-2);
    background: var(--bg-hover);
  }
  .swatch:disabled {
    opacity: var(--fade-off);
    cursor: default;
  }
  .preview {
    overflow: auto;
    white-space: pre-wrap;
  }
  .notes {
    flex: 1;
    border: 0;
    outline: none;
    resize: none;
    background: var(--bg-0);
    color: var(--fg-0);
    padding: 16px 20px;
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    line-height: 1.55;
  }
</style>
