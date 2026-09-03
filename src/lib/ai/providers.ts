import { invoke } from "@tauri-apps/api/core";

export type ApiKind = "anthropic" | "open-ai-compatible";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** Anthropic accepts two levels above `high`; everyone else stops there. */
export const effortsFor = (kind: ApiKind): Effort[] =>
  kind === "anthropic" ? ["low", "medium", "high", "xhigh", "max"] : ["low", "medium", "high"];

export interface ProviderStatus {
  id: string;
  label: string;
  kind: ApiKind;
  needs_key: boolean;
  keys_url: string | null;
  base_url: string;
  default_base: string;
  has_key: boolean;
  hint: string | null;
  ready: boolean;
}

export interface ModelInfo {
  id: string;
  label: string;
  supports_effort: boolean;
  /** Current generation or one back — the UI groups these first. */
  recommended: boolean;
  /** Costs nothing to call, where the provider says so. */
  free: boolean;
}

export const listProviders = () => invoke<ProviderStatus[]>("ai_providers");
export const listModels = (provider: string) => invoke<ModelInfo[]>("ai_models", { provider });
export const setKey = (provider: string, key: string) => invoke<void>("ai_key_set", { provider, key });
export const clearKey = (provider: string) => invoke<void>("ai_key_clear", { provider });
export const setBase = (provider: string, baseUrl: string) =>
  invoke<void>("ai_base_set", { provider, baseUrl });

/**
 * Effort is expressed differently by each API. Claude 5 models take a top-level
 * `effort` alongside adaptive thinking — the older `thinking.type: "enabled"`
 * with a token budget is rejected by them. OpenAI-compatible providers take
 * `reasoning_effort`, which only understands the first three levels.
 */
type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

export function effortOptions(kind: ApiKind, effort: Effort): Record<string, Record<string, JsonValue>> {
  if (kind === "anthropic") {
    return { anthropic: { thinking: { type: "adaptive" }, effort } };
  }
  const capped: Effort = effort === "xhigh" || effort === "max" ? "high" : effort;
  return { openaiCompatible: { reasoningEffort: capped } };
}
