<script lang="ts">
  import { effortsFor, type Effort } from "$lib/ai/providers";
  import { chat, MAX_WIDTH, MIN_WIDTH, type ToolTurn } from "$lib/state/chat.svelte";
  import ProviderSettings from "$lib/components/ProviderSettings.svelte";
  import Icon from "$lib/components/Icon.svelte";

  let scroller = $state<HTMLDivElement | undefined>();
  let box = $state<HTMLTextAreaElement | undefined>();
  let slashIndex = $state(0);

  // `/` at the start of an empty-ish line opens the tool menu.
  const slashQuery = $derived(
    chat.input.startsWith("/") ? chat.input.slice(1).trim().toLowerCase() : null,
  );
  const slashHits = $derived(
    slashQuery === null
      ? []
      : chat.toolNames.filter((t) => t.name.includes(slashQuery.replace(/\s+/g, "_"))).slice(0, 8),
  );

  $effect(() => {
    void chat.turns.length;
    void chat.busy;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  });

  $effect(() => {
    void slashHits.length;
    slashIndex = 0;
  });

  function pickTool(name: string) {
    chat.input = `Use ${name} and tell me what it returns.`;
    box?.focus();
  }

  function onKeydown(e: KeyboardEvent) {
    if (slashHits.length) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        slashIndex = (slashIndex + 1) % slashHits.length;
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        slashIndex = (slashIndex - 1 + slashHits.length) % slashHits.length;
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        pickTool(slashHits[slashIndex].name);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        chat.input = "";
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      chat.send();
    }
  }

  // Drag the left edge. Pointer capture keeps events coming even when the
  // cursor outruns the grip, which it will at speed.
  let dragging = $state(false);
  function startResize(e: PointerEvent) {
    const grip = e.currentTarget as HTMLElement;
    grip.setPointerCapture(e.pointerId);
    dragging = true;
    const startX = e.clientX;
    const startWidth = chat.width;

    const move = (ev: PointerEvent) => chat.setWidth(startWidth + (startX - ev.clientX));
    const end = () => {
      dragging = false;
      chat.setWidth(chat.width, true);
      grip.releasePointerCapture(e.pointerId);
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", end);
      grip.removeEventListener("pointercancel", end);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", end);
    grip.addEventListener("pointercancel", end);
  }

  /** Keyboard resize, so the grip is not mouse-only. */
  function gripKey(e: KeyboardEvent) {
    const step = e.shiftKey ? 40 : 12;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      chat.setWidth(chat.width + step, true);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      chat.setWidth(chat.width - step, true);
    }
  }

  const summary = (t: ToolTurn) => {
    const a = t.args as Record<string, unknown> | null;
    if (!a) return "";
    return Object.entries(a)
      .slice(0, 3)
      .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
      .join(" ");
  };
</script>

