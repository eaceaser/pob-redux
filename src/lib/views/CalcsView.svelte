<script lang="ts">
  import { untrack } from "svelte";
  import { engine, type BreakdownSection, type CalcSection } from "$lib/engine.svelte";
  import { build } from "$lib/state/build.svelte";
  import PobText from "$lib/components/PobText.svelte";
  import BreakdownPanel from "$lib/components/BreakdownPanel.svelte";

  let mode = $state<"sections" | "raw">("sections");
  let actor = $state<"player" | "minion">("player");

  // sections grid
  let sections = $state<CalcSection[]>([]);
  let bd = $state<{ sections: BreakdownSection[]; title: string } | null>(null);

  // raw browser
  let stats = $state<Record<string, number | string | boolean>>({});
  let filter = $state("");

  $effect(() => {
    build.rev;
    const a = actor;
    untrack(() => {
      engine
        .calcSections(a)
        .then((r) => (sections = r.sections))
        .catch(() => {});
      engine.getStats().then((r) => (stats = r.stats)).catch(() => {});
      bd = null;
    });
  });

  const groups = $derived.by(() => {
    const out = new Map<number, CalcSection[]>();
    for (const s of sections) {
      if (!s.enabled) continue;
      const g = s.group ?? 0;
      if (!out.has(g)) out.set(g, []);
      out.get(g)!.push(s);
    }
    return [...out.entries()].sort(([a], [b]) => a - b);
  });

  async function openCell(sec: CalcSection, sub: number, row: number, col: number, title: string) {
    try {
      const r = await engine.calcCellBreakdown({ section: sec.index, sub, row, col, actor });
      bd = { sections: r.sections, title };
    } catch {
      bd = null;
    }
  }

  const rows = $derived.by(() => {
    const q = filter.trim().toLowerCase();
    return Object.entries(stats)
      .filter(([k]) => !q || k.toLowerCase().includes(q))
      .sort(([a], [b]) => a.localeCompare(b));
  });

  function fmt(v: number | string | boolean) {
    if (typeof v === "number") {
      if (Number.isInteger(v)) return v.toLocaleString();
      return Math.abs(v) >= 1000 ? v.toLocaleString(undefined, { maximumFractionDigits: 1 }) : v.toLocaleString(undefined, { maximumFractionDigits: 4 });
    }
    return String(v);
  }
</script>

