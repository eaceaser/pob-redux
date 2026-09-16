<script lang="ts">
  import { engine, type MinionLibrary, type MinionEntry } from "$lib/engine.svelte";
  import { build } from "$lib/state/build.svelte";

  let { onclose }: { onclose: () => void } = $props();

  let kind = $state<"spectre" | "beast">("spectre");
  let lib = $state<MinionLibrary | null>(null);
  /** Edited here and only written back on Save, as PoB's popup does. */
  let owned = $state<MinionEntry[]>([]);
  let search = $state("");
  let category = $state("");
  let recommendedOnly = $state(false);
  let saving = $state(false);

  $effect(() => {
    const k = kind;
    engine
      .minionLibrary(k)
      .then((r) => {
        lib = r;
        owned = [...r.owned];
      })
      .catch((e) => (build.error = String(e)));
  });

  const ownedIds = $derived(new Set(owned.map((m) => m.id)));
  const shown = $derived.by(() => {
    const q = search.trim().toLowerCase();
    return (lib?.available ?? []).filter(
      (m) =>
        !ownedIds.has(m.id) &&
        (!q || m.name.toLowerCase().includes(q)) &&
        (!category || m.category === category) &&
        (!recommendedOnly || m.recommended),
    );
  });

  function add(m: MinionEntry) {
    if (!ownedIds.has(m.id)) owned = [...owned, m];
  }
  function remove(id: string) {
    owned = owned.filter((m) => m.id !== id);
  }

  async function save() {
    saving = true;
    try {
      await build.run(() => engine.setMinionLibrary(kind, owned.map((m) => m.id)));
      onclose();
    } catch (e) {
      build.error = String(e);
    } finally {
      saving = false;
    }
  }
</script>

<div class="modal">
  <div class="panel dialog libdlg">
    <div class="head">
      <span class="label">{kind === "beast" ? "Beast library" : "Spectre library"}</span>
      {#if lib?.hasBeasts}
        <span class="seg">
          <button class:on={kind === "spectre"} onclick={() => (kind = "spectre")}>Spectres</button>
          <button class:on={kind === "beast"} onclick={() => (kind = "beast")}>Beasts</button>
        </span>
      {/if}
    </div>

    <div class="filters">
      <input class="input grow" placeholder="Search by name…" bind:value={search} />
      {#if (lib?.categories.length ?? 0) > 0}
        <select class="select sm" bind:value={category}>
          <option value="">All types</option>
          {#each lib?.categories ?? [] as c}
            <option value={c}>{c}</option>
          {/each}
        </select>
      {/if}
      <label class="chk small" title="Only the ones PoB marks as worth using">
        <input type="checkbox" bind:checked={recommendedOnly} />
        Recommended
      </label>
    </div>

    <div class="cols">
      <section class="side">
        <div class="shead">Available <span class="dim num">{shown.length}</span></div>
        <div class="scroll">
          {#each shown as m (m.id)}
            <button class="row" onclick={() => add(m)} title={m.id}>
              <span class="nm">{m.name}</span>
              {#if m.recommended}<span class="tag">★</span>{/if}
              {#if m.category}<span class="dim small">{m.category}</span>{/if}
            </button>
          {:else}
            <div class="dim small pad">Nothing matches.</div>
          {/each}
        </div>
      </section>
      <section class="side">
        <div class="shead">In your library <span class="dim num">{owned.length}</span></div>
        <div class="scroll">
          {#each owned as m (m.id)}
            <button class="row own" onclick={() => remove(m.id)} title="Remove from the library">
              <span class="nm">{m.name}</span>
              <span class="x">✕</span>
            </button>
          {:else}
            <div class="dim small pad">Empty. Pick from the left.</div>
          {/each}
        </div>
      </section>
    </div>

    <p class="note dim small">
      A {kind === "beast" ? "beast" : "spectre"} in the library does nothing until a
      {kind === "beast" ? "Companion" : "Raise Spectre"} gem in the build is set to it.
    </p>

    <div class="acts">
      <button class="btn primary" disabled={saving || build.busy > 0} onclick={save}>Save</button>
      <button class="btn ghost" onclick={onclose}>Cancel</button>
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
  .libdlg {
    width: 760px;
    max-height: 80vh;
    padding: 16px 18px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }
  .seg {
    display: inline-flex;
    border: 1px solid var(--line-1);
    border-radius: var(--r-2);
    overflow: hidden;
  }
  .seg button {
    padding: 3px 10px;
    font-size: var(--fs-xs);
    color: var(--fg-2);
    background: transparent;
    border: 0;
    cursor: pointer;
  }
  .seg button.on {
    background: var(--bg-active);
    color: var(--fg-0);
  }
  .filters {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .filters .grow {
    flex: 1;
  }
  .cols {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
    min-height: 0;
  }
  .side {
    display: flex;
    flex-direction: column;
    min-height: 0;
    border: 1px solid var(--line-1);
    border-radius: var(--r-2);
  }
  .shead {
    padding: 6px 10px;
    font-size: var(--fs-xs);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--fg-2);
    border-bottom: 1px solid var(--line-0);
  }
  .scroll {
    overflow: auto;
    height: 46vh;
  }
  .row {
    display: flex;
    align-items: baseline;
    gap: 8px;
    width: 100%;
    padding: 4px 10px;
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
  .nm {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tag {
    color: var(--c-spirit);
  }
  .own .x {
    color: var(--fg-3);
  }
  .own:hover .x {
    color: var(--bad);
  }
  .pad {
    padding: 8px 10px;
  }
  .note {
    margin: 0;
  }
  .acts {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
</style>
