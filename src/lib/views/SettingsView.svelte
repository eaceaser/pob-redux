<script lang="ts">
  import { onMount } from "svelte";
  import { appOptions } from "$lib/state/options.svelte";
  import { mcp, mcpConfigJson } from "$lib/state/mcp.svelte";
  import { game } from "$lib/state/game.svelte";
  import { writeText } from "@tauri-apps/plugin-clipboard-manager";
  import { getVersion } from "@tauri-apps/api/app";
  import { appUpdate } from "$lib/state/update.svelte";
  import { ui, type Theme } from "$lib/state/ui.svelte";
  import { save } from "@tauri-apps/plugin-dialog";
  import { exportDiagnostics, revealLogs } from "$lib/engine.svelte";

  let reportNote = $state("");
  async function saveReport() {
    reportNote = "";
    try {
      const path = await save({ defaultPath: "pob-redux-diagnostics.txt", filters: [{ name: "Text", extensions: ["txt"] }] });
      if (!path) return;
      await exportDiagnostics(path);
      reportNote = "Saved";
    } catch (e) {
      reportNote = `Could not save: ${String(e)}`;
    }
  }

  const mcpUrl = $derived(mcp.status?.running ? mcp.status.url : null);
  const mcpToken = $derived(mcp.status?.token ?? "");
  const claudeCmd = $derived(
    mcpUrl ? `claude mcp add --transport http pob-redux ${mcpUrl} --header "Authorization: Bearer ${mcpToken}"` : "",
  );
  const jsonCfg = $derived(mcpUrl ? mcpConfigJson(mcp.status) : "");
  let copied = $state("");
  let checked = $state(false);
  let version = $state("");
  getVersion().then((v) => (version = v)).catch(() => {});
  async function copy(key: string, text: string) {
    try {
      await writeText(text);
      copied = key;
      setTimeout(() => (copied = ""), 1200);
    } catch {}
  }

  const themes: [Theme, string][] = [
    ["system", "System"],
    ["dark", "Dark"],
    ["wraeclast", "Wraeclast"],
    ["light", "Light"],
  ];
  const scalePresets = [0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
  const scales = $derived(scalePresets.includes(ui.scale) ? scalePresets : [...scalePresets, ui.scale].sort((a, b) => a - b));
  const pct = (s: number) => `${Math.round(s * 100)}%`;

  const v = $derived(appOptions.values);

  const sections = $derived([
    { id: "appearance", label: "Appearance" },
    { id: "numbers", label: "Numbers and defaults" },
    ...(game.isPoe2 ? [{ id: "mcp", label: "MCP server" }] : []),
    { id: "updates", label: "Updates" },
    { id: "diagnostics", label: "Diagnostics" },
  ]);
  let scroller = $state<HTMLDivElement | null>(null);
  let active = $state("appearance");

  function go(id: string) {
    active = id;
    scroller?.querySelector(`#settings-${id}`)?.scrollIntoView({ block: "start" });
  }

  function onScroll() {
    if (!scroller) return;
    if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4) {
      active = sections[sections.length - 1].id;
      return;
    }
    let current = sections[0].id;
    for (const s of sections) {
      const el = scroller.querySelector<HTMLElement>(`#settings-${s.id}`);
      if (el && el.offsetTop <= scroller.scrollTop + 32) current = s.id;
    }
    active = current;
  }

  function close() {
    appOptions.open = false;
  }

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || document.querySelector('[role="alertdialog"]')) return;
      close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
</script>

