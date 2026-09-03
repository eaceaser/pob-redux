import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { invoke } from "@tauri-apps/api/core";
import { isStepCount, streamText, type LanguageModel, type ModelMessage, type ToolResultPart } from "ai";

import {
  effortOptions,
  listModels,
  listProviders,
  type Effort,
  type ModelInfo,
  type ProviderStatus,
} from "$lib/ai/providers";
import { proxyFetch } from "$lib/ai/transport";
import { callTool, loadToolDefs, toToolSet, type ToolDef } from "$lib/ai/tools";
import { stripPobText } from "$lib/pobtext";
import { build } from "$lib/state/build.svelte";

const KEY = "pob-redux:chat";
const MAX_STEPS = 12;
export const MIN_WIDTH = 320;
export const MAX_WIDTH = 900;

const clampWidth = (w: number) => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(w)));

/** One tool call as the panel shows it. */
export interface ToolTurn {
  kind: "tool";
  id: string;
  name: string;
  args: unknown;
  readOnly: boolean;
  status: "awaiting" | "running" | "done" | "error" | "skipped";
  result?: unknown;
  error?: string;
}

export type Turn =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | ToolTurn;

/**
 * Appended to PoB's own tool instructions. Kept stable so the whole block stays
 * cacheable — anything that changes per turn goes in the user message instead.
 */
const STYLE = `

## How to answer

You are in the assistant panel of PoB Redux. The user is looking at the build
and watching it change as you work.

Write in plain language, following ISO 24495-1:2023:

- Lead with the answer. Put the conclusion in the first sentence.
- Keep it short. Two or three sentences is usually enough. Use a short list when
  there is more than one item.
- Use common words and the reader's terms. Path of Exile jargon is fine; jargon
  about your own process is not.
- One idea per sentence. Prefer active voice.
- Do not open with a restatement of the question or a preamble.

Do not use rhetorical flourishes. In particular:

- No negative parallelism ("not X, but Y").
- No sentence fragments for emphasis.
- No contrast pairs that state one point twice.

State what a thing is in one clause and stop.

## Accuracy

Every number must come from a tool call. Never estimate, and never carry a
number over from memory of another build. Name the stat key when you quote one.

Read before you write. Do not say you changed something unless the tool call
returned successfully. If a call fails or the user declines it, say so plainly
and stop; do not retry the same call.`;

class ChatStore {
  open = $state(false);
  turns = $state<Turn[]>([]);
  input = $state("");
  busy = $state(false);
  error = $state<string | null>(null);
  provider = $state("anthropic");
  model = $state("claude-sonnet-5");
  effort = $state<Effort>("medium");
  providers = $state<ProviderStatus[]>([]);
  models = $state<ModelInfo[]>([]);
  modelsError = $state<string | null>(null);
  settingsOpen = $state(false);
  /** Panel width in px, dragged by the grip on its left edge. */
  width = $state(400);
  /** Skip the approval prompt for the rest of this conversation. */
  allowWrites = $state(false);
  /** Tool names, for the `/` menu. */
  toolNames = $state<ToolDef[]>([]);

  private defs: ToolDef[] = [];
  private history: ModelMessage[] = [];
  private abort: AbortController | null = null;
  private pending = new Map<string, (ok: boolean) => void>();

  get current(): ProviderStatus | undefined {
    return this.providers.find((p) => p.id === this.provider);
  }

  get ready() {
    return this.current?.ready ?? false;
  }

  /** Any provider usable right now, so the panel knows whether to show setup. */
  get anyReady() {
    return this.providers.some((p) => p.ready);
  }

  get supportsEffort() {
    return this.models.find((m) => m.id === this.model)?.supports_effort ?? false;
  }

