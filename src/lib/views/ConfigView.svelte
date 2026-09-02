<script lang="ts">
  import { engine, type ConfigOption, type ConfigState, type CustomModBlock } from "$lib/engine.svelte";
  import { build } from "$lib/state/build.svelte";
  import PobText from "$lib/components/PobText.svelte";

  let options = $state<ConfigOption[]>([]);
  let config = $state<Record<string, unknown>>({});
  let placeholder = $state<Record<string, unknown>>({});
  let sets = $state<ConfigState["sets"]>([]);
  let visibility = $state<Record<string, boolean> | null>(null);
  let customBlocks = $state<CustomModBlock[]>([]);
  let relevantOnly = $state(true);
  let filter = $state("");
  let collapsed = $state<Set<string>>(new Set());
  let renamingSet = $state(false);
  let setDraft = $state("");

  // mod browser modal
  let browser = $state<number | null>(null); // block index
  let browserMods = $state<{ text: string; sources: string[] }[] | null>(null);
  let browserQuery = $state("");

  $effect(() => {
    engine.listConfigOptions().then((r) => (options = r.options));
  });
  $effect(() => {
    build.rev;
    engine.getConfig().then((r) => {
      config = r.config;
      placeholder = r.placeholder;
      sets = r.sets;
    });
    engine.getCustomMods().then((r) => (customBlocks = r.blocks)).catch(() => (customBlocks = []));
    engine
      .configVisibility()
      .then((r) => (visibility = r.visibility))
      .catch(() => (visibility = null));
  });

  const activeSet = $derived(sets.find((s) => s.active));

  const sections = $derived.by(() => {
    const q = filter.trim().toLowerCase();
    const out: { name: string; items: ConfigOption[] }[] = [];
    for (const o of options) {
      if (q && !`${o.label ?? ""} ${o.var}`.toLowerCase().includes(q)) continue;
      // Hide options PoB would hide for this build, but never hide a set one.
      if (relevantOnly && !q && visibility && !visibility[o.var]) {
        const v = config[o.var];
        if (v === undefined || v === null || v === false) continue;
      }
      const name = o.section ?? "General";
      let s = out.find((x) => x.name === name);
      if (!s) out.push((s = { name, items: [] }));
      s.items.push(o);
    }
    return out;
  });

  function set(o: ConfigOption, value: unknown) {
    build.run(() => engine.setConfig(o.var, value));
  }
  function toggle(name: string) {
    const s = new Set(collapsed);
    s.has(name) ? s.delete(name) : s.add(name);
    collapsed = s;
  }

  function badLines(b: CustomModBlock) {
    return b.lines.filter((l) => l.status === "none" || l.status === "partial");
  }

  async function openBrowser(blockIndex: number) {
    browser = blockIndex;
    browserQuery = "";
    if (!browserMods) {
      try {
        browserMods = (await engine.customModBrowser()).mods;
      } catch {
        browserMods = [];
      }
    }
  }

  const browserList = $derived.by(() => {
    if (!browserMods) return [];
    const words = browserQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return browserMods.slice(0, 200);
    return browserMods.filter((m) => {
      const t = m.text.toLowerCase();
      return words.every((w) => t.includes(w));
    }).slice(0, 200);
  });

  function addModFromBrowser(text: string) {
    if (browser == null) return;
    const block = customBlocks.find((b) => b.index === browser);
    if (!block) return;
    const joined = block.text && !block.text.endsWith("\n") ? block.text + "\n" + text : (block.text ?? "") + text;
    build.run(() => engine.setCustomModBlock(block.index, { text: joined }));
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
          if (activeSet && setDraft.trim() && setDraft !== (activeSet.title ?? "")) build.run(() => engine.renameConfigSet(activeSet.id, setDraft.trim()));
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
        onchange={(e) => build.run(() => engine.selectConfigSet(Number((e.target as HTMLSelectElement).value)))}
        disabled={build.busy > 0}
        title="Config set"
      >
        {#each sets as s}
          <option value={s.id}>{s.title ?? "Default"}</option>
        {/each}
      </select>
    {/if}
    <button class="btn sm ghost" onclick={() => build.run(() => engine.createConfigSet())}>New</button>
    <button class="btn sm ghost" onclick={() => build.run(() => engine.copyConfigSet())}>Copy</button>
    <button
      class="btn sm ghost"
      onclick={() => {
        setDraft = activeSet?.title ?? "";
        renamingSet = true;
      }}>Rename</button
    >
    <button class="btn sm ghost" disabled={sets.length <= 1} onclick={() => activeSet && build.run(() => engine.deleteConfigSet(activeSet.id))}>Delete</button>
    <span class="vr"></span>
    <input class="input" placeholder="Filter options…" bind:value={filter} />
    <label class="chk small" title="Hide options PoB deems irrelevant to this build's skills and gear (set options always show)">
      <input type="checkbox" bind:checked={relevantOnly} disabled={!visibility} />
      Relevant only
    </label>
    <span class="dim small">
      {#if visibility}
        {Object.values(visibility).filter(Boolean).length} of {options.length} options apply to this build
      {/if}
    </span>
  </div>
  <div class="scroll">
    <div class="section">
      <button class="shead" onclick={() => toggle("__custom")}>
        <span class="caret" class:open={!collapsed.has("__custom")}>▸</span>
        <span>Custom Modifiers</span>
        <span class="dim num">{customBlocks.length}</span>
      </button>
      {#if !collapsed.has("__custom")}
        <div class="blocks">
          {#each customBlocks as b (b.index)}
            <div class="block" class:off={!b.enabled}>
              <div class="bhead">
                <input
                  type="checkbox"
                  checked={b.enabled}
                  title="Enable this mod group"
                  onchange={(e) => build.run(() => engine.setCustomModBlock(b.index, { enabled: (e.target as HTMLInputElement).checked }))}
                />
                <input
                  class="input btitle"
                  value={b.title ?? ""}
                  placeholder="Group name"
                  onchange={(e) => build.run(() => engine.setCustomModBlock(b.index, { title: (e.target as HTMLInputElement).value }))}
                />
                <button class="btn sm ghost" onclick={() => openBrowser(b.index)} title="Browse supported mod lines from tree nodes and item mods">Browse…</button>
                <button class="btn sm ghost" disabled={customBlocks.length <= 1 && !b.text} onclick={() => build.run(() => engine.deleteCustomModBlock(b.index))}>Delete</button>
              </div>
              <textarea
                class="bmods mono"
                rows={Math.max(3, b.lines.length + 1)}
                value={b.text}
                placeholder="One modifier per line, e.g. +50 to maximum Life"
                spellcheck="false"
                onchange={(e) => build.run(() => engine.setCustomModBlock(b.index, { text: (e.target as HTMLTextAreaElement).value }))}
              ></textarea>
              {#if badLines(b).length}
                <div class="bstatus">
                  {#each badLines(b) as l}
                    <div class="bline" class:partial={l.status === "partial"}>
                      <span class="mark">{l.status === "partial" ? "~" : "✕"}</span>
                      <span class="mono">{l.text.trim()}</span>
                      <span class="dim">{l.status === "partial" ? "partially recognised" : "not recognised"}</span>
                    </div>
                  {/each}
                </div>
              {/if}
            </div>
          {/each}
          <button class="btn sm ghost addblock" onclick={() => build.run(() => engine.addCustomModBlock())}>Add mod group</button>
        </div>
      {/if}
    </div>
    {#each sections as s}
      <div class="section">
        <button class="shead" onclick={() => toggle(s.name)}>
          <span class="caret" class:open={!collapsed.has(s.name)}>▸</span>
          <span>{s.name}</span>
          <span class="dim num">{s.items.length}</span>
        </button>
        {#if !collapsed.has(s.name)}
          <div class="items">
            {#each s.items as o}
              {@const v = config[o.var]}
              <label class="opt" class:set={v !== undefined && v !== null && v !== false} title={o.tooltip ?? o.var}>
                <span class="olabel"><PobText text={o.label ?? o.var} /></span>
                {#if o.type === "check"}
                  <input type="checkbox" checked={v === true} onchange={(e) => set(o, (e.target as HTMLInputElement).checked ? true : null)} />
                {:else if o.type === "list" && o.list}
                  <select class="select sm" value={v ?? ""} onchange={(e) => { const raw = (e.target as HTMLSelectElement).value; const opt = o.list!.find((x) => String(x.val ?? "") === raw); set(o, opt ? opt.val : null); }}>
                    <option value="">{placeholder[o.var] != null ? `(${o.list.find((x) => String(x.val) === String(placeholder[o.var]))?.label ?? placeholder[o.var]})` : "—"}</option>
                    {#each o.list as e}
                      <option value={String(e.val ?? "")}>{e.label}</option>
                    {/each}
                  </select>
                {:else if o.type === "count" || o.type === "integer" || o.type === "countAllowZero"}
                  <input class="input sm num" type="number" value={v ?? ""} placeholder={placeholder[o.var] != null ? String(placeholder[o.var]) : ""} onchange={(e) => { const s = (e.target as HTMLInputElement).value; set(o, s === "" ? null : Number(s)); }} />
                {:else}
                  <input class="input sm" type="text" value={v ?? ""} placeholder={placeholder[o.var] != null ? String(placeholder[o.var]) : ""} onchange={(e) => { const s = (e.target as HTMLInputElement).value; set(o, s === "" ? null : s); }} />
                {/if}
              </label>
            {/each}
          </div>
        {/if}
      </div>
    {/each}
  </div>
</div>

{#if browser != null}
  <div class="overlay" role="presentation" onclick={() => (browser = null)} onkeydown={(e) => e.key === "Escape" && (browser = null)}>
    <div class="modal" role="dialog" aria-label="Mod browser" tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.key === "Escape" && (browser = null)}>
      <div class="mhead">
        <span class="label">Mod browser</span>
        <span class="dim small">Supported lines from tree nodes and item modifiers — click to add</span>
        <button class="btn sm ghost" onclick={() => (browser = null)}>Close</button>
      </div>
      <!-- svelte-ignore a11y_autofocus -->
      <input class="input msearch" placeholder="Search mods…" bind:value={browserQuery} autofocus />
      <div class="mlist">
        {#if !browserMods}
          <div class="dim small pad">Loading…</div>
        {:else if !browserList.length}
          <div class="dim small pad">No matching modifiers found</div>
        {:else}
          {#each browserList as m}
            <button class="mrow" title={m.sources.join(", ")} onclick={() => addModFromBrowser(m.text)}>{m.text}</button>
          {/each}
          {#if browserMods.length > browserList.length && !browserQuery.trim()}
            <div class="dim small pad">{browserMods.length - browserList.length} more — search to narrow down</div>
          {/if}
        {/if}
      </div>
    </div>
  </div>
{/if}

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
    gap: 8px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--line-0);
    background: var(--bg-1);
  }
  .toolbar .input {
    width: 220px;
  }
  .setsel {
    width: 160px;
  }
  .vr {
    width: 1px;
    height: 16px;
    background: var(--line-1);
    margin: 0 4px;
  }
  .scroll {
    flex: 1;
    overflow-y: auto;
  }
  .section {
    border-bottom: 1px solid var(--line-0);
  }
  .shead {
    appearance: none;
    width: 100%;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border: 0;
    background: var(--bg-1);
    color: var(--fg-0);
    font-size: var(--fs-sm);
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    cursor: pointer;
    text-align: left;
    position: sticky;
    top: 0;
    z-index: 1;
  }
  .caret {
    display: inline-block;
    color: var(--fg-3);
    transition: transform 100ms;
  }
  .caret.open {
    transform: rotate(90deg);
  }
  .blocks {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    padding: 10px 12px;
    align-items: flex-start;
  }
  .block {
    width: 380px;
    background: var(--bg-1);
    border: 1px solid var(--line-0);
    border-radius: var(--r-2);
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .block.off {
    opacity: 0.55;
  }
  .bhead {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .btitle {
    flex: 1;
    height: 22px;
    font-size: var(--fs-xs);
  }
  .bmods {
    background: var(--bg-0);
    border: 1px solid var(--line-1);
    border-radius: var(--r-1);
    color: var(--fg-0);
    font-size: var(--fs-xs);
    line-height: 1.5;
    padding: 6px 8px;
    resize: vertical;
    min-height: 60px;
  }
  .bmods:focus {
    outline: none;
    border-color: var(--focus);
  }
  .bstatus {
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: var(--fs-xs);
  }
  .bline {
    display: flex;
    gap: 6px;
    align-items: baseline;
    color: var(--red, #e06c75);
  }
  .bline.partial {
    color: var(--yellow, #d4a04c);
  }
  .bline .mark {
    width: 10px;
    text-align: center;
  }
  .bline .dim {
    margin-left: auto;
  }
  .addblock {
    align-self: flex-start;
  }
  .items {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(380px, 1fr));
    gap: 0 1px;
    background: var(--line-0);
  }
  .opt {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    padding: 4px 12px;
    background: var(--bg-0);
    border-bottom: 1px solid var(--line-0);
    font-size: var(--fs-sm);
    color: var(--fg-2);
    min-height: 30px;
  }
  .opt.set {
    color: var(--fg-0);
  }
  .olabel {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sm {
    height: 22px;
    font-size: var(--fs-xs);
  }
  .input.sm {
    width: 90px;
    text-align: right;
  }
  .select.sm {
    max-width: 200px;
  }
  .small {
    font-size: var(--fs-xs);
  }
  input[type="checkbox"] {
    accent-color: var(--fg-0);
  }
  .chk {
    display: flex;
    align-items: center;
    gap: 5px;
    color: var(--fg-1);
    white-space: nowrap;
  }
  .overlay {
    position: fixed;
    inset: 0;
    background: rgb(0 0 0 / 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }
  .modal {
    width: 640px;
    max-width: 90vw;
    max-height: 78vh;
    display: flex;
    flex-direction: column;
    background: var(--bg-1);
    border: 1px solid var(--line-1);
    border-radius: var(--r-2);
    box-shadow: 0 12px 40px rgb(0 0 0 / 0.5);
  }
  .mhead {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--line-0);
  }
  .mhead .btn {
    margin-left: auto;
  }
  .msearch {
    margin: 10px 12px 0;
  }
  .mlist {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    padding: 8px 6px 10px;
  }
  .mrow {
    appearance: none;
    border: 0;
    background: none;
    text-align: left;
    padding: 3px 8px;
    font-size: var(--fs-xs);
    color: #8888ff;
    cursor: pointer;
    border-radius: 3px;
    white-space: normal;
  }
  .mrow:hover {
    background: var(--bg-active);
    color: var(--fg-0);
  }
  .pad {
    padding: 6px 10px;
  }
</style>
