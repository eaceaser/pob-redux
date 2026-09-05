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
import { STYLE } from "$lib/ai/prompt";
import { callTool, loadToolDefs, toToolSet, type ToolDef } from "$lib/ai/tools";
import { writeTextFile } from "$lib/engine.svelte";
import { stripPobText } from "$lib/pobtext";
import { build } from "$lib/state/build.svelte";
import { gems } from "$lib/state/gems.svelte";

const KEY = "pob-redux:chat";
/**
 * Tool rounds allowed per message. Assembling a skill setup honestly costs a
 * lot of them: a search per candidate gem, a socket group and an add per skill,
 * a supports lookup, then a stat read to check the result. Twelve ran out
 * midway through exactly that. This is a runaway guard, not a budget.
 */
const MAX_STEPS = 48;
/** Anthropic cache breakpoint; see markCacheBreakpoint for the lifetime choice. */
const CACHE = { type: "ephemeral", ttl: "1h" } as const;
export const MIN_WIDTH = 320;
export const MAX_WIDTH = 900;

/** The prompt forbids em and en dashes; this is the backstop for the ones that slip through. */
const plainDashes = (s: string) => s.replace(/(\d)\s*[—–]\s*(\d)/g, "$1-$2").replace(/\s*[—–]\s*/g, ", ");

/** An answer that ends on an intention instead of an action. */
const ANNOUNCED = /\b(i'?ll|i will(?! not)|let me|i'?m going to|i am going to|will now)\b[^.!?\n]{0,160}[.!]?\s*$/i;

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
  /** `mark` is the history length before this message, so rewinding to it is exact. */
  | { kind: "user"; text: string; mark: number }
  | { kind: "assistant"; text: string }
  | ToolTurn;


/**
 * Turn a provider failure into something worth reading.
 *
 * Neither Anthropic nor OpenAI lets a normal API key query a balance — that
 * needs an admin key with organisation-wide scope — so running dry cannot be
 * warned about in advance. What can be done is to name it clearly when it
 * happens, rather than showing the raw provider JSON.
 */
