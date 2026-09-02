import { engine, type AppOptions } from "$lib/engine.svelte";
import { build } from "$lib/state/build.svelte";

const KEY = "pob-redux:options";

/**
 * App options live on PoB's `main` for the session (number formatting, gem
 * defaults). PoB's SaveSettings is never called, so persistence is ours:
 * localStorage, re-applied to the engine on every boot.
 */
class OptionsStore {
  values = $state<AppOptions | null>(null);
  open = $state(false);

  /** Called once the engine is ready: overlay saved values onto PoB defaults. */
  async init() {
    let saved: Partial<AppOptions> = {};
    try {
      saved = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    } catch {}
    const r = Object.keys(saved).length ? await engine.setAppOptions(saved) : await engine.getAppOptions();
    this.values = r.options;
  }

  async set(patch: Partial<AppOptions>) {
    const apply = async () => {
      const r = await engine.setAppOptions(patch);
      this.values = r.options;
      try {
        localStorage.setItem(KEY, JSON.stringify(r.options));
      } catch {}
    };
    // Separators change PoB's formatted output; resync the build if one is up.
    if (build.loaded) await build.run(apply);
    else await apply();
  }
}

export const appOptions = new OptionsStore();
