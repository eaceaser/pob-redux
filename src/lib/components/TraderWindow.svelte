<script lang="ts">
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { writeText } from "@tauri-apps/plugin-clipboard-manager";
  import { engine, type PowerStat, type SlotInfo } from "$lib/engine.svelte";
  import { build } from "$lib/state/build.svelte";
  import { game } from "$lib/state/game.svelte";

  let { onclose, focusSlot = null }: { onclose: () => void; focusSlot?: string | null } = $props();

  interface Row {
    slot: string;
    label: string;
    itemName: string | null;
    itemRarity: string | null;
    url: string | null;
    error: string | null;
  }

  const rarityColor: Record<string, string> = {
    UNIQUE: "var(--c-unique)",
    RARE: "var(--c-rare)",
    MAGIC: "var(--c-magic)",
    NORMAL: "var(--c-normal)",
    RELIC: "var(--c-gem)",
  };

  const KEY = "pob-redux:trader";

  interface Saved {
    league: string;
    status: string;
    weights: { stat: string; weightMult: number }[];
    corrupted: boolean;
    runes: boolean;
    mirrored: boolean;
    maxLevel: number;
    jewelType: string;
  }

  function load(): Saved {
    const fallback: Saved = {
      league: "Standard",
      status: "online",
      weights: [{ stat: "FullDPS", weightMult: 1 }],
      corrupted: false,
      runes: true,
      mirrored: false,
      maxLevel: 0,
      jewelType: "Base",
    };
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) return { ...fallback, ...(JSON.parse(raw) as Partial<Saved>) };
      // Carry over the league the old single-slot dialog remembered.
      const old = localStorage.getItem("pob-redux:trade-league");
      if (old) fallback.league = old;
    } catch {}
    return fallback;
  }

  const saved = load();
  let league = $state(saved.league);
  let status = $state(saved.status);
  let weights = $state(saved.weights);
  let corrupted = $state(saved.corrupted);
  let runes = $state(saved.runes);
  let mirrored = $state(saved.mirrored);
  let maxLevel = $state(saved.maxLevel);
  let jewelType = $state(saved.jewelType);

  let leagues = $state<{ id: string; text: string }[] | null>(null);
  let statuses = $state<{ id: string; label: string }[]>([]);
  let powerStats = $state<PowerStat[]>([]);
  let rows = $state<Row[]>([]);
  let busySlot = $state<string | null>(null);
  let runAll = $state(false);
  let done = $state(0);
  let note = $state("");
  let cancel = false;

  function remember() {
    try {
      localStorage.setItem(KEY, JSON.stringify({ league, status, weights, corrupted, runes, mirrored, maxLevel, jewelType }));
      localStorage.setItem("pob-redux:trade-league", league);
    } catch {}
  }

  function rowsFrom(slots: SlotInfo[]): Row[] {
    return slots
      .filter((s) => s.shown && !s.inactive)
      .map((s) => ({
        slot: s.slot,
        label: s.label ?? s.slot,
        itemName: s.itemName,
        itemRarity: s.itemRarity,
        url: null,
        error: null,
      }));
  }

  $effect(() => {
    engine
      .listSlots()
      .then((r) => (rows = rowsFrom(r.slots)))
      .catch((e) => (build.error = String(e)));
    engine.powerStats().then((r) => (powerStats = r.stats)).catch(() => {});
    engine
      .tradeStatusOptions()
      .then((r) => (statuses = r.options))
      .catch(() => {});
    engine
      .tradeLeagues()
      .then((r) => {
        leagues = r.leagues;
        if (!r.leagues.some((l) => l.id === league) && r.leagues.length) league = r.leagues[0].id;
      })
      .catch(() => (leagues = null));
  });

  /** Engine errors arrive with a Lua traceback; only the first line says anything. */
  function friendly(e: unknown) {
    const first = String(e).split("\n")[0].replace(/^EngineError: [a-z_]+: /, "").replace(/^runtime error: /, "");
    if (first.includes("found no mods to search for")) return "Nothing here is worth weighing";
    if (first.includes("not supported")) return "This slot cannot be searched";
    return first;
  }

  function urlFor(query: string) {
    const base = game.isPoe2 ? "https://www.pathofexile.com/trade2/search/poe2" : "https://www.pathofexile.com/trade/search";
    return `${base}/${encodeURIComponent(league)}?q=${encodeURIComponent(query)}`;
  }

  async function generate(slot: string): Promise<boolean> {
    busySlot = slot;
    rows = rows.map((r) => (r.slot === slot ? { ...r, error: null } : r));
    try {
      await engine.tradeSearchStart({
        slotName: slot,
        statWeights: weights.filter((w) => w.weightMult > 0),
        includeCorrupted: corrupted,
        includeRunes: runes,
        includeMirrored: mirrored,
        maxLevel: maxLevel > 0 ? maxLevel : undefined,
        status,
        jewelType,
      });
      for (let i = 0; i < 600; i++) {
        const r = await engine.tradeSearchStep(150);
        if (r.done) break;
      }
      const { query } = await engine.tradeSearchResult();
      const url = urlFor(query);
      rows = rows.map((r) => (r.slot === slot ? { ...r, url, error: null } : r));
      return true;
    } catch (e) {
      const msg = friendly(e);
      rows = rows.map((r) => (r.slot === slot ? { ...r, url: null, error: msg } : r));
      return false;
    } finally {
      busySlot = null;
    }
  }

  async function one(slot: string) {
    remember();
    note = "";
    await generate(slot);
  }

  async function all() {
    remember();
    runAll = true;
    cancel = false;
    done = 0;
    note = "";
    let ok = 0;
    for (const r of rows) {
      if (cancel) break;
      if (await generate(r.slot)) ok++;
      done++;
    }
    runAll = false;
    note = cancel ? `Stopped after ${done} of ${rows.length}` : `${ok} of ${rows.length} slots have a search`;
  }

  async function copy(url: string) {
    try {
      await writeText(url);
      note = "Link copied";
    } catch (e) {
      build.error = String(e);
    }
  }

  async function copyAll() {
    const lines = rows.filter((r) => r.url).map((r) => `${r.label}\t${r.url}`);
    if (!lines.length) return;
    try {
      await writeText(lines.join("\n"));
      note = `${lines.length} links copied`;
    } catch (e) {
      build.error = String(e);
    }
  }

  const ready = $derived(rows.filter((r) => r.url).length);
