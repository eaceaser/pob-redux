import { invoke } from "@tauri-apps/api/core";
import { jsonSchema, tool, type ToolSet } from "ai";

export interface ToolDef {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  read_only: boolean;
  destructive: boolean;
}

/**
 * The subset of the 59 MCP tools the chat panel may use. The full set costs
 * ~4,700 tokens on every turn and the user pays for it, so the panel gets the
 * ones that answer questions plus the reversible edits. Build lifecycle and
 * every `delete_*` stay out: they have no undo.
 *
 * External MCP clients still see all 59.
 */
export const ALLOWED = new Set([
  // read
  "get_character",
  "get_stats",
  "get_sidebar",
  "list_stat_keys",
  "sanity_check",
  "get_tree_state",
  "search_tree",
  "node_info",
  "node_path_cost",
  "path_plan",
  "get_items",
  "list_items",
  "get_skills",
  "get_config",
  "list_config_options",
  "get_notes",
  // Gems and gear cannot be chosen without looking them up first. add_gem's own
  // description points at list_gems, and equipping a real unique needs the
  // database rather than invented item text.
  "list_gems",
  "list_valid_supports",
  "search_item_db",
  // write, approval-gated
  "alloc_node",
  "alloc_path",
  "set_attribute_choice",
  "dealloc_node",
  "tree_undo",
  "set_level",
  "set_config",
  "set_main_skill",
  "add_socket_group",
  "set_socket_group",
  "add_gem",
  "set_gem",
  "remove_gem",
  "equip_item_raw",
  "equip_from_item_db",
  "unequip_item",
]);

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
