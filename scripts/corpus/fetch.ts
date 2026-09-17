#!/usr/bin/env bun
/**
 * Collect the build corpus's raw inputs into corpus/raw (Path of Exile 2).
 *
 *   bun scripts/corpus/fetch.ts                 # guides from corpus/sources.md, then the ladder
 *   bun scripts/corpus/fetch.ts --only guides
 *   bun scripts/corpus/fetch.ts --only ladder --sc 8 --hc 4 --ssf 4
 *
 * Guides: each Mobalytics link in sources.md gives one Build Planner file per
 * variant and, when the author attached one, a PoB code. Ladder: poe.ninja's
 * build search lists a league's characters per ascendancy; each character's
 * PoB export comes from its character endpoint. Files that already exist are
 * kept, so a rerun only fetches what is missing.
 */
import { mkdir, exists } from "node:fs/promises";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "corpus");
const RAW = join(ROOT, "raw");
const UA = "pob-redux corpus (+https://pobredux.com)";
const PAUSE_MS = 700;

const args = process.argv.slice(2);
const arg = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const only = arg("only", "");
const perLeague = { sc: Number(arg("sc", "8")), hc: Number(arg("hc", "4")), ssf: Number(arg("ssf", "4")) };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const safe = (s: string) => s.replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, " ").trim().slice(0, 90);

