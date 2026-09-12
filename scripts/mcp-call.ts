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
 *   bun scripts/mcp-call.ts discover
 *   bun scripts/mcp-call.ts call build_summary
 *   bun scripts/mcp-call.ts call suggest_unique_jewels '{"aim":"damage","limit":5}'
 *   bun scripts/mcp-call.ts call load_build '{"source":"C:/path/build.xml"}'
 *
 * Speaks 2026-07-28 statelessly. `--legacy` uses the 2025-11-25 handshake
 * instead, `--port 7316` picks another port, `--raw` prints the tool's text
 * unparsed, `--tasks` and `--elicit` declare those client capabilities so the
 * server answers slow tools with a task and destructive ones with a
 * confirmation.
 *
 * The bearer token comes from POB_REDUX_MCP_TOKEN, else the app's own
 * `mcp-token` file.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const VERSION = "2026-07-28";
const LEGACY_VERSION = "2025-11-25";

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(name);
  if (i < 0) return null;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const bool = (name: string) => {
  const i = argv.indexOf(name);
  if (i < 0) return false;
  argv.splice(i, 1);
  return true;
};
const port = flag("--port") ?? "7315";
const raw = bool("--raw");
const legacy = bool("--legacy");
const wantTasks = bool("--tasks");
const wantElicit = bool("--elicit");
const MCP = `http://127.0.0.1:${port}/mcp`;

function token(): string {
  const fromEnv = process.env.POB_REDUX_MCP_TOKEN;
  if (fromEnv) return fromEnv.trim();
  const appData = process.env.APPDATA ?? join(homedir(), ".config");
  const path = join(appData, "dev.pobredux.desktop", "mcp-token");
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    throw new Error(`no token: set POB_REDUX_MCP_TOKEN or start the app once so it writes ${path}`);
  }
}

const BEARER = token();
const capabilities: Record<string, unknown> = {};
if (wantTasks || wantElicit) {
  const extensions: Record<string, unknown> = {};
  if (wantTasks) extensions["io.modelcontextprotocol/tasks"] = {};
  if (Object.keys(extensions).length) capabilities.extensions = extensions;
  if (wantElicit) capabilities.elicitation = { form: {} };
}

let session: string | null = null;
let rpcId = 0;

async function rpc(method: string, params: Record<string, unknown> = {}): Promise<any> {
  const id = ++rpcId;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${BEARER}`,
  };
  const body: Record<string, unknown> = { jsonrpc: "2.0", id, method, params };
  if (legacy) {
    if (session) headers["mcp-session-id"] = session;
  } else {
    // SEP-2243 request headers and SEP-2575 per-request metadata.
    headers["mcp-protocol-version"] = VERSION;
    headers["mcp-method"] = method;
    // SEP-2243: the name of the thing being acted on, which for tasks/* is the task id.
    const subject = params.name ?? params.taskId;
    if (typeof subject === "string") headers["mcp-name"] = subject;
    body.params = {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": VERSION,
        "io.modelcontextprotocol/clientInfo": { name: "mcp-call", version: "0" },
        "io.modelcontextprotocol/clientCapabilities": capabilities,
        ...((params._meta as object) ?? {}),
      },
    };
  }
  let res: Response;
  try {
    res = await fetch(MCP, { method: "POST", headers, body: JSON.stringify(body) });
  } catch (e) {
    throw new Error(`no MCP server at ${MCP}: start the app with POB_REDUX_MCP=${port} or turn it on in Options (${String(e)})`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error(`${res.status} ${await res.text()}`);
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

async function start(): Promise<string> {
  if (!legacy) {
    const r = await rpc("server/discover");
    return r.result?.instructions ?? "";
  }
  const r = await rpc("initialize", {
    protocolVersion: LEGACY_VERSION,
    capabilities,
    clientInfo: { name: "mcp-call", version: "0" },
  });
  await fetch(MCP, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "mcp-session-id": session!,
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${BEARER}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  return r.result?.instructions ?? "";
}

/** Poll tasks/get until the task settles, then return its inlined result. */
async function awaitTask(taskId: string, pollMs: number): Promise<any> {
  for (;;) {
    await new Promise((r) => setTimeout(r, pollMs));
    const g = await rpc("tasks/get", { taskId });
    const t = g.result;
    if (!t) throw new Error(`tasks/get returned nothing: ${JSON.stringify(g)}`);
    if (t.status === "working" || t.status === "input_required") {
      if (t.statusMessage) console.error(`  ... ${t.status}: ${t.statusMessage}`);
      continue;
    }
    if (t.status === "completed") return t.result;
    throw new Error(`task ${t.status}: ${JSON.stringify(t.error ?? {})}`);
  }
}

const [cmd, ...rest] = argv;

if (cmd === "discover") {
  const r = await rpc("server/discover");
  console.log(JSON.stringify(r.result, null, 2));
} else {
  const instructions = await start();
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
      console.log(JSON.stringify({ inputSchema: t.inputSchema, outputSchema: t.outputSchema, annotations: t.annotations }, null, 2));
    } else {
      for (const t of tools) console.log(`${t.name.padEnd(26)} ${String(t.description).split(/[.:]/)[0].slice(0, 110)}`);
      console.log(`\n${tools.length} tools, ttlMs ${list.result?.ttlMs}, cacheScope ${list.result?.cacheScope}`);
    }
  } else if (cmd === "call") {
    const [name, json] = rest;
    if (!name) throw new Error("usage: call <tool> [json args]");
    const args = json ? JSON.parse(json) : {};
    const t0 = Date.now();
    let r = await rpc("tools/call", { name, arguments: args });
    if (r?.result?.resultType === "input_required") {
      const keys = Object.keys(r.result.inputRequests ?? {});
      console.error(`confirming: ${keys.join(", ")}`);
      const inputResponses = Object.fromEntries(keys.map((k) => [k, { action: "accept", content: { [k]: true } }]));
      r = await rpc("tools/call", { name, arguments: args, inputResponses, requestState: r.result.requestState });
    }
    if (r?.error) {
      console.error(`error: ${r.error.message ?? JSON.stringify(r.error)}`);
      process.exit(1);
    }
    let result = r?.result;
    if (result?.resultType === "task") {
      console.error(`task ${result.taskId}`);
      result = await awaitTask(result.taskId, result.pollIntervalMs ?? 1000);
    }
    const ms = Date.now() - t0;
    const text = result?.content?.map((c: any) => c.text ?? "").join("\n") ?? "";
    if (result?.isError) {
      console.error(`tool error: ${text}`);
      process.exit(1);
    }
    if (raw) {
      console.log(text);
    } else {
      console.log(JSON.stringify(result?.structuredContent ?? text, null, 2));
    }
    console.error(`(${name} in ${ms} ms)`);
  } else {
    console.log("usage: bun scripts/mcp-call.ts tools | describe <tool> | instructions | discover | call <tool> [json]");
    console.log("       [--port n] [--raw] [--legacy] [--tasks] [--elicit]");
  }
}
