<script lang="ts">
  import { engine, fetchBuildCode, type PartyState, type PartyKind } from "$lib/engine.svelte";
  import { build } from "$lib/state/build.svelte";
  import PobText from "$lib/components/PobText.svelte";

  let party = $state<PartyState | null>(null);
  let importText = $state("");
  let append = $state(false);
  let advanced = $state(false);
  let fetching = $state(false);

  $effect(() => {
    build.rev;
    if (build.loaded) engine.getParty().then((r) => (party = r)).catch(() => (party = null));
  });

  const boxes: { kind: PartyKind; label: string; hint: string }[] = [
    { kind: "auras", label: "Auras", hint: "Auras with the highest effect take priority" },
    { kind: "curses", label: "Curses", hint: "Your own curses take priority over a support's" },
    { kind: "warcries", label: "Warcry Skills", hint: "" },
    { kind: "links", label: "Link Skills", hint: "" },
    { kind: "partyMemberStats", label: "Party Member Stats", hint: "" },
    { kind: "enemyConditions", label: "Enemy Conditions", hint: "" },
    { kind: "enemyMods", label: "Enemy Modifiers", hint: "" },
  ];

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
    const p = text.startsWith("<") ? { xml: text, append } : { code, append };
    const r = await build.run(() => engine.partyImport(p));
    if (r) importText = "";
  }
</script>

<div class="page">
  <div class="toolbar">
    <input
      class="input imp"
      placeholder="Support build's share code or link (exported with 'Export support' enabled)"
      bind:value={importText}
      onkeydown={(e) => e.key === "Enter" && doImport()}
    />
    <button class="btn primary sm" onclick={doImport} disabled={!importText.trim() || build.busy > 0 || fetching}>
      {fetching ? "Fetching…" : "Import"}
    </button>
    <label class="chk small" title="Append to the current party lists instead of replacing them (curses still replace)">
      <input type="checkbox" bind:checked={append} />
      Append
    </label>
    <span class="vr"></span>
    <button class="btn sm ghost" onclick={() => build.run(() => engine.partyClear())} disabled={build.busy > 0}>Clear</button>
    <button class="btn sm ghost" title="Reparse all boxes after manual edits" onclick={() => build.run(() => engine.partyRebuild())} disabled={build.busy > 0}>Rebuild all</button>
    <span class="vr"></span>
    <label class="chk small" title="Include this build's own auras/curses/buffs when exporting its share code, so a party member can import them here">
      <input type="checkbox" checked={party?.enableExportBuffs ?? false} onchange={(e) => build.run(() => engine.partySetExport((e.target as HTMLInputElement).checked))} />
      Export support with share code
    </label>
    <label class="chk small" title="Show and edit the raw parsed buffers">
      <input type="checkbox" bind:checked={advanced} />
      Advanced
    </label>
  </div>
  <div class="scroll">
    {#if !party}
      <div class="dim small pad">Load a build first.</div>
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
      <p class="dim small pad">
        Import a party member's build to model their auras, curses, warcries and link skills on this build. The support build must be
        exported with "Export support with share code" enabled. Effects land in the Calcs tab like any other modifier.
      </p>
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
