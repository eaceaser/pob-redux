#!/usr/bin/env bun
/**
 * Load every corpus source in PoB and write the cleaned stage index.
 *
 *   bun scripts/corpus/ingest.ts [--jobs 4] [--batch 30]
 *
 * Sources: corpus/files/**\/*.build (added by hand), corpus/raw/guides (Build
 * Planner variants and attached PoB codes) and corpus/raw/ladder (poe.ninja
 * characters). Each is loaded by scripts/corpus/ingest.lua inside pobctl; every
 * loadout becomes a stage. Output, all under corpus/ (not committed):
 *   stages.jsonl  one line per stage, with nodes, items, skills and stats
 *   xml/<id>.xml  the loaded build, for the bench
 *   index.json    stage metadata with labels, gear status, flags, duplicates
 *   report.md     counts and problems for a person to read
 */
import { mkdir, readdir, rm } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { createHash } from "node:crypto";

const REPO = join(import.meta.dir, "..", "..");
const CORPUS = join(REPO, "corpus");
const WORK = join(CORPUS, ".work");
const PBCTL = join(REPO, "target", process.platform === "win32" ? "debug/pobctl.exe" : "debug/pobctl");
const POB_ROOT = join(REPO, "src-tauri", "resources", "pob");

const args = process.argv.slice(2);
const opt = (name: string, fallback: number) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const JOBS = opt("jobs", 4);
const BATCH = opt("batch", 30);

type Kind = "file" | "guide" | "ladder";
interface Source {
  id: string;
  kind: Kind;
  format: "build" | "code" | "ninja";
  path: string;
  name: string;
  meta: Record<string, unknown>;
}

const slash = (p: string) => p.split(sep).join("/");
const shortId = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 12);

async function walk(dir: string, ext: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p, ext)));
    else if (e.name.toLowerCase().endsWith(ext)) out.push(p);
  }
  return out.sort();
}

async function collectSources(): Promise<Source[]> {
  const sources: Source[] = [];
  for (const path of await walk(join(CORPUS, "files"), ".build")) {
    const rel = slash(relative(join(CORPUS, "files"), path));
    const parts = rel.split("/");
    const file = parts.pop()!.replace(/\.build$/i, "");
    sources.push({
      id: shortId(`file:${rel}`),
      kind: "file",
      format: "build",
      path: slash(path),
      name: file,
      meta: { folder: parts.join("/"), label: file.includes(" - ") ? file.slice(file.lastIndexOf(" - ") + 3) : null, endgameFolder: parts.some((p) => /endgame/i.test(p)) },
    });
  }
  const guidesDir = join(CORPUS, "raw", "guides", "mobalytics");
  let slugs: string[] = [];
  try {
    slugs = (await readdir(guidesDir)).sort();
  } catch {}
  for (const slug of slugs) {
    let meta: Record<string, unknown>;
    try {
      meta = await Bun.file(join(guidesDir, slug, "meta.json")).json();
    } catch {
      continue;
    }
    const common = { url: meta.url, heading: meta.heading, leagueType: meta.leagueType, notes: meta.notes, guide: slug };
    for (const v of (meta.variants as { name: string; file: string }[]) ?? []) {
      sources.push({
        id: shortId(`guide:${slug}:${v.file}`),
        kind: "guide",
        format: "build",
        path: slash(join(guidesDir, slug, "variants", v.file)),
        name: v.name,
        meta: { ...common, label: v.name.includes(" - ") ? v.name.slice(0, v.name.indexOf(" - ")) : v.name },
      });
    }
    if (meta.hasPobCode) {
      sources.push({
        id: shortId(`guide:${slug}:pob`),
        kind: "guide",
        format: "code",
        path: slash(join(guidesDir, slug, "pob.txt")),
        name: `${slug} (PoB)`,
        meta: { ...common, label: null, pobCode: true },
      });
    }
  }
  for (const path of await walk(join(CORPUS, "raw", "ladder"), ".json")) {
    const j = await Bun.file(path).json();
    sources.push({
      id: shortId(`ladder:${j.leagueType}:${j.account}:${j.character}`),
      kind: "ladder",
      format: "ninja",
      path: slash(path),
      name: `${j.character} (${j.ascendancy})`,
      meta: { url: j.url, league: j.league, leagueType: j.leagueType, rank: j.rank, ascendancy: j.ascendancy, updatedUtc: j.updatedUtc },
    });
  }
  return sources;
}

