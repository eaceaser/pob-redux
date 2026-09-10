import type { SidebarRow } from "$lib/engine.svelte";
import { stripPobText } from "$lib/pobtext";

export type StatGroup = "offence" | "skill" | "attributes" | "resources" | "mitigation" | "resistances" | "misc" | "fulldps";

const ORDER: StatGroup[] = ["offence", "skill", "attributes", "resources", "mitigation", "resistances", "misc", "fulldps"];

const LABEL: Record<StatGroup, string> = {
  offence: "Offence",
  skill: "Skill",
  attributes: "Attributes",
  resources: "Resources",
  mitigation: "Mitigation",
  resistances: "Resistances",
  misc: "Misc",
  fulldps: "Full DPS",
};

const KEYS: Record<StatGroup, string[]> = {
  offence: [
    "AverageHit", "PvpAverageHit", "AverageDamage", "AverageBurstDamage", "PvpAverageDamage",
    "Speed", "WarcryCastTime", "ChannelTime", "HitSpeed", "ChannelTimeToTrigger",
    "TrapThrowingTime", "TrapCooldown", "MineLayingTime", "TrapThrowCount", "MineThrowCount",
    "TotemPlacementTime", "FiringRate", "ReloadTime",
    "PreEffectiveCritChance", "CritChance", "CritBifurcates", "CritMultiplier",
    "HitChance", "AccuracyHitChanceUncapped", "MainHand", "OffHand",
    "TotalDPS", "PvpTotalDPS", "TotalDot", "WithDotDPS",
    "BleedDPS", "CorruptingBloodDPS", "BleedDamage", "WithBleedDPS",
    "IgniteDPS", "IgniteDamage", "BurningGroundDPS", "MirageBurningGroundDPS", "WithIgniteDPS",
    "PoisonDPS", "CausticGroundDPS", "MirageCausticGroundDPS", "PoisonDamage", "WithPoisonDPS",
    "DecayDPS", "TotalDotDPS", "ImpaleDPS", "WithImpaleDPS", "MirageDPS", "CullingDPS",
    "ReservationDPS", "CombinedDPS", "CombinedAvg", "ExplodeChance", "CombinedAvgToMonsterLife",
  ],
  skill: [
    "ActiveMinionLimit", "Cooldown", "SealCooldown", "SealMax", "TimeMaxSeals",
    "AreaOfEffectRadiusMetres", "BrandAttachmentRangeMetre", "BrandTicks",
    "ManaCost", "ManaPercentCost", "ManaPerSecondCost", "ManaPercentPerSecondCost",
    "LifeCost", "LifePercentCost", "LifePerSecondCost", "LifePercentPerSecondCost",
    "ESCost", "ESPerSecondCost", "ESPercentPerSecondCost",
    "WardCost", "WardPercentCost", "WardPerSecondCost",
    "RageCost", "RagePerSecondCost", "SoulCost",
  ],
  attributes: ["Str", "ReqStr", "Dex", "ReqDex", "Int", "ReqInt", "Devotion", "Tribute"],
  resources: [
    "Darkness", "ReservedDarkness",
    "Spirit", "SpiritUnreserved", "SpiritUnreservedPercent",
    "Life", "Spec:LifeInc", "LifeUnreserved", "LifeRecoverable", "LifeUnreservedPercent",
    "LifeRegenRecovery", "LifeLeechGainRate", "LifeLeechGainPerHit",
    "Mana", "Spec:ManaInc", "ManaUnreserved", "ManaUnreservedPercent",
    "ManaRegenRecovery", "ManaLeechGainRate", "ManaLeechGainPerHit",
    "EnergyShield", "EnergyShieldRecoveryCap", "Spec:EnergyShieldInc",
    "EnergyShieldRegenRecovery", "EnergyShieldLeechGainRate", "EnergyShieldLeechGainPerHit",
    "Ward", "WardRegenRecovery", "Rage", "RageRegenRecovery",
    "TotalBuildDegen", "TotalNetRegen", "NetLifeRegen", "NetManaRegen", "NetWardRegen", "NetEnergyShieldRegen",
  ],
  mitigation: [
    "TotalEHP", "PvPTotalTakenHit", "PhysicalMaximumHitTaken", "LightningMaximumHitTaken",
    "FireMaximumHitTaken", "ColdMaximumHitTaken", "ChaosMaximumHitTaken",
    "Evasion", "Spec:EvasionInc", "EvadeChance", "MeleeEvadeChance", "ProjectileEvadeChance",
    "SpellEvadeChance", "SpellProjectileEvadeChance", "DeflectionRating", "DeflectChance",
    "Armour", "Spec:ArmourInc", "PhysicalDamageReduction",
    "EffectiveBlockChance", "EffectiveSpellBlockChance", "AttackDodgeChance", "SpellDodgeChance",
    "EffectiveSpellSuppressionChance",
  ],
  resistances: [
    "FireResist", "FireResistOverCap", "ColdResist", "ColdResistOverCap",
    "LightningResist", "LightningResistOverCap", "ChaosResist", "ChaosResistOverCap",
  ],
  misc: ["EffectiveMovementSpeedMod", "MovementSpeedWhileUsingSkill", "PresenceRadiusMetres"],
  fulldps: ["FullDPS", "FullDotDPS", "SkillDPS"],
};

