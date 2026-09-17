#!/usr/bin/env bun
/**
 * Turn the cleaned corpus into priors and baselines, and summarise a bench run.
 *
 *   bun scripts/corpus/analyse.ts [--bench corpus/bench.jsonl]
 *
 * Reads corpus/index.json and corpus/stages.jsonl (scripts/corpus/ingest.ts).
 * Writes corpus/aggregates.json (machine-readable priors) and corpus/analysis.md.
 */
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..");
const CORPUS = join(REPO, "corpus");
const args = process.argv.slice(2);
const benchPath = args.includes("--bench") ? args[args.indexOf("--bench") + 1] : join(CORPUS, "bench.jsonl");

interface Entry {
  id: string;
  kind: string;
  className: string;
  ascendancy: string | null;
  level: number;
  mainSkill: string | null;
  stage: string;
  leagueType: string | null;
  gear: string;
  stats: Record<string, number>;
  findings: string[];
  flags: string[];
  duplicateOf: string | null;
  nearDuplicateOf: string | null;
}
interface Stage {
  id: string;
  nodes: number[];
  ascendancyNodes: number[];
  skills: string[][];
  mainSkill: string | null;
}

const index = (await Bun.file(join(CORPUS, "index.json")).json()) as { stages: Entry[] };
const stageLines = (await Bun.file(join(CORPUS, "stages.jsonl")).text()).split("\n").filter(Boolean);
const stages = new Map<string, Stage>(stageLines.map((l) => JSON.parse(l)).map((s: Stage) => [s.id, s]));
let tree: { nodes: Record<string, { name: string; type: string; ascendancy?: string }> } = { nodes: {} };
try {
  tree = await Bun.file(join(CORPUS, "tree-nodes.json")).json();
} catch {}

const usable = index.stages.filter((e) => !e.duplicateOf && e.flags.length === 0);
const late = usable.filter((e) => e.stage === "endgame" || e.stage === "ladder");

const pct = (n: number, d: number) => (d === 0 ? 0 : Math.round((1000 * n) / d) / 10);
function quantiles(values: number[]) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const q = (p: number) => v[Math.min(v.length - 1, Math.floor(p * (v.length - 1)))];
  return { n: v.length, p25: Math.round(q(0.25)), median: Math.round(q(0.5)), p75: Math.round(q(0.75)) };
}
function top<T extends string>(counts: Map<T, number>, n: number, total: number) {
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, c]) => ({ key: k, count: c, share: pct(c, total) }));
}
const nodeName = (id: number) => tree.nodes[String(id)]?.name ?? String(id);
const nodeType = (id: number) => tree.nodes[String(id)]?.type ?? "?";

// --- per ascendancy priors -------------------------------------------------
const byAsc = new Map<string, Entry[]>();
for (const e of late) {
  const k = e.ascendancy ?? "none";
  byAsc.set(k, [...(byAsc.get(k) ?? []), e]);
}
const ascendancies: Record<string, unknown> = {};
for (const [asc, entries] of [...byAsc].sort()) {
  const nodeCounts = new Map<string, number>();
  const ascNodeCounts = new Map<string, number>();
  const skills = new Map<string, number>();
  for (const e of entries) {
    const s = stages.get(e.id);
    if (!s) continue;
    for (const n of new Set(s.nodes)) {
      const t = nodeType(n);
      if (t === "Notable" || t === "Keystone" || t === "Socket") nodeCounts.set(String(n), (nodeCounts.get(String(n)) ?? 0) + 1);
    }
    for (const n of new Set(s.ascendancyNodes)) ascNodeCounts.set(String(n), (ascNodeCounts.get(String(n)) ?? 0) + 1);
    if (e.mainSkill) skills.set(e.mainSkill, (skills.get(e.mainSkill) ?? 0) + 1);
  }
  const named = (list: { key: string; count: number; share: number }[]) =>
    list.map((x) => ({ id: Number(x.key), name: nodeName(Number(x.key)), type: nodeType(Number(x.key)), share: x.share }));
  ascendancies[asc] = {
    stages: entries.length,
    mainSkills: top(skills, 8, entries.length),
    notablesAndKeystones: named(top(nodeCounts, 30, entries.length)),
    ascendancyNodes: named(top(ascNodeCounts, 12, entries.length)),
  };
}