async function writeJson(path: string, data: unknown) {
  await Bun.write(path, JSON.stringify(data, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// sources.md
// ---------------------------------------------------------------------------

interface Source {
  heading: string;
  url: string;
  leagueType: string | null;
  notes: string;
}

async function readSources(): Promise<Source[]> {
  const text = await Bun.file(join(ROOT, "sources.md")).text();
  const out: Source[] = [];
  let heading = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("#")) {
      heading = line.replace(/^#+\s*/, "");
      continue;
    }
    if (!/^https?:\/\//.test(line)) continue;
    const [url, league, ...notes] = line.split("|").map((s) => s.trim());
    out.push({ heading, url, leagueType: league ? league.toUpperCase() : null, notes: notes.join(" | ") });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Mobalytics
// ---------------------------------------------------------------------------

const BY_SLUG =
  "query PobReduxDocumentBySlug($input: Poe2UserGeneratedDocumentInputBySlug!) { poe2 { documents { userGeneratedDocumentBySlug(input: $input) { error errorMessage data { id data { pobCode buildVariants { values { id } } } } } } } }";
const EXPORT =
  "query Poe2UgDocumentWidgetBuildPlannerExportQuery($input: Poe2UserGeneratedDocumentInputById!, $variantId: String!) { poe2 { documents { userGeneratedDocumentById(input: $input) { error errorMessage data { exportToGame(variantId: $variantId) } } } } }";

async function mobalytics(op: string, query: string, variables: unknown, referer: string) {
  const r = await fetch("https://mobalytics.gg/api/poe-2/v1/graphql/query", {
    method: "POST",
    headers: { "user-agent": UA, accept: "application/json", origin: "https://mobalytics.gg", referer, "content-type": "application/json" },
    body: JSON.stringify({ operationName: op, variables, query }),
  });
  if (!r.ok) throw new Error(`Mobalytics HTTP ${r.status}`);
  const j = (await r.json()) as { data?: any; errors?: { message: string }[] };
  if (j.errors?.length) throw new Error(`Mobalytics: ${j.errors[0].message}`);
  return j.data;
}

async function pobCodeFrom(value: string): Promise<string> {
  const link = /pobb\.in\/([A-Za-z0-9_-]+)/.exec(value);
  if (!link) return value;
  const r = await fetch(`https://pobb.in/${link[1]}/raw`, { headers: { "user-agent": UA } });
  if (!r.ok) throw new Error(`pobb.in HTTP ${r.status}`);
  return (await r.text()).trim();
}

async function fetchGuides() {
  const sources = await readSources();
  let fetched = 0;
  const failed: string[] = [];
  for (const src of sources) {
    const m = /mobalytics\.gg\/poe-2\/(?:profile\/[^/]+\/)?builds\/([^/?#]+)/.exec(src.url);
    if (!m) {
      failed.push(`${src.url}: not a Mobalytics PoE2 build link`);
      continue;
    }
    const slug = m[1];
    const dir = join(RAW, "guides", "mobalytics", slug);
    if (await exists(join(dir, "meta.json"))) continue;
    try {
      const data = await mobalytics("PobReduxDocumentBySlug", BY_SLUG, { input: { slug, type: "builds" } }, src.url);
      const doc = data?.poe2?.documents?.userGeneratedDocumentBySlug;
      if (doc?.error) throw new Error(doc.error);
      const id: string = doc.data.id;
      await mkdir(join(dir, "variants"), { recursive: true });
      const variants = [];
      const ids: string[] = (doc.data.data.buildVariants?.values ?? []).map((v: { id: string }) => v.id);
      for (const [i, vid] of ids.entries()) {
        await sleep(PAUSE_MS);
        const exp = await mobalytics("Poe2UgDocumentWidgetBuildPlannerExportQuery", EXPORT, { input: { id }, variantId: vid }, src.url);
        const raw = exp?.poe2?.documents?.userGeneratedDocumentById?.data?.exportToGame;
        if (typeof raw !== "string") continue;
        const file = JSON.parse(raw);
        const name = String(file.name ?? `Variant ${i + 1}`);
        const fileName = `${String(i + 1).padStart(2, "0")} ${safe(name)}.build`;
        await Bun.write(join(dir, "variants", fileName), JSON.stringify(file, null, 2));
        variants.push({ id: vid, name, file: fileName });
      }
      let pob: string | null = null;
      const attached = doc.data.data.pobCode?.trim();
      if (attached) {
        pob = await pobCodeFrom(attached);
        await Bun.write(join(dir, "pob.txt"), pob + "\n");
      }
      await writeJson(join(dir, "meta.json"), {
        source: "mobalytics",
        url: src.url,
        heading: src.heading,
        leagueType: src.leagueType,
        notes: src.notes,
        documentId: id,
        hasPobCode: pob !== null,
        variants,
        fetchedAt: new Date().toISOString(),
      });
      fetched++;
      console.log(`guide ${slug}: ${variants.length} variants${pob ? " + PoB code" : ""}`);
    } catch (e) {
      failed.push(`${src.url}: ${e instanceof Error ? e.message : String(e)}`);
    }
    await sleep(PAUSE_MS);
  }
  console.log(`guides: ${fetched} fetched, ${failed.length} failed`);
  for (const f of failed) console.log(`  failed ${f}`);
  return failed;
}

// ---------------------------------------------------------------------------
// poe.ninja: the build search is protobuf, read here without a schema
// ---------------------------------------------------------------------------

type PbField = { no: number; v: number | Uint8Array };

function readVarint(b: Uint8Array, p: number): [number, number] {
  let x = 0;
  let s = 0;
  let c: number;
  do {
    c = b[p++];
    x += (c & 0x7f) * 2 ** s;
    s += 7;
  } while (c & 0x80);
  return [x, p];
}

function pbFields(b: Uint8Array): PbField[] {
  const out: PbField[] = [];
  let p = 0;
  while (p < b.length) {
    let key: number;
    [key, p] = readVarint(b, p);
    const no = Math.floor(key / 8);
    const wt = key % 8;
    if (wt === 0) {
      let v: number;
      [v, p] = readVarint(b, p);
      out.push({ no, v });
    } else if (wt === 2) {
      let len: number;
      [len, p] = readVarint(b, p);
      out.push({ no, v: b.subarray(p, p + len) });
      p += len;
    } else if (wt === 5) p += 4;
    else if (wt === 1) p += 8;
    else throw new Error(`unexpected wire type ${wt}`);
  }
  return out;
}

const td = new TextDecoder();

/** The string columns of a search page, keyed by column id (field 12 of the result). */
function searchColumns(body: Uint8Array): Map<string, string[]> {
  const result = pbFields(body).find((f) => f.no === 1)?.v;
  if (!(result instanceof Uint8Array)) throw new Error("poe.ninja search: no result");
  const cols = new Map<string, string[]>();
  for (const col of pbFields(result).filter((f) => f.no === 12)) {
    const fields = pbFields(col.v as Uint8Array);
    const id = fields.find((f) => f.no === 1)?.v;
    if (!(id instanceof Uint8Array)) continue;
    cols.set(
      td.decode(id),
      fields.filter((f) => f.no === 7 && f.v instanceof Uint8Array).map((f) => td.decode(f.v as Uint8Array)),
    );
  }
  return cols;
}

/** poe.ninja's dictionary files: a count, one length byte per entry, then the strings. */
function dictionaryNames(b: Uint8Array): string[] {
  const n = new DataView(b.buffer, b.byteOffset).getUint32(12, true);
  for (let at = b.length - n; at >= 16; at--) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += b[at + i];
    if (sum !== b.length - (at + n)) continue;
    const names: string[] = [];
    let p = at + n;
    for (let i = 0; i < n; i++) {
      names.push(td.decode(b.subarray(p, p + b[at + i])));
      p += b[at + i];
    }
    return names;
  }
  throw new Error("unreadable poe.ninja dictionary");
}

const BASE_CLASSES = new Set(["Druid", "Huntress", "Mercenary", "Monk", "Ranger", "Sorceress", "Warrior", "Witch"]);

async function ninja(path: string): Promise<Response> {
  const r = await fetch(`https://poe.ninja/poe2/${path}`, { headers: { "user-agent": UA } });
  if (r.status === 429) {
    await sleep(30_000);
    return ninja(path);
  }
  return r;
}

async function fetchLadder() {
  const index = (await (await ninja("api/data/index-state")).json()) as {
    buildLeagues: { name: string; url: string; hardcore: boolean }[];
    snapshotVersions: { url: string; name: string; version: string; snapshotName: string }[];
  };
  const league = index.buildLeagues.find((l) => !l.hardcore && l.url !== "standard");
  if (!league) throw new Error("poe.ninja lists no current league");
  const types: [keyof typeof perLeague, string][] = [
    ["sc", league.url],
    ["hc", `${league.url}hc`],
    ["ssf", `${league.url}ssf`],
  ];
  let fetched = 0;
  let missing = 0;
  for (const [type, url] of types) {
    const snap = index.snapshotVersions.find((s) => s.url === url);
    if (!snap || perLeague[type] <= 0) continue;
    // Any class-filtered search names the class dictionary; the unfiltered one is enough.
    const first = await ninja(`api/builds/${snap.version}/search?overview=${encodeURIComponent(snap.snapshotName)}`);
    const firstBody = new Uint8Array(await first.arrayBuffer());
    const dictHash = pbFields(pbFields(firstBody).find((f) => f.no === 1)!.v as Uint8Array)
      .filter((f) => f.no === 6)
      .map((f) => pbFields(f.v as Uint8Array))
      .find((d) => d.some((x) => x.no === 1 && td.decode(x.v as Uint8Array) === "class"))
      ?.find((x) => x.no === 2)?.v;
    if (!(dictHash instanceof Uint8Array)) throw new Error("poe.ninja search names no class dictionary");
    const dict = new Uint8Array(await (await ninja(`api/builds/dictionary/${td.decode(dictHash)}`)).arrayBuffer());
    const ascendancies = dictionaryNames(dict).filter((c) => !BASE_CLASSES.has(c));

    for (const asc of ascendancies) {
      await sleep(PAUSE_MS);
      const res = await ninja(`api/builds/${snap.version}/search?overview=${encodeURIComponent(snap.snapshotName)}&class=${encodeURIComponent(asc)}`);
      if (!res.ok) {
        console.log(`ladder ${type} ${asc}: search HTTP ${res.status}`);
        continue;
      }
      const cols = searchColumns(new Uint8Array(await res.arrayBuffer()));
      const names = cols.get("name") ?? [];
      const accounts = cols.get("account") ?? [];
      const dir = join(RAW, "ladder", type, safe(asc));
      await mkdir(dir, { recursive: true });
      let kept = 0;
      for (let i = 0; i < names.length && kept < perLeague[type]; i++) {
        const account = accounts[i];
        const name = names[i];
        const file = join(dir, `${safe(account)}__${safe(name)}.json`);
        if (await exists(file)) {
          kept++;
          continue;
        }
        await sleep(PAUSE_MS);
        const cr = await ninja(
          `api/builds/${snap.version}/character?account=${encodeURIComponent(account)}&name=${encodeURIComponent(name)}&overview=${encodeURIComponent(snap.snapshotName)}&timeMachine=`,
        );
        if (!cr.ok) {
          missing++;
          continue;
        }
        const c = (await cr.json()) as Record<string, unknown>;
        const pob = typeof c.pathOfBuildingExport === "string" ? c.pathOfBuildingExport : "";
        if (!pob) {
          missing++;
          continue;
        }
        await writeJson(file, {
          source: "poe.ninja",
          url: `https://poe.ninja/poe2/builds/${url}/character/${encodeURIComponent(account)}/${encodeURIComponent(name)}`,
          league: snap.name,
          leagueType: type.toUpperCase(),
          snapshotVersion: snap.version,
          ascendancy: asc,
          rank: i + 1,
          account,
          character: name,
          level: c.level ?? null,
          class: c.class ?? null,
          updatedUtc: c.updatedUtc ?? null,
          fetchedAt: new Date().toISOString(),
          pob,
        });
        kept++;
        fetched++;
      }
      console.log(`ladder ${type} ${asc}: ${kept}/${perLeague[type]}`);
    }
  }
  console.log(`ladder: ${fetched} fetched, ${missing} without a PoB export`);
}

if (only !== "ladder") await fetchGuides();
if (only !== "guides") await fetchLadder();
