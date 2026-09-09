<script lang="ts">
  import { untrack } from "svelte";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import {
    engine,
    type AnointInfo,
    type CorruptionInfo,
    type CraftBase,
    type ItemAffixes,
    type ItemDbRow,
    type ItemInfo,
    type ItemRunes,
    type ItemSetInfo,
    type PowerStat,
    type SharedItem,
    type SlotsResponse,
    type TooltipLine,
  } from "$lib/engine.svelte";
  import { build } from "$lib/state/build.svelte";
  import PobText from "$lib/components/PobText.svelte";
  import PobTooltip from "$lib/components/PobTooltip.svelte";

  let slotsResp = $state<SlotsResponse | null>(null);
  let items = $state<ItemInfo[]>([]);
  let itemSets = $state<ItemSetInfo[]>([]);
  let selectedItem = $state<number | null>(null);

  // database browser
  let dbTab = $state<"unique" | "rare">("unique");
  let dbQuery = $state("");
  let dbType = $state("");
  let dbRows = $state<ItemDbRow[]>([]);
  let dbTypes = $state<{ type: string; count: number }[]>([]);
  let dbTotal = $state(0);
  let dbLoading = $state(false);
  let dbLoaded = $state(false);
  let dbBusy = false;
  let dbStamp = 0;

  // edit modal
  let editOpen = $state(false);
  let editText = $state("");
  let editItemId = $state<number | null>(null);
  let editError = $state<string | null>(null);

  // craft modal
  let craftOpen = $state(false);
  let craftData = $state<{ types: string[]; bases: Record<string, CraftBase[]> } | null>(null);
  let craftType = $state("");
  let craftBase = $state("");
  let craftRarity = $state("RARE");
  let craftTitle = $state("New Item");
  let craftEquip = $state(true);

  // selected item detail (tooltip, affixes, runes, modify flags)
  let detail = $state<{ lines: TooltipLine[]; affixes: ItemAffixes | null; runes: ItemRunes | null } | null>(null);
  let anointFlags = $state<AnointInfo | null>(null);
  let corruptInfo = $state<CorruptionInfo | null>(null);
  let catInfo = $state<{ usable: boolean; names: string[]; catalyst: number; quality: number } | null>(null);

  $effect(() => {
    const id = selectedItem;
    build.rev;
    untrack(() => {
      if (id == null) {
        detail = null;
        anointFlags = corruptInfo = catInfo = null;
        return;
      }
      Promise.all([engine.itemTooltip({ itemId: id }), engine.itemAffixes(id), engine.itemRunes(id)])
        .then(([t, a, r]) => {
          if (selectedItem === id) detail = { lines: t.lines, affixes: a.crafted ? a : null, runes: r.socketCount > 0 ? r : null };
        })
        .catch(() => {
          detail = null;
          selectedItem = null;
        });
      Promise.all([engine.itemAnoints(id), engine.itemCorruptions(id), engine.catalystInfo(id)])
        .then(([an, co, ca]) => {
          if (selectedItem === id) {
            anointFlags = an;
            corruptInfo = co;
            catInfo = ca;
          }
        })
        .catch(() => (anointFlags = corruptInfo = catInfo = null));
    });
  });

  // shared items (main.sharedItemList; app-added ones persisted locally)
  const SHARED_KEY = "pob-redux:shared-items";
  let shared = $state<SharedItem[]>([]);
  $effect(() => {
    build.rev;
    engine.getSharedItems().then((r) => (shared = r.items)).catch(() => (shared = []));
  });
  function persistShared(raw: string, add: boolean) {
    try {
      let raws: string[] = JSON.parse(localStorage.getItem(SHARED_KEY) ?? "[]");
      if (add) raws.push(raw);
      else {
        const i = raws.indexOf(raw);
        if (i >= 0) raws.splice(i, 1);
      }
      localStorage.setItem(SHARED_KEY, JSON.stringify(raws));
    } catch {}
  }
  async function addShared(itemId: number) {
    const r = await engine.addSharedItem({ itemId }).catch(() => null);
    if (r) {
      shared = r.items;
      persistShared(r.items[r.items.length - 1].raw, true);
    }
  }
  async function removeShared(it: SharedItem) {
    const r = await engine.removeSharedItem(it.index).catch(() => null);
    if (r) {
      shared = r.items;
      persistShared(it.raw, false);
    }
  }

  // anoint modal
  let anointOpen = $state(false);
  let anointInfo = $state<AnointInfo | null>(null);
  let anointQuery = $state("");
  let anointSlot = $state(1);
  async function openAnoint() {
    if (selectedItem == null) return;
    anointInfo = await engine.itemAnoints(selectedItem, true).catch(() => null);
    anointQuery = "";
    anointSlot = 1;
    anointOpen = anointInfo != null;
  }
  const anointList = $derived.by(() => {
    if (!anointInfo) return [];
    const words = anointQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const list = words.length
      ? anointInfo.nodes.filter((n) => {
          const hay = `${n.name} ${n.stats.join(" ")} ${n.recipe.join(" ")}`.toLowerCase();
          return words.every((w) => hay.includes(w));
        })
      : anointInfo.nodes;
    return list.slice(0, 120);
  });
  async function applyAnoint(nodeId: number | null) {
    if (selectedItem == null) return;
    anointOpen = false;
    await build.run(() => engine.setItemAnoint(selectedItem!, nodeId, anointSlot));
  }

  // corrupt modal
  let corruptOpen = $state(false);
  let corruptSel = $state<string[]>([]);
  let corruptRanges = $state<Record<number, number>>({});
  function openCorrupt() {
    if (!corruptInfo) return;
    corruptSel = Array(corruptInfo.enchantNum).fill("");
    const r: Record<number, number> = {};
    for (const rng of corruptInfo.ranges) r[rng.index] = rng.current;
    corruptRanges = r;
    corruptOpen = true;
  }
  const corruptModList = $derived(corruptInfo ? [...corruptInfo.mods, ...corruptInfo.specialMods] : []);
  function corruptOptions(i: number) {
    const takenGroups = corruptSel.filter((id, j) => j !== i && id).map((id) => corruptModList.find((m) => m.id === id)?.group);
    return corruptModList.filter((m) => !m.group || !takenGroups.includes(m.group));
  }
  async function applyCorrupt(mode: "implicits" | "ranges") {
    if (selectedItem == null) return;
    corruptOpen = false;
    const p: { itemId: number; modIds?: string[]; ranges?: { index: number; value: number }[] } = { itemId: selectedItem };
    if (mode === "implicits") p.modIds = corruptSel.filter(Boolean);
    else p.ranges = Object.entries(corruptRanges).map(([index, value]) => ({ index: Number(index), value }));
    await build.run(() => engine.corruptItem(p));
  }

  // trade search ("find upgrades") modal
  let tradeOpen = $state<string | null>(null);
  let tradeLeagues = $state<{ id: string; text: string }[] | null>(null);
  let tradeLeague = $state("Standard");
  try {
    tradeLeague = localStorage.getItem("pob-redux:trade-league") ?? "Standard";
  } catch {}
  let tradeWeights = $state<{ stat: string; weightMult: number }[]>([{ stat: "FullDPS", weightMult: 1 }]);
  let tradeCorrupted = $state(false);
  let tradeRunes = $state(true);
  let tradeMaxLevel = $state(0);
  let tradeBusy = $state(false);
  let tradeErr = $state<string | null>(null);
  let tradePowerStats = $state<PowerStat[]>([]);
  async function openTrade(slotName: string) {
    tradeErr = null;
    tradeOpen = slotName;
    if (!tradePowerStats.length) engine.powerStats().then((r) => (tradePowerStats = r.stats)).catch(() => {});
    if (!tradeLeagues) {
      engine
        .tradeLeagues()
        .then((r) => {
          tradeLeagues = r.leagues;
          if (!r.leagues.some((l) => l.id === tradeLeague) && r.leagues.length) tradeLeague = r.leagues[0].id;
        })
        .catch(() => (tradeLeagues = null));
    }
  }
  async function runTrade() {
    if (!tradeOpen) return;
    tradeBusy = true;
    tradeErr = null;
    try {
      localStorage.setItem("pob-redux:trade-league", tradeLeague);
    } catch {}
    try {
      await engine.tradeSearchStart({
        slotName: tradeOpen,
        statWeights: tradeWeights.filter((w) => w.weightMult > 0),
        includeCorrupted: tradeCorrupted,
        includeRunes: tradeRunes,
        maxLevel: tradeMaxLevel > 0 ? tradeMaxLevel : undefined,
      });
      for (let i = 0; i < 600; i++) {
        const r = await engine.tradeSearchStep(150);
        if (r.done) break;
      }
      const { query } = await engine.tradeSearchResult();
      const url = `https://www.pathofexile.com/trade2/search/poe2/${encodeURIComponent(tradeLeague)}?q=${encodeURIComponent(query)}`;
      await openUrl(url);
      tradeOpen = null;
    } catch (e) {
      tradeErr = String(e);
    } finally {
      tradeBusy = false;
    }
  }

  async function openCraft() {
    craftOpen = true;
    if (!craftData) {
      craftData = await engine.craftBases().catch(() => null);
      if (craftData) {
        craftType = craftData.types[0] ?? "";
        craftBase = craftData.bases[craftType]?.[0]?.name ?? "";
      }
    }
  }
  async function doCraft() {
    const r = await build.run(() => engine.craftItem({ type: craftType, baseName: craftBase, rarity: craftRarity, title: craftTitle, equip: craftEquip }));
    if (r) {
      craftOpen = false;
      selectedItem = r.itemId;
    }
  }

  function lineStyle(l: TooltipLine): string {
    if (l.size >= 20) return "font-size:13px;font-weight:600";
    if (l.size >= 16) return "font-size:12px";
    return "font-size:11px";
  }

  // tooltip
  let tip = $state<{ lines: TooltipLine[]; x: number; y: number } | null>(null);
  let tipTimer = 0;
  const tipCache = new Map<string, TooltipLine[]>();

  const activeSet = $derived(itemSets.find((s) => s.active));
  const shownSlots = $derived((slotsResp?.slots ?? []).filter((s) => s.shown && !s.inactive));
  const gearSlots = $derived(shownSlots.filter((s) => s.nodeId == null));
  const socketSlots = $derived(shownSlots.filter((s) => s.nodeId != null));
  const selectedEquippedSlot = $derived(selectedItem == null ? null : (items.find((i) => i.id === selectedItem)?.equippedSlot ?? null));

  $effect(() => {
    build.rev;
    tipCache.clear();
    tip = null;
    Promise.all([engine.listSlots(), engine.getItems(), engine.listItemSets()]).then(([s, i, sets]) => {
      slotsResp = s;
      items = i.items;
      itemSets = sets.itemSets;
    });
  });

  $effect(() => {
    const q = dbQuery;
    const t = dbType;
    const tab = dbTab;
    untrack(() => {
      if (dbBusy) return;
      dbBusy = true;
      const stamp = ++dbStamp;
      dbLoading = !dbLoaded;
      engine
        .itemDbList({ db: tab, query: q, type: t || undefined, limit: 80 })
        .then((r) => {
          if (stamp === dbStamp) {
            dbRows = r.items;
            dbTypes = r.types;
            dbTotal = r.total;
            dbLoaded = true;
          }
        })
        .catch(() => {})
        .finally(() => {
          dbBusy = false;
          dbLoading = false;
        });
    });
  });

  function equipSlot(slot: string, e: Event) {
    const id = Number((e.target as HTMLSelectElement).value);
    build.run(() => engine.equipItem(slot, id));
  }

  function showTip(e: MouseEvent, key: string, fetch: () => Promise<{ lines: TooltipLine[] }>) {
    clearTimeout(tipTimer);
    const x = Math.min(e.clientX + 16, window.innerWidth - 560);
    const y = Math.min(e.clientY + 12, Math.max(window.innerHeight - 520, 40));
    tipTimer = window.setTimeout(async () => {
      const cached = tipCache.get(key);
      if (cached) {
        tip = { lines: cached, x, y };
        return;
      }
      try {
        const r = await fetch();
        tipCache.set(key, r.lines);
        tip = { lines: r.lines, x, y };
      } catch {
        tip = null;
      }
    }, 120);
  }
  function hideTip() {
    clearTimeout(tipTimer);
    tip = null;
  }

  async function openEdit(itemId: number | null) {
    editError = null;
    editItemId = itemId;
    if (itemId != null) {
      const r = await engine.itemRaw(itemId).catch(() => null);
      editText = r?.raw ?? "";
    } else {
      editText = "";
    }
    editOpen = true;
  }
  async function saveEdit(asNew: boolean) {
    editError = null;
    try {
      await engine.itemEdit(editText, asNew ? undefined : (editItemId ?? undefined));
      await build.sync();
      editOpen = false;
    } catch (e) {
      editError = String(e);
    }
  }

  const rarityColor: Record<string, string> = {
    UNIQUE: "var(--c-unique)",
    RARE: "var(--c-rare)",
    MAGIC: "var(--c-magic)",
    NORMAL: "var(--c-normal)",
    RELIC: "var(--c-gem)",
  };