<div class="page">
  <div class="toolbar">
    <span class="tabs2">
      <button class="t2" class:on={mode === "sections"} onclick={() => (mode = "sections")}>Sections</button>
      <button class="t2" class:on={mode === "raw"} onclick={() => (mode = "raw")}>Raw output</button>
    </span>
    {#if mode === "sections"}
      <span class="vr"></span>
      <span class="tabs2">
        <button class="t2" class:on={actor === "player"} onclick={() => (actor = "player")}>Player</button>
        <button class="t2" class:on={actor === "minion"} onclick={() => (actor = "minion")}>Minion</button>
      </span>
    {:else}
      <input class="input rawfilter" placeholder="Filter output keys…" bind:value={filter} />
      <span class="dim num">{rows.length} / {Object.keys(stats).length}</span>
    {/if}
  </div>

  {#if mode === "sections"}
    <div class="body">
      <div class="colwrap" class:narrow={bd !== null}>
        {#each groups as [g, secs] (g)}
          <div class="gcol">
            {#each secs as sec (sec.index)}
              <div class="section" style:border-left-color={sec.colour ?? "var(--line-1)"}>
                {#each sec.subSections as sub (sub.index)}
                  <div class="subhead">
                    <span class="sublabel">{sub.label}</span>
                    {#if sub.extra}<span class="extra num"><PobText text={sub.extra} /></span>{/if}
                  </div>
                  <div class="rows">
                    {#each sub.rows as row (row.index)}
                      <div class="crow">
                        {#if row.label}<span class="rlabel">{row.label}</span>{/if}
                        {#each row.cells as cell (cell.index)}
                          {#if cell.text || cell.hasBreakdown}
                            <button
                              class="cell num"
                              class:link={cell.hasBreakdown}
                              disabled={!cell.hasBreakdown}
                              onclick={() => openCell(sec, sub.index, row.index, cell.index, `${sub.label} · ${row.label ?? ""}`)}
                            >
                              <PobText text={cell.text} />
                            </button>
                          {/if}
                        {/each}
                      </div>
                    {/each}
                  </div>
                {/each}
              </div>
            {/each}
          </div>
        {/each}
      </div>
      {#if bd}
        <aside class="bdside">
          <div class="bdhead">
            <span class="label">{bd.title}</span>
            <button class="btn sm ghost" onclick={() => (bd = null)}>Close</button>
          </div>
          <div class="bdscroll">
            <BreakdownPanel sections={bd.sections} />
          </div>
        </aside>
      {/if}
    </div>
  {:else}
    <div class="grid">
      {#each rows as [k, v]}
        <div class="rcell">
          <span class="k mono">{k}</span>
          <span class="v num selectable">{fmt(v)}</span>
        </div>
      {/each}
    </div>
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
    gap: 12px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--line-0);
    background: var(--bg-1);
  }
  .tabs2 {
    display: inline-flex;
    gap: 2px;
  }
  .t2 {
    appearance: none;
    border: 0;
    background: none;
    color: var(--fg-2);
    font-size: var(--fs-xs);
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    cursor: pointer;
    padding: 2px 6px;
    border-radius: 3px;
  }
  .t2.on {
    color: var(--fg-0);
    background: var(--bg-active);
  }
  .vr {
    width: 1px;
    height: 16px;
    background: var(--line-1);
  }
  .rawfilter {
    width: 280px;
  }
  .body {
    flex: 1;
    display: flex;
    min-height: 0;
  }
  .colwrap {
    flex: 1;
    min-width: 0;
    overflow: auto;
    display: flex;
    gap: 10px;
    padding: 10px;
    align-items: flex-start;
  }
  .gcol {
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 330px;
    max-width: 430px;
    flex: 1;
  }
  .section {
    background: var(--bg-1);
    border: 1px solid var(--line-0);
    border-left-width: 2px;
    border-radius: var(--r-2);
    padding-bottom: 4px;
  }
  .subhead {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 8px;
    padding: 7px 10px 4px;
    border-bottom: 1px solid var(--line-0);
  }
  .sublabel {
    font-size: var(--fs-xs);
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--fg-2);
  }
  .extra {
    font-size: var(--fs-xs);
    color: var(--fg-0);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .rows {
    padding: 4px 10px;
  }
  .crow {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 1px 0;
    font-size: var(--fs-sm);
  }
  .rlabel {
    color: var(--fg-1);
    min-width: 118px;
    font-size: var(--fs-xs);
  }
  .cell {
    appearance: none;
    border: 0;
    background: none;
    padding: 0 2px;
    color: var(--fg-0);
    font-size: var(--fs-sm);
    text-align: left;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .cell.link {
    cursor: pointer;
    border-bottom: 1px dotted var(--line-2);
  }
  .cell.link:hover {
    color: var(--focus);
    border-bottom-color: var(--focus);
  }
  .bdside {
    width: 560px;
    max-width: 45vw;
    display: flex;
    flex-direction: column;
    border-left: 1px solid var(--line-0);
    background: var(--bg-1);
  }
  .bdhead {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 12px;
    border-bottom: 1px solid var(--line-0);
  }
  .bdscroll {
    flex: 1;
    overflow-y: auto;
    padding: 10px 12px;
  }
  .grid {
    flex: 1;
    overflow-y: auto;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    align-content: start;
    gap: 0 1px;
    background: var(--line-0);
  }
  .rcell {
    display: flex;
    justify-content: space-between;
    gap: 10px;
    padding: 5px 12px;
    background: var(--bg-0);
    border-bottom: 1px solid var(--line-0);
    font-size: var(--fs-sm);
  }
  .k {
    color: var(--fg-2);
    font-size: var(--fs-xs);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .v {
    color: var(--fg-0);
    white-space: nowrap;
  }
</style>
