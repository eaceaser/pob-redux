<script lang="ts">
  import PobText from "./PobText.svelte";
  import BreakdownPanel from "./BreakdownPanel.svelte";
  import Icon from "./Icon.svelte";
  import { engine, type BreakdownSection } from "$lib/engine.svelte";
  import { build } from "$lib/state/build.svelte";
  import { groupSidebar } from "$lib/sidebar-groups";

  // breakdown popup for hovered/pinned stat rows
  let bd = $state<{ sections: BreakdownSection[]; row: number; y: number; pinned: boolean } | null>(null);
  let bdTimer = 0;
  const bdCache = new Map<string, BreakdownSection[]>();

  function rowBreakdown(clientY: number, rowIndex: number, pin: boolean) {
    clearTimeout(bdTimer);
    if (pin && bd?.pinned && bd.row === rowIndex) {
      bd = null;
      return;
    }
    const y = Math.max(40, Math.min(clientY - 40, window.innerHeight - 420));
    const key = `${rowIndex}:${build.rev}`;
    const apply = (sections: BreakdownSection[]) => {
      bd = { sections, row: rowIndex, y, pinned: pin || (bd?.pinned && bd.row === rowIndex) || false };
    };
    const cached = bdCache.get(key);
    if (cached) {
      apply(cached);
      return;
    }
    bdTimer = window.setTimeout(async () => {
      try {
        const r = await engine.sidebarBreakdown(rowIndex);
        bdCache.set(key, r.sections);
        apply(r.sections);
      } catch {
        /* row changed under us */
      }
    }, pin ? 0 : 140);
  }

  function rowLeave() {
    clearTimeout(bdTimer);
    if (bd && !bd.pinned) bd = null;
  }

  $effect(() => {
    build.rev;
    bdCache.clear();
    bd = null;
  });

  const info = $derived(build.info);
  const side = $derived(build.sidebar);
  const sections = $derived(side ? groupSidebar(side.rows) : []);
  const cls = $derived(build.classes.find((c) => c.id === info?.classId));
  const groups = $derived(build.skills?.socketGroups ?? []);
  const mainGroup = $derived(groups.find((g) => g.index === info?.mainSocketGroup));
  const mainSkill = $derived(mainGroup?.skills.find((s) => s.index === (mainGroup?.mainActiveSkill ?? 1)) ?? mainGroup?.skills[0]);

  function patchMainSkill(patch: Parameters<typeof engine.setMainSkillOptions>[1]) {
    if (mainGroup) build.run(() => engine.setMainSkillOptions(mainGroup.index, patch));
  }

  let levelDraft = $state("");
  $effect(() => {
    if (info) levelDraft = String(info.level);
  });

  // loadouts: PoB's named tree+items+skills+config combos
  let loadouts = $state<{ loadouts: string[]; active: string | null }>({ loadouts: [], active: null });
  let loEdit = $state<{ mode: "new" | "copy" | "rename"; draft: string } | null>(null);
  $effect(() => {
    build.rev;
    if (build.loaded) engine.getLoadouts().then((r) => (loadouts = r)).catch(() => {});
  });
  function loCommit() {
    const e = loEdit;
    loEdit = null;
    if (!e) return;
    const name = e.draft.trim();
    if (!name) return;
    if (e.mode === "new") build.run(() => engine.newLoadout(name));
    else if (e.mode === "copy" && loadouts.active) build.run(() => engine.copyLoadout(loadouts.active!, name));
    else if (e.mode === "rename" && loadouts.active && name !== loadouts.active) build.run(() => engine.renameLoadout(loadouts.active!, name));
  }

  function commitLevel() {
    const n = Number(levelDraft);
    if (info && Number.isFinite(n) && n !== info.level) build.setLevel(n);
  }

  // Click the build name to rename it; Enter or blur commits, Escape cancels.
  let nameEdit = $state<string | null>(null);
  function commitName() {
    const name = nameEdit?.trim() ?? "";
    nameEdit = null;
    if (name && name !== info?.name) build.rename(name);
  }

  function onClass(e: Event) {
    build.selectClass(Number((e.target as HTMLSelectElement).value), 0);
  }
  function onAsc(e: Event) {
    build.chooseAscendancy(Number((e.target as HTMLSelectElement).value));
  }
  function onMainSkill(e: Event) {
    build.setMainSkill(Number((e.target as HTMLSelectElement).value));
  }

  // PoB emits "label:" / "value" pairs plus header rows (only lhs) and spacer
  // rows (no text). Header detection: lhs without a trailing colon.
  function kind(r: { lhs: string | null; rhs: string | null; h: number; align: string | null }) {
    if (!r.lhs && !r.rhs) return "space";
    if (r.align === "CENTER_X") return "center";
    if (r.lhs && !r.rhs) return "head";
    return "row";
  }
