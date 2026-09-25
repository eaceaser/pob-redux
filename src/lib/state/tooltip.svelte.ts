const DELAY = 450;
const WARM_MS = 400;

function tipTarget(node: EventTarget | null): HTMLElement | SVGElement | null {
  if (!(node instanceof Element)) return null;
  const el = node.closest<HTMLElement | SVGElement>("[title]");
  if (!el || el.tagName === "OPTION" || !el.getAttribute("title")?.trim()) return null;
  return el;
}

/**
 * Replaces the OS tooltip for every `title` attribute in the app. While the
 * pointer is over an element its title is lifted off (which is what stops the
 * native tooltip) and put back on leave, so assistive tech still reads it.
 */
class TooltipStore {
  text = $state("");
  rect = $state<DOMRect | null>(null);
  open = $state(false);

  private el: HTMLElement | SVGElement | null = null;
  private lifted = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private warmUntil = 0;
  private watcher: MutationObserver | null = null;

  install(): () => void {
    const over = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      const el = tipTarget(e.target);
      if (el === this.el) return;
      this.leave();
      if (el) this.enter(el, true);
    };
    const focus = (e: FocusEvent) => {
      const el = tipTarget(e.target);
      if (!el || !(el as HTMLElement).matches(":focus-visible")) return;
      this.leave();
      this.enter(el, false);
    };
    const out = (e: PointerEvent) => {
      if (!e.relatedTarget) this.leave();
    };
    const dismiss = () => this.hide();
    const blurred = () => this.leave();
    const key = (e: KeyboardEvent) => e.key === "Escape" && dismiss();
    document.addEventListener("pointerover", over);
    document.addEventListener("pointerout", out);
    document.addEventListener("focusin", focus);
    document.addEventListener("focusout", blurred);
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("wheel", dismiss, { capture: true, passive: true });
    document.addEventListener("scroll", dismiss, true);
    document.addEventListener("keydown", key, true);
    window.addEventListener("blur", blurred);
    return () => {
      this.leave();
      document.removeEventListener("pointerover", over);
      document.removeEventListener("pointerout", out);
      document.removeEventListener("focusin", focus);
      document.removeEventListener("focusout", blurred);
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("wheel", dismiss, true);
      document.removeEventListener("scroll", dismiss, true);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", blurred);
    };
  }

  private enter(el: HTMLElement | SVGElement, lift: boolean) {
    this.el = el;
    this.text = el.getAttribute("title") ?? "";
    if (lift) {
      el.removeAttribute("title");
      this.lifted = true;
      // The owner may change the title mid-hover (a "Copied" state, say).
      this.watcher = new MutationObserver(() => {
        const next = el.getAttribute("title");
        if (next === null) return;
        this.text = next;
        el.removeAttribute("title");
      });
      this.watcher.observe(el, { attributes: true, attributeFilter: ["title"] });
    }
    clearTimeout(this.timer);
    const show = () => {
      if (this.el !== el || !el.isConnected || !this.text.trim()) return;
      this.rect = el.getBoundingClientRect();
      this.open = true;
    };
    if (Date.now() < this.warmUntil) show();
    else this.timer = setTimeout(show, DELAY);
  }

  /** Close without lifting the element's title back, so neither tooltip returns until the pointer moves on. */
  private hide() {
    clearTimeout(this.timer);
    this.open = false;
    this.warmUntil = 0;
  }

  private leave() {
    clearTimeout(this.timer);
    this.watcher?.disconnect();
    this.watcher = null;
    if (this.el && this.lifted && this.el.getAttribute("title") === null) this.el.setAttribute("title", this.text);
    if (this.open) this.warmUntil = Date.now() + WARM_MS;
    this.el = null;
    this.lifted = false;
    this.open = false;
  }
}

export const tooltip = new TooltipStore();
