import { convertFileSrc } from "@tauri-apps/api/core";

/** One entry of TreeData/<version>/web/manifest.json (written by pob-sync). */
export interface AssetRect {
  file: string;
  x: number;
  y: number;
  w: number;
  h: number;
  ow: number;
  oh: number;
}

export interface AssetManifest {
  version: string;
  assets: Record<string, AssetRect>;
  disabled: Record<string, AssetRect>;
}

interface Slot {
  img: HTMLImageElement;
  ready: boolean;
  failed: boolean;
}

/**
 * Lazily loads sprite sheets through the app's `pob://` protocol and draws
 * named assets with PoB's `DrawAsset` semantics (centre + half extents).
 */
export class AssetStore {
  private slots = new Map<string, Slot>();

  constructor(
    readonly manifest: AssetManifest,
    private onReady: () => void,
  ) {}

  static async load(version: string, onReady: () => void): Promise<AssetStore | null> {
    try {
      const res = await fetch(convertFileSrc(`TreeData/${version}/web/manifest.json`, "pob"));
      if (!res.ok) return null;
      return new AssetStore((await res.json()) as AssetManifest, onReady);
    } catch {
      return null;
    }
  }

  has(name: string): boolean {
    return name in this.manifest.assets;
  }

  rect(name: string, disabled = false): AssetRect | undefined {
    if (disabled) return this.manifest.disabled[name] ?? this.manifest.assets[name];
    return this.manifest.assets[name];
  }

  image(file: string): HTMLImageElement | null {
    let s = this.slots.get(file);
    if (!s) {
      const img = new Image();
      s = { img, ready: false, failed: false };
      this.slots.set(file, s);
      img.onload = () => {
        s!.ready = true;
        this.onReady();
      };
      img.onerror = () => {
        s!.failed = true;
      };
      img.src = convertFileSrc(file, "pob");
    }
    return s.ready ? s.img : null;
  }

  /** Kick off loading without drawing. */
  prefetch(name: string, disabled = false) {
    const r = this.rect(name, disabled);
    if (r) this.image(r.file);
  }

  /** Draws `name` centred on (cx, cy) with the given half extents in screen px. */
  draw(ctx: CanvasRenderingContext2D, name: string, cx: number, cy: number, halfW: number, halfH: number, disabled = false): boolean {
    const r = this.rect(name, disabled);
    if (!r) return false;
    const img = this.image(r.file);
    if (!img) return false;
    ctx.drawImage(img, r.x, r.y, r.w, r.h, cx - halfW, cy - halfH, halfW * 2, halfH * 2);
    return true;
  }

  pattern(ctx: CanvasRenderingContext2D, name: string): CanvasPattern | null {
    const r = this.rect(name);
    if (!r) return null;
    const img = this.image(r.file);
    if (!img) return null;
    // Sub-rect patterns need an intermediate canvas.
    if (r.x !== 0 || r.y !== 0 || r.w !== img.width || r.h !== img.height) {
      const c = document.createElement("canvas");
      c.width = r.w;
      c.height = r.h;
      c.getContext("2d")!.drawImage(img, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
      return ctx.createPattern(c, "repeat");
    }
    return ctx.createPattern(img, "repeat");
  }
}
