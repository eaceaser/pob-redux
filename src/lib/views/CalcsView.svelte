<script lang="ts">
  import { untrack } from "svelte";
  import { engine, type BreakdownSection, type CalcSection } from "$lib/engine.svelte";
  import { build } from "$lib/state/build.svelte";
  import PobText from "$lib/components/PobText.svelte";
  import { stripPobText } from "$lib/pobtext";
  import BreakdownPanel from "$lib/components/BreakdownPanel.svelte";

  let mode = $state<"sections" | "raw">("sections");
  let actor = $state<"player" | "minion">("player");

  // Which buffs these numbers assume. PoB keeps the sidebar on EFFECTIVE whatever this says.
  let calcMode = $state("EFFECTIVE");
  let calcModes = $state<string[]>(["UNBUFFED", "BUFFED", "COMBAT", "EFFECTIVE"]);
  const BUFF_LABELS: Record<string, string> = { UNBUFFED: "Unbuffed", BUFFED: "Buffed", COMBAT: "In combat", EFFECTIVE: "Effective DPS" };
  const BUFF_HELP =
    "What these numbers assume. Unbuffed is standing in town. Buffed adds your auras. In combat adds charges. Effective DPS adds the enemy. The sidebar always shows Effective DPS.";

  $effect(() => {
    build.rev;
    engine
      .calcMode()
      .then((r) => {
        calcMode = r.mode;
        calcModes = r.modes;
      })
      .catch(() => {});
  });

  function setCalcMode(next: string) {
    calcMode = next;
    build.run(() => engine.calcMode(next));
  }

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
      <span class="vr"></span>
      <label class="fld-inline" title={BUFF_HELP}>
        <span class="label">Assuming</span>
        <select class="select sm" value={calcMode} disabled={build.busy > 0} onchange={(e) => setCalcMode((e.target as HTMLSelectElement).value)}>
          {#each calcModes as m}
            <option value={m}>{BUFF_LABELS[m] ?? m}</option>
          {/each}
        </select>
      </label>
    {:else}
      <input class="input rawfilter" placeholder="Filter output keys…" bind:value={filter} />
      <span class="dim num">{rows.length} / {Object.keys(stats).length}</span>
    {/if}
  </div>

  {#if mode === "sections"}
    <div class="body">
      <div class="cards">
        {#each groups as [g, secs] (g)}
          {#each secs as sec (sec.index)}
            {@const table = sec.subSections.some((s) => s.rows.some((r) => r.cells.length >= 4))}
            <div class="section" class:table style:--accent={sec.colour ?? "var(--line-2)"}>
              {#each sec.subSections as sub (sub.index)}
                {@const cols = Math.max(1, ...sub.rows.map((r) => r.cells.length))}
                <div class="subhead">
                  <span class="sublabel"><PobText text={sub.label} /></span>
                  {#if sub.extra}<span class="extra num"><PobText text={sub.extra} /></span>{/if}
                </div>
                <div class="rows" class:wide={cols > 1} style:--cols={cols} style:--colw={`${Math.round((sub.colWidth ?? 95) * 0.72)}px`}>
                  {#each sub.rows as row, ri (row.index)}
                    <div class="crow" class:small={row.textSize != null && row.textSize < 16} class:head={ri === 0 && !row.label && row.cells.length > 1}>
                      <span class="rlabel">{#if row.label}<PobText text={row.label} />{/if}</span>
                      {#each row.cells as cell, i (cell.index)}
                        {@const span = cols > 1 && i === row.cells.length - 1 && row.cells.length < cols}
                        <button
                          class="cell num"
                          class:link={cell.hasBreakdown}
                          class:span
                          disabled={!cell.hasBreakdown}
                          style:grid-column={span ? `${i + 2} / -1` : null}
                          onclick={() => openCell(sec, sub.index, row.index, cell.index, stripPobText(`${sub.label} · ${row.label ?? ""}`))}
                        >
                          <span class="ct">{#if cell.text}<PobText text={cell.text} />{/if}</span>
                        </button>
                      {/each}
                    </div>
                  {/each}
                </div>
              {/each}
            </div>
          {/each}
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
  .cards {
    flex: 1;
    min-width: 0;
    overflow: auto;
    container-type: inline-size;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
    grid-auto-flow: dense;
    align-content: start;
    align-items: start;
    gap: 14px;
    padding: 14px;
  }
  .section {
    min-width: 0;
    background: var(--bg-1);
    border: 1px solid var(--line-0);
    border-left: 2px solid var(--accent);
    border-radius: var(--r-2);
    overflow: clip;
  }
  .section.table {
    grid-column: span 2;
  }
  @container (width < 720px) {
    .section.table {
      grid-column: auto;
    }
  }
  .subhead {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 8px;
    padding: 8px 12px 4px;
    margin-top: 6px;
    border-top: 1px solid var(--line-0);
  }
  /* The card's own title: a band tinted with PoB's section colour, so the eye finds section starts. */
  .subhead:first-child {
    margin-top: 0;
    padding: 9px 12px 8px;
    border-top: 0;
    border-bottom: 1px solid var(--line-0);
    background: color-mix(in srgb, var(--accent) 14%, var(--bg-1));
  }
  .sublabel {
    font-size: var(--fs-xs);
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--fg-2);
  }
  .subhead:first-child .sublabel {
    font-size: var(--fs-sm);
    color: var(--fg-0);
  }
  .extra {
    font-size: var(--fs-xs);
    color: var(--fg-0);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* One grid per subsection, so a table's columns line up across its rows as PoB draws them. */
  .rows {
    display: grid;
    grid-template-columns: minmax(130px, max-content) minmax(0, 1fr);
    column-gap: 8px;
    align-items: baseline;
    padding: 6px 12px 8px;
    font-size: var(--fs-sm);
    line-height: 1.5;
  }
  .rows.wide {
    grid-template-columns: minmax(130px, max-content) repeat(var(--cols), minmax(auto, max-content));
    column-gap: 0;
  }
  .crow {
    display: contents;
  }
  .crow.small {
    font-size: var(--fs-xs);
  }
  .crow.head > * {
    color: var(--fg-2);
    font-size: var(--fs-xs);
    padding-bottom: 4px;
    border-bottom: 1px solid var(--line-0);
  }
  .wide .crow:nth-child(even) > * {
    background: var(--bg-2);
  }
  .rlabel {
    grid-column: 1;
    padding: 2px 0;
    color: var(--fg-2);
  }
  .wide .rlabel {
    padding: 2px 8px 2px 6px;
  }
  .cell {
    appearance: none;
    border: 0;
    background: none;
    padding: 2px 4px;
    color: var(--fg-0);
    font-size: inherit;
    line-height: inherit;
    text-align: left;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .wide .cell {
    padding: 2px 10px 2px 8px;
    text-align: right;
    overflow: visible;
  }
  .wide .cell.span {
    text-align: left;
  }
  /* The floor sits inside the button: a min-width on the button itself would replace the
     automatic minimum, and the track would stop seeing the text width. */
  .wide .ct {
    display: inline-block;
    min-width: var(--colw);
  }
  .cell.link {
    cursor: pointer;
    border-radius: 3px;
  }
  .cell.link:hover {
    color: var(--focus);
    background: var(--bg-hover);
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
