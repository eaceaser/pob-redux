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
  import { locale, LOCALES, LOCALE_LABEL, type LocalePreference } from "$lib/state/locale.svelte";
  import { m } from "$lib/paraglide/messages";

  let reportNote = $state("");
  async function saveReport() {
    reportNote = "";
    try {
      const path = await save({ defaultPath: "pob-redux-diagnostics.txt", filters: [{ name: m.settings_report_filetype(), extensions: ["txt"] }] });
      if (!path) return;
      await exportDiagnostics(path);
      reportNote = m.settings_report_saved();
    } catch (e) {
      reportNote = m.settings_report_failed({ error: String(e) });
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

  const themes = $derived<[Theme, string][]>([
    ["system", m.theme_system()],
    ["dark", m.theme_dark()],
    ["wraeclast", m.theme_wraeclast()],
    ["light", m.theme_light()],
  ]);
  const languages = $derived<[LocalePreference, string][]>([
    ["system", m.settings_language_system({ language: LOCALE_LABEL[locale.system] })],
    ...LOCALES.map((l): [LocalePreference, string] => [l, LOCALE_LABEL[l]]),
  ]);
  const scalePresets = [0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
  const scales = $derived(scalePresets.includes(ui.scale) ? scalePresets : [...scalePresets, ui.scale].sort((a, b) => a - b));
  const pct = (s: number) => `${Math.round(s * 100)}%`;

  const v = $derived(appOptions.values);

  const sections = $derived([
    { id: "appearance", label: m.settings_appearance() },
    { id: "numbers", label: m.settings_numbers() },
    ...(game.isPoe2 ? [{ id: "mcp", label: m.settings_mcp() }] : []),
    { id: "updates", label: m.settings_updates() },
    { id: "diagnostics", label: m.settings_diagnostics() },
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
  <nav class="snav" aria-label={m.settings_sections()}>
    <div class="label ntitle">{m.settings_title()}</div>
    {#each sections as s (s.id)}
      <button class="nitem" class:on={active === s.id} aria-current={active === s.id ? "true" : undefined} onclick={() => go(s.id)}>
        {s.label}
      </button>
    {/each}
    <button class="btn sm ghost back" onclick={close}>{m.common_close()} <kbd>Esc</kbd></button>
  </nav>

  <div class="sbody" bind:this={scroller} onscroll={onScroll}>
    <div class="sinner">
      <section id="settings-appearance">
        <div class="shead"><h2 class="label">{m.settings_appearance()}</h2></div>
        <div class="rows">
          <label class="opt">
            <span>
              {m.settings_language()}
              <span class="hint">{m.settings_language_hint()}</span>
            </span>
            <select class="select" value={locale.preference} onchange={(e) => locale.set((e.target as HTMLSelectElement).value as LocalePreference)}>
              {#each languages as [id, label] (id)}
                <option value={id}>{label}</option>
              {/each}
            </select>
          </label>
          <div class="opt">
            <span>{m.settings_theme()}</span>
            <div class="seg" role="radiogroup" aria-label={m.settings_theme()}>
              {#each themes as [id, label] (id)}
                <button role="radio" aria-checked={ui.theme === id} class:on={ui.theme === id} onclick={() => ui.setTheme(id)}>{label}</button>
              {/each}
            </div>
          </div>
          <div class="opt">
            <span>
              {m.settings_contrast()}
              <span class="hint">{m.settings_contrast_hint()}</span>
            </span>
            <div class="ctrast">
              <button class="btn sm ghost" class:on={ui.contrastAuto} aria-pressed={ui.contrastAuto} onclick={() => ui.setContrastAuto(!ui.contrastAuto)}>{m.common_auto()}</button>
              <input
                class="range"
                type="range"
                min="0"
                max="100"
                step="5"
                value={ui.contrastEffective}
                disabled={ui.contrastAuto}
                aria-label={m.settings_contrast_level()}
                oninput={(e) => ui.setContrastLevel(Number((e.target as HTMLInputElement).value))}
              />
              <span class="num ctval">{ui.contrastEffective}%</span>
            </div>
          </div>
          <label class="opt">
            <span>
              {m.settings_scale()}
              <span class="hint">{m.settings_scale_hint()}</span>
              {#if ui.scaleLimited}
                <span class="hint warn">{m.settings_scale_limited({ applied: pct(ui.scaleApplied), wanted: pct(ui.scale) })}</span>
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
        <div class="shead"><h2 class="label">{m.settings_numbers()}</h2></div>
        {#if v}
          <div class="rows">
            <label class="opt">
              <span>{m.settings_thousands_show()}</span>
              <input type="checkbox" checked={v.showThousandsSeparators} onchange={(e) => appOptions.set({ showThousandsSeparators: (e.target as HTMLInputElement).checked })} />
            </label>
            <label class="opt">
              <span>{m.settings_thousands_separator()}</span>
              <input
                class="input chr"
                maxlength="1"
                value={v.thousandsSeparator}
                onchange={(e) => appOptions.set({ thousandsSeparator: (e.target as HTMLInputElement).value || "," })}
              />
            </label>
            <label class="opt">
              <span>{m.settings_decimal_separator()}</span>
              <input
                class="input chr"
                maxlength="1"
                value={v.decimalSeparator}
                onchange={(e) => appOptions.set({ decimalSeparator: (e.target as HTMLInputElement).value || "." })}
              />
            </label>
            <label class="opt">
              <span>{m.settings_gem_quality()}</span>
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
              <span>{m.settings_char_level()}</span>
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
              <span>{m.settings_affix_quality()}</span>
              <select class="select" value={String(v.defaultItemAffixQuality)} onchange={(e) => appOptions.set({ defaultItemAffixQuality: Number((e.target as HTMLSelectElement).value) })}>
                <option value="0">{m.settings_affix_worst()}</option>
                <option value="0.25">25%</option>
                <option value="0.5">{m.settings_affix_average()}</option>
                <option value="0.75">75%</option>
                <option value="1">{m.settings_affix_best()}</option>
              </select>
            </label>
          </div>
          <p class="note dim">{m.settings_numbers_note()}</p>
        {:else}
          <p class="note dim">{m.settings_numbers_waiting()}</p>
        {/if}
      </section>

      {#if game.isPoe2}
        <section id="settings-mcp">
          <div class="shead">
            <h2 class="label">{m.settings_mcp()}</h2>
            <span class="dim" style:color={mcp.status?.running ? "var(--ok)" : undefined}>{mcp.status?.running ? m.settings_mcp_running() : m.common_off()}</span>
          </div>
          <div class="rows">
            <label class="opt">
              <span>
                {m.settings_mcp_enable()}
                <span class="hint">{m.settings_mcp_enable_hint()}</span>
              </span>
              <input type="checkbox" checked={mcp.enabled} disabled={mcp.busy} onchange={(e) => mcp.setEnabled((e.target as HTMLInputElement).checked)} />
            </label>
            <label class="opt">
              <span>{m.settings_mcp_port()}</span>
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
                  <button class="btn sm ghost" onclick={() => copy("url", mcpUrl)}>{copied === "url" ? m.common_copied() : m.common_copy()}</button>
                </div>
                <div class="row">
                  <span class="dim">Token</span>
                  <code class="mono selectable">{mcpToken}</code>
                  <button class="btn sm ghost" onclick={() => copy("token", mcpToken)}>{copied === "token" ? m.common_copied() : m.common_copy()}</button>
                </div>
                <div class="row">
                  <span class="dim">Claude Code</span>
                  <code class="mono selectable">{claudeCmd}</code>
                  <button class="btn sm ghost" onclick={() => copy("cmd", claudeCmd)}>{copied === "cmd" ? m.common_copied() : m.common_copy()}</button>
                </div>
                <div class="row">
                  <span class="dim">JSON</span>
                  <code class="mono selectable">{jsonCfg}</code>
                  <button class="btn sm ghost" onclick={() => copy("json", jsonCfg)}>{copied === "json" ? m.common_copied() : m.common_copy()}</button>
                </div>
              </div>
            {/if}
          </div>
        </section>
      {/if}

      <section id="settings-updates">
        <div class="shead">
          <h2 class="label">{m.settings_updates()}</h2>
          <span class="dim mono">{version}</span>
        </div>
        <div class="rows">
          <div class="opt">
            <span>
              {m.settings_version()}
              <span class="hint">{m.settings_version_hint()}</span>
            </span>
            <div class="row">
              {#if appUpdate.phase === "available" || appUpdate.phase === "ready"}
                <span class="mono" style:color="var(--ok)">{m.settings_version_ready({ version: appUpdate.version ?? "" })}</span>
              {:else if appUpdate.phase === "checking"}
                <span class="dim">{m.settings_version_checking()}</span>
              {:else if appUpdate.phase === "error"}
                <span class="mono" style:color="var(--bad)" title={appUpdate.error}>{m.settings_version_failed()}</span>
              {:else if checked}
                <span class="dim">{m.settings_version_current()}</span>
              {/if}
              <button
                class="btn sm ghost"
                onclick={async () => {
                  await appUpdate.check(true);
                  checked = true;
                }}
                disabled={appUpdate.phase === "checking" || appUpdate.phase === "downloading"}
              >
                {m.settings_check_updates()}
              </button>
            </div>
          </div>
        </div>
      </section>

      <section id="settings-diagnostics">
        <div class="shead"><h2 class="label">{m.settings_diagnostics()}</h2></div>
        <div class="rows">
          <div class="opt">
            <span>
              {m.settings_report()}
              <span class="hint">{m.settings_report_hint()}</span>
            </span>
            <div class="row">
              {#if reportNote}<span class="dim">{reportNote}</span>{/if}
              <button class="btn sm ghost" onclick={() => revealLogs().catch((e) => (reportNote = String(e)))}>{m.settings_log_folder()}</button>
              <button class="btn sm ghost" onclick={saveReport}>{m.settings_save_report()}</button>
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