  async init(openOnBoot?: string | null) {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}");
      if (typeof saved.provider === "string") this.provider = saved.provider;
      if (typeof saved.model === "string") this.model = saved.model;
      if (typeof saved.effort === "string") this.effort = saved.effort;
      if (typeof saved.open === "boolean") this.open = saved.open;
      if (Number.isFinite(saved.width)) this.width = clampWidth(saved.width);
    } catch {}
    if (openOnBoot != null) this.open = true;
    if (openOnBoot === "settings") this.settingsOpen = true;
    await this.refreshProviders();
    // Land on something usable rather than an unconfigured provider.
    if (!this.ready) {
      const first = this.providers.find((p) => p.ready);
      if (first) await this.setProvider(first.id);
    }
    await this.refreshModels();
    this.defs = await loadToolDefs().catch(() => []);
    this.toolNames = this.defs;
  }

  private persist() {
    try {
      localStorage.setItem(
        KEY,
        JSON.stringify({
          provider: this.provider,
          model: this.model,
          effort: this.effort,
          open: this.open,
          width: this.width,
        }),
      );
    } catch {}
  }

  toggle() {
    this.open = !this.open;
    this.persist();
  }

  setModel(id: string) {
    this.model = id;
    this.persist();
  }

  setEffort(e: Effort) {
    this.effort = e;
    this.persist();
  }

  /** Live update while dragging; `commit` writes it to storage on release. */
  setWidth(px: number, commit = false) {
    this.width = clampWidth(px);
    if (commit) this.persist();
  }

  async setProvider(id: string) {
    this.provider = id;
    this.persist();
    await this.refreshModels();
  }

  async refreshProviders() {
    this.providers = await listProviders().catch(() => []);
  }

  /** Pull the model list for the selected provider and keep the choice valid. */
  async refreshModels() {
    this.modelsError = null;
    if (!this.ready) {
      this.models = [];
      return;
    }
    try {
      this.models = await listModels(this.provider);
      if (this.models.length && !this.models.some((m) => m.id === this.model)) {
        // Prefer a current-generation model over whatever merely sorts newest —
        // a provider's newest entry can be a niche preview.
        this.model = (this.models.find((m) => m.recommended) ?? this.models[0]).id;
        this.persist();
      }
    } catch (e) {
      this.models = [];
      this.modelsError = String(e);
    }
  }

  /**
   * Replace a tool turn in place. Mutating a captured reference does not survive
   * the array being spread into a new `$state` value, so patch by id.
   */
  private patchTool(id: string, patch: Partial<ToolTurn>) {
    this.turns = this.turns.map((t) => (t.kind === "tool" && t.id === id ? { ...t, ...patch } : t));
  }

  /** Answer a pending approval chip. */
  resolveApproval(id: string, ok: boolean) {
    const fn = this.pending.get(id);
    if (fn) {
      this.pending.delete(id);
      fn(ok);
    }
  }

  private approve(turn: ToolTurn): Promise<boolean> {
    if (turn.readOnly || this.allowWrites) return Promise.resolve(true);
    return new Promise((resolve) => this.pending.set(turn.id, resolve));
  }

  reset() {
    this.stop();
    this.turns = [];
    this.history = [];
    this.error = null;
    this.allowWrites = false;
  }

  stop() {
    this.abort?.abort();
    this.abort = null;
    for (const [id, fn] of this.pending) {
      this.pending.delete(id);
      fn(false);
    }
    this.busy = false;
  }

  /** A short snapshot of the open build, refreshed each turn. */
  private async context(): Promise<string> {
    if (!build.loaded) return "No build is open. Ask the user to load one, or use the tools to inspect once it is.";
    const info = build.info;
    const rows = (build.sidebar?.rows ?? [])
      .slice(0, 24)
      .map((r) => `${stripPobText(r.lhs)} ${stripPobText(r.rhs)}`.trim())
      .filter((s) => s.length > 1)
      .join("; ");
    return [
      `Open build: ${info?.name ?? "unnamed"} — level ${info?.level} ${info?.className}` +
        (info?.ascendClassName && info.ascendClassName !== "None" ? ` (${info.ascendClassName})` : ""),
      rows ? `Sidebar: ${rows}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  async send() {
    const text = this.input.trim();
    if (!text || this.busy) return;
    this.input = "";
    this.error = null;
    this.turns = [...this.turns, { kind: "user", text }];
    // The snapshot rides with the question rather than the instructions, so the
    // cached prefix stays byte-identical between turns.
    this.history.push({ role: "user", content: `${await this.context()}\n\n${text}` });
    await this.run();
  }

  /**
   * The key is injected in Rust, so the SDKs only need a placeholder. `baseURL`
   * is nominal too — `proxyFetch` sends the path to Rust, which resolves the
   * real host from the provider's own configuration.
   */
  private buildModel(kind: "anthropic" | "open-ai-compatible"): LanguageModel {
    const fetch = proxyFetch(this.provider);
    if (kind === "anthropic") {
      return createAnthropic({ apiKey: "managed-by-host", fetch })(this.model);
    }
    return createOpenAICompatible({
      name: this.provider,
      baseURL: "https://managed-by-host/v1",
      apiKey: "managed-by-host",
      fetch,
    })(this.model);
  }

  private async run() {
    this.busy = true;
    this.abort = new AbortController();
    try {
      if (!this.defs.length) this.defs = await loadToolDefs();
      const tools = toToolSet(this.defs);
      const readOnly = new Map(this.defs.map((d) => [d.name, d.read_only]));
      const kind = this.current?.kind ?? "anthropic";
      const model = this.buildModel(kind);
      const providerOptions = this.supportsEffort ? effortOptions(kind, this.effort) : undefined;
      const instructions = (await invoke<string>("ai_instructions").catch(() => "")) + STYLE;

      for (let step = 0; step < MAX_STEPS; step++) {
        const result = streamText({
          model,
          abortSignal: this.abort.signal,
          stopWhen: isStepCount(1),
          tools,
          providerOptions,
          // v7 takes the system prompt here, not as a message. Marked cacheable:
          // this plus the tool block dominates the prompt and repeats every turn.
          instructions: {
            role: "system",
            content: instructions,
            providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
          },
          messages: this.history,
        });

        let at = -1;
        for await (const part of result.fullStream) {
          if (part.type === "text-delta") {
            if (at < 0) {
              at = this.turns.length;
              this.turns = [...this.turns, { kind: "assistant", text: "" }];
            }
            const next = [...this.turns];
            const cur = next[at];
            if (cur.kind === "assistant") next[at] = { kind: "assistant", text: cur.text + part.text };
            this.turns = next;
          } else if (part.type === "error") {
            throw part.error;
          }
        }

        this.history.push(...(await result.responseMessages));
        if ((await result.finishReason) !== "tool-calls") break;

        const calls = await result.toolCalls;
        const outputs: ToolResultPart[] = [];
        for (const call of calls) {
          const turn: ToolTurn = {
            kind: "tool",
            id: call.toolCallId,
            name: call.toolName,
            args: call.input,
            readOnly: readOnly.get(call.toolName) ?? false,
            status: readOnly.get(call.toolName) ? "running" : "awaiting",
          };
          this.turns = [...this.turns, turn];

          const ok = await this.approve(turn);
          if (!ok) {
            this.patchTool(turn.id, { status: "skipped" });
            outputs.push({
              type: "tool-result",
              toolName: call.toolName,
              toolCallId: call.toolCallId,
              output: { type: "text", value: "The user declined this change. Do not retry it; suggest an alternative or ask why." },
            });
            continue;
          }

          this.patchTool(turn.id, { status: "running" });
          try {
            const value = await callTool(call.toolName, call.input);
            this.patchTool(turn.id, { result: value, status: "done" });
            outputs.push({
              type: "tool-result",
              toolName: call.toolName,
              toolCallId: call.toolCallId,
              output: { type: "text", value: JSON.stringify(value) },
            });
          } catch (e) {
            this.patchTool(turn.id, { error: String(e), status: "error" });
            outputs.push({
              type: "tool-result",
              toolName: call.toolName,
              toolCallId: call.toolCallId,
              output: { type: "text", value: `Error: ${String(e)}` },
            });
          }
          this.turns = [...this.turns];
        }
        this.history.push({ role: "tool", content: outputs });
      }
    } catch (e) {
      if (!String(e).includes("AbortError")) this.error = String(e);
    } finally {
      this.busy = false;
      this.abort = null;
    }
  }
}

export const chat = new ChatStore();
