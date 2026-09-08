/**
 * Call the running app's MCP tools from a terminal, the same registry the
 * chat panel uses, without spending API credit on the assistant.
 *
 * Start the app with the server on: `POB_REDUX_MCP=7315 bun run tauri dev`
 * (or toggle it in Options), then:
 *
 *   bun scripts/mcp-call.ts tools                      # names and one-line descriptions
 *   bun scripts/mcp-call.ts describe suggest_unique_jewels
 *   bun scripts/mcp-call.ts instructions
 *   bun scripts/mcp-call.ts call build_summary
 *   bun scripts/mcp-call.ts call suggest_unique_jewels '{"aim":"damage","limit":5}'
 *   bun scripts/mcp-call.ts call load_build '{"source":"C:/path/build.xml"}'
 *
 * `--port 7316` picks another port; `--raw` prints the tool's text unparsed.
 */
const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(name);
  if (i < 0) return null;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const port = flag("--port") ?? "7315";
const raw = argv.includes("--raw");
if (raw) argv.splice(argv.indexOf("--raw"), 1);
const MCP = `http://127.0.0.1:${port}/mcp`;

let session: string | null = null;
let rpcId = 0;

async function rpc(method: string, params: unknown = {}): Promise<any> {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (session) headers["mcp-session-id"] = session;
  let res: Response;
  try {
    res = await fetch(MCP, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) });
  } catch (e) {
    throw new Error(`no MCP server at ${MCP}: start the app with POB_REDUX_MCP=${port} or turn it on in Options (${String(e)})`);
  }
  const sid = res.headers.get("mcp-session-id");
  if (sid) session = sid;
  const text = await res.text();
  if (res.headers.get("content-type")?.includes("text/event-stream")) {
    const lines = text.split("\n").filter((l) => l.startsWith("data:"));
    return JSON.parse(lines[lines.length - 1].slice(5));
  }
  return text ? JSON.parse(text) : null;
}

async function init(): Promise<string> {
  const r = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "mcp-call", version: "0" } });
  await fetch(MCP, {
    method: "POST",
    headers: { "content-type": "application/json", "mcp-session-id": session!, accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  return r.result?.instructions ?? "";
}

const [cmd, ...rest] = argv;
const instructions = await init();
if (cmd === "instructions") {
  console.log(instructions);
} else if (cmd === "tools" || cmd === "describe") {
  const list = await rpc("tools/list", {});
  const tools: any[] = list.result?.tools ?? [];
  if (cmd === "describe") {
    const t = tools.find((x) => x.name === rest[0]);
    if (!t) throw new Error(`no tool ${rest[0]}`);
    console.log(t.name);
    console.log(t.description);
    console.log(JSON.stringify(t.inputSchema, null, 2));
  } else {
    for (const t of tools) console.log(`${t.name.padEnd(26)} ${String(t.description).split(/[.:]/)[0].slice(0, 110)}`);
    console.log(`\n${tools.length} tools`);
  }
} else if (cmd === "call") {
  const [name, json] = rest;
  if (!name) throw new Error("usage: call <tool> [json args]");
  const args = json ? JSON.parse(json) : {};
  const t0 = Date.now();
  const r = await rpc("tools/call", { name, arguments: args });
  const ms = Date.now() - t0;
  if (r?.error) {
    console.error(`error: ${r.error.message ?? JSON.stringify(r.error)}`);
    process.exit(1);
  }
  const text = r?.result?.content?.map((c: any) => c.text ?? "").join("\n") ?? "";
  if (r?.result?.isError) {
    console.error(`tool error: ${text}`);
    process.exit(1);
  }
  if (raw) {
    console.log(text);
  } else {
    try {
      console.log(JSON.stringify(JSON.parse(text), null, 2));
    } catch {
      console.log(text);
    }
  }
  console.error(`(${name} in ${ms} ms)`);
} else {
  console.log("usage: bun scripts/mcp-call.ts tools | describe <tool> | instructions | call <tool> [json] [--port n] [--raw]");
}
