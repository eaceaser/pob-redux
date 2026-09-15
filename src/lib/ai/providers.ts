import { invoke } from "@tauri-apps/api/core";

export type ApiKind = "anthropic" | "open-ai-compatible";
export type Effort = "none" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Anthropic accepts two levels above `high`. OpenAI's Responses API takes
 * `none` through `xhigh`; the other OpenAI-compatible APIs stop at `high`.
 */
export const effortsFor = (kind: ApiKind, provider?: string): Effort[] =>
  kind === "anthropic"
    ? ["low", "medium", "high", "xhigh", "max"]
    : provider === "openai"
      ? ["none", "low", "medium", "high", "xhigh"]
      : ["none", "low", "medium", "high"];

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
 * with a token budget is rejected by them. OpenAI's Responses API and the
 * OpenAI-compatible chat API both take `reasoning_effort`. A level the
 * provider does not offer is clamped: above the top to the top, `none` to
 * `medium`.
 */
type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

export function effortOptions(kind: ApiKind, effort: Effort, provider?: string): Record<string, Record<string, JsonValue>> {
  const allowed = effortsFor(kind, provider);
  const level: Effort = allowed.includes(effort) ? effort : effort === "none" ? "medium" : allowed[allowed.length - 1];
  if (kind === "anthropic") {
    return { anthropic: { thinking: { type: "adaptive" }, effort: level } };
  }
  if (provider === "openai") {
    return { openai: { reasoningEffort: level } };
  }
  return { openaiCompatible: { reasoningEffort: level } };
}
