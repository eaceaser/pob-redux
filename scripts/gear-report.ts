/**
 * Print the equipped gear of the open build as a shopping list: slot, base,
 * implicit, and every explicit mod line. Reads through the MCP server.
 *
 *   bun scripts/gear-report.ts
 */
const MCP = "http://127.0.0.1:7315/mcp";
let session: string | null = null;
let id = 0;

async function rpc(method: string, params: unknown = {}): Promise<any> {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (session) headers["mcp-session-id"] = session;
  const res = await fetch(MCP, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
  const sid = res.headers.get("mcp-session-id");
  if (sid) session = sid;
  const text = await res.text();
  if (res.headers.get("content-type")?.includes("text/event-stream")) {
    const lines = text.split("\n").filter((l) => l.startsWith("data:"));
    return JSON.parse(lines[lines.length - 1].slice(5));
  }
  return text ? JSON.parse(text) : null;
}

await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "gear", version: "0" } });
await fetch(MCP, {
  method: "POST",
  headers: { "content-type": "application/json", "mcp-session-id": session!, accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
});
const r = await rpc("tools/call", { name: "list_items", arguments: {} });
const items = JSON.parse(r.result.content[0].text).items as any[];
const order = ["Weapon 1", "Weapon 2", "Helmet", "Body Armour", "Gloves", "Boots", "Belt", "Amulet", "Ring 1", "Ring 2"];
const equipped = items.filter((it) => it.equippedSlot).sort((a, b) => order.indexOf(a.equippedSlot) - order.indexOf(b.equippedSlot));
for (const it of equipped) {
  const raw: string = it.raw ?? "";
  const lines = raw.split("\n");
  const implicitsAt = lines.findIndex((l) => l.startsWith("Implicits:"));
  const nImpl = implicitsAt >= 0 ? Number(lines[implicitsAt].split(":")[1]) : 0;
  const body = implicitsAt >= 0 ? lines.slice(implicitsAt + 1) : [];
  const clean = (l: string) => l.replace(/\{[^}]*\}/g, "").trim();
  const implicits = body.slice(0, nImpl).map(clean).filter(Boolean);
  const explicits = body.slice(nImpl).map(clean).filter(Boolean);
  console.log(`${it.equippedSlot} | ${it.baseName} (${it.rarity})`);
  if (implicits.length) console.log(`   implicit: ${implicits.join(" / ")}`);
  console.log(`   ${explicits.join(" | ")}`);
}
const stats = await rpc("tools/call", { name: "get_stats", arguments: { fields: ["Life", "TotalEHP", "Armour", "CombinedDPS", "FireResist", "ColdResist", "LightningResist", "ChaosResist", "Str", "ReqStr", "MovementSpeedMod"] } });
console.log("\nstats:", stats.result.content[0].text);
