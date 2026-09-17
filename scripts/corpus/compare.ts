#!/usr/bin/env bun
/**
 * Compare two bench runs (pobctl corpus) on the stages both contain.
 *
 *   bun scripts/corpus/compare.ts corpus/bench-baseline.jsonl corpus/bench.jsonl
 */
const [aPath, bPath] = process.argv.slice(2);
if (!aPath || !bPath) {
  console.error("usage: compare.ts <before.jsonl> <after.jsonl>");
  process.exit(1);
}

const read = async (p: string) =>
  new Map(
    (await Bun.file(p).text())
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .map((r) => [r.id as string, r]),
  );
const A = await read(aPath);
const B = await read(bPath);
const ids = [...A.keys()].filter((id) => B.has(id));

const quant = (v: number[]) => {
  const s = v.filter(Number.isFinite).sort((x, y) => x - y);
  if (!s.length) return "–";
  const at = (p: number) => Math.round(s[Math.floor(p * (s.length - 1))]);
  return `${at(0.5)}% (${at(0.25)} to ${at(0.75)})`;
};
const seconds = (v: number[]) => {
  const s = v.filter(Number.isFinite).sort((x, y) => x - y);
  return s.length ? `${(s[Math.floor(0.5 * (s.length - 1))] / 1000).toFixed(1)} s` : "–";
};
const change = (before: number, after: number) => (before > 0 ? (100 * (after - before)) / before : NaN);
const pool = (o: any) => (o.Life ?? 0) + (o.EnergyShield ?? 0);
const dps = (o: any) => Math.max(o.CombinedDPS ?? 0, o.MinionDPS ?? 0);
const uncapped = (o: any) => ["FireResist", "ColdResist", "LightningResist"].filter((r) => (o[r] ?? 0) < 75).length;
const unmet = (o: any) => ["Str", "Dex", "Int"].filter((x) => (o[x] ?? 0) < (o[`Req${x}`] ?? 0)).length;

function gearRow(label: string, runs: Map<string, any>) {
  const rows = ids.map((id) => runs.get(id)).filter((r) => r?.gearOpt);
  // A baseline run may predate EnergyShield in the optimiser's headline; the stage stats have it.
  const withEs = (r: any, side: "before" | "after") => {
    const o = r.gearOpt[side];
    if (o.EnergyShield === undefined && side === "before") return { ...o, EnergyShield: r.before?.EnergyShield ?? 0 };
    return o;
  };
  const esKnown = rows.filter((r) => r.gearOpt.after.EnergyShield !== undefined);
  return {
    label,
    stages: rows.length,
    life: quant(rows.map((r) => change(r.gearOpt.before.Life, r.gearOpt.after.Life))),
    pool: esKnown.length ? quant(esKnown.map((r) => change(pool(withEs(r, "before")), pool(r.gearOpt.after)))) : "–",
    ehp: quant(rows.map((r) => change(r.gearOpt.before.TotalEHP, r.gearOpt.after.TotalEHP))),
    dps: quant(rows.map((r) => change(dps(r.gearOpt.before), dps(r.gearOpt.after)))),
    ehpLoss: rows.filter((r) => r.gearOpt.after.TotalEHP < r.gearOpt.before.TotalEHP * 0.97).length,
    poolLoss: esKnown.length ? esKnown.filter((r) => pool(r.gearOpt.after) < pool(withEs(r, "before")) * 0.97).length : "–",
    dpsLoss: rows.filter((r) => dps(r.gearOpt.after) < dps(r.gearOpt.before) * 0.98).length,
    resistsWorse: rows.filter((r) => uncapped(r.gearOpt.after) > uncapped(r.gearOpt.before)).length,
    attributesWorse: rows.filter((r) => unmet(r.gearOpt.after) > unmet(r.gearOpt.before)).length,
    seconds: seconds(rows.map((r) => r.gearOpt.ms)),
  };
}

const a = gearRow("before", A);
const b = gearRow("after", B);
if (a.stages || b.stages) {
  console.log(`Gear optimiser on ${ids.length} shared stages (median, 25th to 75th percentile)\n`);
  const keys = ["stages", "life", "pool", "ehp", "dps", "ehpLoss", "poolLoss", "dpsLoss", "resistsWorse", "attributesWorse", "seconds"] as const;
  const names: Record<string, string> = {
    stages: "Stages",
    life: "Life change",
    pool: "Life + ES change",
    ehp: "EHP change",
    dps: "DPS change",
    ehpLoss: "EHP down over 3%",
    poolLoss: "Life + ES down over 3%",
    dpsLoss: "DPS down over 2%",
    resistsWorse: "More uncapped resistances",
    attributesWorse: "More unmet attributes",
    seconds: "Seconds",
  };
  console.log(`| | ${aPath.split(/[\\/]/).pop()} | ${bPath.split(/[\\/]/).pop()} |\n|---|---|---|`);
  for (const k of keys) console.log(`| ${names[k]} | ${a[k]} | ${b[k]} |`);
}

const planStats = new Set(ids.flatMap((id) => [...Object.keys(A.get(id)?.plans ?? {}), ...Object.keys(B.get(id)?.plans ?? {})]));
for (const stat of planStats) {
  const gain = (r: any) => {
    const p = r?.plans?.[stat];
    const base = stat === "Life" ? r?.before?.Life : r?.before?.[stat];
    return p && !p.error && base > 0 ? (100 * p.total) / base : NaN;
  };
  console.log(`\nPlanner ${stat}: before ${quant(ids.map((id) => gain(A.get(id))))}, after ${quant(ids.map((id) => gain(B.get(id))))}`);
}
