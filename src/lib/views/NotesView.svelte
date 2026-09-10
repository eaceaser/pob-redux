<script lang="ts">
  import { engine } from "$lib/engine.svelte";
  import { build } from "$lib/state/build.svelte";

  let text = $state("");
  let loadedFor = -1;
  let timer = 0;

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
  <textarea class="notes selectable" bind:value={text} oninput={onInput} placeholder="Notes are saved with the build."></textarea>
</div>

<style>
  .page {
    flex: 1;
    display: flex;
    min-height: 0;
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