function explainError(e: unknown, providerLabel: string): string {
  const raw = String(e);
  const t = raw.toLowerCase();

  if (t.includes("credit balance is too low") || t.includes("insufficient_quota") || t.includes("exceeded your current quota") || t.includes("402")) {
    return `${providerLabel} rejected the request for billing: the account is out of credit. Top it up, then try again.`;
  }
  if (t.includes("401") || t.includes("authentication_error") || t.includes("invalid api key") || t.includes("invalid_api_key")) {
    return `${providerLabel} rejected the key. Check it in provider settings.`;
  }
  if (t.includes("429") || t.includes("rate_limit")) {
    return `${providerLabel} is rate limiting this key. Wait a moment and try again.`;
  }
  if (t.includes("model is unavailable") || t.includes("model_not_found") || t.includes("does not exist")) {
    return `${providerLabel} cannot serve this model. Pick another in the model list.`;
  }
  if (t.includes("fetch failed") || t.includes("connection") || t.includes("econnrefused")) {
    return `Could not reach ${providerLabel}. For a local provider, check it is running.`;
  }
  return raw;
}

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
  /** Cumulative tokens for this conversation. Cache counts are Anthropic-only. */
  usage = $state({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  /**
   * Why the last run ended, when it ended for a reason worth saying out loud.
   * A run that finishes normally leaves this null.
   */
  notice = $state<string | null>(null);
  /** The run hit the step guard rather than finishing, so it can be resumed. */
  canContinue = $state(false);
  /** Panel width in px, dragged by the grip on its left edge. */
  width = $state(400);
  /** Skip the approval prompt for the rest of this conversation. */
  allowWrites = $state(false);
  /** Tool names, for the `/` menu. */
  toolNames = $state<ToolDef[]>([]);
  /** Dev hook: transcript file written when a run ends (POB_REDUX_CHAT_LOG). */
  logPath: string | null = null;
  /**
   * Ollama (Local) loads a model on first use and then evaluates the whole
   * prompt, tens of seconds a user would otherwise wait on their first
   * question. So the model is loaded and its prompt cache primed when it is
   * picked, and the composer says so. Hosted providers are always "ready".
   */
  warm = $state<"ready" | "loading" | "priming" | "failed">("ready");
  warmNote = $state("");
  private warmSeq = 0;
  private lastRequestAt = 0;

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
    void gems.load();
    void this.warmUp();
  }

  get needsWarm() {
    return this.current?.id === "ollama-local";
  }

  /** Load the local model and prime its prompt cache with the real prompt and tools. */
  async warmUp() {
    if (!this.needsWarm || !this.model) {
      this.warm = "ready";
      this.warmNote = "";
      return;
    }
    const seq = ++this.warmSeq;
    this.warm = "loading";
    this.warmNote = `loading ${this.model}`;
    try {
      const ms = await invoke<number>("ai_warm_model", { provider: this.provider, model: this.model });
      if (seq !== this.warmSeq) return;
      this.warm = "priming";
      this.warmNote = "priming the prompt";
      if (!this.defs.length) this.defs = await loadToolDefs();
      const instructions = (await invoke<string>("ai_instructions").catch(() => "")) + STYLE;
      // The same request shape as a real turn, one token long, so the cached
      // prefix matches what the first question will send.
      const result = streamText({
        model: this.buildModel("open-ai-compatible"),
        tools: toToolSet(this.defs),
        maxOutputTokens: 1,
        instructions: { role: "system", content: instructions },
        messages: [{ role: "user", content: "Ready?" }],
      });
      for await (const _ of result.fullStream) {
        // drain
      }
      if (seq !== this.warmSeq) return;
      this.lastRequestAt = Date.now();
      this.warm = "ready";
      this.warmNote = ms > 1000 ? `ready, loaded in ${Math.round(ms / 1000)}s` : "ready";
    } catch (e) {
      if (seq !== this.warmSeq) return;
      this.warm = "failed";
      this.warmNote = explainError(e, this.current?.label ?? this.provider);
    }
  }

  /**
   * The composer was focused. Ollama unloads an idle model after a few
   * minutes; warming again then is cheap and saves the wait on the next send.
   */
  touch() {
    if (this.needsWarm && this.warm === "ready" && Date.now() - this.lastRequestAt > 4 * 60_000) void this.warmUp();
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
    void this.warmUp();
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
    void this.warmUp();
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
    this.notice = null;
    this.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
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
    if (this.warm === "loading" || this.warm === "priming") return;
    this.input = "";
    this.error = null;
    this.notice = null;
    this.canContinue = false;
    this.turns = [...this.turns, { kind: "user", text, mark: this.history.length }];
    // The snapshot rides with the question rather than the instructions, so the
    // cached prefix stays byte-identical between turns.
    this.history.push({ role: "user", content: `${await this.context()}\n\n${text}` });
    await this.run();
  }

  /**
   * Rewind to a user message: its text goes back in the composer and everything
   * from it onward is dropped, from the visible log and from what the model
   * sees. Without the second part the model would still be carrying the reply
   * being replaced.
   */
  rewindTo(index: number) {
    const turn = this.turns[index];
    if (turn?.kind !== "user" || this.busy) return;
    this.stop();
    this.input = turn.text;
    this.turns = this.turns.slice(0, index);
    this.history = this.history.slice(0, turn.mark);
    this.error = null;
  }

  /**
   * Carry on from where the step budget ran out. The history already holds the
   * work so far, so this resumes rather than starting the task again.
   */
  async continueRun() {
    if (this.busy || !this.history.length) return;
    this.notice = null;
    this.canContinue = false;
    await this.run();
  }

  /** Send the last message again, dropping whatever it produced. */
  async retryLast() {
    if (this.busy) return;
    for (let i = this.turns.length - 1; i >= 0; i--) {
      if (this.turns[i].kind === "user") {
        this.rewindTo(i);
        await this.send();
        return;
      }
    }
  }

  /**
   * The key is injected in Rust, so the SDKs only need a placeholder. The host
   * is nominal too: `proxyFetch` sends only the path onward and Rust joins it
   * to the provider's configured base.
   *
   * That join is a plain concatenation, so exactly one side must carry the
   * version segment. Anthropic's base in ai.rs has none and its SDK default
   * baseURL supplies `/v1`. OpenAI-compatible bases already end in `/v1`
   * (`http://localhost:11434/v1`), so the placeholder here must not repeat it —
   * doing so produced `/v1/v1/chat/completions` and a 404 from every provider
   * of that kind.
   */
  private buildModel(kind: "anthropic" | "open-ai-compatible"): LanguageModel {
    const fetch = proxyFetch(this.provider);
    if (kind === "anthropic") {
      return createAnthropic({ apiKey: "managed-by-host", fetch })(this.model);
    }
    return createOpenAICompatible({
      name: this.provider,
      baseURL: "https://managed-by-host",
      apiKey: "managed-by-host",
      fetch,
    })(this.model);
  }

  /**
   * Cache the conversation so far. The system prompt and tools carry a fixed
   * breakpoint; this one moves to the newest message each step, and Anthropic
   * matches the unchanged prefix against the previous step's cache, so a
   * 20-step task pays for each message about once rather than 20 times.
   *
   * The 1-hour lifetime is for the gaps between turns: a user reading an
   * answer and typing the next question often takes longer than the 5-minute
   * default, after which the whole prefix would be written again.
   *
   * OpenAI and Ollama cache a repeated prefix on their own, and this loop
   * already keeps tools, system prompt and history in a stable, append-only
   * order, which is all they need. The other providers ignore the option.
   */
  private markCacheBreakpoint() {
    const mark = { anthropic: { cacheControl: CACHE } };
    for (let i = 0; i < this.history.length; i++) {
      const m = this.history[i] as ModelMessage & { providerOptions?: Record<string, unknown> };
      if (i === this.history.length - 1) m.providerOptions = mark;
      else delete m.providerOptions;
    }
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
      // Set when the model itself ends the turn, so exhausting the step budget
      // can be told apart from finishing.
      let done = false;
      // Read calls made this run, by name and arguments. A small model that
      // repeats one is looping; answering from the earlier result breaks the
      // loop instead of spending the step budget on it.
      const seen = new Map<string, number>();
      // A small model sometimes ends its turn on "I'll do X now" without doing
      // X. One nudge per run turns that into the call.
      let nudged = false;

      for (let step = 0; step < MAX_STEPS; step++) {
        this.markCacheBreakpoint();
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
            providerOptions: { anthropic: { cacheControl: CACHE } },
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
            if (cur.kind === "assistant") next[at] = { kind: "assistant", text: plainDashes(cur.text + part.text) };
            this.turns = next;
          } else if (part.type === "error") {
            throw part.error;
          }
        }

        this.lastRequestAt = Date.now();
        const u = await result.usage;
        this.usage = {
          input: this.usage.input + (u.inputTokens ?? 0),
          output: this.usage.output + (u.outputTokens ?? 0),
          cacheRead: this.usage.cacheRead + (u.inputTokenDetails?.cacheReadTokens ?? 0),
          cacheWrite: this.usage.cacheWrite + (u.inputTokenDetails?.cacheWriteTokens ?? 0),
        };

        this.history.push(...(await result.responseMessages));
        const finish = await result.finishReason;
        if (finish === "stop" && !nudged && at >= 0) {
          const last = this.turns[at];
          const text = last?.kind === "assistant" ? last.text.trim() : "";
          if (ANNOUNCED.test(text.slice(-200))) {
            nudged = true;
            this.history.push({ role: "user", content: "Do it now: call the tool. Do not describe what you are about to do." });
            continue;
          }
        }
        if (finish !== "tool-calls") {
          // Anything other than a plain stop ended the answer early, and saying
          // so is the difference between "finished" and "gave up quietly".
          if (finish === "length") {
            this.notice = "The reply hit the model's output limit and was cut off.";
          } else if (finish === "content-filter") {
            this.notice = "The provider's content filter stopped the reply.";
          } else if (finish === "error" || finish === "other") {
            this.notice = `The model stopped early (${finish}).`;
          }
          done = true;
          break;
        }

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

          const key = `${call.toolName}:${JSON.stringify(call.input ?? {})}`;
          if (turn.readOnly) {
            const n = (seen.get(key) ?? 0) + 1;
            seen.set(key, n);
            if (n >= 3) {
              this.patchTool(turn.id, { status: "skipped", error: "repeated call" });
              outputs.push({
                type: "tool-result",
                toolName: call.toolName,
                toolCallId: call.toolCallId,
                output: {
                  type: "text",
                  value: `You already called ${call.toolName} with these arguments ${n - 1} times this turn and the result did not change. Do not call it again. Use what you have and answer the user now.`,
                },
              });
              continue;
            }
          }

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

      if (!done) {
        this.notice = `Paused after ${MAX_STEPS} tool steps without finishing.`;
        this.canContinue = true;
      }
    } catch (e) {
      if (!String(e).includes("AbortError")) {
        this.error = explainError(e, this.current?.label ?? this.provider);
      }
    } finally {
      this.busy = false;
      this.abort = null;
      if (this.logPath) {
        const log = { turns: this.turns, usage: this.usage, notice: this.notice, error: this.error, at: new Date().toISOString() };
        writeTextFile(this.logPath, JSON.stringify(log, null, 2)).catch(() => {});
      }
    }
  }
}

export const chat = new ChatStore();
