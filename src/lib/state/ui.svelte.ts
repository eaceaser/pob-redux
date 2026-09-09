const KEY = "pob-redux:ui";

export type Dock = "top" | "bottom";
export type Theme = "system" | "dark" | "light";

class UiStore {
  sidebarCollapsed = $state(false);
  treeBarDock = $state<Dock>("top");
  theme = $state<Theme>("system");

  private systemLight = window.matchMedia("(prefers-color-scheme: light)");

  constructor() {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}");
      if (typeof saved.sidebarCollapsed === "boolean") this.sidebarCollapsed = saved.sidebarCollapsed;
      if (saved.treeBarDock === "top" || saved.treeBarDock === "bottom") this.treeBarDock = saved.treeBarDock;
      if (saved.theme === "system" || saved.theme === "dark" || saved.theme === "light") this.theme = saved.theme;
    } catch {}
    this.applyTheme();
    this.systemLight.addEventListener("change", () => this.applyTheme());
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

  private applyTheme() {
    const effective = this.theme === "system" ? (this.systemLight.matches ? "light" : "dark") : this.theme;
    document.documentElement.dataset.theme = effective;
  }

  private save() {
    try {
      localStorage.setItem(KEY, JSON.stringify({ sidebarCollapsed: this.sidebarCollapsed, treeBarDock: this.treeBarDock, theme: this.theme }));
    } catch {}
  }
}

export const ui = new UiStore();
