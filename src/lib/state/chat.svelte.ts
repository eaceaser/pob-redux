import { m } from "$lib/paraglide/messages";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenAI } from "@ai-sdk/openai";
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
import { routeTools } from "$lib/ai/decide";
import { decider } from "$lib/state/decide.svelte";
import { MODE_PROMPT, STYLE, type Mode } from "$lib/ai/prompt";
import {
  callTool,
  CORE,
  findTools,
  FIND_TOOLS,
  FIND_TOOLS_DEF,
  loadToolDefs,
  toToolSet,
  type ToolDef,
} from "$lib/ai/tools";
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
/**
 * Characters of one tool result the model sees. optimise_gear and
 * suggest_unique_jewels return tens of kilobytes; the panel still shows all of
 * it. Roughly 1,500 tokens.
 */
const MAX_RESULT_CHARS = 6000;
/** Past this, the oldest tool results are elided. Roughly 100k tokens. */
const MAX_HISTORY_CHARS = 400_000;
/** Tool rounds whose results survive compaction intact. */
const KEEP_RESULTS = 6;
/** The numbers a Try experiment reports on. */
const TRY_STATS: [string, string][] = [
  ["CombinedDPS", "DPS"],
  ["Life", "life"],
  ["TotalEHP", "EHP"],
  ["EnergyShield", "ES"],
];

export type { Mode };

/** An open Try experiment: one checkpoint, resolved by Keep or Undo. */
export interface Experiment {
  label: string;
  before: Record<string, number>;
  now: Record<string, number>;
  /** `build.userEdits` when the checkpoint was taken. */
  editsAt: number;
}

/** The moved numbers a Try strip shows, biggest relative change first. */
export function experimentDelta(e: Experiment): { label: string; pct: number; abs: number }[] {
  return TRY_STATS.map(([key, label]) => {
    const before = e.before[key] ?? 0;
    const now = e.now[key] ?? before;
    return { label, pct: before ? ((now - before) / before) * 100 : 0, abs: now - before };
  })
    .filter((r) => Math.abs(r.abs) > 0.5)
    .sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));
}

export const MIN_WIDTH = 320;
export const MAX_WIDTH = 900;

/** The prompt forbids em and en dashes; this is the backstop for the ones that slip through. */
const plainDashes = (s: string) => s.replace(/(\d)\s*[—–]\s*(\d)/g, "$1-$2").replace(/\s*[—–]\s*/g, ", ");

/** An answer that ends on an intention instead of an action. */
const ANNOUNCED = /\b(i'?ll|i will(?! not)|let me|i'?m going to|i am going to|will now)\b[^.!?\n]{0,160}[.!]?\s*$/i;

const clampWidth = (w: number) => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(w)));

/** Everything an error carries, not only its message: provider failures hide the useful part in `cause` or `responseBody`. */
function describeError(e: unknown): string {
  if (e == null) return "";
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let cur: unknown = e;
  for (let depth = 0; cur && depth < 4 && !seen.has(cur); depth++) {
    seen.add(cur);
    if (typeof cur !== "object") {
      parts.push(String(cur));
      break;
    }
    const o = cur as Record<string, unknown>;
    const head = [o.name, o.message].filter(Boolean).join(": ") || String(cur);
    parts.push(head);
    for (const k of ["statusCode", "url", "responseBody", "data"]) {
      const v = o[k];
      if (v != null && v !== "") parts.push(`${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`.slice(0, 2000));
    }
    cur = o.cause;
  }
  return parts.join("\n");
}

/** A tool result cut down to what a log needs. */
function compact(v: unknown, max = 1500): string {
  const t = typeof v === "string" ? v : JSON.stringify(v);
  return t == null ? "" : t.length > max ? `${t.slice(0, max)}… (${t.length} chars)` : t;
}

