import {
  engine,
  poolPresync,
  EngineError,
  type BuildInfo,
  type ClassInfo,
  type Sidebar,
  type Skills,
  type SpecInfo,
  type TreeClickResult,
  type TreeState,
} from "$lib/engine.svelte";

export type ViewId = "tree" | "skills" | "items" | "calcs" | "config" | "notes" | "party" | "import";

/**
 * The one live build. Mutations go through the engine and then re-pull the
 * derived state (build info, sidebar, tree allocation) so every view reflects
 * PoB's own numbers. Calls are serialised by the engine thread; issuing them
 * concurrently from here is safe.
 */
class BuildStore {
  info = $state<BuildInfo | null>(null);
  sidebar = $state<Sidebar | null>(null);
  tree = $state<TreeState | null>(null);
  skills = $state<Skills | null>(null);
  specs = $state<SpecInfo[]>([]);
  classes = $state<ClassInfo[]>([]);
  /** Engine metadata (PoB version, tree versions); fetched once. */
  meta = $state<{ pobVersion: string; treeVersions: string[]; latestTreeVersion: string } | null>(null);
  view = $state<ViewId>("import");
  busy = $state(0);
  error = $state<string | null>(null);
  /** Bumped when calc output changes; views use it to refetch their own data. */
  rev = $state(0);

  get loaded() {
    return this.info !== null;
  }

  async run<T>(fn: () => Promise<T>, opts: { sync?: boolean } = {}): Promise<T | undefined> {
    this.busy++;
    try {
      const r = await fn();
      if (opts.sync !== false) await this.sync();
      return r;
    } catch (e) {
      this.error = e instanceof EngineError ? `${e.method}: ${e.message}` : String(e);
      console.error(e);
      return undefined;
    } finally {
      this.busy--;
    }
  }

  private autosaveTimer: ReturnType<typeof setInterval> | undefined;
  private lastAutosave = "";
  private presyncTimer: ReturnType<typeof setTimeout> | undefined;

  /** Keep the worker engines on the current build so parallel scans skip their sync. */
  private schedulePresync() {
    clearTimeout(this.presyncTimer);
    this.presyncTimer = setTimeout(() => {
      if (this.busy === 0) poolPresync().catch(() => {});
    }, 400);
  }

  /** Snapshot the build XML to localStorage every 2 minutes for crash recovery. */
  private async autosave() {
    if (!this.info || this.busy > 0) return;
    try {
      const { xml } = await engine.saveBuildXml();
      if (xml === this.lastAutosave) return;
      this.lastAutosave = xml;
      localStorage.setItem(
        "pob-redux:autosave",
        JSON.stringify({ name: this.info.name, file: this.info.file ?? null, at: Date.now(), xml }),
      );
    } catch {
      // engine busy or storage full; next tick retries
    }
  }

  /** Re-pull everything derived from the engine's current build. */
  async sync() {
    if (!this.autosaveTimer) {
      this.autosaveTimer = setInterval(() => this.autosave(), 120_000);
    }
    const [info, sidebar, tree, skills, specs] = await Promise.all([
      engine.getBuild(),
      engine.getSidebar(),
      engine.getTreeState(),
      engine.getSkills(),
      engine.listSpecs(),
    ]);
    this.info = info;
    this.sidebar = sidebar;
    this.tree = tree;
    this.skills = skills;
    this.specs = specs.specs;
    this.rev = info.rev;
    this.schedulePresync();
    if (this.classes.length === 0) {
      this.classes = (await engine.listClasses()).classes;
    }
    if (!this.meta) {
      const v = await engine.version();
      this.meta = { pobVersion: v.pobVersion, treeVersions: v.treeVersions, latestTreeVersion: v.latestTreeVersion };
    }
  }

  clearError() {
    this.error = null;
  }

  newBuild(name?: string) {
    return this.run(() => engine.newBuild(name)).then((r) => {
      if (r) this.view = "tree";
      return r;
    });
  }

  loadCode(code: string, name?: string) {
    return this.run(() => engine.loadBuildCode(code.trim(), name)).then((r) => {
      if (r) this.view = "tree";
      return r;
    });
  }

  loadXml(xml: string, name?: string) {
    return this.run(() => engine.loadBuildXml(xml, name)).then((r) => {
      if (r) this.view = "tree";
      return r;
    });
  }

  loadFile(path: string) {
    return this.run(() => engine.loadBuildFile(path)).then((r) => {
      if (r) this.view = "tree";
      return r;
    });
  }

  setLevel(level: number) {
    return this.run(() => engine.setLevel(level));
  }

  selectClass(classId?: number, ascendClassId?: number) {
    return this.run(() => engine.selectClass(classId, ascendClassId));
  }

  setMainSkill(index: number) {
    return this.run(() => engine.setMainSkill(index));
  }

  allocNode(id: number) {
    return this.run(() => engine.allocNode(id));
  }

  deallocNode(id: number) {
    return this.run(() => engine.deallocNode(id));
  }

  toggleNode(id: number) {
    const allocated = this.tree?.allocatedNodes.includes(id) ?? false;
    return allocated ? this.deallocNode(id) : this.allocNode(id);
  }

  /** PoB's click semantics; the result may ask the UI for a follow-up. */
  clickNode(id: number, opts?: { attribute?: number; confirm?: "reset" | "connect" }): Promise<TreeClickResult | undefined> {
    return this.run(() => engine.treeClick(id, opts));
  }

  switchAttribute(id: number, attribute: number) {
    return this.run(() => engine.switchAttribute(id, attribute));
  }

  selectSpec(index: number) {
    return this.run(() => engine.selectSpec(index));
  }
  createSpec(title?: string) {
    return this.run(() => engine.createSpec(title));
  }
  copySpec(index?: number, title?: string) {
    return this.run(() => engine.copySpec(index, title));
  }
  renameSpec(index: number, title: string) {
    return this.run(() => engine.renameSpec(index, title));
  }
  deleteSpec(index: number) {
    return this.run(() => engine.deleteSpec(index));
  }
  importTreeUrl(url: string) {
    return this.run(() => engine.importTreeUrl(url));
  }
  convertTree(all = false) {
    return this.run(() => engine.convertTree({ all }));
  }

  undo() {
    return this.run(() => engine.treeUndo());
  }

  redo() {
    return this.run(() => engine.treeRedo());
  }
}

export const build = new BuildStore();