// --- supports per main skill -----------------------------------------------
const supportsBySkill = new Map<string, { builds: number; supports: Map<string, number> }>();
for (const e of usable) {
  const s = stages.get(e.id);
  if (!s || !e.mainSkill) continue;
  const group = s.skills.find((g) => g.includes(e.mainSkill!));
  if (!group) continue;
  const rec = supportsBySkill.get(e.mainSkill) ?? { builds: 0, supports: new Map() };
  rec.builds++;
  for (const gem of new Set(group)) if (gem !== e.mainSkill) rec.supports.set(gem, (rec.supports.get(gem) ?? 0) + 1);
  supportsBySkill.set(e.mainSkill, rec);
}
const mainSkillSupports = Object.fromEntries(
  [...supportsBySkill]
    .filter(([, r]) => r.builds >= 3)
    .sort((a, b) => b[1].builds - a[1].builds)
    .map(([skill, r]) => [skill, { builds: r.builds, supports: top(r.supports, 10, r.builds) }]),
);

// --- stat baselines ------------------------------------------------------------
const band = (level: number) => (level < 60 ? "1-59" : level < 80 ? "60-79" : level < 90 ? "80-89" : level < 95 ? "90-94" : "95-100");
const withGear = usable.filter((e) => e.gear === "full");
const baselineGroups = new Map<string, Entry[]>();
for (const e of withGear) {
  for (const key of [`all|${band(e.level)}`, `${e.leagueType ?? "unknown"}|${band(e.level)}`]) {
    baselineGroups.set(key, [...(baselineGroups.get(key) ?? []), e]);
  }
}
const baselines = Object.fromEntries(
  [...baselineGroups].sort().map(([key, entries]) => [
    key,
    {
      life: quantiles(entries.map((e) => e.stats.Life)),
      energyShield: quantiles(entries.map((e) => e.stats.EnergyShield)),
      totalEHP: quantiles(entries.map((e) => e.stats.TotalEHP)),
      combinedDPS: quantiles(entries.map((e) => e.stats.CombinedDPS)),
      chaosResist: quantiles(entries.map((e) => e.stats.ChaosResist)),
      elementalCappedShare: pct(entries.filter((e) => ["FireResist", "ColdResist", "LightningResist"].every((r) => (e.stats[r] ?? 0) >= 75)).length, entries.length),
    },
  ]),
);

// --- review rules against real endgame characters -------------------------------
const ladder = usable.filter((e) => e.kind === "ladder");
const findingCounts = new Map<string, number>();
for (const e of ladder) for (const f of new Set(e.findings)) findingCounts.set(f, (findingCounts.get(f) ?? 0) + 1);
const reviewOnLadder = top(findingCounts, 20, ladder.length);

// --- bench ---------------------------------------------------------------------------
let bench: any[] = [];
try {
  bench = (await Bun.file(benchPath).text())
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
} catch {}
const benchSummary: Record<string, unknown> = {};
if (bench.length) {
  const okRows = bench.filter((b) => !b.error);
  benchSummary.stages = bench.length;
  benchSummary.errors = bench.filter((b) => b.error).map((b) => ({ id: b.id, ascendancy: b.ascendancy, error: String(b.error).slice(0, 160) }));
  const planStats = new Set(okRows.flatMap((b) => Object.keys(b.plans ?? {})));
  benchSummary.plans = Object.fromEntries(
    [...planStats].map((stat) => {
      const rows = okRows.filter((b) => b.plans?.[stat] && !b.plans[stat].error);
      const base = (b: any) => (stat === "CombinedDPS" ? b.before?.CombinedDPS : b.before?.[stat]) ?? 0;
      return [
        stat,
        {
          stages: rows.length,
          failed: okRows.filter((b) => b.plans?.[stat]?.error).length,
          noGain: rows.filter((b) => !(b.plans[stat].total > 0)).length,
          gainPercent: quantiles(rows.filter((b) => base(b) > 0).map((b) => (100 * b.plans[stat].total) / base(b))),
          pointsSpent: quantiles(rows.map((b) => b.plans[stat].spent)),
          seconds: quantiles(rows.map((b) => b.plans[stat].ms / 1000)),
        },
      ];
    }),
  );
  const gear = okRows.filter((b) => b.gearOpt);
  const change = (k: string) =>
    quantiles(gear.filter((b) => (b.gearOpt.before[k] ?? 0) > 0).map((b) => (100 * (b.gearOpt.after[k] - b.gearOpt.before[k])) / b.gearOpt.before[k]));
  const uncapped = (o: any) => ["FireResist", "ColdResist", "LightningResist"].filter((r) => (o[r] ?? 0) < 75).length;
  const unmet = (o: any) => ["Str", "Dex", "Int"].filter((a) => (o[a] ?? 0) < (o[`Req${a}`] ?? 0)).length;
  benchSummary.gear = {
    stages: gear.length,
    lifePercent: change("Life"),
    ehpPercent: change("TotalEHP"),
    dpsPercent: change("CombinedDPS"),
    lostLife: gear.filter((b) => b.gearOpt.after.Life < b.gearOpt.before.Life).length,
    lostDps: gear.filter((b) => b.gearOpt.after.CombinedDPS < b.gearOpt.before.CombinedDPS * 0.98).length,
    resistsWorse: gear.filter((b) => uncapped(b.gearOpt.after) > uncapped(b.gearOpt.before)).length,
    attributesWorse: gear.filter((b) => unmet(b.gearOpt.after) > unmet(b.gearOpt.before)).length,
    seconds: quantiles(gear.map((b) => b.gearOpt.ms / 1000)),
  };
}

