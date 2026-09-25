<script lang="ts">
  import {
    engine,
    type AffixOption,
    type AffixRollStep,
    type AffixRollTier,
    type AffixSlot,
    type ItemCustomizationEdit,
    type ItemTarget,
  } from "$lib/engine.svelte";
  import { m } from "$lib/paraglide/messages";

  let { slot, table, target, onchange, onbegin, onend }: {
    slot: AffixSlot;
    table: "prefixes" | "suffixes";
    target: ItemTarget;
    onchange: (edit: ItemCustomizationEdit) => Promise<unknown>;
    onbegin: () => boolean;
    onend: () => void;
  } = $props();

  type Family = { group: string; label: string; tiers: AffixOption[] };
  type Choice = { modId: string; affix: string | null; tier: number; step: AffixRollStep; position: number };
  const segment = 101;

  const families: Family[] = $derived.by(() => {
    const byGroup = new Map<string, AffixOption[]>();
    for (const option of slot.options) {
      const tiers = byGroup.get(option.group) ?? [];
      tiers.push(option);
      byGroup.set(option.group, tiers);
    }
    return [...byGroup].map(([group, tiers]) => ({
      group,
      label: tiers.length > 1
        ? tiers[0].label.replace(/\(-?\d+(?:\.\d+)?--?\d+(?:\.\d+)?\)/g, "#").replace(/-?\d+(?:\.\d+)?/g, "#")
        : tiers[0].label,
      tiers,
    }));
  });
  const selectedGroup = $derived(slot.options.find((option) => option.modId === slot.modId)?.group ?? "");
  let tiers = $state<AffixRollTier[]>([]);
  let loading = $state(false);
  let changing = $state(false);
  let error = $state<string | null>(null);
  let localChoice = $state<Choice | null>(null);
  // WebKit may skip change after snapping input.value or fire it after pointerup.
  let submitted: string | null = null;

  $effect(() => {
    const group = selectedGroup;
    const currentTarget = target;
    // Options can change when another affix changes the item's tags.
    const optionIds = slot.options.map((option) => option.modId).join("|");
    let active = true;
    tiers = [];
    error = null;
    loading = !!group;
    if (group && optionIds) {
      engine.itemAffixRolls(currentTarget, table, slot.index, group).then(
        (result) => { if (active) tiers = result.tiers; },
        (e) => { if (active) error = String(e); },
      ).finally(() => { if (active) loading = false; });
    }
    return () => { active = false; };
  });

  $effect(() => {
    slot.modId;
    slot.range;
    localChoice = null;
    submitted = null;
  });

  function sliderPosition(tierIndex: number, stepPosition: number): number {
    return tierIndex * segment + stepPosition;
  }

  function nearest(rollTiers: AffixRollTier[], position: number): Choice | null {
    if (!rollTiers.length) return null;
    const tierIndex = Math.min(rollTiers.length - 1, Math.max(0, Math.floor(position / segment)));
    const tier = rollTiers[tierIndex];
    const inTier = Math.min(100, Math.max(0, position - tierIndex * segment));
    const step = tier.steps.reduce((best, candidate) =>
      Math.abs(candidate.position - inTier) < Math.abs(best.position - inTier) ? candidate : best,
    );
    return { modId: tier.modId, affix: tier.affix, tier: tier.tier, step, position: sliderPosition(tierIndex, step.position) };
  }

  const savedChoice: Choice | null = $derived.by(() => {
    const tierIndex = tiers.findIndex((tier) => tier.modId === slot.modId);
    if (tierIndex < 0) return null;
    const tier = tiers[tierIndex];
    const range = slot.range ?? 0.5;
    const step = tier.steps.reduce((best, candidate) =>
      Math.abs(candidate.range - range) < Math.abs(best.range - range) ? candidate : best,
    );
    return { modId: tier.modId, affix: tier.affix, tier: tier.tier, step, position: sliderPosition(tierIndex, step.position) };
  });
  const shownChoice = $derived(localChoice ?? savedChoice);
  const valueText = $derived(localChoice?.step.value ?? slot.value ?? shownChoice?.step.value ?? slot.label ?? "");
  const choices: Choice[] = $derived(tiers.flatMap((tier, tierIndex) => tier.steps.map((step) => ({
    modId: tier.modId, affix: tier.affix, tier: tier.tier, step,
    position: sliderPosition(tierIndex, step.position),
  }))));

  async function changeFamily(group: string) {
    if (changing || group === selectedGroup || !onbegin()) return;
    const fraction = shownChoice && tiers.length ? shownChoice.position / (tiers.length * segment - 1) : 0.5;
    changing = true;
    error = null;
    try {
      if (!group) {
        await onchange({ operation: "affix", table, index: slot.index, modId: "None" });
        return;
      }
      const family = families.find((candidate) => candidate.group === group);
      if (!family) return;
      const result = await engine.itemAffixRolls(target, table, slot.index, group);
      const choice = nearest(result.tiers, fraction * (result.tiers.length * segment - 1));
      if (choice) await onchange({ operation: "affix", table, index: slot.index, modId: choice.modId, range: choice.step.range });
    } catch (e) {
      error = String(e);
    } finally {
      changing = false;
      onend();
    }
  }

  function choose(rawPosition: number, input: HTMLInputElement): Choice | null {
    const choice = nearest(tiers, rawPosition);
    if (choice) {
      if (localChoice?.position !== choice.position) submitted = null;
      localChoice = choice;
      input.value = String(choice.position);
    }
    return choice;
  }

  function keydown(event: KeyboardEvent & { currentTarget: EventTarget & HTMLInputElement }) {
    const direction = event.key === "ArrowRight" || event.key === "ArrowUp" ? 1
      : event.key === "ArrowLeft" || event.key === "ArrowDown" ? -1 : 0;
    if (!direction && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    if (!choices.length) return;
    const current = shownChoice;
    const index = current ? choices.findIndex((choice) => choice.modId === current.modId && choice.position === current.position) : -1;
    const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? choices.length - 1
      : Math.max(0, Math.min(choices.length - 1, index + direction));
    const choice = choices[nextIndex];
    if (localChoice?.position !== choice.position) submitted = null;
    localChoice = choice;
    event.currentTarget.value = String(choice.position);
  }

  function keyup(event: KeyboardEvent & { currentTarget: EventTarget & HTMLInputElement }) {
    if (!["ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    commit(Number(event.currentTarget.value), event.currentTarget);
  }

  async function commit(rawPosition: number, input: HTMLInputElement) {
    const choice = localChoice ?? choose(rawPosition, input);
    if (!choice) return;
    const key = `${choice.modId}:${choice.step.range}`;
    if (submitted === key) return;
    if (choice.modId !== slot.modId || Math.abs(choice.step.range - (slot.range ?? 0.5)) > 0.00001) {
      if (!onbegin()) {
        localChoice = null;
        return;
      }
      submitted = key;
      try {
        const result = await onchange({ operation: "affix", table, index: slot.index, modId: choice.modId, range: choice.step.range });
        if (result !== undefined && result !== false) return;
      } catch (e) {
        error = String(e);
      } finally {
        onend();
      }
      localChoice = null;
      submitted = null;
    }
  }
</script>

<select class="select" aria-label={table === "prefixes" ? m.items_prefix_number({ index: slot.index }) : m.items_suffix_number({ index: slot.index })}
  value={selectedGroup} disabled={changing} onchange={(e) => {
    const group = e.currentTarget.value;
    e.currentTarget.value = selectedGroup;
    void changeFamily(group);
  }}>
  <option value="">{table === "prefixes" ? m.items_empty_prefix() : m.items_empty_suffix()}</option>
  {#each families as family (family.group)}<option value={family.group}>{family.label}</option>{/each}
</select>
{#if slot.modId !== "None"}
  <div class="affix-roll">
    <div class="affix-detail">
      <span>{shownChoice ? [shownChoice.affix, m.items_affix_tier({ tier: shownChoice.tier })].filter(Boolean).join(" - ") : slot.affix}</span>
      <span class="value">{valueText}</span>
    </div>
    {#if choices.length > 1 && shownChoice}
      <div class="slider-wrap">
        <input type="range" min="0" max={tiers.length * segment - 1} step="1" value={shownChoice.position} disabled={changing}
          aria-label={m.items_affix_roll()}
          aria-valuetext={`${valueText}, ${shownChoice.affix ?? ""}, ${m.items_affix_tier({ tier: shownChoice.tier })}`}
          oninput={(e) => choose(Number(e.currentTarget.value), e.currentTarget)}
          onpointerup={(e) => commit(Number(e.currentTarget.value), e.currentTarget)}
          onkeydown={keydown}
          onkeyup={keyup}
          onchange={(e) => commit(Number(e.currentTarget.value), e.currentTarget)} />
        {#each tiers.slice(1) as _, index}
          <span class="tick" style:left={`calc(8px + (100% - 16px) * ${(index + 1) / tiers.length})`} aria-hidden="true"></span>
        {/each}
      </div>
    {:else if loading}
      <span class="dim">{m.items_mod_loading()}</span>
    {/if}
    {#if error}<span class="error" role="alert">{error}</span>{/if}
  </div>
{/if}

<style>
  .select { width: 100%; min-width: 0; font-size: var(--fs-xs); }
  .affix-roll { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .affix-detail { display: flex; flex-wrap: wrap; gap: 4px 10px; color: var(--fg-2); }
  .value { color: var(--fg-1); }
  .slider-wrap { position: relative; min-width: 100px; }
  input[type="range"] { width: 100%; margin: 0; position: relative; z-index: 1; accent-color: var(--fg-1); }
  .tick { position: absolute; z-index: 2; top: 2px; bottom: 2px; width: 2px; background: var(--fg-2); pointer-events: none; }
  .error { color: var(--bad); }
</style>
