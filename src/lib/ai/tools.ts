import { invoke } from "@tauri-apps/api/core";
import { jsonSchema, tool, type ToolSet } from "ai";

import { ALLOWED } from "$lib/ai/allowed";

export { ALLOWED };

export interface ToolDef {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  read_only: boolean;
  destructive: boolean;
}


export async function loadToolDefs(): Promise<ToolDef[]> {
  const all = await invoke<ToolDef[]>("ai_tools");
  return all.filter((d) => ALLOWED.has(d.name));
}

/**
 * AI SDK tools with no `execute`. The loop runs them itself so a write can be
 * held for approval first — an `execute` callback would fire before the user
 * could decline.
 */
export function toToolSet(defs: ToolDef[]): ToolSet {
  return Object.fromEntries(
    defs.map((d) => [
      d.name,
      tool({
        description: d.description,
        inputSchema: jsonSchema(d.schema as never),
      }),
    ]),
  );
}

export function callTool(name: string, args: unknown): Promise<unknown> {
  return invoke("ai_call_tool", { name, args: args ?? {} });
}
