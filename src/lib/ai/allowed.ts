/**
 * The subset of the MCP tools the chat panel may use. The full set costs
 * ~4,700 tokens on every turn and the user pays for it, so the panel gets the
 * ones that answer questions plus the reversible edits. Build lifecycle and
 * every `delete_*` stay out: they have no undo.
 *
 * External MCP clients still see every tool.
 */
export const ALLOWED = new Set([
  // read
  "get_character",
  "get_stats",
  "get_sidebar",
  "list_stat_keys",
  "sanity_check",
  "build_summary",
  "library",
  "checkpoint",
  "tree_suggest",
  "list_power_stats",
  "get_tree_state",
  "search_tree",
  "node_info",
  "node_path_cost",
  "path_plan",
  "get_items",
  "list_items",
  "get_skills",
  "skill_info",
  "get_config",
  "list_config_options",
  "get_notes",
  // Gems and gear cannot be chosen without looking them up first. add_gem's own
  // description points at list_gems, and equipping a real unique needs the
  // database rather than invented item text.
  "list_gems",
  "list_valid_supports",
  "search_item_db",
  "list_bases",
  "list_affixes",
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
  "craft_rare",
  "optimise_gear",
  "set_gem_levels",
  "unequip_item",
  "rollback",
  // Removing a whole skill setup is what "get rid of that skill" means, and
  // the approval gate plus checkpoint cover the missing undo.
  "remove_socket_group",
]);
