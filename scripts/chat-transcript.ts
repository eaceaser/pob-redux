/**
 * Print a POB_REDUX_CHAT_LOG transcript in a readable form: the user turns,
 * every tool call with a trimmed result, and the assistant text.
 *
 *   bun scripts/chat-transcript.ts <log.json> [--full]
 */
import { readFileSync } from "node:fs";

const file = process.argv[2];
const full = process.argv.includes("--full");
if (!file) throw new Error("usage: bun scripts/chat-transcript.ts <log.json> [--full]");
const d = JSON.parse(readFileSync(file, "utf8"));
const cut = (s: string, n: number) => (full || s.length <= n ? s : s.slice(0, n) + " …");
console.log(`usage ${JSON.stringify(d.usage)} notice=${d.notice ?? ""} error=${d.error ?? ""}`);
let calls = 0;
for (const t of d.turns) {
  if (t.kind === "user") console.log(`\n### USER\n${t.text}`);
  else if (t.kind === "assistant") console.log(`\n### ASSISTANT\n${t.text}`);
  else {
    calls++;
    const args = JSON.stringify(t.args ?? {});
    const res = t.error ? `ERROR ${t.error}` : JSON.stringify(t.result ?? "");
    console.log(`\n[${t.name} ${t.status}] ${cut(args, 220)}\n   -> ${cut(res, 260)}`);
  }
}
console.log(`\ntool calls: ${calls}`);