<aside class="chat" style:width="{chat.width}px">
  <div
    class="grip"
    class:dragging
    role="slider"
    aria-orientation="vertical"
    aria-label="Resize assistant panel"
    aria-valuenow={chat.width}
    aria-valuemin={MIN_WIDTH}
    aria-valuemax={MAX_WIDTH}
    tabindex="0"
    onpointerdown={startResize}
    onkeydown={gripKey}
    ondblclick={() => chat.setWidth(400, true)}
    title="Drag to resize · double-click to reset"
  ></div>
  <div class="head">
    <span class="label">Assistant</span>
    <div class="acts">
      <button
        class="icon fresh"
        onclick={() => chat.reset()}
        disabled={chat.busy}
        title="New conversation"
        aria-label="New conversation"
      >
        <Icon name="plus-square" size={17} />
      </button>
      <button
        class="icon"
        class:on={chat.settingsOpen}
        title="Providers and keys"
        aria-label="Provider settings"
        onclick={() => (chat.settingsOpen = !chat.settingsOpen)}
      >
        <Icon name="gear" size={17} />
      </button>
      <button class="icon close" onclick={() => chat.toggle()} title="Hide panel (Ctrl+K)" aria-label="Hide panel">
        <Icon name="x-square" size={17} />
      </button>
    </div>
  </div>

  {#if chat.settingsOpen}
    <ProviderSettings />
  {/if}

  {#if !chat.anyReady && !chat.settingsOpen}
    <div class="setup">
      <div class="label">No provider configured</div>
      <p class="dim">
        Add a key for Anthropic, OpenAI, OpenRouter, OpenCode Zen or Ollama Cloud — or run Ollama locally, which
        needs no key. Keys are held in your operating system's credential manager and never written to disk by
        this app.
      </p>
      <button class="btn sm" onclick={() => (chat.settingsOpen = true)}>Open provider settings</button>
    </div>
  {:else}
    <div class="log" bind:this={scroller}>
      {#each chat.turns as turn}
        {#if turn.kind === "user"}
          <div class="turn user">{turn.text}</div>
        {:else if turn.kind === "assistant"}
          <div class="turn bot">{turn.text}</div>
        {:else}
          <div class="tool" class:err={turn.status === "error"}>
            <div class="tline">
              <span class="tname">{turn.name}</span>
              <span class="targs">{summary(turn)}</span>
              <span class="tstat {turn.status}">{turn.status}</span>
            </div>
            {#if turn.status === "awaiting"}
              <div class="approve">
                <span>This changes the build.</span>
                <button class="btn sm" onclick={() => chat.resolveApproval(turn.id, true)}>Run</button>
                <button class="btn sm ghost" onclick={() => chat.resolveApproval(turn.id, false)}>Skip</button>
                <label class="always"><input type="checkbox" bind:checked={chat.allowWrites} /> allow all</label>
              </div>
            {/if}
            {#if turn.error}<div class="terr">{turn.error}</div>{/if}
          </div>
        {/if}
      {/each}
      {#if chat.busy}<div class="dim thinking">working…</div>{/if}
      {#if chat.error}<div class="terr">{chat.error}</div>{/if}
      {#if !chat.turns.length && !chat.busy}
        <div class="dim empty">
          Ask about the open build. Every number comes from Path of Building's own engine.
          <div class="egs">
            <button class="eg" onclick={() => { chat.input = "Why is my EHP low?"; chat.send(); }}>Why is my EHP low?</button>
            <button class="eg" onclick={() => { chat.input = "Summarise this build's defences."; chat.send(); }}>Summarise defences</button>
            <button class="eg" onclick={() => { chat.input = "Are my resistances capped?"; chat.send(); }}>Are my resists capped?</button>
          </div>
        </div>
      {/if}
    </div>

    <div class="composer">
      {#if slashHits.length}
        <div class="slash">
          <div class="slabel">Built-in tools · {chat.toolNames.length} available</div>
          {#each slashHits as t, i}
            <button class="srow" class:sel={i === slashIndex} onclick={() => pickTool(t.name)}>
              <span class="sname">{t.name}</span>
              <span class="skind" class:ro={t.read_only}>{t.read_only ? "read" : "write"}</span>
              <span class="sdesc">{t.description}</span>
            </button>
          {/each}
        </div>
      {/if}
      <textarea
        bind:this={box}
        class="ta"
        rows="2"
        placeholder="Ask anything, / for tools…"
        bind:value={chat.input}
        onkeydown={onKeydown}
        disabled={chat.busy}
      ></textarea>
      <div class="bar">
        <select
          class="pill"
          value={chat.provider}
          onchange={(e) => chat.setProvider((e.target as HTMLSelectElement).value)}
          title="Provider"
        >
          {#each chat.providers as p}
            <option value={p.id} disabled={!p.ready}>{p.label}{p.ready ? "" : " — no key"}</option>
          {/each}
        </select>

        <select
          class="pill"
          value={chat.model}
          onchange={(e) => chat.setModel((e.target as HTMLSelectElement).value)}
          title="Model"
          disabled={!chat.models.length}
        >
          {#if chat.models.length}
            {@const top = chat.models.filter((m) => m.recommended)}
            {@const rest = chat.models.filter((m) => !m.recommended)}
            {#if top.length && rest.length}
              <optgroup label="Latest">
                {#each top as m}<option value={m.id}>{m.label}</option>{/each}
              </optgroup>
              <optgroup label="All models ({rest.length})">
                {#each rest as m}<option value={m.id}>{m.label}</option>{/each}
              </optgroup>
            {:else}
              {#each chat.models as m}<option value={m.id}>{m.label}</option>{/each}
            {/if}
          {:else}
            <option value={chat.model}>{chat.modelsError ? "unavailable" : chat.model}</option>
          {/if}
        </select>

        {#if chat.supportsEffort}
          <select
            class="pill"
            value={chat.effort}
            onchange={(e) => chat.setEffort((e.target as HTMLSelectElement).value as Effort)}
            title="Reasoning effort"
          >
            {#each effortsFor(chat.current?.kind ?? "anthropic") as e}<option value={e}>{e[0].toUpperCase() + e.slice(1)}</option>{/each}
          </select>
        {/if}

        <div class="grow"></div>
        {#if chat.busy}
          <button class="send" onclick={() => chat.stop()} title="Stop" aria-label="Stop">
            <Icon name="stop" size={13} />
          </button>
        {:else}
          <button class="send" onclick={() => chat.send()} disabled={!chat.input.trim()} title="Send" aria-label="Send">
            <Icon name="paper-plane" size={13} />
          </button>
        {/if}
      </div>
      {#if chat.modelsError}<div class="terr small">{chat.modelsError}</div>{/if}
    </div>
  {/if}
</aside>

<style>
  .chat {
    position: relative;
    display: flex;
    flex-direction: column;
    flex: none;
    border-left: 1px solid var(--line-1);
    background: var(--bg-1);
    overflow: hidden;
  }
  /* Sits over the border, wider than it looks so it is easy to grab. */
  .grip {
    position: absolute;
    top: 0;
    bottom: 0;
    left: -3px;
    width: 7px;
    z-index: 10;
    cursor: col-resize;
    touch-action: none;
  }
  .grip:hover::after,
  .grip:focus-visible::after,
  .grip.dragging::after {
    content: "";
    position: absolute;
    inset: 0 3px;
    background: var(--focus);
  }
  .grip:focus-visible {
    outline: none;
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 8px 10px;
    border-bottom: 1px solid var(--line-1);
  }
  .acts {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .icon {
    display: grid;
    place-items: center;
    width: 28px;
    height: 26px;
    padding: 0;
    background: none;
    border: 1px solid transparent;
    border-radius: var(--r-1);
    color: var(--fg-2);
    cursor: pointer;
  }
  .icon:hover:not(:disabled),
  .icon.on {
    background: var(--bg-hover);
    border-color: var(--line-1);
    color: var(--fg-0);
  }
  /* Both hovers reuse existing tokens; no new colours. Red reads as the
     closing action, blue as the one that starts something. */
  .icon.close:hover:not(:disabled) {
    color: var(--bad);
  }
  .icon.fresh:hover:not(:disabled) {
    color: var(--focus);
  }
  .icon:disabled {
    opacity: 0.4;
  }
  .setup {
    padding: 14px;
  }
  .setup p {
    font-size: var(--fs-xs);
    line-height: 1.55;
    margin: 6px 0 12px;
  }
  .log {
    flex: 1;
    overflow-y: auto;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .turn {
    font-size: var(--fs-md);
    line-height: 1.55;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .user {
    align-self: flex-end;
    max-width: 88%;
    background: var(--bg-3);
    border: 1px solid var(--line-1);
    border-radius: var(--r-2);
    padding: 6px 9px;
  }
  .bot {
    color: var(--fg-0);
  }
  .tool {
    border-left: 2px solid var(--line-2);
    padding: 3px 0 3px 8px;
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
  }
  .tool.err {
    border-left-color: var(--bad);
  }
  .tline {
    display: flex;
    gap: 6px;
    align-items: baseline;
  }
  .tname {
    color: var(--fg-1);
  }
  .targs {
    color: var(--fg-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }
  .tstat {
    color: var(--fg-3);
    font-size: var(--fs-2xs);
  }
  .tstat.done {
    color: var(--ok);
  }
  .tstat.error {
    color: var(--bad);
  }
  .tstat.awaiting {
    color: var(--warn);
  }
  .approve {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 5px;
    color: var(--warn);
    font-size: var(--fs-2xs);
  }
  .always {
    display: flex;
    align-items: center;
    gap: 3px;
    color: var(--fg-3);
  }
  .terr {
    color: var(--bad);
    font-size: var(--fs-xs);
    word-break: break-word;
  }
  .terr.small {
    font-size: var(--fs-2xs);
    padding: 0 10px 8px;
  }
  .thinking {
    font-size: var(--fs-xs);
  }
  .empty {
    font-size: var(--fs-sm);
    line-height: 1.5;
  }
  .egs {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 10px;
  }
  .eg {
    text-align: left;
    background: none;
    border: 1px solid var(--line-1);
    border-radius: var(--r-1);
    color: var(--fg-2);
    font: inherit;
    font-size: var(--fs-xs);
    padding: 4px 7px;
    cursor: pointer;
  }
  .eg:hover {
    background: var(--bg-hover);
    color: var(--fg-0);
  }

  /* Composer: one bordered card holding the box and its controls. */
  .composer {
    position: relative;
    margin: 8px;
    border: 1px solid var(--line-1);
    border-radius: var(--r-2);
    background: var(--bg-2);
  }
  .composer:focus-within {
    border-color: var(--line-2);
  }
  .ta {
    display: block;
    width: 100%;
    box-sizing: border-box;
    resize: none;
    background: none;
    border: 0;
    outline: none;
    color: var(--fg-0);
    font-family: var(--font-ui);
    font-size: var(--fs-md);
    line-height: 1.5;
    padding: 9px 10px 4px;
  }
  .ta::placeholder {
    color: var(--fg-3);
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 5px 6px 6px;
  }
  .grow {
    flex: 1;
  }
  .pill {
    appearance: none;
    background: none;
    border: 1px solid transparent;
    border-radius: var(--r-1);
    color: var(--fg-2);
    font-family: var(--font-ui);
    font-size: var(--fs-xs);
    padding: 2px 17px 2px 5px;
    max-width: 132px;
    cursor: pointer;
    /* appearance:none drops the native arrow. Same chevron as `.select` in
       app.css so dropdowns look the same everywhere. */
    background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><path d='M1 1l4 4 4-4' fill='none' stroke='%2380808a' stroke-width='1.2'/></svg>");
    background-repeat: no-repeat;
    background-position: right 5px center;
  }
  .pill:hover:not(:disabled) {
    background: var(--bg-hover);
    border-color: var(--line-1);
    color: var(--fg-0);
  }
  .pill:disabled {
    color: var(--fg-4);
    cursor: default;
  }
  .send {
    display: grid;
    place-items: center;
    width: 26px;
    height: 24px;
    padding: 0;
    background: var(--bg-3);
    border: 1px solid var(--line-2);
    border-radius: var(--r-1);
    color: var(--fg-1);
    font-size: var(--fs-sm);
    cursor: pointer;
  }
  .send:hover:not(:disabled) {
    background: var(--bg-hover);
    color: var(--fg-0);
  }
  .send:disabled {
    color: var(--fg-4);
    border-color: var(--line-1);
    cursor: default;
  }

  .slash {
    position: absolute;
    bottom: calc(100% + 6px);
    left: 0;
    right: 0;
    max-height: 260px;
    overflow-y: auto;
    background: var(--bg-2);
    border: 1px solid var(--line-2);
    border-radius: var(--r-2);
    padding: 4px;
    z-index: 5;
  }
  .slabel {
    color: var(--fg-3);
    font-size: var(--fs-2xs);
    padding: 3px 6px 5px;
  }
  .srow {
    display: block;
    width: 100%;
    text-align: left;
    background: none;
    border: 0;
    border-radius: var(--r-1);
    padding: 4px 6px;
    color: var(--fg-1);
    font: inherit;
    cursor: pointer;
  }
  .srow:hover,
  .srow.sel {
    background: var(--bg-hover);
  }
  .sname {
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    color: var(--fg-0);
  }
  .skind {
    font-family: var(--font-mono);
    font-size: var(--fs-2xs);
    color: var(--warn);
    margin-left: 6px;
  }
  .skind.ro {
    color: var(--fg-3);
  }
  .sdesc {
    display: block;
    color: var(--fg-3);
    font-size: var(--fs-2xs);
    line-height: 1.4;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