/** A tool result cut down to what the model is sent. */
function clipResult(name: string, v: unknown): string {
  const t = (typeof v === "string" ? v : JSON.stringify(v)) ?? "";
  if (t.length <= MAX_RESULT_CHARS) return t;
  return `${t.slice(0, MAX_RESULT_CHARS)}\n[cut: ${t.length - MAX_RESULT_CHARS} more characters. Call ${name} again with a limit, a filter or a narrower argument if you need the rest.]`;
}

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
  // Match on everything the error carries: the status and body live in `cause`.
  const t = describeError(e).toLowerCase();

  // Match the status line describeError emits, not a bare number: a tool result
  // or a model id containing "402" is not a billing failure.
  const status = (code: number) => t.includes(`statuscode: ${code}`) || t.includes(`"status":${code}`);

  if (t.includes("credit balance is too low") || t.includes("insufficient_quota") || t.includes("exceeded your current quota") || status(402)) {
    return `${providerLabel} rejected the request for billing: the account is out of credit. Top it up, then try again.`;
  }
  if (status(401) || t.includes("authentication_error") || t.includes("invalid api key") || t.includes("invalid_api_key")) {
    return `${providerLabel} rejected the key. Check it in provider settings.`;
  }
  if (status(429) || t.includes("rate_limit")) {
    return `${providerLabel} is rate limiting this key. Wait a moment and try again.`;
  }
  if (t.includes("model is unavailable") || t.includes("model_not_found") || t.includes("not_found_error") || t.includes("does not exist") || status(404)) {
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
  /** Tools approved for the rest of this conversation, by name. */
  allowedTools = $state<string[]>([]);
  /** ask reads only, build writes with approval, try writes freely inside a checkpoint. */
  mode = $state<Mode>("build");
  /** The open Try experiment, if any. Outlives a single message. */
  experiment = $state<Experiment | null>(null);
  /** Set when Undo would also discard something the user did by hand. */
  undoWarning = $state<string | null>(null);
  /** Tool names, for the `/` menu. */
  toolNames = $state<ToolDef[]>([]);
  /** Dev hook: transcript file written when a run ends (POB_REDUX_CHAT_LOG). */
  logPath: string | null = null;
  /** Where the always-on run log lands; known after the first run. */
  logFile = $state<string | null>(null);
  /** The last failure with everything it carried, for Copy details. */
  private lastErrorDetail = "";
  /**
   * Ollama (Local) loads a model on first use and then evaluates the whole
   * prompt, tens of seconds a user would otherwise wait on their first
   * question. So the model is loaded and its prompt cache primed when it is
   * picked, and the composer says so. Hosted providers are always "ready".
   */
  warm = $state<"ready" | "loading" | "priming" | "failed">("ready");
  warmNote = $state("");
  warmDetail = $state("");
  private warmSeq = 0;
  private warming: Promise<void> | null = null;
  private lastRequestAt = 0;

  private defs: ToolDef[] = [];
  /** Tool names loaded beyond CORE, added by find_tools and kept for the conversation. */
  private active = new Set<string>();
  /** Tool rounds elided to stay inside the context window. */
  private elided = 0;
  private routed: { picked?: string[]; model?: string; ms?: number; error?: string } | null = null;
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
      // An experiment does not survive a restart, so Try would have no undo.
      if (saved.mode === "ask" || saved.mode === "build") this.mode = saved.mode;
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
    void decider.init();
    void this.warmUp();
  }

  get needsWarm() {
    return this.current?.id === "ollama-local";
  }

  /** Load the local model and prime its prompt cache with the real prompt and tools. */
  warmUp(): Promise<void> {
    if (!this.needsWarm || !this.model) {
      this.warm = "ready";
      this.warmNote = "";
      return Promise.resolve();
    }
    this.warming = this.doWarmUp().finally(() => {
      this.warming = null;
    });
    return this.warming;
  }

  private async doWarmUp() {
    const seq = ++this.warmSeq;
    this.warm = "loading";
    this.warmNote = `loading ${this.model}`;
    try {
      const ms = await invoke<number>("ai_warm_model", { provider: this.provider, model: this.model });
      if (seq !== this.warmSeq) return;
      this.warm = "priming";
      this.warmNote = "priming the prompt";
      if (!this.defs.length) this.defs = await loadToolDefs();
      const instructions = (await invoke<string>("ai_instructions").catch(() => "")) + STYLE + MODE_PROMPT[this.mode];
      // The same request shape as a real turn, one token long, so the cached
      // prefix matches what the first question will send.
      const result = streamText({
        model: this.buildModel("open-ai-compatible"),
        tools: toToolSet(this.activeDefs()),
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
      this.warmNote = "ready";
      this.warmDetail = ms > 1000 ? `Model loaded in ${Math.round(ms / 1000)}s and its prompt cached.` : "Model loaded and its prompt cached.";
    } catch (e) {
      if (seq !== this.warmSeq) return;
      this.warm = "failed";
      this.warmNote = explainError(e, this.current?.label ?? this.provider);
      this.lastErrorDetail = describeError(e);
      console.error("assistant warm-up failed", e);
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
          mode: this.mode,
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

  /**
   * Switching into Try opens an experiment. Switching out of it leaves the
   * changes in place and stops tracking them: discarding someone's work
   * because they changed a dropdown would be the wrong default.
   */
  async setMode(mode: Mode) {
    if (mode === this.mode) return;
    const leavingTry = this.mode === "try" && this.experiment;
    this.mode = mode;
    this.persist();
    if (mode === "try") {
      await this.startExperiment();
    } else if (leavingTry) {
      this.experiment = null;
      this.undoWarning = null;
      this.notice = m.chat_experiment_kept();
    }
  }

  private async readStats(): Promise<Record<string, number>> {
    try {
      const out = (await callTool("get_stats", { fields: TRY_STATS.map(([k]) => k) })) as {
        stats?: Record<string, number>;
      };
      return out?.stats ?? {};
    } catch {
      return {};
    }
  }

  /** Open a Try experiment if the mode calls for one and none is open. */
  async openExperiment() {
    await this.startExperiment();
  }

  private async startExperiment() {
    if (!build.loaded || this.experiment) return;
    const label = `try-${Date.now().toString(36)}`;
    try {
      await callTool("checkpoint", { label });
    } catch (e) {
      this.notice = m.chat_checkpoint_failed({ error: String(e) });
      return;
    }
    const before = await this.readStats();
    this.experiment = { label, before, now: { ...before }, editsAt: build.userEdits };
    this.undoWarning = null;
  }

  /** Keep the experiment's changes and stop tracking them. */
  keepExperiment() {
    this.experiment = null;
    this.undoWarning = null;
  }

  /**
   * Roll the build back to the checkpoint. Asks twice when the user has edited
   * the build themselves since, because the checkpoint is build-wide and their
   * change would go with it.
   */
  async undoExperiment(confirmed = false) {
    const e = this.experiment;
    if (!e || this.busy) return;
    if (!confirmed && build.userEdits > e.editsAt) {
      const n = build.userEdits - e.editsAt;
      this.undoWarning = `You changed the build ${n === 1 ? "once" : `${n} times`} since this started. Undo restores the checkpoint, so those changes go too.`;
      return;
    }
    this.undoWarning = null;
    try {
      await callTool("rollback", { label: e.label });
      this.experiment = null;
      this.notice = m.chat_rolled_back();
    } catch (err) {
      this.notice = m.chat_rollback_failed({ error: String(err) });
    }
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

  /** Answer a pending approval chip. `always` covers that tool for the rest of the conversation. */
  resolveApproval(id: string, ok: boolean, always = false) {
    const turn = this.turns.find((t) => t.kind === "tool" && t.id === id) as ToolTurn | undefined;
    if (ok && always && turn && !this.allowedTools.includes(turn.name)) {
      this.allowedTools = [...this.allowedTools, turn.name];
    }
    const fn = this.pending.get(id);
    if (fn) {
      this.pending.delete(id);
      fn(ok);
    }
  }

  private approve(turn: ToolTurn): Promise<boolean> {
    // Try auto-approves: everything the panel can reach is inside the
    // checkpoint, so Undo covers it.
    if (turn.readOnly || this.allowWrites || this.mode === "try" || this.allowedTools.includes(turn.name)) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => this.pending.set(turn.id, resolve));
  }

  reset() {
    this.stop();
    this.turns = [];
    this.history = [];
    this.active.clear();
    this.elided = 0;
    this.error = null;
    this.notice = null;
    this.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    this.allowWrites = false;
    this.allowedTools = [];
    // The build keeps whatever the experiment did; a new conversation only
    // stops tracking it.
    this.experiment = null;
    this.undoWarning = null;
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
    // A send during warm-up waits for it; the composer button is disabled
    // meanwhile, but a boot-time message must not be lost.
    if (this.warming) await this.warming;
    // Try was selected before a build was open, or the checkpoint failed.
    if (this.mode === "try" && !this.experiment) await this.startExperiment();
    this.input = "";
    this.error = null;
    this.notice = null;
    this.canContinue = false;
    this.turns = [...this.turns, { kind: "user", text, mark: this.history.length }];
    // The snapshot rides with the question rather than the instructions, so the
    // cached prefix stays byte-identical between turns.
    this.history.push({ role: "user", content: `${await this.context()}\n\n${text}` });
    await this.route(text);
    await this.run();
  }

  /** Experimental: load the tools a decision model expects this message to need. */
  private async route(text: string) {
    this.routed = null;
    if (!decider.routingOn) return;
    if (!this.defs.length) this.defs = await loadToolDefs().catch(() => []);
    const candidates = this.defs.filter(
      (d) => !CORE.has(d.name) && !this.active.has(d.name) && (this.mode !== "ask" || d.read_only),
    );
    const users = this.turns.filter((t) => t.kind === "user");
    const previous = users.length > 1 ? users[users.length - 2].text : undefined;
    try {
      const r = await routeTools(text, candidates, { previous, min: 0.15, max: 3 });
      this.routed = { picked: r.picks.map((p) => p.name), model: r.model, ms: r.ms };
      if (!r.picks.length) return;
      for (const p of r.picks) this.active.add(p.name);
      this.turns = [
        ...this.turns,
        {
          kind: "tool",
          id: `route-${Date.now()}`,
          name: "pick_tools",
          args: { tools: r.picks.map((p) => p.name).join(", ") },
          readOnly: true,
          status: "done",
          result: { loaded: r.picks.map((p) => ({ name: p.name, p: Math.round(p.p * 100) / 100 })), model: r.model, ms: r.ms },
        },
      ];
    } catch (e) {
      this.routed = { error: String(e) };
    }
  }

  /** find_tools: keyword matches, led by the decision model's picks when routing is on. */
  private async searchTools(query: string): Promise<ToolDef[]> {
    const readOnly = this.mode === "ask";
    const keyword = findTools(this.defs, query, 8, readOnly);
    if (!decider.routingOn) return keyword;
    try {
      const candidates = this.defs.filter((d) => !readOnly || d.read_only);
      const r = await routeTools(query, candidates, { min: 0.1, max: 5 });
      const byName = new Map(this.defs.map((d) => [d.name, d]));
      const exact = keyword.filter((d) => d.name === query.trim());
      const picked = r.picks.flatMap((p) => byName.get(p.name) ?? []);
      return [...new Set([...exact, ...picked, ...keyword])].slice(0, 8);
    } catch {
      return keyword;
    }
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
    if (this.provider === "openai") {
      return createOpenAI({ baseURL: "https://managed-by-host", apiKey: "managed-by-host", fetch }).responses(this.model);
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
  /** The tool definitions loaded for this step. */
  private activeDefs(): ToolDef[] {
    const loaded = this.defs.filter((d) => CORE.has(d.name) || this.active.has(d.name));
    const forMode = this.mode === "ask" ? loaded.filter((d) => d.read_only) : loaded;
    return [FIND_TOOLS_DEF, ...forMode];
  }

  /**
   * Drop the bodies of old tool results once the conversation outgrows the
   * budget, keeping the most recent rounds whole. The panel still shows every
   * result; this is only what the model carries forward.
   *
   * Eliding invalidates the cached prefix from that point on, which is the
   * trade being made: one cache write against staying inside the window.
   */
  private compactHistory() {
    const size = () => this.history.reduce((n, m) => n + JSON.stringify(m.content ?? "").length, 0);
    if (size() < MAX_HISTORY_CHARS) return;
    const toolRounds = this.history.flatMap((m, i) => (m.role === "tool" ? [i] : []));
    const cutoff = toolRounds[Math.max(0, toolRounds.length - KEEP_RESULTS)] ?? 0;
    for (let i = 0; i < cutoff; i++) {
      const m = this.history[i];
      if (m.role !== "tool" || !Array.isArray(m.content)) continue;
      m.content = m.content.map((part) => {
        if (part.type !== "tool-result" || part.output?.type !== "text") return part;
        const text = part.output.value;
        if (text.length < 200) return part;
        this.elided++;
        return {
          ...part,
          output: {
            type: "text",
            value: `[dropped to save context: ${part.toolName}, ${text.length} characters. Call it again if you still need it.]`,
          },
        } as ToolResultPart;
      });
    }
  }

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
      const readOnly = new Map(this.defs.map((d) => [d.name, d.read_only]));
      const kind = this.current?.kind ?? "anthropic";
      const model = this.buildModel(kind);
      const providerOptions = this.supportsEffort ? effortOptions(kind, this.effort, this.provider) : undefined;
      const instructions = (await invoke<string>("ai_instructions").catch(() => "")) + STYLE + MODE_PROMPT[this.mode];
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
        this.compactHistory();
        this.markCacheBreakpoint();
        const result = streamText({
          model,
          abortSignal: this.abort.signal,
          stopWhen: isStepCount(1),
          tools: toToolSet(this.activeDefs()),
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
            this.notice = m.chat_output_limit();
          } else if (finish === "content-filter") {
            this.notice = m.chat_content_filter();
          } else if (finish === "error" || finish === "other") {
            this.notice = m.chat_stopped_early({ reason: finish });
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

          if (call.toolName === FIND_TOOLS) {
            const query = String((call.input as { query?: unknown })?.query ?? "");
            const found = await this.searchTools(query);
            for (const d of found) this.active.add(d.name);
            const value = found.length
              ? { loaded: found.map((d) => ({ name: d.name, description: d.description, writes: !d.read_only })) }
              : { loaded: [], note: "Nothing matched. Try a different word, or work with the tools you have." };
            this.patchTool(turn.id, { result: value, status: "done" });
            outputs.push({
              type: "tool-result",
              toolName: call.toolName,
              toolCallId: call.toolCallId,
              output: { type: "text", value: JSON.stringify(value) },
            });
            continue;
          }

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
            // Every write returns absolute headline stats, so the strip stays
            // correct against the checkpoint without another round trip.
            const stats = (value as { stats?: Record<string, number> })?.stats;
            if (this.experiment && stats) {
              this.experiment = { ...this.experiment, now: { ...this.experiment.now, ...stats } };
            }
            outputs.push({
              type: "tool-result",
              toolName: call.toolName,
              toolCallId: call.toolCallId,
              output: { type: "text", value: clipResult(call.toolName, value) },
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
        this.notice = m.chat_paused_steps({ steps: MAX_STEPS });
        this.canContinue = true;
      }
    } catch (e) {
      if (!String(e).includes("AbortError")) {
        this.error = explainError(e, this.current?.label ?? this.provider);
        this.lastErrorDetail = describeError(e);
        console.error("assistant run failed", e);
      }
    } finally {
      this.busy = false;
      this.abort = null;
      void this.log();
      if (this.logPath) {
        const log = { turns: this.turns, usage: this.usage, notice: this.notice, error: this.error, at: new Date().toISOString() };
        writeTextFile(this.logPath, JSON.stringify(log, null, 2)).catch(() => {});
      }
    }
  }

  /** The run that just ended, as one log line: settings, outcome, and the turns since the last question. */
  private entry() {
    let from = this.turns.length - 1;
    while (from > 0 && this.turns[from].kind !== "user") from--;
    const turns = this.turns.slice(Math.max(0, from)).map((t) => {
      if (t.kind === "user") return { user: t.text };
      if (t.kind === "assistant") return { assistant: t.text };
      return { tool: t.name, status: t.status, args: compact(t.args, 600), result: t.error ? undefined : compact(t.result), error: t.error };
    });
    return {
      at: new Date().toISOString(),
      provider: this.provider,
      model: this.model,
      effort: this.supportsEffort ? this.effort : undefined,
      mode: this.mode,
      error: this.error,
      errorDetail: this.lastErrorDetail || undefined,
      notice: this.notice,
      usage: this.usage,
      tools: this.activeDefs().length,
      routing: this.routed ?? undefined,
      elided: this.elided || undefined,
      turns,
    };
  }

  private async log() {
    try {
      this.logFile = await invoke<string>("ai_log_append", { line: JSON.stringify(this.entry()) });
    } catch (e) {
      console.warn("assistant log not written", e);
    }
  }

  /** What to paste into a bug report: the failure and the run around it. */
  diagnostics(): string {
    const e = this.entry();
    const lines = [
      `PoB Redux assistant, ${e.at}`,
      `provider: ${e.provider}   model: ${e.model}${e.effort ? `   effort: ${e.effort}` : ""}`,
      e.error ? `error: ${e.error}` : "",
      e.errorDetail && e.errorDetail !== e.error ? `detail: ${e.errorDetail}` : "",
      e.notice ? `notice: ${e.notice}` : "",
      `tokens: in ${e.usage.input}, out ${e.usage.output}, cache read ${e.usage.cacheRead}, cache write ${e.usage.cacheWrite}`,
      "",
      ...e.turns.map((t) => {
        if ("user" in t) return `> ${t.user}`;
        if ("assistant" in t) return `< ${t.assistant}`;
        const tail = t.error ? `\n  error: ${t.error}` : t.result ? `\n  -> ${compact(t.result, 400)}` : "";
        return `[${t.tool} ${t.status}] ${t.args}${tail}`;
      }),
      this.logFile ? `\nfull log: ${this.logFile}` : "",
    ];
    return lines.filter((l) => l !== "").join("\n");
  }

  revealLog() {
    return invoke<string>("ai_log_reveal").then((p) => (this.logFile = p));
  }
}

export const chat = new ChatStore();
