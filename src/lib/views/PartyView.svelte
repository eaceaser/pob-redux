<script lang="ts">
  import { engine, fetchBuildCode, type PartyState, type PartyKind } from "$lib/engine.svelte";
  import { build } from "$lib/state/build.svelte";
  import PobText from "$lib/components/PobText.svelte";
  import { m } from "$lib/paraglide/messages";

  let party = $state<PartyState | null>(null);
  let importText = $state("");
  let append = $state(false);
  let only = $state("all");

  // PoB's destination dropdown: take everything, or just one kind of buff.
  const DESTINATIONS = $derived<[string, string][]>([
    ["all", m.party_dest_all()],
    ["editPartyMemberStats", m.party_dest_stats()],
    ["editAuras", m.party_dest_auras()],
    ["editCurses", m.party_dest_curses()],
    ["editWarcries", m.party_dest_warcries()],
    ["editLinks", m.party_dest_links()],
    ["enemyCond", m.party_dest_enemy_cond()],
    ["enemyMods", m.party_dest_enemy_mods()],
  ]);
  let advanced = $state(false);
  let fetching = $state(false);

  $effect(() => {
    build.rev;
    if (build.loaded) engine.getParty().then((r) => (party = r)).catch(() => (party = null));
  });

  const boxes = $derived<{ kind: PartyKind; label: string; hint: string }[]>([
    { kind: "auras", label: m.party_box_auras(), hint: m.party_box_auras_hint() },
    { kind: "curses", label: m.party_box_curses(), hint: m.party_box_curses_hint() },
    { kind: "warcries", label: m.party_box_warcries(), hint: "" },
    { kind: "links", label: m.party_box_links(), hint: "" },
    { kind: "partyMemberStats", label: m.party_box_stats(), hint: "" },
    { kind: "enemyConditions", label: m.party_box_enemy_cond(), hint: "" },
    { kind: "enemyMods", label: m.party_box_enemy_mods(), hint: "" },
  ]);

  async function doImport() {
    const text = importText.trim();
    if (!text) return;
    let code = text;
    if (/^https?:\/\//i.test(text)) {
      fetching = true;
      try {
        code = (await fetchBuildCode(text)).code;
      } catch (e) {
        build.error = String(e);
        fetching = false;
        return;
      }
      fetching = false;
    }
    const p = text.startsWith("<") ? { xml: text, append, only } : { code, append, only };
    const r = await build.run(() => engine.partyImport(p));
    if (r) importText = "";
  }
</script>

<div class="page">
  <div class="toolbar">
    <input
      class="input imp"
      placeholder={m.party_import_placeholder()}
      bind:value={importText}
      onkeydown={(e) => e.key === "Enter" && doImport()}
    />
    <button class="btn primary sm" onclick={doImport} disabled={!importText.trim() || build.busy > 0 || fetching}>
      {fetching ? m.party_fetching() : m.party_import()}
    </button>
    <label class="chk small" title={m.party_append_title()}>
      <input type="checkbox" bind:checked={append} />
      {m.party_append()}
    </label>
    <label class="fld-inline" title={m.party_take_title()}>
      <span class="label">{m.party_take()}</span>
      <select class="select sm" bind:value={only}>
        {#each DESTINATIONS as [id, label] (id)}
          <option value={id}>{label}</option>
        {/each}
      </select>
    </label>
    <span class="vr"></span>
    <button class="btn sm ghost" onclick={() => build.run(() => engine.partyClear())} disabled={build.busy > 0}>{m.common_clear()}</button>
    <button
      class="btn sm ghost"
      title={m.party_disable_title()}
      onclick={() => build.run(() => engine.partyDisable())}
      disabled={build.busy > 0}>{m.party_disable()}</button
    >
    <button class="btn sm ghost" title={m.party_rebuild_title()} onclick={() => build.run(() => engine.partyRebuild())} disabled={build.busy > 0}>{m.party_rebuild()}</button>
    <span class="vr"></span>
    <label class="chk small" title={m.party_export_title()}>
      <input type="checkbox" checked={party?.enableExportBuffs ?? false} onchange={(e) => build.run(() => engine.partySetExport((e.target as HTMLInputElement).checked))} />
      {m.party_export()}
    </label>
    <label class="chk small" title={m.party_advanced_title()}>
      <input type="checkbox" bind:checked={advanced} />
      {m.party_advanced()}
    </label>
  </div>
  <div class="scroll">
    {#if !party}
      <div class="dim small pad">{m.party_no_build()}</div>
    {:else}
      <div class="cols">
        {#each boxes as b (b.kind)}
          {@const box = party[b.kind]}
          <div class="box" class:empty={!box.text && !box.summary}>
            <div class="bhead">
              <span class="blabel">{b.label}</span>
              {#if b.hint}<span class="dim small">{b.hint}</span>{/if}
            </div>
            {#if advanced}
              <textarea
                class="bedit mono"
                rows="6"
                value={box.text}
                spellcheck="false"
                onchange={(e) => build.run(() => engine.setPartyText(b.kind, (e.target as HTMLTextAreaElement).value))}
              ></textarea>
            {:else if b.kind === "partyMemberStats" || b.kind === "enemyConditions"}
              <pre class="bsimple mono">{box.text || "—"}</pre>
            {:else if box.summary.trim()}
              <div class="bsimple"><PobText text={box.summary} /></div>
            {:else}
              <div class="bsimple dim">—</div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>
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
    gap: 10px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--line-0);
    background: var(--bg-1);
    flex-wrap: wrap;
  }
  .imp {
    flex: 1;
    min-width: 260px;
  }
  .vr {
    width: 1px;
    height: 16px;
    background: var(--line-1);
  }
  .chk {
    display: flex;
    align-items: center;
    gap: 5px;
    color: var(--fg-1);
    white-space: nowrap;
  }
  input[type="checkbox"] {
    accent-color: var(--fg-0);
  }
  .scroll {
    flex: 1;
    overflow-y: auto;
  }
  .cols {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(380px, 1fr));
    gap: 10px;
    padding: 10px 12px;
    align-items: start;
  }
  .box {
    background: var(--bg-1);
    border: 1px solid var(--line-0);
    border-radius: var(--r-2);
    display: flex;
    flex-direction: column;
  }
  .box.empty {
    opacity: 0.65;
  }
  .bhead {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 7px 10px 4px;
    border-bottom: 1px solid var(--line-0);
  }
  .blabel {
    font-size: var(--fs-xs);
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--fg-2);
  }
  .bsimple {
    padding: 8px 10px;
    font-size: var(--fs-xs);
    line-height: 1.5;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    margin: 0;
    max-height: 300px;
    overflow-y: auto;
  }
  .bedit {
    background: var(--bg-0);
    border: 0;
    border-top: 1px solid var(--line-1);
    border-radius: 0 0 var(--r-2) var(--r-2);
    color: var(--fg-0);
    font-size: var(--fs-xs);
    line-height: 1.5;
    padding: 6px 8px;
    resize: vertical;
    min-height: 90px;
  }
  .bedit:focus {
    outline: none;
  }
  .small {
    font-size: var(--fs-xs);
  }
  .pad {
    padding: 10px 12px;
    max-width: 76ch;
  }
</style>
