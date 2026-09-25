import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { ALLOWED } from "../src/lib/ai/allowed";
import type { ToolDef } from "../src/lib/ai/tools";

export type McpTool = { name: string; description: string; annotations?: { readOnlyHint?: boolean } };

function token(): string {
  const fromEnv = process.env.POB_REDUX_MCP_TOKEN;
  if (fromEnv) return fromEnv.trim();
  const appData = process.env.APPDATA ?? join(homedir(), ".config");
  return readFileSync(join(appData, "dev.pobredux.desktop", "mcp-token"), "utf8").trim();
}

export async function listTools(port = process.env.POB_REDUX_MCP ?? "7315"): Promise<McpTool[]> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token()}`,
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/list",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "pob-redux-scripts", version: "0" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  const text = await res.text();
  const line = text.split("\n").filter((l) => l.startsWith("data:")).pop();
  const body = JSON.parse(line ? line.slice(5) : text);
  if (!body.result?.tools) throw new Error(`tools/list failed: ${JSON.stringify(body).slice(0, 300)}`);
  return body.result.tools;
}

/** The chat panel's tool set, shaped as the panel sees it. */
export function toDefs(tools: McpTool[]): ToolDef[] {
  return tools
    .filter((t) => ALLOWED.has(t.name))
    .map((t) => ({ name: t.name, description: t.description, read_only: t.annotations?.readOnlyHint ?? false }) as ToolDef);
}