</script>

{#snippet slotRow(s: SlotsResponse["slots"][number])}
  <div
    class="slot"
    class:jewel={s.nodeId != null}
    role="note"
    onmouseenter={(e) => s.itemId !== 0 && showTip(e, `i${s.itemId}`, () => engine.itemTooltip({ itemId: s.itemId }))}
    onmouseleave={hideTip}
  >
    <span class="sname">{s.label ?? s.slot}</span>
    <select class="select" value={s.itemId} onchange={(e) => equipSlot(s.slot, e)} disabled={build.busy > 0} style:color={rarityColor[s.itemRarity ?? ""] ?? undefined}>
      <option value={0}>—</option>
      {#each items as it}
        <option value={it.id}>{it.name}</option>
      {/each}
    </select>
  </div>
{/snippet}

<div class="page">
  <div class="toolbar">
    <select class="select setsel" value={activeSet?.id ?? 1} onchange={(e) => build.run(() => engine.selectItemSet(Number((e.target as HTMLSelectElement).value)))} disabled={build.busy > 0} title="Item set">
      {#each itemSets as s}
        <option value={s.id}>{s.title}</option>
      {/each}
    </select>
    <button class="btn sm ghost" onclick={() => build.run(() => engine.createItemSet())}>New</button>
    <button class="btn sm ghost" onclick={() => build.run(() => engine.copyItemSet())}>Copy</button>
    <button
      class="btn sm ghost"
      onclick={() => {
        const t = prompt("Item set name", activeSet?.title ?? "");
        if (t && activeSet) build.run(() => engine.renameItemSet(activeSet.id, t));
      }}>Rename</button
    >
    <button class="btn sm ghost" disabled={itemSets.length <= 1} onclick={() => activeSet && build.run(() => engine.deleteItemSet(activeSet.id))}>Delete</button>
    <span class="vr"></span>
    <span class="label">Weapon set</span>
    <div class="wset">
      <button class="btn sm" class:on={!slotsResp?.useSecondWeaponSet} onclick={() => build.run(() => engine.setWeaponSet(1))}>I</button>
      <button class="btn sm" class:on={slotsResp?.useSecondWeaponSet} onclick={() => build.run(() => engine.setWeaponSet(2))}>II</button>
    </div>
    <span class="vr"></span>
    <button class="btn sm" onclick={openCraft}>Craft item…</button>
    <button class="btn sm" onclick={() => openEdit(null)}>New item from text</button>
  </div>

  <div class="cols">
    <section class="col slots">
      <div class="panel-head"><span class="label">Equipment</span></div>
      <div class="scroll">
        {#each gearSlots as s (s.slot)}
          {@render slotRow(s)}
        {/each}
        {#if socketSlots.length}
          <div class="subhead" title="Jewel sockets allocated on the tree; each takes a jewel">
            <span>Jewel sockets</span>
            <span class="dim num">{socketSlots.length}</span>
          </div>
          {#each socketSlots as s (s.slot)}
            {@render slotRow(s)}
          {/each}
        {/if}
      </div>
    </section>

    <section class="col">
      <div class="panel-head"><span class="label">Items in build</span><span class="dim num">{items.length}</span></div>
      <div class="scroll">
        {#each items as it (it.id)}
          <div
            class="item"
            class:sel={selectedItem === it.id}
            role="note"
            onmouseenter={(e) => showTip(e, `i${it.id}`, () => engine.itemTooltip({ itemId: it.id }))}
            onmouseleave={hideTip}
          >
            <button class="iname" style:color={rarityColor[it.rarity ?? ""] ?? "var(--fg-1)"} onclick={() => (selectedItem = it.id)}>
              {it.name}
            </button>
            <span class="itag dim">{it.equippedSlot ?? ""}</span>
            <span class="iops">
              {#if !it.equippedSlot && it.primarySlot}
                <button class="mini w" title={`Equip in ${it.primarySlot}`} onclick={() => it.primarySlot && build.run(() => engine.equipItem(it.primarySlot!, it.id))}>Equip</button>
              {/if}
              <button class="mini w" onclick={() => openEdit(it.id)}>Edit</button>
              <button class="mini x" title="Delete item" onclick={() => build.run(() => engine.deleteItem(it.id))}>✕</button>
            </span>
          </div>
        {/each}
        {#if items.length === 0}
          <div class="dim small pad">No items yet.</div>
        {/if}
      </div>
      <div class="panel-head">
        <span class="label">Shared items</span>
        <span class="dim num">{shared.length}</span>
      </div>
      <div class="scroll sharedlist" title="Shared items are available in every build. Items from PoB's own settings show here too; ones you add are kept by this app.">
        {#each shared as it (it.index)}
          <div class="item">
            <span class="iname" style:color={rarityColor[it.rarity ?? ""] ?? "var(--fg-1)"}>{it.name}</span>
            <span class="itag dim">{it.baseName ?? ""}</span>
            <span class="iops">
              <button class="mini w" title="Copy into this build and equip" onclick={() => build.run(() => engine.equipSharedItem(it.index))}>Equip</button>
              <button class="mini x" title="Remove from shared items" onclick={() => removeShared(it)}>✕</button>
            </span>
          </div>
        {/each}
        {#if shared.length === 0}
          <div class="dim small pad">Nothing shared yet.</div>
        {/if}
      </div>
    </section>

    <section class="col db">
      {#if selectedItem != null && detail}
        <div class="panel-head">
          <span class="label">Item</span>
          <button class="btn sm ghost" onclick={() => (selectedItem = null)}>Back to database</button>
        </div>
        <div class="scroll detailpane">
          <div class="ttbox">
            {#each detail.lines as l}
              {#if l.sep}
                <div class="tsep"></div>
              {:else}
                <div class="tline" class:tcenter={l.center} style={lineStyle(l)}><PobText text={l.text} /></div>
              {/if}
            {/each}
          </div>

          {#if detail.affixes}
            <div class="craftsec">
              <div class="label">Prefixes</div>
              {#each detail.affixes.prefixes as slot (slot.index)}
                <div class="affix">
                  <select class="select" value={slot.modId} onchange={(e) => selectedItem != null && build.run(() => engine.setItemAffix(selectedItem!, "prefixes", slot.index, (e.target as HTMLSelectElement).value, slot.range))}>
                    <option value="None">— empty prefix —</option>
                    {#each slot.options as o (o.modId)}
                      <option value={o.modId}>{(o.affix ? o.affix + "  ·  " : "") + o.label}</option>
                    {/each}
                  </select>
                  {#if slot.modId !== "None"}
                    <input
                      class="range"
                      type="range"
                      min="0"
                      max="100"
                      value={Math.round(slot.range * 100)}
                      title={`Roll: ${Math.round(slot.range * 100)}%`}
                      onchange={(e) => selectedItem != null && build.run(() => engine.setItemAffix(selectedItem!, "prefixes", slot.index, slot.modId, Number((e.target as HTMLInputElement).value) / 100))}
                    />
                  {/if}
                </div>
              {/each}
              <div class="label">Suffixes</div>
              {#each detail.affixes.suffixes as slot (slot.index)}
                <div class="affix">
                  <select class="select" value={slot.modId} onchange={(e) => selectedItem != null && build.run(() => engine.setItemAffix(selectedItem!, "suffixes", slot.index, (e.target as HTMLSelectElement).value, slot.range))}>
                    <option value="None">— empty suffix —</option>
                    {#each slot.options as o (o.modId)}
                      <option value={o.modId}>{(o.affix ? o.affix + "  ·  " : "") + o.label}</option>
                    {/each}
                  </select>
                  {#if slot.modId !== "None"}
                    <input
                      class="range"
                      type="range"
                      min="0"
                      max="100"
                      value={Math.round(slot.range * 100)}
                      title={`Roll: ${Math.round(slot.range * 100)}%`}
                      onchange={(e) => selectedItem != null && build.run(() => engine.setItemAffix(selectedItem!, "suffixes", slot.index, slot.modId, Number((e.target as HTMLInputElement).value) / 100))}
                    />
                  {/if}
                </div>
              {/each}
            </div>
          {/if}

          {#if detail.runes}
            <div class="craftsec">
              <div class="label">Runes</div>
              {#each detail.runes.runes as rune, i}
                <div class="affix">
                  <select class="select" value={rune} onchange={(e) => selectedItem != null && build.run(() => engine.setItemRune(selectedItem!, i + 1, (e.target as HTMLSelectElement).value))}>
                    {#each detail.runes.options as o (o.name)}
                      <option value={o.name} title={o.lines.join("\n")}>{o.name === "None" ? "— empty socket —" : `${o.name}  ·  ${o.label ?? o.lines[0] ?? ""}`}</option>
                    {/each}
                  </select>
                </div>
              {/each}
            </div>
          {/if}

          <div class="craftsec">
            <div class="label">Modify</div>
            <div class="modrow">
              {#if anointFlags?.anointable}
                <button class="btn sm" onclick={openAnoint}>
                  {anointFlags.current.length ? `Anoint: ${anointFlags.current.join(", ")}` : "Anoint…"}
                </button>
              {/if}
              {#if corruptInfo?.corruptible || corruptInfo?.corrupted}
                <button class="btn sm" onclick={openCorrupt}>{corruptInfo.corrupted ? "Corrupted — modify…" : "Corrupt…"}</button>
              {/if}
              <button class="btn sm ghost" onclick={() => selectedItem != null && addShared(selectedItem)}>Add to shared</button>
              {#if selectedEquippedSlot}
                <button class="btn sm ghost" title="Generate a weighted trade-site search for upgrades in this slot" onclick={() => openTrade(selectedEquippedSlot!)}>Find upgrades on trade…</button>
              {/if}
            </div>
            {#if catInfo?.usable}
              <div class="affix">
                <select
                  class="select"
                  value={catInfo.catalyst}
                  title="Catalyst"
                  onchange={(e) => selectedItem != null && build.run(() => engine.setItemProps(selectedItem!, { catalyst: Number((e.target as HTMLSelectElement).value) }))}
                >
                  <option value={0}>— no catalyst —</option>
                  {#each catInfo.names as n, i}
                    <option value={i + 1}>{n} Catalyst</option>
                  {/each}
                </select>
                {#if catInfo.catalyst > 0}
                  <input
                    class="input catq num"
                    type="number"
                    min="0"
                    max="100"
                    value={catInfo.quality}
                    title="Catalyst quality %"
                    onchange={(e) => selectedItem != null && build.run(() => engine.setItemProps(selectedItem!, { catalystQuality: Number((e.target as HTMLInputElement).value) }))}
                  />
                {/if}
              </div>
            {/if}
          </div>
        </div>
      {:else}
      <div class="panel-head">
        <span class="tabs2">
          <button class="t2" class:on={dbTab === "unique"} onclick={() => { dbTab = "unique"; dbType = ""; }}>Uniques</button>
          <button class="t2" class:on={dbTab === "rare"} onclick={() => { dbTab = "rare"; dbType = ""; }}>Rare templates</button>
        </span>
        <span class="dim num">{dbTotal}</span>
      </div>
      <div class="dbbar">
        <input class="input" placeholder="Search…" bind:value={dbQuery} />
        <select class="select typesel" bind:value={dbType}>
          <option value="">All types</option>
          {#each dbTypes as t}
            <option value={t.type}>{t.type} ({t.count})</option>
          {/each}
        </select>
      </div>
      <div class="scroll">
        {#if dbLoading}
          <div class="dim small pad">Parsing item database (one-time)…</div>
        {/if}
        {#each dbRows as row (dbTab + row.name)}
          <div
            class="item"
            role="note"
            onmouseenter={(e) => showTip(e, `d${dbTab}:${row.name}:${build.rev}`, () => engine.itemTooltip({ db: dbTab, name: row.name }))}
            onmouseleave={hideTip}
          >
            <span class="iname" style:color={rarityColor[row.rarity ?? ""] ?? "var(--fg-1)"}>{row.name}</span>
            <span class="itag dim">{row.baseName ?? row.type}</span>
            <span class="iops">
              <button class="mini w" title="Add to build and equip" onclick={() => build.run(() => engine.itemDbEquip(dbTab, row.name))}>Equip</button>
            </span>
          </div>
        {/each}
        {#if !dbLoading && dbRows.length === 0}
          <div class="dim small pad">No matches.</div>
        {/if}
      </div>
      {/if}
    </section>
  </div>

  {#if craftOpen}
    <div class="modal">
      <div class="panel dialog craftdlg">
        <div class="label">Craft item</div>
        <div class="crow">
          <span class="clabel">Rarity</span>
          <select class="select" bind:value={craftRarity}>
            <option value="NORMAL">Normal</option>
            <option value="MAGIC">Magic</option>
            <option value="RARE">Rare</option>
            <option value="UNIQUE">Unique</option>
          </select>
        </div>
        {#if craftRarity === "RARE" || craftRarity === "UNIQUE"}
          <div class="crow"><span class="clabel">Name</span><input class="input" bind:value={craftTitle} /></div>
        {/if}
        <div class="crow">
          <span class="clabel">Type</span>
          <select class="select" bind:value={craftType} onchange={() => (craftBase = craftData?.bases[craftType]?.[0]?.name ?? "")}>
            {#each craftData?.types ?? [] as t}
              <option value={t}>{t}</option>
            {/each}
          </select>
        </div>
        <div class="crow">
          <span class="clabel">Base</span>
          <select class="select" bind:value={craftBase}>
            {#each craftData?.bases[craftType] ?? [] as b (b.name)}
              <option value={b.name}>{b.name}{b.subType ? ` (${b.subType})` : ""}</option>
            {/each}
          </select>
        </div>
        <div class="crow">
          <span class="clabel"></span>
          <label class="chk small"><input type="checkbox" bind:checked={craftEquip} /> Equip after creating</label>
        </div>
        <div class="actions">
          <button class="btn primary" onclick={doCraft} disabled={!craftBase || build.busy > 0}>Create</button>
          <button class="btn ghost" onclick={() => (craftOpen = false)}>Cancel</button>
        </div>
      </div>
    </div>
  {/if}

  {#if editOpen}
    <div class="modal">
      <div class="panel dialog">
        <div class="label">{editItemId != null ? "Edit item" : "New item"}</div>
        <textarea class="textarea" rows="18" bind:value={editText} placeholder={"Rarity: Rare\nItem name\nBase Type\n...mod lines..."}></textarea>
        {#if editError}<div class="err small">{editError}</div>{/if}
        <div class="actions">
          {#if editItemId != null}
            <button class="btn" onclick={() => saveEdit(true)}>Save as copy</button>
          {/if}
          <button class="btn primary" onclick={() => saveEdit(editItemId == null)} disabled={!editText.trim()}>
            {editItemId != null ? "Save" : "Create"}
          </button>
          <button class="btn ghost" onclick={() => (editOpen = false)}>Cancel</button>
        </div>
      </div>
    </div>
  {/if}

  {#if anointOpen && anointInfo}
    <div class="modal">
      <div class="panel dialog anointdlg">
        <div class="label">Anoint item</div>
        <div class="crow">
          <input class="input grow2" placeholder="Search notables…" bind:value={anointQuery} />
          {#if anointInfo.slots > 1}
            <select class="select" bind:value={anointSlot} title="Anoint slot">
              {#each Array(anointInfo.slots) as _, i}
                <option value={i + 1}>Slot {i + 1}</option>
              {/each}
            </select>
          {/if}
        </div>
        <div class="anointlist">
          {#each anointList as n (n.id)}
            <button class="arow" class:alloc={n.allocated} title={n.stats.join("\n")} onclick={() => applyAnoint(n.id)}>
              <span class="aname">{n.name}</span>
              <span class="dim small">{n.recipe.join(" + ")}</span>
            </button>
          {/each}
          {#if !anointList.length}
            <div class="dim small pad">No matching notables.</div>
          {/if}
        </div>
        <div class="actions">
          {#if anointInfo.current.length}
            <button class="btn" onclick={() => applyAnoint(null)}>Remove {anointInfo.current[anointSlot - 1] ?? "anoint"}</button>
          {/if}
          <button class="btn ghost" onclick={() => (anointOpen = false)}>Cancel</button>
        </div>
      </div>
    </div>
  {/if}

  {#if corruptOpen && corruptInfo}
    <div class="modal">
      <div class="panel dialog">
        <div class="label">Corrupt item</div>
        {#each corruptSel as sel, i}
          <div class="crow">
            <span class="clabel">Implicit {i + 1}</span>
            <select class="select grow2" value={sel} onchange={(e) => (corruptSel[i] = (e.target as HTMLSelectElement).value)}>
              <option value="">— none —</option>
              {#each corruptOptions(i) as m (m.id)}
                <option value={m.id}>{m.label}</option>
              {/each}
            </select>
          </div>
        {/each}
        {#if corruptInfo.ranges.length}
          <div class="label">Roll ranges (0.78–1.22)</div>
          {#each corruptInfo.ranges as r (r.index)}
            <div class="crow">
              <input
                class="range grow2"
                type="range"
                min="0.78"
                max="1.22"
                step="0.01"
                value={corruptRanges[r.index] ?? 1}
                onchange={(e) => (corruptRanges[r.index] = Number((e.target as HTMLInputElement).value))}
              />
              <span class="num small">{(corruptRanges[r.index] ?? 1).toFixed(2)}</span>
              <span class="dim small rline">{r.line}</span>
            </div>
          {/each}
        {/if}
        <div class="actions">
          <button class="btn primary" onclick={() => applyCorrupt("implicits")} disabled={build.busy > 0}>Corrupt with implicits</button>
          {#if corruptInfo.ranges.length}
            <button class="btn" onclick={() => applyCorrupt("ranges")} disabled={build.busy > 0}>Corrupt rerolling ranges</button>
          {/if}
          <button class="btn ghost" onclick={() => (corruptOpen = false)}>Cancel</button>
        </div>
      </div>
    </div>
  {/if}

  {#if tradeOpen}
    <div class="modal">
      <div class="panel dialog">
        <div class="label">Find upgrades — {tradeOpen}</div>
        <div class="crow">
          <span class="clabel">League</span>
          {#if tradeLeagues}
            <select class="select grow2" bind:value={tradeLeague}>
              {#each tradeLeagues as l (l.id)}
                <option value={l.id}>{l.text}</option>
              {/each}
            </select>
          {:else}
            <input class="input grow2" bind:value={tradeLeague} placeholder="League name" />
          {/if}
        </div>
        {#each tradeWeights as w, i}
          <div class="crow">
            <span class="clabel">{i === 0 ? "Weigh by" : ""}</span>
            <select class="select grow2" value={w.stat} onchange={(e) => (tradeWeights[i] = { ...w, stat: (e.target as HTMLSelectElement).value })}>
              <option value="FullDPS">Full DPS</option>
              {#each tradePowerStats as s (s.stat)}
                <option value={s.stat}>{s.label}</option>
              {/each}
            </select>
            <input
              class="input catq num"
              type="number"
              min="0"
              max="10"
              step="0.1"
              value={w.weightMult}
              title="Weight multiplier"
              onchange={(e) => (tradeWeights[i] = { ...w, weightMult: Number((e.target as HTMLInputElement).value) })}
            />
            {#if tradeWeights.length > 1}
              <button class="mini x" onclick={() => (tradeWeights = tradeWeights.filter((_, j) => j !== i))}>✕</button>
            {/if}
          </div>
        {/each}
        <div class="crow">
          <span class="clabel"></span>
          <button class="btn sm ghost" onclick={() => (tradeWeights = [...tradeWeights, { stat: "TotalEHP", weightMult: 0.5 }])}>Add stat</button>
        </div>
        <div class="crow">
          <span class="clabel"></span>
          <label class="chk small"><input type="checkbox" bind:checked={tradeCorrupted} /> Include corrupted implicits</label>
          <label class="chk small"><input type="checkbox" bind:checked={tradeRunes} /> Include runes</label>
        </div>
        <div class="crow">
          <span class="clabel">Max level</span>
          <input class="input catq num" type="number" min="0" max="100" bind:value={tradeMaxLevel} title="Required-level cap; 0 = no cap" />
        </div>
        {#if tradeErr}<div class="err small">{tradeErr}</div>{/if}
        <div class="actions">
          <button class="btn primary" onclick={runTrade} disabled={tradeBusy}>{tradeBusy ? "Scoring mods…" : "Generate & open"}</button>
          <button class="btn ghost" onclick={() => (tradeOpen = null)} disabled={tradeBusy}>Cancel</button>
        </div>
      </div>
    </div>
  {/if}

  {#if tip}
    <PobTooltip lines={tip.lines} x={tip.x} y={tip.y} />
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
    width: 190px;
    height: 24px;
    font-size: var(--fs-xs);
  }
  .vr {
    width: 1px;
    height: 16px;
    background: var(--line-1);
    margin: 0 4px;
  }
  .wset {
    display: inline-flex;
  }
  .subhead {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    padding: 10px 12px 4px;
    font-size: var(--fs-xs);
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--fg-3);
  }
  .sharedlist {
    flex: 0 0 auto;
    max-height: 200px;
  }
  .modrow {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .catq {
    width: 64px;
    text-align: right;
  }
  .grow2 {
    flex: 1;
    min-width: 0;
  }
  .anointdlg {
    width: 520px;
  }
  .anointlist {
    max-height: 46vh;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    border: 1px solid var(--line-0);
    border-radius: var(--r-1);
  }
  .arow {
    appearance: none;
    border: 0;
    border-bottom: 1px solid var(--line-0);
    background: none;
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 10px;
    padding: 4px 8px;
    color: var(--fg-1);
    font-size: var(--fs-sm);
    text-align: left;
    cursor: pointer;
  }
  .arow:hover {
    background: var(--bg-2);
    color: var(--fg-0);
  }
  .arow.alloc .aname {
    color: var(--ok);
  }
  .rline {
    max-width: 220px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .wset .btn {
    border-radius: 0;
  }
  .wset .btn:first-child {
    border-radius: var(--r-1) 0 0 var(--r-1);
  }
  .wset .btn:last-child {
    border-radius: 0 var(--r-1) var(--r-1) 0;
    border-left: 0;
  }
  .btn.on {
    color: var(--fg-0);
    border-color: var(--fg-2);
    background: var(--bg-active);
  }
  .cols {
    flex: 1;
    display: grid;
    grid-template-columns: 340px 1fr 1fr;
    min-height: 0;
  }
  .col {
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-right: 1px solid var(--line-0);
  }
  .col:last-child {
    border-right: 0;
  }
  .scroll {
    flex: 1;
    overflow-y: auto;
  }
  .slot {
    display: grid;
    grid-template-columns: 104px 1fr;
    align-items: center;
    gap: 8px;
    padding: 3px 10px;
    border-bottom: 1px solid var(--line-0);
  }
  .slot .select {
    height: 24px;
    font-size: var(--fs-xs);
  }
  .slot.jewel .sname {
    color: var(--fg-3);
  }
  .sname {
    font-size: var(--fs-xs);
    color: var(--fg-2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .item {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    align-items: center;
    gap: 10px;
    padding: 4px 10px;
    border-bottom: 1px solid var(--line-0);
    font-size: var(--fs-sm);
  }
  .item:hover {
    background: var(--bg-2);
  }
  .item.sel {
    background: var(--bg-2);
    box-shadow: inset 2px 0 0 var(--fg-0);
  }
  .iname {
    appearance: none;
    border: 0;
    background: none;
    padding: 0;
    font-size: var(--fs-sm);
    text-align: left;
    cursor: default;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .itag {
    font-size: var(--fs-2xs);
    white-space: nowrap;
  }
  .iops {
    display: inline-flex;
    gap: 4px;
    visibility: hidden;
  }
  .item:hover .iops {
    visibility: visible;
  }
  .mini {
    appearance: none;
    border: 1px solid var(--line-1);
    background: var(--bg-2);
    color: var(--fg-2);
    font-size: var(--fs-2xs);
    height: 18px;
    padding: 0 6px;
    cursor: pointer;
    border-radius: 3px;
  }
  .mini:hover {
    color: var(--fg-0);
    border-color: var(--line-2);
  }
  .mini.x:hover {
    color: var(--bad);
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
  .dbbar {
    display: flex;
    gap: 6px;
    padding: 8px 10px;
    border-bottom: 1px solid var(--line-0);
  }
  .dbbar .input {
    flex: 1;
  }
  .typesel {
    width: 170px;
    font-size: var(--fs-xs);
  }
  .modal {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    background: var(--backdrop);
    z-index: 5;
  }
  .dialog {
    width: 560px;
    padding: 16px 18px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .dialog .textarea {
    width: 100%;
  }
  .actions {
    display: flex;
    gap: 6px;
    justify-content: flex-end;
  }
  .err {
    color: var(--bad);
  }
  .small {
    font-size: var(--fs-xs);
  }
  .pad {
    padding: 10px 12px;
  }
  .detailpane {
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .ttbox {
    padding: 10px 12px;
    border: 1px solid var(--line-0);
    border-radius: var(--r-2);
    background: var(--bg-1);
    line-height: 1.45;
  }
  .tline {
    color: var(--fg-1);
    white-space: pre-wrap;
  }
  .tcenter {
    text-align: center;
  }
  .tsep {
    height: 1px;
    background: var(--line-1);
    margin: 6px 0;
  }
  .craftsec {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .affix {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .affix .select {
    height: 24px;
    font-size: var(--fs-xs);
    width: 100%;
  }
  .range {
    width: 100%;
    accent-color: var(--fg-1);
    height: 14px;
  }
  .craftdlg {
    width: 460px;
  }
  .crow {
    display: grid;
    grid-template-columns: 64px 1fr;
    align-items: center;
    gap: 10px;
  }
  .clabel {
    font-size: var(--fs-xs);
    color: var(--fg-2);
    text-align: right;
  }
  .chk {
    display: flex;
    align-items: center;
    gap: 5px;
    color: var(--fg-2);
  }
</style>
