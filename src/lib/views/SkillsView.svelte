<script lang="ts">
  import { untrack } from "svelte";
  import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
  import { engine, gemDpsParallel, type GemSearchRow, type SkillEntry, type SkillsOptions, type SocketGroup, type Tooltip } from "$lib/engine.svelte";
  import { build } from "$lib/state/build.svelte";
  import PobText from "$lib/components/PobText.svelte";
  import PobTooltip from "$lib/components/PobTooltip.svelte";

  const groups = $derived(build.skills?.socketGroups ?? []);
  const skillSets = $derived(build.skills?.skillSets ?? []);
  let selectedIdx = $state(1);
  const sel = $derived<SocketGroup | undefined>(groups.find((g) => g.index === selectedIdx) ?? groups[0]);
  const selSkill = $derived<SkillEntry | undefined>(sel?.skills.find((s) => s.index === (sel?.mainActiveSkill ?? 1)) ?? sel?.skills[0]);

  let renamingSet = $state(false);
  let setDraft = $state("");
  let labelDraft = $state("");

  // gem picker
  let pickerQuery = $state("");
  let pickerRows = $state<GemSearchRow[]>([]);
  let pickerOpen = $state(false);
  let pickerDps = $state(false);
  let pickerScoring = $state(false);
  let pickerBusy = false;
  let pickerStamp = 0;

  // per-build gem defaults (persisted by PoB in the build file)
  let options = $state<SkillsOptions | null>(null);
  $effect(() => {
    build.rev;
    engine
      .getSkillsOptions()
      .then((o) => (options = o))
      .catch(() => {});
  });
  function setOptions(patch: Partial<SkillsOptions>) {
    engine
      .setSkillsOptions(patch)
      .then((o) => (options = o))
      .catch(() => {});
  }

  // gem tooltip (PoB's GemTooltip lines)
  let tip = $state<{ tt: Tooltip; x: number; y: number } | null>(null);
  let tipTimer = 0;
  const tipCache = new Map<string, Tooltip>();

  $effect(() => {
    if (sel) labelDraft = sel.label ?? "";
  });

  $effect(() => {
    // refresh picker results when open, query, group, sort mode or build changes
    const q = pickerQuery;
    const g = sel?.index;
    const open = pickerOpen;
    const dps = pickerDps;
    build.rev;
    untrack(() => {
      if (!open || g == null) return;
      const stamp = ++pickerStamp;
      if (pickerBusy) return;
      pickerBusy = true;
      pickerScoring = dps;
      // pre-score across the worker pool so the DPS-sorted search finds a warm cache
      (dps ? gemDpsParallel(g).catch(() => undefined) : Promise.resolve())
        .then(() => engine.gemSearch({ groupIndex: g, query: q, limit: 60, sortByDps: dps }))
        .then((r) => {
          if (stamp === pickerStamp) pickerRows = r.gems;
        })
        .catch(() => {})
        .finally(() => {
          pickerBusy = false;
          pickerScoring = false;
        });
    });
  });

  function fmtDps(d: number | undefined): string {
    if (d == null) return "";
    const sign = d >= 0 ? "+" : "";
    if (Math.abs(d) >= 100000) return `${sign}${(d / 1000).toFixed(0)}k`;
    if (Math.abs(d) >= 1000) return `${sign}${(d / 1000).toFixed(1)}k`;
    return `${sign}${d.toFixed(Math.abs(d) < 10 ? 1 : 0)}`;
  }

  async function copyGroup() {
    if (!sel) return;
    const r = await build.run(() => engine.copySocketGroup(sel.index), { sync: false });
    if (r?.text) await writeText(r.text).catch(() => {});
  }
  async function pasteGroup() {
    const text = (await readText().catch(() => "")) ?? "";
    if (!text.trim()) return;
    const r = await build.run(() => engine.pasteSocketGroup(text));
    if (r) selectedIdx = r.socketGroups.length;
  }

  $effect(() => {
    build.rev;
    tipCache.clear();
    tip = null;
  });

  function patchGroup(index: number, patch: Record<string, unknown>) {
    build.run(() => engine.setSocketGroup(index, patch));
  }
  function patchGem(g: number, i: number, patch: Record<string, unknown>) {
    build.run(() => engine.setGem(g, i, patch));
  }
  function patchSkill(patch: Parameters<typeof engine.setMainSkillOptions>[1]) {
    if (sel) build.run(() => engine.setMainSkillOptions(sel.index, patch));
  }

  async function addGroup() {
    const r = await build.run(() => engine.addSocketGroup());
    if (r) selectedIdx = r.groupIndex;
  }
  async function removeGroup() {
    if (!sel) return;
    await build.run(() => engine.removeSocketGroup(sel.index));
    selectedIdx = 1;
  }
  function moveGroup(from: number, dir: number) {
    const to = from + dir;
    if (to < 1 || to > groups.length) return;
    build.run(() => engine.moveSocketGroup(from, to)).then(() => (selectedIdx = to));
  }
  function addGem(row: GemSearchRow) {
    if (!sel) return;
    pickerQuery = "";
    build.run(() => engine.addGem(sel.index, row.gemId, Math.min(row.maxLevel, 20)));
  }

  function showTip(e: MouseEvent, groupIndex: number, gemIndex: number) {
    clearTimeout(tipTimer);
    const x = Math.min(e.clientX + 16, window.innerWidth - 560);
    const y = Math.min(e.clientY + 12, window.innerHeight - 420);
    const key = `${groupIndex}:${gemIndex}`;
    tipTimer = window.setTimeout(async () => {
      const cached = tipCache.get(key);
      if (cached) {
        tip = { tt: cached, x, y };
        return;
      }
      try {
        const r = await engine.gemTooltip(groupIndex, gemIndex);
        tipCache.set(key, r);
        tip = { tt: r, x, y };
      } catch {
        tip = null;
      }
    }, 120);
  }
  function hideTip() {
    clearTimeout(tipTimer);
    tip = null;
  }

  const activeSet = $derived(skillSets.find((s) => s.active));

  // Item-, node- and mechanic-granted groups, and gems the game hands out
  // (a weapon's default attack, Raise Shield): each gets a mark and a sentence.
  type Mark = { glyph: string; text: string; kind: "item" | "node" | "mechanic" | "gem" };
  function markOf(g: SocketGroup): Mark | null {
    const by = g.grantedBy;
    if (by?.kind === "mechanic") return { glyph: "◈", text: `${by.source}: a mechanic PoB calculates, not a skill`, kind: "mechanic" };
    if (by?.kind === "node") return { glyph: "✦", text: `Granted by the passive ${by.node ?? "node"}; not a socketed gem`, kind: "node" };
    if (by?.kind === "item") {
      const where = by.item ? `${by.item}${by.slot ? ` (${by.slot})` : ""}` : "an item";
      const dup = g.duplicateOf ? `. Same skill as group ${g.duplicateOf}, which carries the supports` : "";
      return { glyph: "⚔", text: `Comes with ${where}; leaves with it${dup}`, kind: "item" };
    }
    const gem = g.gems.find((x) => !x.support && x.granted);
    if (gem) return { glyph: "⚔", text: `${gem.name ?? "This skill"} ${gem.granted}`, kind: "gem" };
    return null;
  }
