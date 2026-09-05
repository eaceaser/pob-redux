<script lang="ts">
  import {
    engine,
    powerScanParallel,
    type PowerReportRow,
    type BuildSummary,
    type GearOptParams,
    type GearOptProgress,
    type GearOptResult,
    type GearProposal,
    type SanityCheck,
    type SlotInfo,
  } from "$lib/engine.svelte";
  import { build } from "$lib/state/build.svelte";
  import { stripPobText } from "$lib/pobtext";

  // Review: PoB's numbers plus the rule-based findings, refreshed with the build.
  let summary = $state<BuildSummary | null>(null);
  let sanity = $state<SanityCheck | null>(null);
  let slots = $state<SlotInfo[]>([]);
  let loadedRev = -1;

  $effect(() => {
    const rev = build.rev;
    if (!build.loaded || rev === loadedRev) return;
    loadedRev = rev;
    Promise.all([engine.buildSummary(), engine.sanityCheck(), engine.listSlots()])
      .then(([s, c, l]) => {
        summary = s;
        sanity = c;
        slots = l.slots.filter((x) => x.shown !== false && !x.inactive);
      })
      .catch(() => {});
  });

  // Gear optimiser
  const OPT_SLOTS = ["Weapon 1", "Weapon 2", "Helmet", "Body Armour", "Gloves", "Boots", "Belt", "Amulet", "Ring 1", "Ring 2"];
  let preset = $state<"balanced" | "defence" | "damage">("balanced");
  let itemLevel = $state(82);
  // Mods need an item level the character could have found, so the default
  // follows the level until the user types one.
  let itemLevelTouched = $state(false);
  $effect(() => {
    const lvl = summary?.characterLevel;
    if (lvl && !itemLevelTouched) itemLevel = Math.min(82, lvl);
  });
  let range = $state(1);
  let chosen = $state<Set<string>>(new Set());
  let running = $state(false);
  let progress = $state<GearOptProgress | null>(null);
  let result = $state<GearOptResult | null>(null);
  let error = $state<string | null>(null);
  let applied = $state<Set<string>>(new Set());
  let cancel = false;

  const equipped = $derived(
    slots.filter((s) => OPT_SLOTS.includes(s.slot) && s.itemId > 0).map((s) => ({ slot: s.slot, name: s.itemName, unique: s.itemRarity === "UNIQUE" })),
  );

  $effect(() => {
    // Default to every equipped rare slot; keep the user's picks across refreshes.
    const list = equipped;
    if (chosen.size === 0 && list.length) chosen = new Set(list.filter((e) => !e.unique).map((e) => e.slot));
  });

  function toggleSlot(slot: string) {
    const next = new Set(chosen);
    if (next.has(slot)) next.delete(slot);
    else next.add(slot);
    chosen = next;
  }

  async function run() {
    if (running || !build.loaded) return;
    running = true;
    cancel = false;
    error = null;
    result = null;
    applied = new Set();
    const params: GearOptParams = { preset, itemLevel, range, slots: [...chosen] };
    try {
      let r = await engine.gearOptStart(params);
      progress = r.progress;
      while (!r.done && !cancel) {
        r = await engine.gearOptStep(120);
        progress = r.progress;
        await new Promise((res) => setTimeout(res, 0));
      }
      if (!cancel) {
        result = await engine.gearOptResult();
        await build.sync();
      }
    } catch (e) {
      error = String(e);
    } finally {
      running = false;
      progress = null;
    }
  }

  async function apply(p: GearProposal) {
    const ok = await build.run(() => engine.equipItemRaw(p.raw, p.slot));
    if (ok) applied = new Set([...applied, p.slot]);
  }

  async function applyAll() {
    if (!result) return;
    for (const p of result.proposals) {
      if (!applied.has(p.slot)) await apply(p);
    }
  }

  const HEADLINE: { key: string; label: string; pct?: boolean }[] = [
    { key: "Life", label: "Life" },
    { key: "TotalEHP", label: "Effective HP" },
    { key: "Armour", label: "Armour" },
    { key: "CombinedDPS", label: "DPS" },
    { key: "FireResist", label: "Fire res", pct: true },
    { key: "ColdResist", label: "Cold res", pct: true },
    { key: "LightningResist", label: "Lightning res", pct: true },
    { key: "ChaosResist", label: "Chaos res", pct: true },
    { key: "Str", label: "Strength" },
    { key: "Dex", label: "Dexterity" },
    { key: "Int", label: "Intelligence" },
  ];

  const fmt = (v: number | undefined, pct = false) =>
    v == null ? "" : pct ? `${Math.round(v)}%` : Math.round(v).toLocaleString();
  const fmtDelta = (v: number | undefined, pct = false) => {
    if (v == null || Math.abs(v) < 0.5) return "";
    const n = Math.round(v);
    return (n > 0 ? "+" : "") + (pct ? `${n}%` : n.toLocaleString());
  };
  const deltaClass = (v: number | undefined) => (v == null || Math.abs(v) < 0.5 ? "" : v > 0 ? "up" : "down");

  const DELTA_KEYS: { key: string; label: string; pct?: boolean }[] = [
    { key: "Life", label: "life" },
    { key: "TotalEHP", label: "EHP" },
    { key: "CombinedDPS", label: "DPS" },
    { key: "Armour", label: "armour" },
    { key: "FireResist", label: "fire", pct: true },
    { key: "ColdResist", label: "cold", pct: true },
    { key: "LightningResist", label: "lightning", pct: true },
    { key: "ChaosResist", label: "chaos", pct: true },
    { key: "Str", label: "str" },
    { key: "Dex", label: "dex" },
    { key: "Int", label: "int" },
  ];

  const sevClass: Record<string, string> = { high: "bad", medium: "warn", low: "low" };

  /** An implicit as a shopping-list line: the roll range dropped, one line only. */
  const plainImplicit = (s: string) =>
    s
      .split("\n")[0]
      .replace(/\{[^}]*\}/g, "")
      .replace(/\(?[\d.]+-[\d.]+\)?%?/g, "")
      .replace(/\s+/g, " ")
      .trim();

  // Tree: node power for one stat, the best unallocated per point and the
  // weakest allocated, straight from the scan the tree tab already runs.
  const TREE_STATS: [string, string][] = [
    ["Life", "Life"],
    ["TotalEHP", "EHP"],
    ["CombinedDPS", "DPS"],
    ["Armour", "Armour"],
    ["EffectiveMovementSpeedMod", "Speed"],
  ];
  let treeStat = $state("Life");
  let notablesOnly = $state(true);
  let treeRunning = $state(false);
  let treeRows = $state<{ best: PowerReportRow[]; weakest: PowerReportRow[]; stat: string; ms: number } | null>(null);
  let treeError = $state<string | null>(null);

  async function scanTree() {
    if (treeRunning || !build.loaded) return;
    treeRunning = true;
    treeError = null;
    try {
      const { result } = await powerScanParallel(treeStat, null);
      const best = result.report
        .filter((r) => !r.allocated && r.pathPower > 0 && (r.pathDist ?? 99) <= 8 && r.type !== "Mastery" && (!notablesOnly || r.type !== "Normal"))
        .sort((a, b) => b.pathPower - a.pathPower)
        .slice(0, 12);
      const weakest = result.report
        .filter((r) => r.allocated && r.type !== "ClassStart")
        .sort((a, b) => b.power - a.power)
        .slice(0, 8);
      treeRows = { best, weakest, stat: result.label, ms: result.ms };
      treeStale = false;
    } catch (e) {
      treeError = String(e);
    } finally {
      treeRunning = false;
    }
  }

  // A change leaves the list in place but stale; a rescan costs seconds.
  let treeStale = $state(false);
  async function allocate(id: number) {
    await build.allocNode(id);
    treeStale = true;
  }
  async function remove(id: number) {
    await build.deallocNode(id);
    treeStale = true;
  }
  const fmtGain = (v: number) => (Math.abs(v) >= 100 ? Math.round(v).toLocaleString() : (Math.round(v * 10) / 10).toString());