async function runBatches(sources: Source[]) {
  await rm(WORK, { recursive: true, force: true });
  await mkdir(WORK, { recursive: true });
  await mkdir(join(CORPUS, "xml"), { recursive: true });
  // Lua's io.open on Windows cannot open paths outside the ANSI code page, and
  // ladder file names carry accounts in any script; the engine reads copies.
  await mkdir(join(WORK, "in"), { recursive: true });
  for (const s of sources) await Bun.write(join(WORK, "in", s.id), Bun.file(s.path));
  const batches: Source[][] = [];
  for (let i = 0; i < sources.length; i += BATCH) batches.push(sources.slice(i, i + BATCH));
  let next = 0;
  let finished = 0;
  const lua = slash(join(import.meta.dir, "ingest.lua"));
  const worker = async () => {
    while (next < batches.length) {
      const n = next++;
      const job = slash(join(WORK, `job-${n}.json`));
      const out = slash(join(WORK, `out-${n}.jsonl`));
      await Bun.write(job, JSON.stringify(batches[n].map(({ id, format, name }) => ({ id, format, path: slash(join(WORK, "in", id)), name }))));
      const code = `JOB=[[${job}]] OUT=[[${out}]] XMLDIR=[[${slash(join(CORPUS, "xml"))}]] return dofile([[${lua}]])`;
      const proc = Bun.spawn([PBCTL, "--pob-root", POB_ROOT, "eval", code], { stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      await proc.exited;
      finished++;
      const summary = stdout.slice(stdout.indexOf("{")).replace(/\s+/g, " ");
      console.log(`batch ${finished}/${batches.length}: ${proc.exitCode === 0 ? summary : `exit ${proc.exitCode} ${stderr.slice(-300)}`}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(JOBS, batches.length) }, worker));
}

// ---------------------------------------------------------------------------
// Cleaning
// ---------------------------------------------------------------------------

interface Stage {
  source: string;
  loadout: string | null;
  error?: string;
  buildName: string;
  className: string;
  ascendancy: string | null;
  level: number;
  mainSkill: string | null;
  mainSocketGroup: number;
  mainSkillFixed: boolean;
  pointsSpent: number;
  pointsAvailableMax: number;
  ascendancyPoints: number;
  activeSkills: number;
  nodes: number[];
  ascendancyNodes: number[];
  items: { slot: string; rarity: string; name: string; base: string; mods: number; explicit: number }[];
  skills: string[][];
  stats: Record<string, number>;
  findings: { severity: string; area: string; message: string }[];
}

function stageKind(text: string | null | undefined, level: number, kind: Kind): string {
  const t = (text ?? "").toLowerCase();
  if (/campaign|level(l)?ing|act \d|story/.test(t)) return "campaign";
  if (/early|first maps|early maps|starter|pre-/.test(t)) return "early-maps";
  if (/mid|mapping|maps|budget|transition/.test(t)) return "mid-maps";
  if (/end ?game|late|min-?max|aspirational|uber|pinnacle|mirror|endgame|variant/.test(t)) return "endgame";
  if (kind === "ladder") return "ladder";
  if (level > 0 && level < 60) return "campaign";
  if (level >= 90) return "endgame";
  return "unlabelled";
}

function gearStatus(items: Stage["items"]): "none" | "bases" | "full" {
  const gear = items.filter((i) => !/flask|charm/i.test(i.slot));
  if (gear.length === 0) return "none";
  // Build Planner files carry bases and uniques; the import names their rares
  // "Imported <base>" and gives them no real mods.
  const rares = gear.filter((i) => i.rarity !== "UNIQUE");
  return rares.length > 0 && rares.every((i) => i.explicit === 0 || i.name.startsWith("Imported ")) ? "bases" : "full";
}

const fingerprint = (s: Stage) =>
  createHash("sha1")
    .update(JSON.stringify([s.ascendancy, s.nodes, s.ascendancyNodes, s.skills, s.items.map((i) => [i.slot, i.name, i.mods])]))
    .digest("hex");

function jaccard(a: number[], b: number[]) {
  const sa = new Set(a);
  let inter = 0;
  for (const x of b) if (sa.has(x)) inter++;
  const union = sa.size + b.length - inter;
  return union === 0 ? 1 : inter / union;
}

const KIND_PRIORITY: Record<Kind, number> = { file: 0, guide: 1, ladder: 2 };

async function clean(sources: Source[]) {
  const byId = new Map(sources.map((s) => [s.id, s]));
  const stages: Stage[] = [];
  const errors: { source: Source | undefined; loadout: string | null; error: string }[] = [];
  const outs = (await readdir(WORK)).filter((f) => f.startsWith("out-")).sort();
  const lines: string[] = [];
  for (const f of outs) lines.push(...(await Bun.file(join(WORK, f)).text()).split("\n").filter(Boolean));
  for (const line of lines) {
    const s = JSON.parse(line) as Stage;
    if (s.error) errors.push({ source: byId.get(s.source), loadout: s.loadout ?? null, error: s.error });
    else stages.push(s);
  }
  const loadedIds = new Set(lines.map((l) => JSON.parse(l).source));
  for (const src of sources) if (!loadedIds.has(src.id)) errors.push({ source: src, loadout: null, error: "no output (batch crashed)" });

  stages.sort((a, b) => KIND_PRIORITY[byId.get(a.source)!.kind] - KIND_PRIORITY[byId.get(b.source)!.kind]);
  const seen = new Map<string, string>();
  const index = [];
  const kept: { entry: any; stage: Stage }[] = [];
  for (const s of stages) {
    const src = byId.get(s.source)!;
    const stageId = shortId(`${s.source}:${s.loadout ?? ""}`);
    const fp = fingerprint(s);
    const labelText = s.loadout && s.loadout !== "Default" ? s.loadout : (src.meta.label as string | null) ?? src.name;
    const flags: string[] = [];
    if (s.nodes.length < 5) flags.push("empty-tree");
    if (s.skills.length === 0) flags.push("no-skills");
    if (!(s.stats.EffectiveDPS > 0)) flags.push("no-dps");
    if (!s.ascendancy) flags.push("no-ascendancy");
    const gear = gearStatus(s.items);
    const entry: any = {
      id: stageId,
      source: s.source,
      kind: src.kind,
      path: slash(relative(CORPUS, src.path)),
      loadout: s.loadout,
      name: src.name,
      className: s.className,
      ascendancy: s.ascendancy,
      level: s.level,
      mainSkill: s.mainSkill,
      mainSocketGroup: s.mainSocketGroup,
      mainSkillFixed: s.mainSkillFixed,
      minion: (s.stats.MinionDPS ?? 0) > (s.stats.CombinedDPS ?? 0),
      stage: src.kind === "file" && src.meta.endgameFolder ? "endgame" : stageKind(labelText, s.level, src.kind),
      stageText: labelText,
      leagueType: (src.meta.leagueType as string | null) ?? null,
      gear,
      pointsSpent: s.pointsSpent,
      pointsAvailableMax: s.pointsAvailableMax,
      stats: s.stats,
      findings: s.findings.map((f) => f.area),
      flags,
      duplicateOf: seen.get(fp) ?? null,
      nearDuplicateOf: null as string | null,
      meta: src.meta,
    };
    if (!entry.duplicateOf) {
      seen.set(fp, stageId);
      const near = kept.find(
        (k) =>
          k.entry.ascendancy === entry.ascendancy &&
          k.entry.mainSkill === entry.mainSkill &&
          k.entry.gear === entry.gear &&
          jaccard(k.stage.nodes, s.nodes) >= 0.97,
      );
      if (near) entry.nearDuplicateOf = near.entry.id;
      kept.push({ entry, stage: s });
    }
    index.push(entry);
  }

  await Bun.write(join(CORPUS, "stages.jsonl"), stages.map((s) => JSON.stringify({ ...s, id: shortId(`${s.source}:${s.loadout ?? ""}`) })).join("\n") + "\n");
  await Bun.write(join(CORPUS, "index.json"), JSON.stringify({ generatedAt: new Date().toISOString(), sources: sources.length, stages: index }, null, 2) + "\n");
  await Bun.write(join(CORPUS, "report.md"), report(sources, index, errors));
  console.log(`stages: ${index.length} (${index.filter((e) => e.duplicateOf).length} exact duplicates, ${index.filter((e) => e.nearDuplicateOf).length} near), errors: ${errors.length}`);
}

function countBy<T>(rows: T[], key: (r: T) => string) {
  const m = new Map<string, number>();
  for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function table(rows: [string, number][], head: string) {
  return [`| ${head} | Stages |`, "|---|---|", ...rows.map(([k, v]) => `| ${k} | ${v} |`)].join("\n");
}

function report(sources: Source[], index: any[], errors: { source: Source | undefined; loadout: string | null; error: string }[]) {
  const usable = index.filter((e) => !e.duplicateOf && e.flags.length === 0);
  const asc = countBy(usable, (e) => `${e.className} / ${e.ascendancy ?? "none"}`);
  const matrix = new Map<string, Record<string, number>>();
  for (const e of usable) {
    const k = `${e.className} / ${e.ascendancy ?? "none"}`;
    const row = matrix.get(k) ?? {};
    row[e.stage] = (row[e.stage] ?? 0) + 1;
    matrix.set(k, row);
  }
  const stageCols = ["campaign", "early-maps", "mid-maps", "endgame", "ladder", "unlabelled"];
  const findings = countBy(usable.flatMap((e) => e.findings.map((f: string) => ({ f }))), (r) => r.f);
  return [
    `# Build corpus`,
    ``,
    `Generated ${new Date().toISOString()}. ${sources.length} sources, ${index.length} stages, ${usable.length} usable (not a duplicate, no flags).`,
    ``,
    `## Sources`,
    ``,
    table(countBy(sources, (s) => s.kind), "Kind"),
    ``,
    `## Usable stages by kind, league type and gear`,
    ``,
    table(countBy(usable, (e) => e.kind), "Kind"),
    ``,
    table(countBy(usable, (e) => e.leagueType ?? "unknown"), "League type"),
    ``,
    table(countBy(usable, (e) => e.gear), "Gear"),
    ``,
    `## Ascendancies by stage`,
    ``,
    `| Class / ascendancy | ${stageCols.join(" | ")} | Total |`,
    `|---|${stageCols.map(() => "---").join("|")}|---|`,
    ...asc.map(([k, total]) => `| ${k} | ${stageCols.map((c) => matrix.get(k)?.[c] ?? "").join(" | ")} | ${total} |`),
    ``,
    `## Flags and duplicates`,
    ``,
    table(countBy(index.flatMap((e) => e.flags.map((f: string) => ({ f }))), (r) => r.f), "Flag"),
    ``,
    `Exact duplicates: ${index.filter((e) => e.duplicateOf).length}. Near duplicates (same ascendancy, skill and gear status, 97% of nodes shared): ${index.filter((e) => e.nearDuplicateOf).length}.`,
    ``,
    `## Review findings on usable stages`,
    ``,
    table(findings, "Area"),
    ``,
    `## Load errors`,
    ``,
    errors.length === 0 ? "None." : errors.map((e) => `- ${e.source ? slash(relative(CORPUS, e.source.path)) : "?"}${e.loadout ? ` (loadout ${e.loadout})` : ""}: ${e.error.split("\n")[0].slice(0, 200)}`).join("\n"),
    ``,
  ].join("\n");
}

const sources = await collectSources();
console.log(`sources: ${sources.length} (${countBy(sources, (s) => s.kind).map(([k, v]) => `${k} ${v}`).join(", ")})`);
if (!args.includes("--clean-only")) await runBatches(sources);
await clean(sources);
