<script lang="ts">
  import { engine, type ItemEnchants } from "$lib/engine.svelte";
  import { build } from "$lib/state/build.svelte";

  let { itemId, onclose }: { itemId: number; onclose: () => void } = $props();

  let info = $state<ItemEnchants | null>(null);
  let skill = $state<string | null>(null);
  let source = $state<string | null>(null);
  let search = $state("");
  let slot = $state(1);

  $effect(() => {
    const sk = skill;
    const src = source;
    engine
      .itemEnchants(itemId, sk ?? undefined, src ?? undefined)
      .then((r) => {
        info = r;
        // Follow what the engine settled on, so the pickers never show a
        // skill or source that has no lines behind it.
        skill = r.skill;
        source = r.source;
      })
      .catch((e) => (build.error = String(e)));
  });

  const lines = $derived.by(() => {
    const q = search.trim().toLowerCase();
    return (info?.lines ?? []).filter((l) => !q || l.toLowerCase().includes(q));
  });

  async function apply(line: string) {
    await build.run(() => engine.setItemEnchant(itemId, { line, slot, skill: skill ?? undefined, source: source ?? undefined }).then((r) => (info = r)));
  }
  async function removeAt(i: number) {
    await build.run(() => engine.setItemEnchant(itemId, { remove: true, slot: i + 1, skill: skill ?? undefined, source: source ?? undefined }).then((r) => (info = r)));
  }
</script>

<div class="modal">
  <div class="panel dialog enchdlg">
    <div class="label">Enchant item</div>

    {#if info && !info.available}
      <p class="dim small">This item takes no enchantments.</p>
    {:else}
      <div class="filters">
        {#if info?.bySkill}
          <label class="fld-inline">
            <span class="label">Skill</span>
            <select class="select sm" value={skill ?? ""} onchange={(e) => (skill = (e.target as HTMLSelectElement).value)}>
              {#each info?.skills ?? [] as s}
                <option value={s}>{s}</option>
              {/each}
            </select>
          </label>
        {/if}
        <label class="fld-inline">
          <span class="label">Source</span>
          <select class="select sm" value={source ?? ""} onchange={(e) => (source = (e.target as HTMLSelectElement).value)}>
            {#each info?.sources ?? [] as s}
              <option value={s}>{s}</option>
            {/each}
          </select>
        </label>
        {#if (info?.slots ?? 1) > 1}
          <label class="fld-inline" title="Which enchantment slot to write">
            <span class="label">Slot</span>
            <select class="select sm" bind:value={slot}>
              {#each Array(info?.slots ?? 1) as _, i}
                <option value={i + 1}>{i + 1}</option>
              {/each}
            </select>
          </label>
        {/if}
        <input class="input grow" placeholder="Search enchantments…" bind:value={search} />
      </div>

      {#if info?.current.length}
        <div class="current">
          <span class="label">On the item</span>
          {#each info.current as c, i (c + i)}
            <span class="pill">
              {c}
              <button class="mini x" title="Remove" onclick={() => removeAt(i)}>✕</button>
            </span>
          {/each}
        </div>
      {/if}

      <div class="scroll">
        {#each lines as l (l)}
          <button class="row" onclick={() => apply(l)}>{l}</button>
        {:else}
          <div class="dim small pad">Nothing matches.</div>
        {/each}
      </div>
    {/if}

    <div class="acts">
      <button class="btn ghost" onclick={onclose}>Close</button>
    </div>
  </div>
</div>

<style>
  .modal {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    background: var(--backdrop);
    z-index: 6;
  }
  .enchdlg {
    width: 720px;
    max-height: 80vh;
    padding: 16px 18px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .filters {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
  }
  .filters .grow {
    flex: 1;
    min-width: 180px;
  }
  .current {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
  }
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 4px 2px 8px;
    font-size: var(--fs-xs);
    border: 1px solid var(--line-1);
    border-radius: var(--r-2);
    color: var(--fg-1);
  }
  .scroll {
    overflow: auto;
    height: 44vh;
    border: 1px solid var(--line-1);
    border-radius: var(--r-2);
  }
  .row {
    display: block;
    width: 100%;
    padding: 5px 10px;
    background: none;
    border: 0;
    color: var(--fg-1);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .row:hover {
    background: var(--bg-hover);
    color: var(--fg-0);
  }
  .pad {
    padding: 8px 10px;
  }
  .acts {
    display: flex;
    justify-content: flex-end;
  }
</style>