</script>

<div class="modal">
  <div class="panel dialog trdlg">
    <div class="head">
      <span class="label">Trader</span>
      <span class="dim small">A weighted trade search for every slot. Results open in your browser.</span>
    </div>

    <div class="opts">
      <div class="orow">
        <span class="olabel">League</span>
        {#if leagues}
          <select class="select sm grow" bind:value={league}>
            {#each leagues as l (l.id)}
              <option value={l.id}>{l.text}</option>
            {/each}
          </select>
        {:else}
          <input class="input sm grow" bind:value={league} placeholder="League name" />
        {/if}
        <span class="olabel">Listings</span>
        <select class="select sm" bind:value={status} title="Which listings the search should return">
          {#each statuses as s (s.id)}
            <option value={s.id}>{s.label}</option>
          {/each}
        </select>
      </div>

      {#each weights as w, i}
        <div class="orow">
          <span class="olabel">{i === 0 ? "Weigh by" : ""}</span>
          <select
            class="select sm grow"
            value={w.stat}
            onchange={(e) => (weights[i] = { ...w, stat: (e.target as HTMLSelectElement).value })}
          >
            <option value="FullDPS">Full DPS</option>
            {#each powerStats as s (s.stat)}
              <option value={s.stat}>{s.label}</option>
            {/each}
          </select>
          <input
            class="input sm wnum"
            type="number"
            min="0"
            max="10"
            step="0.1"
            value={w.weightMult}
            title="How much this stat counts against the others"
            onchange={(e) => (weights[i] = { ...w, weightMult: Number((e.target as HTMLInputElement).value) })}
          />
          {#if weights.length > 1}
            <button class="x" onclick={() => (weights = weights.filter((_, j) => j !== i))} title="Remove">✕</button>
          {:else}
            <span class="x"></span>
          {/if}
        </div>
      {/each}

      <div class="orow">
        <span class="olabel"></span>
        <button class="btn sm ghost" onclick={() => (weights = [...weights, { stat: "TotalEHP", weightMult: 0.5 }])}>Add stat</button>
        <label class="chk small"><input type="checkbox" bind:checked={corrupted} /> Corrupted</label>
        <label class="chk small"><input type="checkbox" bind:checked={runes} /> Runes</label>
        <label class="chk small"><input type="checkbox" bind:checked={mirrored} /> Mirrored</label>
        <span class="olabel">Max level</span>
        <input class="input sm wnum" type="number" min="0" max="100" bind:value={maxLevel} title="Required-level cap; 0 means no cap" />
        <span class="olabel">Jewels</span>
        <select class="select sm" bind:value={jewelType} title="Which kind of jewel the socket rows should search for">
          <option value="Base">Base</option>
          <option value="Abyss">Abyss</option>
          <option value="Any">Any</option>
        </select>
      </div>
    </div>

    <div class="side">
      <div class="shead">
        Slots
        <span class="dim num">{rows.length}</span>
        {#if ready}<span class="dim small">{ready} with a search</span>{/if}
      </div>
      <div class="scroll">
        {#each rows as r (r.slot)}
          <div class="trow" class:focus={r.slot === focusSlot}>
            <span class="sname">{r.label}</span>
            <span class="iname" style:color={rarityColor[r.itemRarity ?? ""] ?? "var(--fg-2)"}>{r.itemName ?? "empty"}</span>
            {#if r.error}
              <span class="dim small grow">{r.error}</span>
            {:else if r.url}
              <input class="input sm grow mono" readonly value={r.url} onfocus={(e) => (e.target as HTMLInputElement).select()} />
              <button class="btn sm ghost" onclick={() => copy(r.url!)}>Copy</button>
              <button class="btn sm" onclick={() => openUrl(r.url!)}>Open</button>
            {:else}
              <span class="grow"></span>
            {/if}
            <button class="btn sm ghost find" onclick={() => one(r.slot)} disabled={busySlot !== null || runAll}>
              {busySlot === r.slot ? "…" : r.url ? "Redo" : "Find"}
            </button>
          </div>
        {:else}
          <div class="dim small pad">No slots to search.</div>
        {/each}
      </div>
    </div>

    <p class="note dim small">
      Prices, live results and whisper messages need a Path of Exile account login, which this app does not have. Path
      of Building calls the same thing No Session Mode.
    </p>

    <div class="acts">
      {#if runAll}
        <button class="btn ghost sm" onclick={() => (cancel = true)}>Stop</button>
        <div class="prog"><span style:width={`${rows.length ? Math.round((done / rows.length) * 100) : 0}%`}></span></div>
        <span class="dim num small">{done} / {rows.length}</span>
      {:else}
        <button class="btn primary" onclick={all} disabled={busySlot !== null}>Find all slots</button>
        {#if ready}
          <button class="btn sm ghost" onclick={copyAll}>Copy all links</button>
        {/if}
        {#if note}<span class="dim small">{note}</span>{/if}
        <span class="sp"></span>
      {/if}
      <button class="btn ghost" onclick={onclose} disabled={runAll}>Close</button>
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
  .trdlg {
    width: 940px;
    max-height: 88vh;
    padding: 16px 18px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
  }
  .opts {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .orow {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .orow .grow {
    flex: 1;
    min-width: 0;
  }
  .olabel {
    width: 62px;
    flex: none;
    font-size: var(--fs-xs);
    color: var(--fg-2);
  }
  .wnum {
    width: 70px;
    text-align: right;
  }
  .orow .x {
    width: 18px;
    flex: none;
    background: none;
    border: 0;
    color: var(--fg-3);
    font: inherit;
    cursor: pointer;
  }
  .orow button.x:hover {
    color: var(--bad);
  }
  .side {
    display: flex;
    flex-direction: column;
    min-height: 0;
    border: 1px solid var(--line-1);
    border-radius: var(--r-2);
  }
  .shead {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 6px 10px;
    font-size: var(--fs-xs);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--fg-2);
    border-bottom: 1px solid var(--line-0);
  }
  .shead .small {
    margin-left: auto;
    text-transform: none;
    letter-spacing: 0;
  }
  .scroll {
    overflow: auto;
    height: 42vh;
  }
  .trow {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 3px 10px;
  }
  .trow:hover {
    background: var(--bg-hover);
  }
  .trow.focus {
    background: var(--bg-active);
  }
  .sname {
    width: 130px;
    flex: none;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .iname {
    width: 170px;
    flex: none;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fs-xs);
  }
  .trow .grow {
    flex: 1;
    min-width: 0;
  }
  .find {
    width: 58px;
    flex: none;
  }
  .pad {
    padding: 8px 10px;
  }
  .note {
    margin: 0;
  }
  .acts {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .acts .sp {
    flex: 1;
  }
  .prog {
    flex: 1;
    height: 4px;
    background: var(--bg-2);
    border-radius: 2px;
    overflow: hidden;
  }
  .prog span {
    display: block;
    height: 100%;
    background: var(--accent);
    transition: width 120ms linear;
  }
</style>