const GROUP_OF = new Map<string, StatGroup>();
for (const g of ORDER) for (const k of KEYS[g]) GROUP_OF.set(k, g);

export interface SidebarItem {
  row: SidebarRow;
  /** Position in PoB's own list, which the breakdown API addresses. */
  index: number;
}

export interface SidebarSection {
  key: string;
  label: string | null;
  items: SidebarItem[];
}

const isSpacer = (r: SidebarRow) => !r.lhs && !r.rhs;

function trimmed(items: SidebarItem[]): SidebarItem[] {
  const out: SidebarItem[] = [];
  for (const it of items) {
    if (isSpacer(it.row) && (out.length === 0 || isSpacer(out[out.length - 1].row))) continue;
    out.push(it);
  }
  while (out.length && isSpacer(out[out.length - 1].row)) out.pop();
  return out;
}

/**
 * PoB's sidebar regrouped under headings. Rows keep PoB's relative order
 * inside a group; a key PoB adds that is not listed here stays with the group
 * of the row before it, since PoB's list is already ordered by topic. Rows
 * PoB inserts itself (skill info, "Skill disabled") lead, unlabelled; minion
 * stats form one group in place of PoB's "Minion:" / "Player:" headings.
 */
export function groupSidebar(rows: SidebarRow[]): SidebarSection[] {
  const info: SidebarItem[] = [];
  const minion: SidebarItem[] = [];
  const buckets = new Map<StatGroup, SidebarItem[]>();
  let ctx: "player" | "minion" = "player";
  let cur: StatGroup | null = null;

  rows.forEach((row, index) => {
    const it = { row, index };
    if (row.actor === "minion") {
      ctx = "minion";
      minion.push(it);
      return;
    }
    if (row.stat) {
      const g = GROUP_OF.get(row.stat) ?? cur ?? "offence";
      cur = g;
      let b = buckets.get(g);
      if (!b) buckets.set(g, (b = []));
      b.push(it);
      return;
    }
    if (row.actor === "player") {
      if (cur) buckets.get(cur)!.push(it);
      return;
    }
    const head = row.lhs && !row.rhs ? stripPobText(row.lhs).trim() : "";
    if (head === "Minion:") {
      ctx = "minion";
      return;
    }
    if (head === "Player:") {
      ctx = "player";
      return;
    }
    if (ctx === "minion") minion.push(it);
    else if (cur === null) info.push(it);
    else buckets.get(cur)!.push(it);
  });

  const out: SidebarSection[] = [];
  const infoRows = trimmed(info);
  if (infoRows.length) out.push({ key: "info", label: null, items: infoRows });
  const minionRows = trimmed(minion);
  if (minionRows.length) out.push({ key: "minion", label: "Minion", items: minionRows });
  for (const g of ORDER) {
    const items = trimmed(buckets.get(g) ?? []);
    if (items.length) out.push({ key: g, label: LABEL[g], items });
  }
  return out;
}