<div class="settings">
  <nav class="snav" aria-label="Settings sections">
    <div class="label ntitle">Settings</div>
    {#each sections as s (s.id)}
      <button class="nitem" class:on={active === s.id} aria-current={active === s.id ? "true" : undefined} onclick={() => go(s.id)}>
        {s.label}
      </button>
    {/each}
    <button class="btn sm ghost back" onclick={close}>Close <kbd>Esc</kbd></button>
  </nav>

  <div class="sbody" bind:this={scroller} onscroll={onScroll}>
    <div class="sinner">
      <section id="settings-appearance">
        <div class="shead"><h2 class="label">Appearance</h2></div>
        <div class="rows">
          <div class="opt">
            <span>Theme</span>
            <div class="seg" role="radiogroup" aria-label="Theme">
              {#each themes as [id, label] (id)}
                <button role="radio" aria-checked={ui.theme === id} class:on={ui.theme === id} onclick={() => ui.setTheme(id)}>{label}</button>
              {/each}
            </div>
          </div>
          <div class="opt">
            <span>
              Contrast
              <span class="hint">Lifts the grey text tones. Auto follows the OS setting.</span>
            </span>
            <div class="ctrast">
              <button class="btn sm ghost" class:on={ui.contrastAuto} aria-pressed={ui.contrastAuto} onclick={() => ui.setContrastAuto(!ui.contrastAuto)}>Auto</button>
              <input
                class="range"
                type="range"
                min="0"
                max="100"
                step="5"
                value={ui.contrastEffective}
                disabled={ui.contrastAuto}
                aria-label="Contrast level"
                oninput={(e) => ui.setContrastLevel(Number((e.target as HTMLInputElement).value))}
              />
              <span class="num ctval">{ui.contrastEffective}%</span>
            </div>
          </div>
          <label class="opt">
            <span>
              Interface scale
              <span class="hint">Ctrl+= and Ctrl+- step it, Ctrl+0 resets.</span>
              {#if ui.scaleLimited}
                <span class="hint warn">The window fits {pct(ui.scaleApplied)} at most. Make it larger to use {pct(ui.scale)}.</span>
              {/if}
            </span>
            <select class="select" value={String(ui.scale)} onchange={(e) => ui.setScale(Number((e.target as HTMLSelectElement).value))}>
              {#each scales as s (s)}
                <option value={String(s)}>{pct(s)}</option>
              {/each}
            </select>
          </label>
        </div>
      </section>

      <section id="settings-numbers">
        <div class="shead"><h2 class="label">Numbers and defaults</h2></div>
        {#if v}
          <div class="rows">
            <label class="opt">
              <span>Show thousands separators</span>
              <input type="checkbox" checked={v.showThousandsSeparators} onchange={(e) => appOptions.set({ showThousandsSeparators: (e.target as HTMLInputElement).checked })} />
            </label>
            <label class="opt">
              <span>Thousands separator</span>
              <input
                class="input chr"
                maxlength="1"
                value={v.thousandsSeparator}
                onchange={(e) => appOptions.set({ thousandsSeparator: (e.target as HTMLInputElement).value || "," })}
              />
            </label>
            <label class="opt">
              <span>Decimal separator</span>
              <input
                class="input chr"
                maxlength="1"
                value={v.decimalSeparator}
                onchange={(e) => appOptions.set({ decimalSeparator: (e.target as HTMLInputElement).value || "." })}
              />
            </label>
            <label class="opt">
              <span>Default gem quality</span>
              <input
                class="input num"
                type="number"
                min="0"
                max="20"
                value={v.defaultGemQuality}
                onchange={(e) => appOptions.set({ defaultGemQuality: Math.max(0, Math.min(20, Number((e.target as HTMLInputElement).value) || 0)) })}
              />
            </label>
            <label class="opt">
              <span>Default character level (new builds)</span>
              <input
                class="input num"
                type="number"
                min="1"
                max="100"
                value={v.defaultCharLevel}
                onchange={(e) => appOptions.set({ defaultCharLevel: Math.max(1, Math.min(100, Number((e.target as HTMLInputElement).value) || 1)) })}
              />
            </label>
            <label class="opt">
              <span>Default item affix quality</span>
              <select class="select" value={String(v.defaultItemAffixQuality)} onchange={(e) => appOptions.set({ defaultItemAffixQuality: Number((e.target as HTMLSelectElement).value) })}>
                <option value="0">Worst roll</option>
                <option value="0.25">25%</option>
                <option value="0.5">Average</option>
                <option value="0.75">75%</option>
                <option value="1">Best roll</option>
              </select>
            </label>
          </div>
          <p class="note dim">Applied to the calculation engine now and re-applied on every start. Path of Building's own settings file is never touched.</p>
        {:else}
          <p class="note dim">These settings are available once the calculation engine has started.</p>
        {/if}
      </section>

      {#if game.isPoe2}
        <section id="settings-mcp">
          <div class="shead">
            <h2 class="label">MCP server</h2>
            <span class="dim" style:color={mcp.status?.running ? "var(--ok)" : undefined}>{mcp.status?.running ? "running" : "off"}</span>
          </div>
          <div class="rows">
            <label class="opt">
              <span>
                Enable MCP server
                <span class="hint">An AI client (Claude Code, Claude Desktop, Cursor) can read and edit the open build. Local only.</span>
              </span>
              <input type="checkbox" checked={mcp.enabled} disabled={mcp.busy} onchange={(e) => mcp.setEnabled((e.target as HTMLInputElement).checked)} />
            </label>
            <label class="opt">
              <span>Port</span>
              <input
                class="input num"
                type="number"
                min="1024"
                max="65535"
                value={mcp.port}
                disabled={mcp.busy}
                onchange={(e) => mcp.setPort(Number((e.target as HTMLInputElement).value))}
              />
            </label>
            {#if mcp.status?.error}
              <div class="opt err mono">{mcp.status.error}</div>
            {/if}
            {#if mcpUrl}
              <div class="opt col">
                <div class="row">
                  <span class="dim">URL</span>
                  <code class="mono selectable">{mcpUrl}</code>
                  <button class="btn sm ghost" onclick={() => copy("url", mcpUrl)}>{copied === "url" ? "Copied" : "Copy"}</button>
                </div>
                <div class="row">
                  <span class="dim">Token</span>
                  <code class="mono selectable">{mcpToken}</code>
                  <button class="btn sm ghost" onclick={() => copy("token", mcpToken)}>{copied === "token" ? "Copied" : "Copy"}</button>
                </div>
                <div class="row">
                  <span class="dim">Claude Code</span>
                  <code class="mono selectable">{claudeCmd}</code>
                  <button class="btn sm ghost" onclick={() => copy("cmd", claudeCmd)}>{copied === "cmd" ? "Copied" : "Copy"}</button>
                </div>
                <div class="row">
                  <span class="dim">JSON</span>
                  <code class="mono selectable">{jsonCfg}</code>
                  <button class="btn sm ghost" onclick={() => copy("json", jsonCfg)}>{copied === "json" ? "Copied" : "Copy"}</button>
                </div>
              </div>
            {/if}
          </div>
        </section>
      {/if}

      <section id="settings-updates">
        <div class="shead">
          <h2 class="label">Updates</h2>
          <span class="dim mono">{version}</span>
        </div>
        <div class="rows">
          <div class="opt">
            <span>
              App version
              <span class="hint">Checked once shortly after start. Installing replaces the app and needs a restart.</span>
            </span>
            <div class="row">
              {#if appUpdate.phase === "available" || appUpdate.phase === "ready"}
                <span class="mono" style:color="var(--ok)">{appUpdate.version} ready</span>
              {:else if appUpdate.phase === "checking"}
                <span class="dim">checking…</span>
              {:else if appUpdate.phase === "error"}
                <span class="mono" style:color="var(--bad)" title={appUpdate.error}>check failed</span>
              {:else if checked}
                <span class="dim">up to date</span>
              {/if}
              <button
                class="btn sm ghost"
                onclick={async () => {
                  await appUpdate.check(true);
                  checked = true;
                }}
                disabled={appUpdate.phase === "checking" || appUpdate.phase === "downloading"}
              >
                Check for updates
              </button>
            </div>
          </div>
        </div>
      </section>

      <section id="settings-diagnostics">
        <div class="shead"><h2 class="label">Diagnostics</h2></div>
        <div class="rows">
          <div class="opt">
            <span>
              Bug report file
              <span class="hint">A text file with app details and recent logs, for attaching to an issue. Paths, tokens and API keys are masked.</span>
            </span>
            <div class="row">
              {#if reportNote}<span class="dim">{reportNote}</span>{/if}
              <button class="btn sm ghost" onclick={() => revealLogs().catch((e) => (reportNote = String(e)))}>Log folder</button>
              <button class="btn sm ghost" onclick={saveReport}>Save report…</button>
            </div>
          </div>
        </div>
      </section>
    </div>
  </div>
</div>

<style>
  .settings {
    flex: 1;
    display: flex;
    min-height: 0;
  }
  .snav {
    width: 200px;
    flex: none;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 14px 8px 10px;
    border-right: 1px solid var(--line-0);
    background: var(--bg-1);
    overflow-y: auto;
  }
  .ntitle {
    padding: 0 10px 8px;
  }
  .nitem {
    appearance: none;
    border: 0;
    border-radius: var(--r-1);
    background: transparent;
    color: var(--fg-2);
    font-size: var(--fs-sm);
    text-align: left;
    padding: 6px 10px;
  }
  .nitem:hover {
    color: var(--fg-0);
    background: var(--bg-hover);
  }
  .nitem.on {
    color: var(--fg-0);
    background: var(--bg-active);
  }
  .back {
    margin-top: auto;
    align-self: flex-start;
  }
  .sbody {
    position: relative;
    flex: 1;
    min-width: 0;
    overflow-y: auto;
  }
  .sinner {
    max-width: 760px;
    padding: 18px 24px 48px;
  }
  section + section {
    margin-top: 26px;
  }
  .shead {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
  }
  .shead h2 {
    margin: 0;
  }
  .rows {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--line-0);
    border-radius: var(--r-2);
    background: var(--bg-1);
  }
  .opt {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 16px;
    padding: 9px 12px;
    border-bottom: 1px solid var(--line-0);
    font-size: var(--fs-sm);
    color: var(--fg-1);
  }
  .opt:last-child {
    border-bottom: 0;
  }
  .note {
    margin: 8px 2px 0;
    font-size: var(--fs-xs);
  }
  .ctrast {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .ctrast .range {
    width: 150px;
    height: 14px;
    accent-color: var(--fg-1);
  }
  .ctrast .range:disabled {
    opacity: var(--fade-off);
  }
  .ctrast .btn.on {
    color: var(--fg-0);
    border-color: var(--fg-2);
    background: var(--bg-active);
  }
  .ctval {
    min-width: 34px;
    text-align: right;
    font-size: var(--fs-xs);
    color: var(--fg-2);
  }
  .seg {
    display: inline-flex;
    flex: none;
    border: 1px solid var(--line-1);
    border-radius: var(--r-2);
    overflow: hidden;
  }
  .seg button {
    padding: 3px 10px;
    font-size: var(--fs-xs);
    color: var(--fg-2);
    background: transparent;
    border: 0;
    border-right: 1px solid var(--line-1);
  }
  .seg button:last-child {
    border-right: 0;
  }
  .seg button.on {
    color: var(--fg-0);
    background: var(--bg-3);
  }
  .input.chr {
    width: 40px;
    text-align: center;
  }
  .input.num {
    width: 70px;
    text-align: right;
  }
  .hint {
    display: block;
    color: var(--fg-2);
    font-size: var(--fs-xs);
    max-width: 440px;
  }
  .hint.warn {
    color: var(--warn);
  }
  .opt.err {
    color: var(--bad);
    font-size: var(--fs-xs);
    white-space: pre-wrap;
  }
  .opt.col {
    flex-direction: column;
    align-items: stretch;
    gap: 6px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .row > .dim {
    width: 84px;
    flex: none;
  }
  .row > code {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fs-xs);
    color: var(--fg-1);
  }
  input[type="checkbox"] {
    accent-color: var(--fg-0);
  }
</style>
