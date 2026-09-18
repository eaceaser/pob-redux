import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { fetchBuildCode } from "$lib/engine.svelte";
import { build } from "$lib/state/build.svelte";
import { confirm } from "$lib/state/confirm.svelte";
import { game } from "$lib/state/game.svelte";

type Link = { game: "poe1" | "poe2"; url: string };

class LinkStore {
  private listening = false;
  /** macOS can report the launch link twice; the same link within this window is ignored. */
  private recent = new Map<string, number>();

  async init(): Promise<boolean> {
    if (!this.listening) {
      this.listening = true;
      await listen("open-link", () => void this.openPending());
    }
    return this.openPending();
  }

  async openPending(): Promise<boolean> {
    const link = await invoke<Link | null>("take_open_link").catch(() => null);
    if (!link) return false;
    const seen = this.recent.get(link.url);
    if (seen && Date.now() - seen < 10_000) return false;
    this.recent.set(link.url, Date.now());
    return this.open(link);
  }

  private async open(link: Link): Promise<boolean> {
    // switching game asks about unsaved changes on its own
    if (build.info?.unsaved && link.game === game.current) {
      const ok = await confirm.ask({
        title: "Open linked build",
        message: "The open build has unsaved changes. Open the linked build anyway?",
        ok: "Open",
        cancel: "Keep editing",
      });
      if (!ok) return false;
    }
    try {
      const r = await fetchBuildCode(link.url);
      const loaded = await build.loadCode(r.code);
      if (loaded) build.say(`Opened a build from ${r.site}`);
      return !!loaded;
    } catch (e) {
      build.error = `Could not open the link: ${String(e)}`;
      return false;
    }
  }
}

export const links = new LinkStore();
