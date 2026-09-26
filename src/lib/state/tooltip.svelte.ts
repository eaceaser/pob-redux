const DELAY = 450;
const WARM_MS = 400;

type Tipped = HTMLElement | SVGElement;

/**
 * Replaces the OS tooltip for every `title` attribute in the app. Every titled
 * element under the pointer has its title lifted off (the OS tooltip reads the
 * nearest one, so all of them must go) and put back when the pointer moves on,
 * so assistive tech still reads it.
 */
class TooltipStore {
  text = $state("");
  rect = $state<DOMRect | null>(null);
  open = $state(false);

  private el: Tipped | null = null;
  private lifted = new Map<Tipped, string>();
  /** Closed by a click, scroll or Escape: stays closed until the pointer moves to another element. */
  private quiet: Tipped | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private warmUntil = 0;
  // The owner may change a title mid-hover (a "Copied" state, say).
  private watcher = new MutationObserver((records) => this.relift(records));

  install(): () => void {
    const over = (e: PointerEvent) => {
      if (e.pointerType !== "touch") this.hover(e.target);
    };
    const out = (e: PointerEvent) => {
      if (!e.relatedTarget) this.release();
    };
    const focus = (e: FocusEvent) => this.focus(e.target);
    const blurred = (e: FocusEvent) => {
      if (this.el && e.target === this.el && !this.lifted.has(this.el)) this.close();
    };
    const dismiss = () => this.hide();
    const key = (e: KeyboardEvent) => e.key === "Escape" && dismiss();
    const gone = () => this.release();
    document.addEventListener("pointerover", over);
    document.addEventListener("pointerout", out);
    document.addEventListener("focusin", focus);
    document.addEventListener("focusout", blurred);
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("wheel", dismiss, { capture: true, passive: true });
    document.addEventListener("scroll", dismiss, true);
    document.addEventListener("keydown", key, true);
    window.addEventListener("blur", gone);
    return () => {
      this.release();
      document.removeEventListener("pointerover", over);
      document.removeEventListener("pointerout", out);
      document.removeEventListener("focusin", focus);
      document.removeEventListener("focusout", blurred);
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("wheel", dismiss, true);
      document.removeEventListener("scroll", dismiss, true);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", gone);
    };
  }

  /** Titled elements from `node` up to the root, innermost first. Dropdown options keep the native tooltip. */
  private chain(node: EventTarget | null): Tipped[] {
    const out: Tipped[] = [];
    for (let e = node instanceof Element ? node : null; e; e = e.parentElement) {
      if (e.tagName === "OPTION") return [];
      const title = this.lifted.get(e as Tipped) ?? e.getAttribute("title");
      if (title?.trim()) out.push(e as Tipped);
    }
    return out;
  }

  private relift(records: MutationRecord[]) {
    for (const r of records) {
      const el = r.target as Tipped;
      const next = el.getAttribute("title");
      if (next === null || !this.lifted.has(el)) continue;
      this.lifted.set(el, next);
      el.removeAttribute("title");
      if (el === this.el) this.text = next;
    }
  }

  /** Lift exactly `keep`, putting every other lifted title back. */
  private liftOnly(keep: Tipped[]) {
    this.relift(this.watcher.takeRecords());
    this.watcher.disconnect();
    const wanted = new Set(keep);
    for (const [el, title] of this.lifted) {
      if (wanted.has(el)) continue;
      if (el.getAttribute("title") === null) el.setAttribute("title", title);
      this.lifted.delete(el);
    }
    for (const el of keep) {
      if (this.lifted.has(el)) continue;
      this.lifted.set(el, el.getAttribute("title") ?? "");
      el.removeAttribute("title");
    }
    for (const el of this.lifted.keys()) this.watcher.observe(el, { attributes: true, attributeFilter: ["title"] });
  }

  private hover(node: EventTarget | null) {
    const chain = this.chain(node);
    this.liftOnly(chain);
    this.aim(chain[0] ?? null, chain[0] ? (this.lifted.get(chain[0]) ?? "") : "");
  }

  private focus(node: EventTarget | null) {
    if (this.lifted.size || !(node instanceof HTMLElement) || !node.matches(":focus-visible")) return;
    const title = node.getAttribute("title");
    if (title?.trim()) this.aim(node, title);
  }

  private aim(el: Tipped | null, text: string) {
    if (el === this.el) return;
    this.close();
    if (el !== this.quiet) this.quiet = null;
    this.el = el;
    this.text = text;
    if (!el || this.quiet) return;
    const show = () => {
      if (this.el !== el || !el.isConnected || !this.text.trim()) return;
      this.rect = el.getBoundingClientRect();
      this.open = true;
    };
    if (Date.now() < this.warmUntil) show();
    else this.timer = setTimeout(show, DELAY);
  }

  private close() {
    clearTimeout(this.timer);
    if (this.open) this.warmUntil = Date.now() + WARM_MS;
    this.open = false;
    this.el = null;
  }

  private hide() {
    clearTimeout(this.timer);
    this.open = false;
    this.warmUntil = 0;
    this.quiet = this.el;
  }

  private release() {
    this.liftOnly([]);
    this.close();
    this.quiet = null;
  }
}

export const tooltip = new TooltipStore();
