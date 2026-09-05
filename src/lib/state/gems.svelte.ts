import { engine, type GemName, type TooltipLine } from "$lib/engine.svelte";

export interface GemMatch {
  name: string;
  gemId: string;
  kind: GemName["kind"];
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Every gem name PoB knows, so prose can be scanned for them. Case-sensitive
 * on purpose: gem names are capitalised, and "Execute" or "Momentum" in
 * running text should not light up.
 */
class GemIndex {
  byName = $state<Map<string, GemMatch>>(new Map());
  /** Longest names first, so "Bleed III" wins over "Bleed". */
  pattern = $state<RegExp | null>(null);

  private loading: Promise<void> | null = null;
  private tips = new Map<string, TooltipLine[]>();

  load(): Promise<void> {
    if (this.byName.size) return Promise.resolve();
    this.loading ??= engine
      .gemNames()
      .then((r) => {
        const map = new Map<string, GemMatch>();
        for (const g of r.gems) {
          if (g.name.length < 3) continue;
          map.set(g.name, { name: g.name, gemId: g.gemId, kind: g.kind });
        }
        const names = [...map.keys()].sort((a, b) => b.length - a.length).map(escape);
        this.byName = map;
        this.pattern = names.length ? new RegExp(`(?<![\\w'])(?:${names.join("|")})(?![\\w'])`, "g") : null;
      })
      .catch(() => {
        this.loading = null;
      });
    return this.loading;
  }

  /** Split a string into plain text and gem-name runs. */
  scan(text: string): Array<{ text: string; gem?: GemMatch }> {
    const re = this.pattern;
    if (!re) return [{ text }];
    const out: Array<{ text: string; gem?: GemMatch }> = [];
    let last = 0;
    for (const m of text.matchAll(re)) {
      const at = m.index ?? 0;
      const gem = this.byName.get(m[0]);
      if (!gem) continue;
      if (at > last) out.push({ text: text.slice(last, at) });
      out.push({ text: m[0], gem });
      last = at + m[0].length;
    }
    if (last < text.length) out.push({ text: text.slice(last) });
    return out;
  }

  async tooltip(gemId: string): Promise<TooltipLine[]> {
    const cached = this.tips.get(gemId);
    if (cached) return cached;
    const r = await engine.gemTooltipById(gemId);
    this.tips.set(gemId, r.lines);
    return r.lines;
  }
}

export const gems = new GemIndex();