await Bun.write(
  join(CORPUS, "aggregates.json"),
  JSON.stringify({ generatedAt: new Date().toISOString(), usableStages: usable.length, lateStages: late.length, ascendancies, mainSkillSupports, baselines, reviewOnLadder, bench: benchSummary }, null, 2) + "\n",
);

// --- readable summary ----------------------------------------------------------
const q = (x: any) => (x ? `${x.median.toLocaleString("en-US")} (${x.p25.toLocaleString("en-US")}–${x.p75.toLocaleString("en-US")})` : "–");
const lines: string[] = [];
lines.push("# Corpus analysis", "", `${usable.length} usable stages, ${late.length} of them endgame or ladder.`, "");
lines.push("## Typical stats with full gear (median, 25th–75th percentile)", "");
lines.push("| Group | Stages | Life | ES | EHP | Combined DPS | Chaos res | Elemental capped |", "|---|---|---|---|---|---|---|---|");
for (const [key, b] of Object.entries(baselines) as [string, any][]) {
  lines.push(`| ${key.replace("|", ", level ")} | ${b.life?.n ?? 0} | ${q(b.life)} | ${q(b.energyShield)} | ${q(b.totalEHP)} | ${q(b.combinedDPS)} | ${q(b.chaosResist)} | ${b.elementalCappedShare}% |`);
}
lines.push("", "## Review findings on ladder characters", "", `How often the Optimise review flags real ladder builds (${ladder.length} characters). A rule that fires on most of them is worth a second look.`, "");
lines.push("| Area | Share of ladder builds |", "|---|---|");
for (const r of reviewOnLadder) lines.push(`| ${r.key} | ${r.share}% |`);
lines.push("", "## Ascendancies", "");
for (const [asc, a] of Object.entries(ascendancies) as [string, any][]) {
  lines.push(`### ${asc} (${a.stages} endgame/ladder stages)`, "");
  lines.push(`Main skills: ${a.mainSkills.map((s: any) => `${s.key} ${s.share}%`).join(", ")}`, "");
  lines.push(`Most taken notables and keystones: ${a.notablesAndKeystones.slice(0, 12).map((n: any) => `${n.name} ${n.share}%`).join(", ")}`, "");
}
if (bench.length) {
  const b: any = benchSummary;
  lines.push("## Bench", "", `${b.stages} stages, ${b.errors.length} errors.`, "");
  for (const [stat, p] of Object.entries(b.plans) as [string, any][]) {
    lines.push(`- Planner (${stat}): ${p.stages} stages, median gain ${p.gainPercent?.median ?? "–"}% (${p.gainPercent?.p25 ?? "–"}–${p.gainPercent?.p75 ?? "–"}), no gain on ${p.noGain}, failed ${p.failed}, median ${p.seconds?.median ?? "–"} s.`);
  }
  const g = b.gear;
  if (g?.stages) {
    lines.push(
      `- Gear optimiser: ${g.stages} stages. Median change: life ${g.lifePercent?.median ?? "–"}%, EHP ${g.ehpPercent?.median ?? "–"}%, DPS ${g.dpsPercent?.median ?? "–"}%. Lost life on ${g.lostLife}, lost over 2% DPS on ${g.lostDps}, more uncapped resistances on ${g.resistsWorse}, more unmet attributes on ${g.attributesWorse}. Median ${g.seconds?.median ?? "–"} s.`,
    );
  }
  lines.push("");
}
await Bun.write(join(CORPUS, "analysis.md"), lines.join("\n"));
console.log(`analysis: ${usable.length} usable stages, ${Object.keys(ascendancies).length} ascendancies, bench rows ${bench.length}`);
