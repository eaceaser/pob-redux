<script lang="ts">
  import { confirm } from "$lib/state/confirm.svelte";
  import { m } from "$lib/paraglide/messages";

  const c = $derived(confirm.current);
  let cancelEl = $state<HTMLButtonElement | null>(null);

  // The cancel button takes focus so Enter cannot discard work by accident.
  $effect(() => {
    if (c) cancelEl?.focus();
  });
</script>

{#if c}
  <div class="overlay" role="presentation" onclick={() => confirm.answer(false)}>
    <div
      class="modal"
      role="alertdialog"
      aria-modal="true"
      aria-label={c.title}
      tabindex="-1"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => {
        if (e.key === "Escape") confirm.answer(false);
      }}
    >
      <div class="mhead"><span class="label">{c.title}</span></div>
      <div class="body">{c.message}</div>
      <div class="foot">
        <button class="btn sm ghost" bind:this={cancelEl} onclick={() => confirm.answer(false)}>{c.cancel ?? m.common_cancel()}</button>
        <button class="btn sm primary" onclick={() => confirm.answer(true)}>{c.ok ?? m.confirm_ok()}</button>
      </div>
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
    z-index: 120;
  }
  .modal {
    width: 420px;
    max-width: 90vw;
    background: var(--bg-1);
    border: 1px solid var(--line-1);
    border-radius: var(--r-2);
    box-shadow: var(--shadow-modal);
  }
  .mhead {
    padding: 10px 12px;
    border-bottom: 1px solid var(--line-0);
  }
  .body {
    padding: 12px;
    font-size: var(--fs-sm);
    color: var(--fg-1);
    line-height: 1.45;
  }
  .foot {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 8px 12px 10px;
    border-top: 1px solid var(--line-0);
  }
</style>