</script>

<div class="page">
  <div class="toolbar">
    {#if renamingSet}
      <input
        class="input setsel"
        bind:value={setDraft}
        onblur={() => {
          renamingSet = false;
          if (activeSet && setDraft.trim() && setDraft !== activeSet.title) build.run(() => engine.renameSkillSet(activeSet.id, setDraft.trim()));
        }}
        onkeydown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") renamingSet = false;
        }}
      />
    {:else}
      <select
        class="select setsel"
        value={activeSet?.id ?? 1}
        onchange={(e) => build.run(() => engine.selectSkillSet(Number((e.target as HTMLSelectElement).value)))}
        disabled={build.busy > 0}
        title="Skill set"
      >
        {#each skillSets as s}
          <option value={s.id}>{s.title}</option>
        {/each}
      </select>
    {/if}
    <button class="btn sm ghost" onclick={() => build.run(() => engine.createSkillSet())}>New</button>
    <button class="btn sm ghost" onclick={() => build.run(() => engine.copySkillSet())}>Copy</button>
    <button
      class="btn sm ghost"
      onclick={() => {
        setDraft = activeSet?.title ?? "";
        renamingSet = true;
      }}>Rename</button
    >
    <button class="btn sm ghost" disabled={skillSets.length <= 1} onclick={() => activeSet && build.run(() => engine.deleteSkillSet(activeSet.id))}>Delete</button>
    <span class="vr"></span>
    <button class="btn sm" onclick={addGroup}>New socket group</button>
    <button class="btn sm ghost" disabled={!sel} onclick={copyGroup} title="Copy the selected group as text (PoB-compatible)">Copy group</button>
    <button class="btn sm ghost" onclick={pasteGroup} title="Paste a group copied from PoB or this app">Paste group</button>
    <span class="vr"></span>
    <label class="fld-inline" title="Level given to newly added gems">
      <span class="label">Default level</span>
      <select class="select opt" value={options?.defaultGemLevel ?? "normalMaximum"} onchange={(e) => setOptions({ defaultGemLevel: (e.target as HTMLSelectElement).value })}>
        <option value="normalMaximum">Max</option>
        <option value="corruptedMaximum">Corrupted max</option>
        <option value="characterLevel">Character level</option>
      </select>
    </label>
    <label class="fld-inline" title="Quality given to newly added gems">
      <span class="label">Quality</span>
      <input class="input opt num" type="number" min="0" max="23" value={options?.defaultGemQuality ?? 0} onchange={(e) => setOptions({ defaultGemQuality: Number((e.target as HTMLInputElement).value) })} />
    </label>
  </div>

  <div class="cols">
    <section class="col list">
      {#each groups as g (g.index)}
        {@const mark = markOf(g)}
        <div class="grow-row" class:sel={sel?.index === g.index} class:off={!g.enabled} class:dup={!!g.duplicateOf}>
          <button class="gmain" title="Set as main skill" class:ismain={g.isMainSkill} onclick={() => build.setMainSkill(g.index)}>⌾</button>
          <button class="gname" onclick={() => (selectedIdx = g.index)}>
            <PobText text={g.displayLabel ?? g.label ?? `Group ${g.index}`} />
            {#if mark}
              <span class="granted mark-{mark.kind}" title={mark.text}>{mark.glyph}</span>
            {/if}
            {#if g.duplicateOf}
              <span class="dim small">item copy of group {g.duplicateOf}</span>
            {/if}
          </button>
          <span class="ops">
            <button class="mini" title="Move up" disabled={g.index <= 1} onclick={() => moveGroup(g.index, -1)}>▲</button>
            <button class="mini" title="Move down" disabled={g.index >= groups.length} onclick={() => moveGroup(g.index, 1)}>▼</button>
          </span>
        </div>
      {/each}
      {#if groups.length === 0}
        <div class="dim pad">No socket groups yet.</div>
      {/if}
    </section>

    <section class="col detail">
      {#if sel}
        <div class="dhead">
          <input
            class="input dlabel"
            placeholder="Group label"
            bind:value={labelDraft}
            onblur={() => labelDraft !== (sel.label ?? "") && patchGroup(sel.index, { label: labelDraft })}
            onkeydown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          />
          {#if sel.slot && !sel.grantedBy}<span class="dim small">socketed in {sel.slot}</span>{/if}
          {#if markOf(sel)}{@const m = markOf(sel)!}<span class="dim small">{m.glyph} {m.text}</span>{/if}
          <span class="grow"></span>
          <label class="chk small"><input type="checkbox" checked={sel.includeInFullDPS} onchange={(e) => patchGroup(sel.index, { includeInFullDPS: (e.target as HTMLInputElement).checked })} /> Full DPS</label>
          <label class="chk small"><input type="checkbox" checked={sel.enabled} onchange={(e) => patchGroup(sel.index, { enabled: (e.target as HTMLInputElement).checked })} /> Enabled</label>
          <button
            class="btn sm ghost danger"
            disabled={!!sel.source}
            title={sel.source ? "This group comes with an item or a mechanic and cannot be deleted; change the item instead" : "Delete this socket group"}
            onclick={removeGroup}>Delete group</button>
        </div>

        {#if sel.skills.length > 0}
          <div class="skillsel">
            {#if sel.skills.length > 1}
              <label class="fld">
                <span class="label">Skill</span>
                <select class="select sm" value={sel.mainActiveSkill ?? 1} onchange={(e) => patchSkill({ mainActiveSkill: Number((e.target as HTMLSelectElement).value) })}>
                  {#each sel.skills as s}
                    <option value={s.index}>{s.name}</option>
                  {/each}
                </select>
              </label>
            {/if}
            {#if selSkill?.statSets?.length}
              <label class="fld">
                <span class="label">Stat set</span>
                <select class="select sm" value={selSkill.statSet ?? 1} onchange={(e) => patchSkill({ statSet: Number((e.target as HTMLSelectElement).value) })}>
                  {#each selSkill.statSets as label, i}
                    <option value={i + 1}>{label}</option>
                  {/each}
                </select>
              </label>
            {/if}
            {#if selSkill?.parts?.length}
              <label class="fld">
                <span class="label">Part</span>
                <select class="select sm" value={selSkill.part ?? 1} onchange={(e) => patchSkill({ part: Number((e.target as HTMLSelectElement).value) })}>
                  {#each selSkill.parts as part, i}
                    <option value={i + 1}>{part.name}</option>
                  {/each}
                </select>
              </label>
            {/if}
            {#if selSkill?.hasStages}
              <label class="fld">
                <span class="label">Stages</span>
                <input class="input sm num" type="number" min="1" value={selSkill.stageCount ?? 1} onchange={(e) => patchSkill({ stageCount: Number((e.target as HTMLInputElement).value) })} />
              </label>
            {/if}
            {#if selSkill?.hasMines}
              <label class="fld">
                <span class="label">Mines</span>
                <input class="input sm num" type="number" min="1" value={selSkill.mineCount ?? ""} onchange={(e) => patchSkill({ mineCount: Number((e.target as HTMLInputElement).value) })} />
              </label>
            {/if}
            {#if selSkill?.minions?.length}
              <label class="fld">
                <span class="label">Minion</span>
                <select class="select sm wide" value={selSkill.minion ?? selSkill.minions[0].id} onchange={(e) => patchSkill({ minionId: (e.target as HTMLSelectElement).value })}>
                  {#each selSkill.minions as m}
                    <option value={m.id}>{m.name}</option>
                  {/each}
                </select>
              </label>
            {/if}
            {#if selSkill?.minionSkills?.length}
              <label class="fld">
                <span class="label">Minion skill</span>
                <select class="select sm wide" value={selSkill.minionSkill ?? 1} onchange={(e) => patchSkill({ minionSkill: Number((e.target as HTMLSelectElement).value) })}>
                  {#each selSkill.minionSkills as name, i}
                    <option value={i + 1}>{name}</option>
                  {/each}
                </select>
              </label>
            {/if}
          </div>
        {/if}

        <div class="gems">
          <div class="gcols label"><span></span><span>Gem</span><span class="r">Level</span><span class="r">Quality</span><span></span></div>
          {#each sel.gems as gem (gem.index)}
            <div class="gem" class:disabled={!gem.enabled}>
              <span class="ops">
                <button class="mini" disabled={gem.index <= 1} onclick={() => build.run(() => engine.moveGem(sel.index, gem.index, gem.index - 1))}>▲</button>
                <button class="mini" disabled={gem.index >= sel.gems.length} onclick={() => build.run(() => engine.moveGem(sel.index, gem.index, gem.index + 1))}>▼</button>
              </span>
              <span
                class="gemname"
                class:sup={gem.support}
                role="note"
                onmouseenter={(e) => showTip(e, sel.index, gem.index)}
                onmouseleave={hideTip}
              >
                <input type="checkbox" checked={gem.enabled} onchange={(e) => patchGem(sel.index, gem.index, { enabled: (e.target as HTMLInputElement).checked })} />
                <PobText text={(gem.color ?? "^7") + (gem.name ?? gem.nameSpec ?? "?")} />
                {#if gem.errMsg}<span class="err small">{gem.errMsg}</span>{/if}
              </span>
              <input class="input sm num r" type="number" min="1" max={gem.maxLevel + 10} value={gem.level ?? 1} onchange={(e) => patchGem(sel.index, gem.index, { level: Number((e.target as HTMLInputElement).value) })} />
              <input class="input sm num r" type="number" min="0" max="30" value={gem.quality ?? 0} onchange={(e) => patchGem(sel.index, gem.index, { quality: Number((e.target as HTMLInputElement).value) })} />
              <button class="mini x" title="Remove gem" onclick={() => build.run(() => engine.removeGem(sel.index, gem.index))}>✕</button>
            </div>
          {/each}

          <div class="adder" class:open={pickerOpen}>
            <input
              class="input"
              placeholder="Add a gem… (name, or tag like 'projectile')"
              bind:value={pickerQuery}
              onfocus={() => (pickerOpen = true)}
              onkeydown={(e) => {
                if (e.key === "Escape") {
                  pickerOpen = false;
                  (e.target as HTMLInputElement).blur();
                }
                if (e.key === "Enter" && pickerRows[0]) addGem(pickerRows[0]);
              }}
            />
            {#if pickerOpen}
              <button class="btn sm" class:on={pickerDps} onclick={() => (pickerDps = !pickerDps)} title="Score every valid support by its DPS impact and sort by it (first run takes a moment)">DPS</button>
              <button class="btn sm ghost" onclick={() => (pickerOpen = false)}>Close</button>
            {/if}
          </div>
          {#if pickerOpen}
            <div class="picker">
              {#if pickerScoring}
                <div class="dim small pad">Scoring gems against this group…</div>
              {/if}
              {#each pickerRows as row (row.gemId)}
                <button class="prow" class:invalid={!row.valid} onclick={() => addGem(row)} title={row.valid ? row.gemId : "Cannot support this group's active skill"}>
                  <span class="pname"><PobText text={row.color + row.name} /></span>
                  <span class="ptags dim">{row.tags ?? ""}</span>
                  {#if pickerDps}
                    <span class="pdps num" style:color={row.dpsDiff == null ? "var(--fg-3)" : row.dpsDiff > 0 ? "var(--ok)" : row.dpsDiff < 0 ? "var(--bad)" : "var(--fg-2)"}>{fmtDps(row.dpsDiff)}</span>
                  {/if}
                  <span class="pkind dim">{row.support ? (row.valid ? "support" : "support ✕") : "active"}</span>
                </button>
              {/each}
              {#if pickerRows.length === 0 && !pickerScoring}
                <div class="dim small pad">No matching gems.</div>
              {/if}
            </div>
          {/if}
        </div>
      {:else}
        <div class="dim pad">Select or create a socket group.</div>
      {/if}
    </section>
  </div>

  {#if tip}
    <PobTooltip lines={tip.tt.lines} header={tip.tt.header} runic={tip.tt.runic} uniqueGem={tip.tt.uniqueGem} x={tip.x} y={tip.y} />
  {/if}
</div>

<style>
  .page {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    position: relative;
  }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--line-0);
    background: var(--bg-1);
  }
  .setsel {
    width: 200px;
    height: 24px;
    font-size: var(--fs-xs);
  }
  .vr {
    width: 1px;
    height: 16px;
    background: var(--line-1);
    margin: 0 4px;
  }
  .grow {
    flex: 1;
  }
  .cols {
    flex: 1;
    display: grid;
    grid-template-columns: 380px 1fr;
    min-height: 0;
  }
  .col {
    min-height: 0;
    overflow-y: auto;
  }
  .list {
    border-right: 1px solid var(--line-0);
  }
  .grow-row {
    display: flex;
    align-items: center;
    gap: 4px;
    border-bottom: 1px solid var(--line-0);
    padding-right: 6px;
  }
  .grow-row.sel {
    background: var(--bg-2);
    box-shadow: inset 2px 0 0 var(--fg-0);
  }
  .grow-row.off .gname,
  .grow-row.dup .gname {
    opacity: 0.45;
  }
  .gmain {
    appearance: none;
    border: 0;
    background: none;
    color: var(--fg-3);
    font-size: 19px;
    line-height: 1;
    width: 30px;
    height: 30px;
    cursor: pointer;
  }
  .gmain:hover {
    color: var(--fg-1);
  }
  .gmain.ismain {
    color: var(--warn);
  }
  .granted {
    margin-left: 8px;
    color: var(--fg-2);
    font-size: 16px;
    line-height: 1;
    vertical-align: -1px;
  }
  .granted.mark-mechanic {
    color: var(--fg-3);
    font-size: 13px;
  }
  .gname {
    appearance: none;
    border: 0;
    background: none;
    color: var(--fg-1);
    flex: 1;
    text-align: left;
    padding: 6px 0;
    font-size: var(--fs-sm);
    cursor: pointer;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .grow-row:hover {
    background: var(--bg-2);
  }
  .ops {
    display: inline-flex;
    gap: 2px;
  }
  .mini {
    appearance: none;
    border: 1px solid transparent;
    background: none;
    color: var(--fg-3);
    font-size: 9px;
    width: 18px;
    height: 18px;
    cursor: pointer;
    border-radius: 3px;
  }
  .mini:hover:not(:disabled) {
    color: var(--fg-0);
    border-color: var(--line-1);
  }
  .mini:disabled {
    opacity: 0.3;
  }
  .mini.x:hover {
    color: var(--bad);
  }
  .detail {
    display: flex;
    flex-direction: column;
  }
  .dhead {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--line-0);
  }
  .dlabel {
    width: 260px;
  }
  .danger:hover {
    color: var(--bad);
  }
  .skillsel {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--line-0);
    background: var(--bg-1);
  }
  .fld {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .select.sm,
  .input.sm {
    height: 22px;
    font-size: var(--fs-xs);
  }
  .select.sm {
    min-width: 140px;
  }
  .select.sm.wide {
    min-width: 200px;
  }
  .input.sm.num {
    width: 64px;
    text-align: right;
  }
  .gems {
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-width: 760px;
  }
  .gcols,
  .gem {
    display: grid;
    grid-template-columns: 44px 1fr 70px 70px 26px;
    gap: 8px;
    align-items: center;
  }
  .gcols {
    padding: 2px 0 6px;
  }
  .r {
    text-align: right;
  }
  .gem {
    padding: 3px 0;
    border-bottom: 1px solid var(--line-0);
    font-size: var(--fs-sm);
  }
  .gem.disabled .gemname {
    opacity: 0.45;
  }
  .gemname {
    display: flex;
    align-items: center;
    gap: 8px;
    overflow: hidden;
    white-space: nowrap;
  }
  .gemname.sup {
    padding-left: 14px;
  }
  .err {
    color: var(--bad);
  }
  .adder {
    display: flex;
    gap: 6px;
    margin-top: 8px;
  }
  .adder .input {
    flex: 1;
  }
  .picker {
    border: 1px solid var(--line-1);
    border-radius: var(--r-1);
    max-height: 320px;
    overflow-y: auto;
    background: var(--bg-1);
  }
  .fld-inline {
    display: flex;
    align-items: center;
    gap: 5px;
  }
  .select.opt {
    height: 22px;
    font-size: var(--fs-2xs);
    width: 120px;
  }
  .input.opt {
    height: 22px;
    font-size: var(--fs-2xs);
    width: 48px;
    text-align: right;
  }
  .btn.on {
    color: var(--fg-0);
    border-color: var(--fg-2);
    background: var(--bg-active);
  }
  .pdps {
    text-align: right;
    font-size: var(--fs-2xs);
  }
  .prow {
    appearance: none;
    width: 100%;
    display: grid;
    grid-template-columns: 220px 1fr auto 76px;
    gap: 10px;
    padding: 4px 10px;
    border: 0;
    border-bottom: 1px solid var(--line-0);
    background: transparent;
    text-align: left;
    cursor: pointer;
    font-size: var(--fs-xs);
    align-items: baseline;
  }
  .prow:hover {
    background: var(--bg-2);
  }
  .prow.invalid {
    opacity: 0.4;
  }
  .pname {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ptags {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .pkind {
    text-align: right;
  }
  .chk {
    display: flex;
    align-items: center;
    gap: 5px;
    color: var(--fg-2);
  }
  .small {
    font-size: var(--fs-xs);
  }
  .pad {
    padding: 10px 12px;
  }
  input[type="checkbox"] {
    accent-color: var(--fg-0);
  }
</style>
