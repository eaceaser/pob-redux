import {
  engine,
  poolPresync,
  poolTrim,
  EngineError,
  type BuildInfo,
  type ClassInfo,
  type Sidebar,
  type Skills,
  type SpecInfo,
  type TreeClickResult,
  type TreeState,
} from "$lib/engine.svelte";

const AUTOSAVE_KEY = "pob-redux:autosave";

export type ViewId = "tree" | "skills" | "items" | "calcs" | "config" | "notes" | "party" | "optimise" | "import";

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
  /** Set to ask the tree view to centre on the ascendancy ring; the view clears it. */
  ascendancyFocus = $state(false);
  /**
   * Mutations the user made in the app. The assistant's own writes arrive as
   * `mcp:changed` and pass `user: false`, so a Try experiment can tell whether
   * rolling back would also discard something the user did by hand.
   */
  userEdits = $state(0);

  get loaded() {
    return this.info !== null;
  }

  async run<T>(fn: () => Promise<T>, opts: { sync?: boolean; user?: boolean } = {}): Promise<T | undefined> {
    if (opts.user !== false) this.userEdits++;
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

  private autosaveTimer: ReturnType<typeof setTimeout> | undefined;
  private lastAutosave = "";
  private presyncTimer: ReturnType<typeof setTimeout> | undefined;
  private trimTimer: ReturnType<typeof setTimeout> | undefined;

  /** Keep the worker engines on the current build so parallel scans skip their sync. */
  private schedulePresync() {
    clearTimeout(this.presyncTimer);
    this.presyncTimer = setTimeout(() => {
      if (this.busy === 0) poolPresync().catch(() => {});
    }, 400);
    this.scheduleTrim();
  }

  /** A scan leaves every engine full of dead calc state; collect it once things go quiet. */
  private scheduleTrim() {
    clearTimeout(this.trimTimer);
    this.trimTimer = setTimeout(() => {
      if (this.busy === 0) poolTrim().catch(() => {});
    }, 6_000);
  }

  /**
   * Snapshot the build XML to localStorage a few seconds after the last change.
   * It is what the app reopens on the next start, so it has to be close to the
   * state the user last saw rather than minutes behind it.
   */
  private scheduleAutosave() {
    clearTimeout(this.autosaveTimer);
    this.autosaveTimer = setTimeout(() => void this.autosave(), 3_000);
  }

  private async autosave() {
    if (!this.info || this.busy > 0) {
      this.scheduleAutosave();
      return;
    }
    try {
      const { xml } = await engine.saveBuildXml();
      if (xml === this.lastAutosave) return;
      this.lastAutosave = xml;
      localStorage.setItem(
        AUTOSAVE_KEY,
        JSON.stringify({ name: this.info.name, file: this.info.file ?? null, at: Date.now(), xml }),
      );
    } catch {
      // engine busy or storage full; the next change retries
    }
  }

  /**
   * Reopen whatever was open when the app last ran, from the snapshot. A saved
   * build keeps its file so Save still writes there. Returns false when there
   * is nothing to reopen or the snapshot no longer loads.
   */
  async reopenLast(): Promise<boolean> {
    let saved: { name?: string; file?: string | null; xml?: string } | null = null;
    try {
      saved = JSON.parse(localStorage.getItem(AUTOSAVE_KEY) ?? "null");
    } catch {}
    if (!saved?.xml) return false;
    try {
      await engine.loadBuildXml(saved.xml, saved.name, saved.file ?? undefined);
      this.lastAutosave = saved.xml;
      await this.sync();
      return true;
    } catch (e) {
      console.warn("could not reopen the last build", e);
      return false;
    }
  }

  /** Re-pull everything derived from the engine's current build. */
  async sync() {
    this.scheduleAutosave();
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

  rename(name: string) {
    return this.run(() => engine.setBuildName(name));
  }

  selectClass(classId?: number, ascendClassId?: number) {
    return this.run(() => engine.selectClass(classId, ascendClassId));
  }

  /** Pick an ascendancy and show its ring, so the points can be spent right away. */
  async chooseAscendancy(ascendClassId: number) {
    await this.selectClass(undefined, ascendClassId);
    if (ascendClassId > 0) {
      this.view = "tree";
      this.ascendancyFocus = true;
    }
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
