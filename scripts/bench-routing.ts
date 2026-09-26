/**
 * Score assistant tool routing against scripts/routing-cases.json.
 *
 *   bun scripts/bench-routing.ts --keyword                                   # the keyword matcher, no API
 *   TYPESAFE_API_KEY=... bun scripts/bench-routing.ts                        # Jev
 *   bun scripts/bench-routing.ts --base http://127.0.0.1:8009 --model kev-latest
 *   OPENROUTER_API_KEY=... bun scripts/bench-routing.ts --base https://openrouter.ai/api           # Kev 4B
 *   bun scripts/bench-routing.ts --app                                       # the backend and key set in the running app
 *   ... --strategy noul      # one yes/no per tool instead of one pick-one question
 *   ... --verbose            # list every miss at the app's threshold
 *
 * Tool definitions come from the running app (POB_REDUX_MCP=7315 bun run tauri dev) and are cached in
 * target/routing-defs.json; --offline reads the cache. Raw answers go to target/bench-routing-<strategy>.jsonl.
 * --app sends each request through the app's decide_ask over WebView2 remote debugging
 * (WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333), so the key never leaves the app.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { CORE } from "../src/lib/ai/allowed";
import { firstSentence, readPicks, routingRequest, type Decision, type Pick, type Question } from "../src/lib/ai/decide";
import { findTools, type ToolDef } from "../src/lib/ai/tools";
import { listTools, toDefs } from "./mcp-tools";

type Case = { q: string; previous?: string; need: string[]; ok: string[]; lang?: string; src?: string };

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name: string) => argv.includes(name);

const strategy = has("--keyword") ? "keyword" : (flag("--strategy") ?? "choice");
const base = (flag("--base") ?? "https://api.typesafe.ai").replace(/\/+$/, "");
const model = flag("--model") ?? (base.includes("typesafe") ? "jev-latest" : base.includes("openrouter") ? "jaredpalmer/kev-4b" : "kev-latest");
const key = (base.includes("openrouter") ? process.env.OPENROUTER_API_KEY : process.env.TYPESAFE_API_KEY ?? process.env.KEV_API_KEY) ?? "";
const APP_MIN = 0.15;
const APP_MAX = 3;
const PRICE_PER_TOKEN = 0.042 / 1e6;

const cases: Case[] = JSON.parse(readFileSync("scripts/routing-cases.json", "utf8"));
mkdirSync("target", { recursive: true });
const cache = "target/routing-defs.json";
let defs: ToolDef[];
if (has("--offline")) {
  if (!existsSync(cache)) throw new Error(`${cache} is missing: run once with the app up`);
  defs = JSON.parse(readFileSync(cache, "utf8"));
} else {
  defs = toDefs(await listTools());
  writeFileSync(cache, JSON.stringify(defs, null, 2));
}
const candidates = defs.filter((d) => !CORE.has(d.name));
const names = new Set(candidates.map((d) => d.name));
for (const c of cases) {
  for (const n of [...c.need, ...c.ok]) if (!names.has(n)) throw new Error(`case "${c.q.slice(0, 40)}" names ${n}, which is not a routable tool`);
}

async function viaApp(port: string) {
  const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = pages.find((p: { type: string; url: string }) => p.type === "page" && !p.url.startsWith("devtools"));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  type Reply = { result?: { result?: { value?: unknown }; exceptionDetails?: { exception?: { description?: string } } } };
  let id = 0;
  const pending = new Map<number, (v: Reply) => void>();
  ws.onmessage = (e) => {
    const msg = JSON.parse(String(e.data));
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  };
  return async (state: unknown, questions: Record<string, Question>): Promise<Decision> => {
    const args = JSON.stringify({ state, questions, timeoutMs: 15_000 });
    const msg = await new Promise<Reply>((resolve) => {
      const i = ++id;
      pending.set(i, resolve);
      ws.send(
        JSON.stringify({
          id: i,
          method: "Runtime.evaluate",
          params: { expression: `window.__TAURI_INTERNALS__.invoke("decide_ask", ${args})`, awaitPromise: true, returnByValue: true },
        }),
      );
    });
    const err = msg.result?.exceptionDetails;
    if (err) throw new Error(err.exception?.description ?? "decide_ask failed");
    return msg.result?.result?.value as Decision;
  };
}

const appAsk = has("--app") ? await viaApp(flag("--cdp") ?? "9333") : null;

async function systemOne(state: unknown, questions: Record<string, Question>): Promise<Decision> {
  if (appAsk) return appAsk(state, questions);
  for (let attempt = 0; ; attempt++) {
    const t0 = performance.now();
    const res = await fetch(`${base}/v1/systemone`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ state, model, questions }),
    });
    if ((res.status === 429 || res.status === 529) && attempt < 4) {
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      continue;
    }
    if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 300)}`);
    return { ...(await res.json()), elapsed_ms: Math.round(performance.now() - t0) };
  }
}

function noulRequest(c: Case) {
  const state = c.previous ? { request: c.q, previous: c.previous } : { request: c.q };
  const questions: Record<string, Question> = Object.fromEntries(
    candidates.map((d) => [
      d.name,
      {
        type: "noul",
        instructions:
          `A Path of Exile 2 player asks an assistant in a Path of Building app about their build. ` +
          `Does the assistant need the tool ${d.name} (${firstSentence(d.description)}) for \`request\`?`,
      },
    ]),
  );
  return { state, questions };
}

type Raw = { scores: Record<string, number>; ms: number; tokens: number; model: string };

async function ask(c: Case): Promise<Raw> {
  if (strategy === "keyword") {
    const found = findTools(candidates, c.q, APP_MAX);
    return { scores: Object.fromEntries(found.map((d, i) => [d.name, 1 - i * 0.1])), ms: 0, tokens: 0, model: "keyword" };
  }
  const { state, questions } = strategy === "noul" ? noulRequest(c) : routingRequest(c.q, candidates, c.previous);
  const res = await systemOne(state, questions);
  const scores =
    strategy === "noul"
      ? Object.fromEntries(Object.entries(res.answers).flatMap(([n, a]) => (a?.type === "noul" ? [[n, a.noul]] : [])))
      : Object.fromEntries(readPicks(res.answers, 0, 1000).map((p) => [p.name, p.p]));
  return { scores, ms: res.elapsed_ms, tokens: res.usage?.input_tokens ?? 0, model: res.model };
}

const raws: Raw[] = new Array(cases.length);
let next = 0;
await Promise.all(
  Array.from({ length: strategy === "keyword" ? 1 : 6 }, async () => {
    while (next < cases.length) {
      const i = next++;
      raws[i] = await ask(cases[i]);
    }
  }),
);
writeFileSync(
  `target/bench-routing-${strategy}.jsonl`,
  cases.map((c, i) => JSON.stringify({ ...c, ...raws[i] })).join("\n") + "\n",
);

const picksAt = (r: Raw, min: number): Pick[] =>
  Object.entries(r.scores)
    .filter(([, p]) => p >= min)
    .sort((a, b) => b[1] - a[1])
    .slice(0, APP_MAX)
    .map(([name, p]) => ({ name, p }));

function evaluate(min: number) {
  let withNeed = 0, top1 = 0, hit = 0, all = 0, noneCases = 0, noneClean = 0, waste = 0, loads = 0;
  let langCases = 0, langHit = 0;
  const misses: string[] = [];
  cases.forEach((c, i) => {
    const picks = picksAt(raws[i], min).map((p) => p.name);
    loads += picks.length;
    const extra = picks.filter((p) => !c.need.includes(p) && !c.ok.includes(p));
    waste += extra.length;
    if (c.need.length) {
      withNeed++;
      const h = c.need.some((n) => picks.includes(n));
      if (c.need.includes(picks[0])) top1++;
      if (h) hit++;
      if (c.need.every((n) => picks.includes(n))) all++;
      if (c.lang) {
        langCases++;
        if (h) langHit++;
      }
      if (!h) misses.push(`miss  ${c.q.slice(0, 70).padEnd(70)} want ${c.need.join("+")}, got ${picks.join(", ") || "-"}`);
    } else {
      noneCases++;
      if (!extra.length) noneClean++;
      else misses.push(`extra ${c.q.slice(0, 70).padEnd(70)} want none, got ${extra.join(", ")}`);
    }
  });
  const pct = (a: number, b: number) => `${b ? Math.round((a / b) * 100) : 0}%`.padStart(5);
  return {
    row: `${String(min).padEnd(5)} ${pct(top1, withNeed)} ${pct(hit, withNeed)} ${pct(all, withNeed)} ${pct(noneClean, noneCases)}  ${(loads / cases.length).toFixed(2).padStart(5)} ${(waste / cases.length).toFixed(2).padStart(5)}  ${pct(langHit, langCases)}`,
    misses,
  };
}

const ms = raws.map((r) => r.ms).sort((a, b) => a - b);
const tokens = raws.reduce((n, r) => n + r.tokens, 0);
console.log(`${strategy} · ${raws[0]?.model ?? ""} · ${cases.length} cases, ${candidates.length} routable tools`);
if (strategy !== "keyword") {
  console.log(
    `latency p50 ${ms[Math.floor(ms.length / 2)]} ms, p95 ${ms[Math.floor(ms.length * 0.95)]} ms · ` +
      `${tokens} input tokens (${Math.round(tokens / cases.length)} per message, $${(tokens * PRICE_PER_TOKEN).toFixed(4)} total at Jev's price)`,
  );
}
console.log("\nmin    top1   hit   all  clean  loads waste  other-lang");
const thresholds = strategy === "keyword" ? [0] : strategy === "noul" ? [0.3, 0.5, 0.7, 0.9] : [0.05, 0.1, APP_MIN, 0.2, 0.3];
for (const t of thresholds) console.log(evaluate(t).row);
console.log(
  "\ntop1/hit/all: messages that need a tool, where the first pick / any pick / every pick is right." +
    "\nclean: messages the loaded tools already cover, where nothing extra was picked. loads/waste: tools picked per message, and how many were not useful.",
);
if (has("--verbose")) {
  const at = strategy === "keyword" ? 0 : strategy === "noul" ? 0.5 : APP_MIN;
  console.log(`\nat ${at}:\n${evaluate(at).misses.join("\n")}`);
}
process.exit(0);
