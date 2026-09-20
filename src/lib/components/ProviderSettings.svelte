<script lang="ts">
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { clearKey, setBase, setKey, type ProviderStatus } from "$lib/ai/providers";
  import { chat } from "$lib/state/chat.svelte";
  import Icon from "$lib/components/Icon.svelte";
  import { m } from "$lib/paraglide/messages";

  let drafts = $state<Record<string, string>>({});
  let bases = $state<Record<string, string>>({});
  let busy = $state("");
  let error = $state<string | null>(null);
  let expanded = $state<string | null>(null);

  async function save(p: ProviderStatus) {
    const key = (drafts[p.id] ?? "").trim();
    if (!key) return;
    busy = p.id;
    error = null;
    try {
      await setKey(p.id, key);
      drafts[p.id] = "";
      await chat.refreshProviders();
      if (p.id === chat.provider) await chat.refreshModels();
    } catch (e) {
      error = String(e);
    } finally {
      busy = "";
    }
  }

  async function remove(p: ProviderStatus) {
    busy = p.id;
    error = null;
    try {
      await clearKey(p.id);
      await chat.refreshProviders();
      if (p.id === chat.provider) await chat.refreshModels();
    } catch (e) {
      error = String(e);
    } finally {
      busy = "";
    }
  }

  async function saveBase(p: ProviderStatus) {
    busy = p.id;
    error = null;
    try {
      await setBase(p.id, bases[p.id] ?? "");
      await chat.refreshProviders();
      if (p.id === chat.provider) await chat.refreshModels();
    } catch (e) {
      error = String(e);
    } finally {
      busy = "";
    }
  }

  function toggle(p: ProviderStatus) {
    expanded = expanded === p.id ? null : p.id;
    if (expanded) bases[p.id] = p.base_url;
  }
</script>

<div class="sheet">
  <p class="dim intro">{m.provider_intro()}</p>

  {#each chat.providers as p}
    <div class="row" class:active={p.id === chat.provider}>
      <button class="top" onclick={() => toggle(p)}>
        <span class="dot" class:ok={p.ready}></span>
        <span class="name">{p.label}</span>
        {#if !p.needs_key}
          <span class="tag">{m.provider_no_key_needed()}</span>
        {:else if p.has_key}
          <span class="tag mono">···{p.hint}</span>
        {:else}
          <span class="tag warn">{m.provider_not_configured()}</span>
        {/if}
        <span class="chev"><Icon name={expanded === p.id ? "minus" : "plus"} size={11} /></span>
      </button>

      {#if expanded === p.id}
        <div class="body">
          {#if p.needs_key}
            <div class="field">
              <input
                class="input"
                type="password"
                placeholder={p.has_key ? m.provider_replace_key() : m.provider_paste_key()}
                bind:value={drafts[p.id]}
                onkeydown={(e) => e.key === "Enter" && save(p)}
              />
              <button class="btn sm" onclick={() => save(p)} disabled={busy === p.id || !(drafts[p.id] ?? "").trim()}>
                {m.common_save()}
              </button>
              {#if p.has_key}
                <button class="btn sm ghost" onclick={() => remove(p)} disabled={busy === p.id}>{m.provider_remove()}</button>
              {/if}
            </div>
            {#if p.keys_url}
              <button class="link" onclick={() => openUrl(p.keys_url!)}>{m.provider_get_key()}</button>
            {/if}
          {/if}

          <div class="field">
            <input class="input mono sm" bind:value={bases[p.id]} placeholder={p.default_base} />
            <button class="btn sm ghost" onclick={() => saveBase(p)} disabled={busy === p.id}>{m.provider_set_url()}</button>
          </div>
          <div class="hint">{m.provider_base_hint({ base: p.default_base })}</div>
        </div>
      {/if}
    </div>
  {/each}

  {#if error}<div class="err">{error}</div>{/if}
</div>

<style>
  .sheet {
    border-bottom: 1px solid var(--line-1);
    padding: 10px;
    max-height: 55%;
    overflow-y: auto;
    background: var(--bg-2);
  }
  .intro {
    font-size: var(--fs-2xs);
    line-height: 1.5;
    margin: 0 0 10px;
  }
  .row {
    border: 1px solid var(--line-1);
    border-radius: var(--r-1);
    margin-bottom: 5px;
    background: var(--bg-1);
  }
  .row.active {
    border-color: var(--line-2);
  }
  .top {
    display: flex;
    align-items: center;
    gap: 7px;
    width: 100%;
    background: none;
    border: 0;
    color: var(--fg-1);
    font: inherit;
    font-size: var(--fs-sm);
    padding: 6px 8px;
    cursor: pointer;
    text-align: left;
  }
  .top:hover {
    background: var(--bg-hover);
  }
  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--fg-4);
    flex: none;
  }
  .dot.ok {
    background: var(--ok);
  }
  .name {
    flex: 1;
    color: var(--fg-0);
  }
  .tag {
    font-size: var(--fs-2xs);
    color: var(--fg-3);
  }
  .tag.warn {
    color: var(--warn);
  }
  .tag.mono {
    font-family: var(--font-mono);
  }
  .chev {
    color: var(--fg-3);
    display: grid;
    place-items: center;
    width: 12px;
  }
  .body {
    padding: 4px 8px 9px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .field {
    display: flex;
    gap: 5px;
  }
  .field .input {
    flex: 1;
    min-width: 0;
  }
  .input.sm {
    font-size: var(--fs-2xs);
  }
  .hint {
    color: var(--fg-3);
    font-size: var(--fs-2xs);
    line-height: 1.4;
    word-break: break-all;
  }
  .link {
    align-self: flex-start;
    background: none;
    border: 0;
    padding: 0;
    color: var(--focus);
    font: inherit;
    font-size: var(--fs-2xs);
    cursor: pointer;
  }
  .link:hover {
    text-decoration: underline;
  }
  .err {
    color: var(--bad);
    font-size: var(--fs-xs);
    margin-top: 6px;
    word-break: break-word;
  }
</style>
