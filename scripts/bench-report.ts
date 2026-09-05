/**
 * Turn a bench-models.ts result file into a per-model, per-prompt matrix plus
 * the failure notes, so a model's weak spots are visible at a glance.
 *
 *   bun scripts/bench-report.ts target/bench/<stamp>.json
 */
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) throw new Error("usage: bun scripts/bench-report.ts <result.json>");
const data = JSON.parse(readFileSync(file, "utf8"));
const runs: any[] = data.runs;
const prompts = [...new Set(runs.map((r) => r.prompt))].sort((a, b) => a - b);
const titles = new Map<number, string>(runs.map((r) => [r.prompt, r.title]));
const models = [...new Set(runs.map((r) => r.model))];

const rowsOf = (m: string) => runs.filter((r) => r.model === m);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

const summary = models
  .map((m) => {
    const rs = rowsOf(m);
    const size = (data.models ?? []).find((x: any) => x.name === m)?.size ?? 0;
    return {
      model: m,
      size,
      score: mean(rs.map((r) => r.score)),
      read: mean(rs.filter((r) => r.prompt <= 4).map((r) => r.score)),
      write: mean(rs.filter((r) => r.prompt >= 5).map((r) => r.score)),
      noTools: rs.filter((r) => r.ended === "no-tools").length,
      errs: rs.reduce((a, r) => a + r.toolErrors + r.unknownTools + r.argErrors, 0),
      caps: rs.filter((r) => r.ended === "cap" || r.ended === "timeout" || r.ended === "error").length,
      time: mean(rs.map((r) => r.wallMs)) / 1000,
      tps: mean(rs.filter((r) => r.evalTokPerSec).map((r) => r.evalTokPerSec)),
      words: mean(rs.map((r) => r.words)),
      dashes: rs.reduce((a, r) => a + r.dashes, 0),
      narration: rs.reduce((a, r) => a + r.narration, 0),
    };
  })
  .sort((a, b) => b.score - a.score);

const out: string[] = [];
out.push(`# Local model bench (${file})`, "");
out.push(`Context ${data.numCtx}, temperature 0, ${prompts.length} prompts, the app's system prompt and tool list.`, "");
out.push("| Model | Size | Overall | Read (P1-4) | Write (P5-6) | No-tool answers | Tool errors | Capped/failed | Avg time | tok/s | Avg words | Dashes | Narration |");
out.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const s of summary) {
  out.push(
    `| ${s.model} | ${(s.size / 1e9).toFixed(1)} GB | **${(s.score * 100).toFixed(0)}%** | ${(s.read * 100).toFixed(0)}% | ${(s.write * 100).toFixed(0)}% | ${s.noTools} | ${s.errs} | ${s.caps} | ${s.time.toFixed(0)}s | ${s.tps.toFixed(0)} | ${s.words.toFixed(0)} | ${s.dashes} | ${s.narration} |`,
  );
}
out.push("", "## Per prompt", "");
out.push(`| Model | ${prompts.map((p) => `P${p} ${titles.get(p)}`).join(" | ")} |`);
out.push(`|---|${prompts.map(() => "---").join("|")}|`);
for (const s of summary) {
  const cells = prompts.map((p) => {
    const r = rowsOf(s.model).find((x) => x.prompt === p);
    if (!r) return "";
    const flag = r.ended === "stop" ? "" : ` (${r.ended})`;
    return `${(r.score * 100).toFixed(0)}%${flag}`;
  });
  out.push(`| ${s.model} | ${cells.join(" | ")} |`);
}
out.push("", "## Notes", "");
for (const s of summary) {
  const notes = rowsOf(s.model)
    .filter((r) => r.notes || r.error)
    .map((r) => `P${r.prompt}: ${[r.notes, r.error].filter(Boolean).join(" | ")}`);
  if (notes.length) out.push(`- **${s.model}**: ${notes.join("; ")}`);
}
console.log(out.join("\n"));
