import { getCurrentWebview } from "@tauri-apps/api/webview";

const KEY = "pob-redux:ui";

export type Dock = "top" | "bottom";
export type Theme = "system" | "dark" | "light";
export type Contrast = "system" | "normal" | "more" | "most";

export const SCALE_MIN = 0.75;
export const SCALE_MAX = 2;
export const SCALE_STEP = 0.1;

class UiStore {
  sidebarCollapsed = $state(false);
  treeBarDock = $state<Dock>("top");
  theme = $state<Theme>("system");
  contrast = $state<Contrast>("system");
  scale = $state(1);

  private systemLight = window.matchMedia("(prefers-color-scheme: light)");
  private systemContrast = window.matchMedia("(prefers-contrast: more)");

  constructor() {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}");
      if (typeof saved.sidebarCollapsed === "boolean") this.sidebarCollapsed = saved.sidebarCollapsed;
      if (saved.treeBarDock === "top" || saved.treeBarDock === "bottom") this.treeBarDock = saved.treeBarDock;
      if (saved.theme === "system" || saved.theme === "dark" || saved.theme === "light") this.theme = saved.theme;
      if (["system", "normal", "more", "most"].includes(saved.contrast)) this.contrast = saved.contrast;
      if (typeof saved.scale === "number") this.scale = clampScale(saved.scale);
    } catch {}
    this.applyTheme();
    this.applyContrast();
    this.systemLight.addEventListener("change", () => this.applyTheme());
    this.systemContrast.addEventListener("change", () => this.applyContrast());
    if (this.scale !== 1) this.applyScale();
  }

  toggleSidebar() {
    this.sidebarCollapsed = !this.sidebarCollapsed;
    this.save();
  }

  setTreeBarDock(dock: Dock) {
    this.treeBarDock = dock;
    this.save();
  }

  setTheme(theme: Theme) {
    this.theme = theme;
    this.applyTheme();
    this.save();
  }

  setContrast(contrast: Contrast) {
    this.contrast = contrast;
    this.applyContrast();
    this.save();
  }

  setScale(scale: number) {
    this.scale = clampScale(scale);
    this.applyScale();
    this.save();
  }

  stepScale(direction: 1 | -1) {
    this.setScale(this.scale + direction * SCALE_STEP);
  }

  private applyTheme() {
    const effective = this.theme === "system" ? (this.systemLight.matches ? "light" : "dark") : this.theme;
    document.documentElement.dataset.theme = effective;
  }

  private applyContrast() {
    const effective = this.contrast === "system" ? (this.systemContrast.matches ? "more" : "normal") : this.contrast;
    if (effective === "normal") delete document.documentElement.dataset.contrast;
    else document.documentElement.dataset.contrast = effective;
  }

  private applyScale() {
    getCurrentWebview()
      .setZoom(this.scale)
      .catch(() => {});
  }

  private save() {
    try {
      localStorage.setItem(
        KEY,
        JSON.stringify({
          sidebarCollapsed: this.sidebarCollapsed,
          treeBarDock: this.treeBarDock,
          theme: this.theme,
          contrast: this.contrast,
          scale: this.scale,
        }),
      );
    } catch {}
  }
}

function clampScale(s: number) {
  const snapped = Math.round(s / 0.05) * 0.05;
  return Math.min(SCALE_MAX, Math.max(SCALE_MIN, Number(snapped.toFixed(2))));
}

export const ui = new UiStore();
