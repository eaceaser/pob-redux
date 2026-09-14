<script lang="ts">
  import { appOptions } from "$lib/state/options.svelte";
  import { mcp, mcpConfigJson } from "$lib/state/mcp.svelte";
  import { game } from "$lib/state/game.svelte";
  import { writeText } from "@tauri-apps/plugin-clipboard-manager";
  import { getVersion } from "@tauri-apps/api/app";
  import { appUpdate } from "$lib/state/update.svelte";
  import { ui, type Theme } from "$lib/state/ui.svelte";

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
    ["light", "Light"],
  ];

  const v = $derived(appOptions.values);

  function close() {
    appOptions.open = false;
  }
</script>

{#if appOptions.open && v}
  <div class="overlay" role="presentation" onclick={close} onkeydown={(e) => e.key === "Escape" && close()}>
    <div class="modal" role="dialog" aria-label="Options" tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.key === "Escape" && close()}>
      <div class="mhead">
        <span class="label">Options</span>
        <button class="btn sm ghost" onclick={close}>Close</button>
      </div>
      <div class="shead"><span class="label">Appearance</span></div>
      <div class="rows">
        <div class="opt">
          <span>Theme</span>
          <div class="seg" role="radiogroup" aria-label="Theme">
            {#each themes as [id, label] (id)}
              <button role="radio" aria-checked={ui.theme === id} class:on={ui.theme === id} onclick={() => ui.setTheme(id)}>{label}</button>
            {/each}
          </div>
        </div>
      </div>
      <div class="shead"><span class="label">Numbers and defaults</span></div>
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
      {#if game.isPoe2}
      <div class="shead">
        <span class="label">MCP server</span>
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
      {/if}
      <div class="shead">
        <span class="label">Updates</span>
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
      <div class="foot dim">Applied to the calculation engine now and re-applied on every start. Path of Building's own settings file is never touched.</div>
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: var(--backdrop);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }
  .modal {
    width: 520px;
    max-width: 90vw;
    background: var(--bg-1);
    border: 1px solid var(--line-1);
    border-radius: var(--r-2);
    box-shadow: var(--shadow-modal);
  }
  .mhead {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 10px 12px;
    border-bottom: 1px solid var(--line-0);
  }
  .rows {
    display: flex;
    flex-direction: column;
  }
  .opt {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    padding: 7px 12px;
    border-bottom: 1px solid var(--line-0);
    font-size: var(--fs-sm);
    color: var(--fg-1);
  }
  .seg {
    display: inline-flex;
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
  .foot {
    padding: 8px 12px;
    font-size: var(--fs-xs);
  }
  .shead {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 12px 4px;
    border-top: 1px solid var(--line-1);
  }
  .hint {
    display: block;
    color: var(--fg-2);
    font-size: var(--fs-xs);
    max-width: 320px;
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
