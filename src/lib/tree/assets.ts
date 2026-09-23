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
  /** Already masked to its inscribed circle by pob-sync. */
  round?: boolean;
}

export interface Lod {
  file: string;
  scale: number;
}

export interface AssetManifest {
  version: string;
  assets: Record<string, AssetRect>;
  disabled: Record<string, AssetRect>;
  /** Smaller copies of a sheet, keyed by its file; a rect maps into one divided by `scale`. */
  lods?: Record<string, Lod[]>;
}

interface Slot {
  img: HTMLImageElement;
  ready: boolean;
  failed: boolean;
}

/**
 * Lazily loads sprite sheets through the app's `pobasset://` protocol and draws
 * named assets with PoB's `DrawAsset` semantics (centre + half extents).
 */
export class AssetStore {
  private slots = new Map<string, Slot>();
  private tinted = new Map<string, HTMLCanvasElement>();
  onReady: () => void = () => {};

  constructor(readonly manifest: AssetManifest) {}

  static async load(version: string): Promise<AssetStore | null> {
    try {
      const res = await fetch(convertFileSrc(`TreeData/${version}/web/manifest.json`, "pobasset"));
      if (!res.ok) return null;
      return new AssetStore((await res.json()) as AssetManifest);
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
      img.src = convertFileSrc(file, "pobasset");
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
    const src = this.source(r, 2 * Math.max(halfW, halfH) * devicePixelRatio);
    if (!src) return false;
    const [img, f] = src;
    ctx.drawImage(img, r.x / f, r.y / f, r.w / f, r.h / f, cx - halfW, cy - halfH, halfW * 2, halfH * 2);
    return true;
  }

  /** The smallest copy with twice `px` (just enough resamples soft); until it loads, the nearest loaded one. */
  private source(r: AssetRect, px: number): [HTMLImageElement, number] | null {
    const lods = this.manifest.lods?.[r.file];
    if (!lods) {
      const img = this.image(r.file);
      return img ? [img, 1] : null;
    }
    const size = Math.max(r.w, r.h);
    let file = r.file;
    let scale = 1;
    for (const l of lods) {
      if (l.scale > scale && size / l.scale >= 2 * px) {
        file = l.file;
        scale = l.scale;
      }
    }
    const img = this.image(file);
    if (img) return [img, scale];
    const all = [{ file: r.file, scale: 1 }, ...lods];
    for (const l of [...all.filter((l) => l.scale < scale).reverse(), ...all.filter((l) => l.scale > scale)]) {
      const s = this.slots.get(l.file);
      if (s?.ready) return [s.img, l.scale];
    }
    return null;
  }

  /** `draw` with the art multiplied by `color`, as PoB's SetDrawColor tints an image. */
  drawTinted(ctx: CanvasRenderingContext2D, name: string, cx: number, cy: number, halfW: number, halfH: number, color: string): boolean {
    const key = `${name}|${color}`;
    let c = this.tinted.get(key);
    if (!c) {
      const r = this.rect(name);
      const img = r && this.image(r.file);
      if (!r || !img) return false;
      c = document.createElement("canvas");
      c.width = r.w;
      c.height = r.h;
      const t = c.getContext("2d")!;
      t.drawImage(img, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
      t.globalCompositeOperation = "multiply";
      t.fillStyle = color;
      t.fillRect(0, 0, r.w, r.h);
      t.globalCompositeOperation = "destination-in";
      t.drawImage(img, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
      this.tinted.set(key, c);
    }
    ctx.drawImage(c, cx - halfW, cy - halfH, halfW * 2, halfH * 2);
    return true;
  }

  /**
   * Tiles `name` over a w×h area at `size` px per tile, one drawImage per
   * tile. A repeating CanvasPattern would be the natural tool, but filling
   * with one while the window is being resized crashes WebView2's renderer
   * (STATUS_INTEGER_DIVIDE_BY_ZERO) after roughly a hundred resize steps.
   */
  tile(ctx: CanvasRenderingContext2D, name: string, w: number, h: number, size: number): boolean {
    const r = this.rect(name);
    if (!r) return false;
    const src = this.source(r, size * devicePixelRatio);
    if (!src) return false;
    const [img, f] = src;
    for (let y = 0; y < h; y += size) {
      for (let x = 0; x < w; x += size) {
        ctx.drawImage(img, r.x / f, r.y / f, r.w / f, r.h / f, x, y, size, size);
      }
    }
    return true;
  }
}