</script>

<div class="page">
  <section class="col review">
    <div class="head">
      <span class="title">Review</span>
      {#if sanity}
        <span class="dim small">
          <span class="mono">{sanity.high}</span> high · <span class="mono">{sanity.medium}</span> medium · <span class="mono">{sanity.low}</span> low
        </span>
      {/if}
    </div>
    {#if !build.loaded}
      <div class="dim small pad">Open a build to review it.</div>
    {:else if summary}
      <div class="facts">
        <div class="fact"><span class="k">Buttons</span><span class="v mono">{summary.activeSkills}</span><span class="n dim">skills that need a keypress</span></div>
        <div class="fact"><span class="k">Automatic</span><span class="v mono">{summary.persistentSkills + summary.triggerSkills + summary.metaSkills}</span><span class="n dim">persistent, trigger and meta gems</span></div>
        <div class="fact"><span class="k">Points</span><span class="v mono">{summary.mainTreePointsUsed}<span class="dim"> / {summary.pointsAvailableMin === summary.pointsAvailableMax ? summary.pointsAvailableMax : `${summary.pointsAvailableMin}–${summary.pointsAvailableMax}`}</span></span><span class="n dim">main tree, budget at level {summary.characterLevel}</span></div>
        <div class="fact"><span class="k">Spirit</span><span class="v mono">{summary.spiritReserved}<span class="dim"> / {summary.spirit}</span></span><span class="n dim">reserved</span></div>
        <div class="fact"><span class="k">Charms</span><span class="v mono">{summary.charmsEquipped}<span class="dim"> / {summary.charmLimit}</span></span><span class="n dim">equipped, slots from the belt</span></div>
        <div class="fact"><span class="k">Resists</span><span class="v mono"><span class:bad={summary.fireResist < 75}>{Math.round(summary.fireResist)}</span> / <span class:bad={summary.coldResist < 75}>{Math.round(summary.coldResist)}</span> / <span class:bad={summary.lightningResist < 75}>{Math.round(summary.lightningResist)}</span> / {Math.round(summary.chaosResist)}</span><span class="n dim">fire, cold, lightning, chaos</span></div>
      </div>
      <div class="findings">
        {#if sanity && sanity.findings.length === 0}
          <div class="dim small pad">No findings. This checks numbers only; it cannot see how skills interact in play.</div>
        {/if}
        {#each sanity?.findings ?? [] as f}
          <div class="finding">
            <span class="sev {sevClass[f.severity]}"></span>
            <div class="ftext">
              <div><span class="area">{f.area}</span> {stripPobText(f.message)}</div>
              {#if f.fix}<div class="dim small">{f.fix}</div>{/if}
            </div>
          </div>
        {/each}
      </div>
      <div class="dim small pad">Numbers only. A finding cannot see how skills interact in play; the assistant can read the gems for that.</div>
    {/if}
  </section>

  <section class="col gear">
    <div class="head">
      <span class="title">Gear</span>
      <span class="dim small">Rares built from PoB's affix tables, scored by PoB's calculation</span>
    </div>
    <div class="controls">
      <div class="ctl">
        <span class="label">Aim</span>
        <div class="seg" role="radiogroup">
          {#each [["balanced", "Balanced"], ["defence", "Defence"], ["damage", "Damage"]] as [id, label]}
            <button class:on={preset === id} onclick={() => (preset = id as typeof preset)} disabled={running}>{label}</button>
          {/each}
        </div>
      </div>
      <div class="ctl">
        <span class="label">Item level</span>
        <input class="input mono ilvl" type="number" min="1" max="100" bind:value={itemLevel} oninput={() => (itemLevelTouched = true)} disabled={running} />
      </div>
      <div class="ctl">
        <span class="label">Rolls</span>
        <div class="seg" role="radiogroup">
          {#each [[1, "Perfect"], [0.8, "Good"], [0.5, "Average"]] as [v, label]}
            <button class:on={range === v} onclick={() => (range = v as number)} disabled={running}>{label}</button>
          {/each}
        </div>
      </div>
      <div class="ctl slots">
        <span class="label">Slots</span>
        <div class="chips">
          {#each equipped as e (e.slot)}
            <button class="chip" class:on={chosen.has(e.slot)} disabled={running} title={e.name ?? ""} onclick={() => toggleSlot(e.slot)}>
              {e.slot}{#if e.unique}<span class="dim"> unique</span>{/if}
            </button>
          {/each}
          {#if equipped.length === 0}<span class="dim small">No gear equipped.</span>{/if}
        </div>
      </div>
      <div class="ctl run">
        {#if running}
          <button class="btn sm" onclick={() => (cancel = true)}>Stop</button>
          <span class="prog">
            <span class="bar"><span class="fill" style:width={progress && progress.total ? `${(100 * progress.done) / progress.total}%` : "0%"}></span></span>
            <span class="dim small">{progress?.note ?? "starting"}</span>
          </span>
        {:else}
          <button class="btn sm primary" onclick={run} disabled={!build.loaded || chosen.size === 0}>Optimise {chosen.size} slot{chosen.size === 1 ? "" : "s"}</button>
          <span class="dim small">Resistances stay at 75, requirements stay met, movement speed is kept. Nothing changes until you apply.</span>
        {/if}
      </div>
      {#if error}<div class="err small">{error}</div>{/if}
    </div>

    {#if result}
      <div class="results">
        <div class="ghead">
          <span>Result</span>
          <span class="dim">{result.proposals.length} item{result.proposals.length === 1 ? "" : "s"} · {Math.round(result.ms / 100) / 10}s</span>
          <button class="btn sm primary" onclick={applyAll} disabled={build.busy > 0 || result.proposals.every((p) => applied.has(p.slot))}>Apply all</button>
        </div>
        <table class="before">
          <thead><tr><th></th><th class="num">Now</th><th class="num">Proposed</th><th class="num">Change</th></tr></thead>
          <tbody>
            {#each HEADLINE as h}
              {#if result.before[h.key] !== undefined || result.after[h.key] !== undefined}
                <tr>
                  <td>{h.label}</td>
                  <td class="num mono">{fmt(result.before[h.key], h.pct)}</td>
                  <td class="num mono">{fmt(result.after[h.key], h.pct)}</td>
                  <td class="num mono {deltaClass(result.delta[h.key])}">{fmtDelta(result.delta[h.key], h.pct)}</td>
                </tr>
              {/if}
            {/each}
          </tbody>
        </table>
        {#each result.proposals as p (p.slot)}
          <div class="prop" class:done={applied.has(p.slot)}>
            <div class="phead">
              <span class="pslot">{p.slot}</span>
              <span class="pbase">{p.base}</span>
              {#if p.replaces}<span class="dim small">replaces {stripPobText(p.replaces)}</span>{/if}
              <button class="btn sm" onclick={() => apply(p)} disabled={build.busy > 0 || applied.has(p.slot)}>{applied.has(p.slot) ? "Applied" : "Apply"}</button>
            </div>
            <div class="mods mono">
              {#each p.mods as m}<div>{m}</div>{/each}
            </div>
            <div class="lookfor"><span class="dim">Look for</span> {p.lookFor.join(", ")}{#if p.implicit}<span class="dim"> · implicit</span> {plainImplicit(p.implicit)}{/if}</div>
            <div class="deltas">
              {#each DELTA_KEYS as d}
                {#if p.delta[d.key] !== undefined && Math.abs(p.delta[d.key]) >= 0.5}
                  <span class="dchip {deltaClass(p.delta[d.key])}"><span class="mono">{fmtDelta(p.delta[d.key], d.pct)}</span> {d.label}</span>
                {/if}
              {/each}
              {#if p.requirements.str || p.requirements.dex || p.requirements.int}
                <span class="dim small">needs <span class="mono">{[p.requirements.str && `${p.requirements.str} str`, p.requirements.dex && `${p.requirements.dex} dex`, p.requirements.int && `${p.requirements.int} int`].filter(Boolean).join(", ")}</span></span>
              {/if}
            </div>
          </div>
        {/each}
        {#each result.skipped as s}
          <div class="dim small pad">{s.slot}: {s.reason}</div>
        {/each}
      </div>
    {/if}
    <div class="head tree">
      <span class="title">Tree</span>
      <span class="dim small">Every node scored by PoB for one stat</span>
    </div>
    <div class="controls">
      <div class="ctl">
        <span class="label">Stat</span>
        <div class="seg" role="radiogroup">
          {#each TREE_STATS as [id, label]}
            <button class:on={treeStat === id} onclick={() => (treeStat = id)} disabled={treeRunning}>{label}</button>
          {/each}
        </div>
      </div>
      <div class="ctl run">
        <button class="btn sm primary" onclick={scanTree} disabled={treeRunning || !build.loaded}>{treeRunning ? "Scanning…" : "Scan"}</button>
        <label class="chk small"><input type="checkbox" bind:checked={notablesOnly} disabled={treeRunning} /> notables only</label>
        {#if summary}
          <span class="dim small"><span class="mono">{Math.max(0, summary.pointsAvailableMax - summary.mainTreePointsUsed)}</span> points unspent. Allocate takes the shortest path; Remove drops the node and what hangs off it.</span>
        {/if}
      </div>
      {#if treeError}<div class="err small">{treeError}</div>{/if}
    </div>
    {#if treeRows}
      <div class="results">
        <div class="ghead"><span>Best to add · {treeRows.stat} per point</span><span class="dim">{Math.round(treeRows.ms / 100) / 10}s</span>{#if treeStale}<span class="warn">tree changed, scan again</span>{/if}</div>
        {#each treeRows.best as r (r.id)}
          <div class="node">
            <span class="nname" title={r.name}>{r.name}</span>
            <span class="ntype dim small">{r.type}</span>
            <span class="ngain mono up">+{fmtGain(r.pathPower)}</span>
            <span class="nnote dim small">per point · <span class="mono">{r.pathDist}</span> to reach</span>
            <button class="btn sm" onclick={() => allocate(r.id)} disabled={build.busy > 0}>Allocate</button>
          </div>
        {/each}
        <div class="ghead"><span>Allocated, contributing least</span></div>
        {#each treeRows.weakest as r (r.id)}
          <div class="node">
            <span class="nname" title={r.name}>{r.name}</span>
            <span class="ntype dim small">{r.type}</span>
            <span class="ngain mono" class:down={r.power < 0}>{r.power < 0 ? fmtGain(r.power) : "0"}</span>
            <span class="nnote dim small">if removed · <span class="mono">{r.pathDist}</span> depend on it</span>
            <button class="btn sm ghost" onclick={() => remove(r.id)} disabled={build.busy > 0}>Remove</button>
          </div>
        {/each}
      </div>
    {/if}
  </section>
</div>

<style>
  .page {
    flex: 1;
    display: grid;
    grid-template-columns: minmax(340px, 440px) minmax(420px, 1fr);
    min-height: 0;
  }
  .col {
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow-y: auto;
  }
  .review {
    border-right: 1px solid var(--line-0);
  }
  .head {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 12px 14px 8px;
    border-bottom: 1px solid var(--line-0);
  }
  .title {
    font-size: var(--fs-md);
    font-weight: 600;
  }
  .pad {
    padding: 8px 14px;
  }
  .facts {
    display: grid;
    grid-template-columns: 1fr;
    padding: 6px 0;
    border-bottom: 1px solid var(--line-0);
  }
  .fact {
    display: grid;
    grid-template-columns: 74px auto 1fr;
    align-items: baseline;
    gap: 10px;
    padding: 4px 14px;
    font-size: var(--fs-sm);
  }
  .fact .k {
    color: var(--fg-2);
  }
  .fact .v {
    font-size: var(--fs-md);
  }
  .fact .n {
    font-size: var(--fs-xs);
  }
  .bad {
    color: var(--bad);
  }
  .findings {
    display: flex;
    flex-direction: column;
  }
  .finding {
    display: flex;
    gap: 10px;
    padding: 8px 14px;
    border-bottom: 1px solid var(--line-0);
    font-size: var(--fs-sm);
    line-height: 1.45;
  }
  .sev {
    flex: 0 0 auto;
    width: 6px;
    height: 6px;
    margin-top: 6px;
    border-radius: 50%;
    background: var(--fg-3);
  }
  .sev.bad {
    background: var(--bad);
  }
  .sev.warn {
    background: var(--warn);
  }
  .area {
    color: var(--fg-2);
    text-transform: capitalize;
  }
  .area::after {
    content: " ·";
  }
  .controls {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 14px;
    border-bottom: 1px solid var(--line-0);
  }
  .ctl {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: var(--fs-sm);
  }
  .ctl .label {
    width: 74px;
    flex: 0 0 auto;
  }
  .ctl.slots {
    align-items: flex-start;
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
    border-right: 1px solid var(--line-1);
  }
  .seg button:last-child {
    border-right: 0;
  }
  .seg button.on {
    color: var(--fg-0);
    background: var(--bg-3);
  }
  .ilvl {
    width: 64px;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .chip {
    padding: 2px 8px;
    font-size: var(--fs-xs);
    color: var(--fg-2);
    background: transparent;
    border: 1px solid var(--line-1);
    border-radius: var(--r-2);
  }
  .chip.on {
    color: var(--fg-0);
    border-color: var(--line-2);
    background: var(--bg-3);
  }
  .run {
    margin-top: 2px;
  }
  .prog {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: 1;
  }
  .bar {
    width: 160px;
    height: 3px;
    background: var(--bg-3);
    border-radius: 2px;
    overflow: hidden;
  }
  .fill {
    display: block;
    height: 100%;
    background: var(--fg-1);
    transition: width 0.15s;
  }
  .err {
    color: var(--bad);
  }
  .results {
    display: flex;
    flex-direction: column;
  }
  .ghead {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px 6px;
    font-size: var(--fs-xs);
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--fg-3);
  }
  .ghead .btn {
    margin-left: auto;
  }
  table.before {
    margin: 0 14px 6px;
    border-collapse: collapse;
    font-size: var(--fs-sm);
    width: calc(100% - 28px);
    max-width: 520px;
  }
  table.before th,
  table.before td {
    padding: 3px 8px 3px 0;
    text-align: left;
    border-bottom: 1px solid var(--line-0);
  }
  table.before th {
    font-weight: 500;
    color: var(--fg-3);
  }
  .num {
    text-align: right !important;
  }
  .up {
    color: var(--ok);
  }
  .down {
    color: var(--bad);
  }
  .prop {
    margin: 6px 14px;
    padding: 8px 10px;
    border: 1px solid var(--line-1);
    border-radius: var(--r-2);
    font-size: var(--fs-sm);
  }
  .prop.done {
    opacity: 0.6;
  }
  .phead {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  .phead .btn {
    margin-left: auto;
  }
  .pslot {
    font-weight: 600;
  }
  .pbase {
    color: var(--fg-2);
  }
  .mods {
    margin: 6px 0;
    font-size: var(--fs-xs);
    color: var(--fg-1);
    line-height: 1.5;
  }
  .lookfor {
    margin: 0 0 6px;
    font-size: var(--fs-xs);
    color: var(--fg-1);
    line-height: 1.5;
  }
  .deltas {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 10px;
    font-size: var(--fs-xs);
    color: var(--fg-2);
  }
  .dchip .mono {
    color: var(--fg-1);
  }
  .dchip.up .mono {
    color: var(--ok);
  }
  .dchip.down .mono {
    color: var(--bad);
  }
  .head.tree {
    border-top: 1px solid var(--line-0);
    margin-top: 8px;
  }
  .node {
    display: grid;
    grid-template-columns: minmax(120px, 1fr) 56px 64px minmax(150px, auto) auto;
    align-items: baseline;
    gap: 10px;
    padding: 5px 14px;
    border-bottom: 1px solid var(--line-0);
    font-size: var(--fs-sm);
  }
  .nname {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ngain {
    text-align: right;
  }
  .nnote {
    white-space: nowrap;
  }
  .chk {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    color: var(--fg-2);
  }
  .warn {
    color: var(--warn);
    text-transform: none;
    letter-spacing: 0;
    font-weight: 400;
  }
</style>