</script>

<aside class="sidebar">
  {#if info}
    <section class="head">
      <div class="buildname">
        <span class="label">Build</span>
        {#if nameEdit !== null}
          <!-- svelte-ignore a11y_autofocus -->
          <input
            class="input"
            bind:value={nameEdit}
            autofocus
            onblur={commitName}
            onkeydown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") (nameEdit = null);
            }}
          />
        {:else}
          <button
            class="bname"
            onclick={() => (nameEdit = info?.name ?? "")}
            title={(info.file ? `${info.file}\n` : "Not saved yet. ") + "Click to rename. The file is renamed with it."}
          >
            <span class="bn">{info.name}</span>
            {#if info.unsaved}<span class="unsaved" title="Unsaved changes">●</span>{/if}
          </button>
        {/if}
      </div>
      {#if loadouts.loadouts.length}
        <div class="field">
          <span class="label">Loadout</span>
          {#if loEdit}
            <input
              class="input"
              placeholder={loEdit.mode === "new" ? "New loadout name" : loEdit.mode === "copy" ? "Copy as…" : "Rename to…"}
              bind:value={loEdit.draft}
              onblur={loCommit}
              onkeydown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                if (e.key === "Escape") (loEdit = null);
              }}
            />
          {:else}
            <div class="lorow">
              <select
                class="select"
                value={loadouts.active ?? ""}
                onchange={(e) => build.run(() => engine.selectLoadout((e.target as HTMLSelectElement).value))}
                disabled={build.busy > 0}
                title="Loadout: a matching tree, item set, skill set and config set"
              >
                {#if !loadouts.active}<option value="">—</option>{/if}
                {#each loadouts.loadouts as l}
                  <option value={l}>{l}</option>
                {/each}
              </select>
              <button class="loact" title="New loadout" aria-label="New loadout" onclick={() => (loEdit = { mode: "new", draft: "" })}>
                <Icon name="plus" size={13} />
              </button>
              <button
                class="loact"
                title="Copy loadout"
                aria-label="Copy loadout"
                disabled={!loadouts.active}
                onclick={() => (loEdit = { mode: "copy", draft: `${loadouts.active} (Copy)` })}
              >
                <Icon name="copy" size={13} />
              </button>
              <button
                class="loact"
                title="Rename loadout"
                aria-label="Rename loadout"
                disabled={!loadouts.active}
                onclick={() => (loEdit = { mode: "rename", draft: loadouts.active ?? "" })}
              >
                <Icon name="pencil" size={13} />
              </button>
              <button
                class="loact danger"
                title="Delete loadout (removes its tree, item, skill and config sets)"
                aria-label="Delete loadout"
                disabled={loadouts.loadouts.length <= 1 || !loadouts.active}
                onclick={() => loadouts.active && build.run(() => engine.deleteLoadout(loadouts.active!))}
              >
                <Icon name="trash" size={13} />
              </button>
            </div>
          {/if}
        </div>
      {/if}
      <div class="row2">
        <label class="field">
          <span class="label">Class</span>
          <select class="select" value={info.classId} onchange={onClass} disabled={build.busy > 0}>
            {#each build.classes as c}
              <option value={c.id}>{c.name}</option>
            {/each}
          </select>
        </label>
        <label class="field">
          <span class="label">Ascendancy</span>
          <select class="select" value={info.ascendClassId} onchange={onAsc} disabled={build.busy > 0}>
            <option value={0}>None</option>
            {#each cls?.ascendancies ?? [] as a}
              <option value={a.id}>{a.name}</option>
            {/each}
          </select>
        </label>
      </div>
      <div class="row2">
        <label class="field lvl">
          <span class="label">Level</span>
          <input
            class="input num"
            type="number"
            min="1"
            max="100"
            bind:value={levelDraft}
            onchange={commitLevel}
            onkeydown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          />
        </label>
        <div class="field points" title={info.points.requiredLevelText ?? ""}>
          <span class="label">Points</span>
          <div class="pts num">
            <span class:over={info.points.used > info.points.max}>{info.points.used}<span class="dim">/{info.points.max}</span></span>
            <span class="sep">·</span>
            <span class="asc" class:over={info.points.ascUsed > info.points.ascMax}>{info.points.ascUsed}<span class="dim">/{info.points.ascMax}</span></span>
            <span class="dim label2">asc</span>
          </div>
        </div>
      </div>
      <label class="field">
        <span class="label">Main skill</span>
        <select class="select" value={info.mainSocketGroup} onchange={onMainSkill} disabled={groups.length === 0 || build.busy > 0}>
          {#if groups.length === 0}
            <option value={0}>No skills</option>
          {/if}
          {#each groups as g}
            <option value={g.index}>{g.grantedBy?.kind === "mechanic" ? "◈ " : g.grantedBy?.kind === "node" ? "✦ " : g.grantedBy ? "⚔ " : ""}{g.displayLabel ?? g.label ?? `Group ${g.index}`}{g.duplicateOf ? ` (item copy of ${g.duplicateOf})` : ""}</option>
          {/each}
        </select>
      </label>
      {#if mainGroup && mainGroup.skills.length > 1}
        <label class="field">
          <span class="label">Active skill</span>
          <select class="select" value={mainGroup.mainActiveSkill ?? 1} onchange={(e) => patchMainSkill({ mainActiveSkill: Number((e.target as HTMLSelectElement).value) })}>
            {#each mainGroup.skills as s}
              <option value={s.index}>{s.name}</option>
            {/each}
          </select>
        </label>
      {/if}
      {#if mainSkill?.statSets?.length}
        <label class="field">
          <span class="label">Stat set</span>
          <select class="select" value={mainSkill.statSet ?? 1} onchange={(e) => patchMainSkill({ statSet: Number((e.target as HTMLSelectElement).value) })}>
            {#each mainSkill.statSets as label, i}
              <option value={i + 1}>{label}</option>
            {/each}
          </select>
        </label>
      {/if}
      {#if mainSkill?.parts?.length}
        <label class="field">
          <span class="label">Skill part</span>
          <select class="select" value={mainSkill.part ?? 1} onchange={(e) => patchMainSkill({ part: Number((e.target as HTMLSelectElement).value) })}>
            {#each mainSkill.parts as part, i}
              <option value={i + 1}>{part.name}</option>
            {/each}
          </select>
        </label>
      {/if}
      {#if mainSkill?.minions?.length}
        <label class="field">
          <span class="label">Minion</span>
          <select class="select" value={mainSkill.minion ?? mainSkill.minions[0].id} onchange={(e) => patchMainSkill({ minionId: (e.target as HTMLSelectElement).value })}>
            {#each mainSkill.minions as m}
              <option value={m.id}>{m.name}</option>
            {/each}
          </select>
        </label>
      {/if}
    </section>

    <div class="stats" class:busy={build.busy > 0}>
      {#if side}
        {#each sections as sec (sec.key)}
          {#if sec.label}
            <div class="sgroup"><span>{sec.label}</span></div>
          {/if}
          {#each sec.items as { row: r, index: rowIndex } (rowIndex)}
            {@const k = kind(r)}
            {#if k === "space"}
              <div class="space"></div>
            {:else if k === "head"}
              <div class="shead"><PobText text={r.lhs} /></div>
            {:else if k === "center"}
              <div class="scenter"><PobText text={r.lhs} defaultColor="var(--fg-2)" /></div>
            {:else}
              <div
                class="srow"
                class:hasbd={r.hasBreakdown}
                class:pinnedrow={bd?.pinned && bd.row === rowIndex + 1}
                role="button"
                tabindex={r.hasBreakdown ? 0 : -1}
                onmouseenter={(e) => r.hasBreakdown && rowBreakdown(e.clientY, rowIndex + 1, false)}
                onmouseleave={rowLeave}
                onclick={(e) => r.hasBreakdown && rowBreakdown(e.clientY, rowIndex + 1, true)}
                onkeydown={(e) => e.key === "Enter" && r.hasBreakdown && rowBreakdown(200, rowIndex + 1, true)}
              >
                <span class="k"><PobText text={r.lhs?.replace(/:\s*$/, "")} defaultColor="var(--fg-1)" /></span>
                <span class="v num"><PobText text={r.rhs} /></span>
              </div>
            {/if}
          {/each}
        {/each}
        {#if side.warnings.length}
          <div class="warnings">
            <div class="label" style:color="var(--warn)">Warnings</div>
            {#each side.warnings as w}
              <div class="warn">{w}</div>
            {/each}
          </div>
        {/if}
      {/if}
    </div>
  {:else}
    <div class="empty">
      <span class="label">No build loaded</span>
    </div>
  {/if}

  {#if bd}
    <div class="bdpop" style:top={`${bd.y}px`}>
      <div class="bdhead">
        <span class="label">Breakdown</span>
        {#if bd.pinned}<span class="dim small">pinned</span>{/if}
      </div>
      <div class="bdscroll">
        <BreakdownPanel sections={bd.sections} />
      </div>
    </div>
  {/if}
</aside>

<style>
  .sidebar {
    width: var(--sidebar-w);
    display: flex;
    flex-direction: column;
    background: var(--bg-1);
    border-right: 1px solid var(--line-0);
    min-height: 0;
  }
  .head {
    padding: 10px 12px 12px;
    border-bottom: 1px solid var(--line-0);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .row2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  .buildname {
    padding: 0 0 8px;
    margin-bottom: 2px;
    border-bottom: 1px solid var(--line-0);
    display: flex;
    flex-direction: column;
    gap: 4px;
    text-align: left;
    min-width: 0;
  }
  .buildname .label {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .bname {
    appearance: none;
    border: 0;
    background: none;
    padding: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    cursor: text;
    text-align: left;
  }
  .bname:hover .bn {
    color: var(--focus);
  }
  .bn {
    font-size: var(--fs-md, 14px);
    font-weight: 600;
    color: var(--fg-0);
    letter-spacing: 0.01em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .unsaved {
    color: var(--warn);
    font-size: 10px;
    flex: 0 0 auto;
  }
  .lorow {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .lorow .select {
    flex: 1;
    min-width: 0;
  }
  .loact {
    appearance: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    width: 26px;
    height: 26px;
    padding: 0;
    border: 1px solid var(--line-1);
    border-radius: var(--r-1);
    background: var(--bg-2);
    color: var(--fg-1);
    cursor: pointer;
    transition: background 80ms linear, border-color 80ms linear, color 80ms linear;
  }
  .loact:hover:not(:disabled) {
    background: var(--bg-hover);
    border-color: var(--line-2);
    color: var(--fg-0);
  }
  .loact.danger:hover:not(:disabled) {
    color: var(--bad);
  }
  .loact:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .lvl .input {
    width: 100%;
  }
  .pts {
    height: 26px;
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: var(--fs-sm);
    color: var(--fg-0);
    padding: 0 2px;
  }
  .pts .sep {
    color: var(--fg-4);
  }
  .label2 {
    font-size: var(--fs-xs);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .over {
    color: var(--bad);
  }
  .stats {
    flex: 1;
    overflow-y: auto;
    padding: 8px 12px 16px;
    transition: opacity 120ms;
  }
  .stats.busy {
    opacity: 0.6;
  }
  .space {
    height: 7px;
  }
  .sgroup {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 14px 0 4px;
    font-size: var(--fs-xs);
    font-weight: 600;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--fg-2);
  }
  .sgroup::after {
    content: "";
    flex: 1;
    height: 1px;
    background: var(--line-0);
  }
  .sgroup:first-child {
    padding-top: 4px;
  }
  .shead {
    padding: 8px 0 3px;
    font-size: var(--fs-xs);
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--fg-2);
  }
  .scenter {
    text-align: center;
    font-size: var(--fs-xs);
    padding: 1px 0;
  }
  .srow {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 10px;
    padding: 1px 0;
    font-size: var(--fs-sm);
    line-height: 17px;
    border-radius: 2px;
  }
  .srow .k {
    color: var(--fg-1);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .srow .v {
    white-space: nowrap;
    color: var(--fg-0);
  }
  .srow.hasbd {
    cursor: default;
  }
  .srow.hasbd:hover,
  .srow.pinnedrow {
    background: var(--bg-2);
    margin: 0 -6px;
    padding: 1px 6px;
  }
  .srow.pinnedrow {
    box-shadow: inset 2px 0 0 var(--focus);
  }
  .bdpop {
    position: fixed;
    left: calc(var(--sidebar-w) + 8px);
    width: 560px;
    max-width: calc(100vw - var(--sidebar-w) - 24px);
    max-height: 60vh;
    display: flex;
    flex-direction: column;
    background: color-mix(in srgb, var(--bg-1) 96%, transparent);
    border: 1px solid var(--line-1);
    border-radius: var(--r-2);
    box-shadow: var(--shadow-pop);
    backdrop-filter: blur(8px);
    z-index: 20;
    pointer-events: none;
  }
  .bdhead {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    padding: 8px 12px 6px;
    border-bottom: 1px solid var(--line-0);
  }
  .bdscroll {
    padding: 10px 12px;
    overflow-y: auto;
  }
  .small {
    font-size: var(--fs-xs);
  }
  .warnings {
    margin-top: 12px;
    padding-top: 10px;
    border-top: 1px solid var(--line-0);
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .warn {
    font-size: var(--fs-xs);
    color: var(--warn);
    line-height: 1.35;
  }
  .empty {
    flex: 1;
    display: grid;
    place-items: center;
  }
</style>
