<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { writeText } from "@tauri-apps/plugin-clipboard-manager";
  import { engine, poolStatus, powerScanParallel, readTreeJson, type JewelRadius, type PowerStat, type TreePower } from "$lib/engine.svelte";
  import { build } from "$lib/state/build.svelte";
  import { parseTree, NodeIndex, type TreeModel, type TNode } from "$lib/tree/model";
  import { AssetStore } from "$lib/tree/assets";
  import PobText from "$lib/components/PobText.svelte";

  let canvas = $state<HTMLCanvasElement | null>(null);
  let wrap = $state<HTMLDivElement | null>(null);
  let model = $state<TreeModel | null>(null);
  let assets: AssetStore | null = null;
  let assetsMissing = $state(false);
  let index: NodeIndex | null = null;
  let loadError = $state<string | null>(null);
  let jewelRadii: JewelRadius[] = [];

  // camera: world -> screen
  let cx = 0;
  let cy = 0;
  let scale = 0.12;
  let w = $state(0);
  let h = $state(0);
  let dpr = 1;

  let hover = $state<TNode | null>(null);
  let hoverPath = $state<Set<number>>(new Set());
  let hoverDep = $state<Set<number>>(new Set());
  let hoverCost = $state<number | null>(null);
  let mouse = $state({ x: 0, y: 0 });
  let search = $state("");
  let matches = $state<Set<number>>(new Set());

  // follow-ups requested by the engine's click handler
  let attrMenu = $state<{ id: number; x: number; y: number } | null>(null);
  let classConfirm = $state<{ id: number; className: string; ascendClassName: string | null } | null>(null);
  let urlPanel = $state<"import" | "export" | null>(null);
  let urlDraft = $state("");
  let renaming = $state(false);
  let renameDraft = $state("");

  // node power heat map (PoB "Show Node Power")
  let powerOn = $state(false);
  let power = $state<TreePower | null>(null);
  let powerStat = $state<string | null>(null);
  let powerDepth = $state<number | null>(10);
  let powerStats = $state<PowerStat[]>([]);
  let powerBusy = $state(false);
  let powerProgress = $state(0);
  let powerNote = $state("");
  let showReport = $state(false);
  let powerKey = "";
  let powerRerun = false;

  const allocated = $derived(new Set(build.tree?.allocatedNodes ?? []));
  const overrides = $derived(build.tree?.overrides ?? {});
  const sockets = $derived(new Map((build.tree?.sockets ?? []).map((s) => [s.nodeId, s])));

  // spec compare overlay (green = allocate to match, red = remove to match)
  let compareIdx = $state(0);
  let compareAlloc = $state<Set<number> | null>(null);

  // shift-hover path tracing (PoB's trace mode)
  let shiftDown = $state(false);
  let trace = $state<number[]>([]);

  // nodes inside a socketed jewel's radius, fetched lazily per socket
  const socketRadius = new Map<number, Set<number>>();
  const currentAsc = $derived(build.info?.ascendClassName && build.info.ascendClassName !== "None" ? build.info.ascendClassName : null);
  const currentClass = $derived(build.info?.className ?? null);
  const activeSpec = $derived(build.specs.find((s) => s.active) ?? null);

  let dirty = true;
  let raf = 0;
  const invalidate = () => {
    dirty = true;
    if (!raf) raf = requestAnimationFrame(frame);
  };

  const palette = {
    bg: "#0b0b0c",
    edge: "#2a2a30",
    edgeAlloc: "#e6e6ea",
    edgePath: "#7f9dff",
    nodeFill: "#151518",
    nodeStroke: "#3b3b44",
    nodeAlloc: "#f2f2f4",
    search: "#e7b04e",
    bad: "#f06a6a",
  };
  function readPalette() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n: string, fb: string) => cs.getPropertyValue(n).trim() || fb;
    palette.bg = v("--bg-0", palette.bg);
    palette.edge = v("--line-2", palette.edge);
    palette.edgeAlloc = v("--fg-0", palette.edgeAlloc);
    palette.edgePath = v("--focus", palette.edgePath);
    palette.nodeFill = v("--bg-2", palette.nodeFill);
    palette.nodeStroke = v("--line-2", palette.nodeStroke);
    palette.nodeAlloc = v("--fg-0", palette.nodeAlloc);
    palette.search = v("--warn", palette.search);
    palette.bad = v("--bad", palette.bad);
  }

  // Connector art approximated as two-tone strokes (widths in tree units),
  // sampled from PoB's Character_orbit_*.png line art.
  const LINE = {
    Normal: { outer: "#141210", inner: "#3a3122", ow: 12, iw: 3.5 },
    Intermediate: { outer: "#2e2a24", inner: "#9b917c", ow: 13, iw: 5 },
    Active: { outer: "#5d4717", inner: "#d9b256", ow: 14, iw: 7 },
    CompareGain: { outer: "#173d24", inner: "#67d38a", ow: 13, iw: 6 },
    CompareLoss: { outer: "#4a1616", inner: "#f06a6a", ow: 13, iw: 6 },
    Depend: { outer: "#4a1616", inner: "#f06a6a", ow: 14, iw: 7 },
  } as const;
  type LineState = keyof typeof LINE;

  function toScreen(x: number, y: number): [number, number] {
    return [(x - cx) * scale + w / 2, (y - cy) * scale + h / 2];
  }
  function toWorld(sx: number, sy: number): [number, number] {
    return [(sx - w / 2) / scale + cx, (sy - h / 2) / scale + cy];
  }

  function nodeState(n: TNode): "alloc" | "path" | "unalloc" {
    if (allocated.has(n.id) || hover?.id === n.id) return "alloc";
    if (hoverPath.has(n.id)) return "path";
    return "unalloc";
  }

  /** PoB's heat-map colour: offence → red, defence → blue, both → green mix. */
  function powerColor(id: number): string | null {
    if (!power) return null;
    const pw = power.nodes[String(id)];
    if (!pw) return null;
    const curve = (v: number, max: number) => Math.min(1, Math.sqrt((Math.max(v, 0) / (max || 1)) * 1.5));
    let r = 0;
    let g = 0;
    let b = 0;
    if (power.stat) {
      r = curve(pw.s ?? 0, power.max.singleStat);
    } else {
      const dps = curve(pw.o ?? 0, power.max.offence);
      const def = curve(pw.d ?? 0, power.max.defence);
      const mix = (Math.max(dps - 0.5, 0) + Math.max(def - 0.5, 0)) / 2;
      r = dps;
      g = mix;
      b = def;
    }
    if (r + g + b < 0.05) return null;
    return `rgba(${(r * 255) | 0},${(g * 255) | 0},${(b * 255) | 0},0.9)`;
  }

  async function computePower() {
    if (powerBusy) {
      powerRerun = true;
      return;
    }
    powerBusy = true;
    powerProgress = 0;
    powerNote = "";
    try {
      let scored = false;
      try {
        // worker pool: one call, all cores; the sequential builder remains the fallback
        const st = await poolStatus();
        if (st.size > 0) {
          const r = await powerScanParallel(powerStat, powerDepth);
          power = r.result;
          powerNote = `${Math.round(r.elapsed_ms)} ms · ${Math.max(1, st.ready)} engines`;
          scored = true;
        }
      } catch (e) {
        console.warn("parallel power scan unavailable, using PowerBuilder", e);
      }
      if (!scored) {
        const t0 = performance.now();
        let r = await engine.treePowerStart(powerStat, powerDepth);
        while (!r.done) {
          r = await engine.treePowerStep(150);
          powerProgress = r.progress;
        }
        power = await engine.treePowerResult();
        powerNote = `${Math.round(performance.now() - t0)} ms · 1 engine`;
      }
      powerKey = `${powerStat}|${powerDepth}|${power!.rev}`;
    } catch (e) {
      build.error = String(e);
    } finally {
      powerBusy = false;
      invalidate();
      if (powerRerun) {
        powerRerun = false;
        computePower();
      }
    }
  }

  const reportRows = $derived.by(() => {
    if (!power || !model) return [];
    if (power.stat) {
      return power.report
        .filter((r) => !r.allocated && r.pathPower !== 0)
        .sort((a, b) => b.pathPower - a.pathPower)
        .slice(0, 60)
        .map((r) => ({ id: r.id, name: r.name, a: r.pathPowerStr, b: r.powerStr, dist: r.pathDist ?? 0 }));
    }
    const rows: { id: number; name: string; a: string; b: string; dist: number; score: number }[] = [];
    for (const [id, pw] of Object.entries(power.nodes)) {
      const n = model.nodes.get(Number(id));
      if (!n || allocated.has(n.id) || n.asc) continue;
      const dist = Math.max(pw.dist ?? 1, 1);
      const o = (pw.o ?? 0) * 100;
      const d = (pw.d ?? 0) * 100;
      if (o <= 0 && d <= 0) continue;
      rows.push({ id: n.id, name: n.name, a: `${(o / dist).toFixed(2)}%`, b: `${(d / dist).toFixed(2)}%`, dist, score: (o + d) / dist });
    }
    return rows.sort((x, y) => y.score - x.score).slice(0, 60);
  });

  function jumpTo(id: number) {
    const n = model?.nodes.get(id);
    if (!n) return;
    cx = n.x;
    cy = n.y;
    if (scale < 0.2) scale = 0.25;
    invalidate();
  }

  function edgeState(a: TNode, b: TNode): LineState {
    const aa = allocated.has(a.id);
    const ab = allocated.has(b.id);
    if (hoverDep.size && hoverDep.has(a.id) && hoverDep.has(b.id)) return "Depend";
    if (compareAlloc) {
      const ca = compareAlloc.has(a.id);
      const cb = compareAlloc.has(b.id);
      if (ca && cb && !(aa && ab)) return "CompareGain";
      if (aa && ab && !(ca && cb)) return "CompareLoss";
    }
    if (aa && ab) return "Active";
    if (hoverPath.size) {
      const q = (n: TNode) => n.id === hover?.id || hoverPath.has(n.id) || allocated.has(n.id);
      if (q(a) && q(b)) return "Intermediate";
    }
    return "Normal";
  }

  function iconFor(n: TNode): string {
    return overrides[String(n.id)]?.icon ?? n.icon;
  }

  function frameFor(n: TNode, st: "alloc" | "path" | "unalloc"): string | null {
    const ov = overrides[String(n.id)]?.overlay;
    return ov?.[st] ?? n.overlay?.[st] ?? null;
  }

  function frame() {
    raf = 0;
    if (!dirty || !canvas || !model) return;
    dirty = false;
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "medium";
    ctx.fillStyle = palette.bg;
    ctx.fillRect(0, 0, w, h);

    const A = assets;
    const margin = 4000 * scale;
    const minX = cx - (w / 2 + margin) / scale;
    const maxX = cx + (w / 2 + margin) / scale;
    const minY = cy - (h / 2 + margin) / scale;
    const maxY = cy + (h / 2 + margin) / scale;
    const inView = (x: number, y: number) => x >= minX && x <= maxX && y >= minY && y <= maxY;

    // --- background tile ---
    if (A) {
      const pat = A.pattern(ctx, "Background2");
      if (pat) {
        const r = A.rect("Background2")!;
        pat.setTransform(new DOMMatrix([100 / r.w, 0, 0, 100 / r.h, 0, 0]));
        ctx.fillStyle = pat;
        ctx.fillRect(0, 0, w, h);
      }
    }

    // --- class hub and ascendancy backgrounds ---
    if (A) {
      const cls = model.classes.find((c) => c.name === currentClass);
      if (cls && cls.bg) {
        const [bx, by] = toScreen(cls.bgX, cls.bgY);
        const ascBg = currentAsc ? cls.ascendancies.find((a) => a.name === currentAsc)?.bg : null;
        A.draw(ctx, ascBg ?? cls.bg, bx, by, cls.bgHalf * scale, cls.bgHalf * scale);
        const start = cls.startNode != null ? model.nodes.get(cls.startNode) : null;
        if (start) {
          const ang = Math.PI / 2 + Math.atan2(start.y - cls.bgY, start.x - cls.bgX);
          ctx.save();
          ctx.translate(bx, by);
          ctx.rotate(ang);
          A.draw(ctx, "BGTreeActive", 0, 0, cls.activeHalf * scale, cls.activeHalf * scale);
          ctx.restore();
        }
        A.draw(ctx, "BGTree", bx, by, cls.ringHalf * scale, cls.ringHalf * scale);
      }
      for (const c of model.classes) {
        for (const a of c.ascendancies) {
          if (!inView(a.x, a.y)) continue;
          const [ax, ay] = toScreen(a.x, a.y);
          ctx.globalAlpha = a.name === currentAsc ? 1 : 0.45;
          A.draw(ctx, a.bg, ax, ay, a.half * scale, a.half * scale);
        }
      }
      ctx.globalAlpha = 1;
    }

    // --- connectors, batched per state ---
    ctx.lineCap = "round";
    const buckets: Record<LineState, { edges: typeof model.edges; dim: boolean }[]> = {
      Normal: [],
      Intermediate: [],
      Active: [],
      CompareGain: [],
      CompareLoss: [],
      Depend: [],
    };
    const perState = new Map<string, typeof model.edges>();
    for (const e of model.edges) {
      const a = model.nodes.get(e.a)!;
      const b = model.nodes.get(e.b)!;
      if (!inView(a.x, a.y) && !inView(b.x, b.y)) continue;
      const st = edgeState(a, b);
      const dim = e.asc !== null && e.asc !== currentAsc;
      const key = `${st}:${dim ? 1 : 0}`;
      let list = perState.get(key);
      if (!list) perState.set(key, (list = []));
      list.push(e);
    }
    void buckets;
    const order: LineState[] = ["Normal", "Intermediate", "Active", "CompareGain", "CompareLoss", "Depend"];
    for (const st of order) {
      for (const dim of [true, false]) {
        const list = perState.get(`${st}:${dim ? 1 : 0}`);
        if (!list?.length) continue;
        const style = LINE[st];
        ctx.beginPath();
        for (const e of list) {
          const a = model.nodes.get(e.a)!;
          const b = model.nodes.get(e.b)!;
          if (e.arc) {
            const [acx, acy] = toScreen(e.arc.cx, e.arc.cy);
            const [ax, ay] = toScreen(a.x, a.y);
            ctx.moveTo(ax, ay);
            ctx.arc(acx, acy, e.arc.r * scale, e.arc.a1, e.arc.a2, e.arc.ccw);
          } else {
            const [ax, ay] = toScreen(a.x, a.y);
            const [bx, by] = toScreen(b.x, b.y);
            ctx.moveTo(ax, ay);
            ctx.lineTo(bx, by);
          }
        }
        ctx.globalAlpha = dim ? 0.45 : 1;
        ctx.strokeStyle = style.outer;
        ctx.lineWidth = Math.max(1.2, style.ow * scale);
        ctx.stroke();
        ctx.strokeStyle = style.inner;
        ctx.lineWidth = Math.max(0.6, style.iw * scale);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;

    // --- nodes ---
    const drawEffects = scale > 0.045;
    const drawIcons = scale > 0.03;
    const heat = powerOn && power !== null;
    const hoverJewel = hover?.kind === "socket" ? sockets.get(hover.id) : undefined;
    const hoverSocketSet = hoverJewel?.radiusIndex ? (socketRadius.get(hover!.id) ?? null) : null;
    const hoverSocketColor = hoverJewel?.radiusIndex ? pobColor(jewelRadii[hoverJewel.radiusIndex - 1]?.color ?? "") : palette.search;
    for (const n of model.nodes.values()) {
      if (n.hidden || n.kind === "classStart") continue;
      if (!inView(n.x, n.y)) continue;
      const [sx, sy] = toScreen(n.x, n.y);
      const isAlloc = allocated.has(n.id);
      const st = heat ? "alloc" : nodeState(n);
      const onPath = hoverPath.has(n.id);
      const dimAsc = n.asc !== null && n.asc !== currentAsc;

      if (!A) {
        drawFallback(ctx, n, sx, sy, isAlloc, onPath, hover?.id === n.id);
        continue;
      }
      // With art available, a not-yet-loaded sheet just leaves a gap for a
      // frame or two (the store repaints on load) instead of flashing wireframe.

      if (n.kind === "onlyImage") {
        if (drawEffects && n.effect) {
          ctx.globalAlpha = 0.15;
          A.draw(ctx, n.effect, sx, sy, n.size.base * scale, n.size.base * scale);
          ctx.globalAlpha = 1;
        }
        continue;
      }

      if (n.kind === "ascStart") {
        ctx.globalAlpha = n.asc === currentAsc ? 1 : 0.5;
        A.draw(ctx, "AscendancyMiddle", sx, sy, n.size.overlay * scale, n.size.overlay * scale);
        ctx.globalAlpha = 1;
        continue;
      }

      ctx.globalAlpha = dimAsc ? 0.6 : 1;

      if (drawEffects && n.effect && n.size.effect > 0 && !heat) {
        ctx.globalAlpha = (isAlloc || onPath ? 1 : 0.15) * (dimAsc ? 0.6 : 1);
        A.draw(ctx, n.effect, sx, sy, n.size.effect * scale, n.size.effect * scale);
        ctx.globalAlpha = dimAsc ? 0.6 : 1;
      }

      if (heat && !isAlloc) {
        const col = powerColor(n.id);
        if (col) {
          ctx.beginPath();
          ctx.arc(sx, sy, Math.max((n.size.overlay || n.size.base) * scale * 0.95, 2.5), 0, Math.PI * 2);
          ctx.fillStyle = col;
          ctx.fill();
        }
      }

      if (n.kind === "socket") {
        const frameName = frameFor(n, st);
        if (frameName) A.draw(ctx, frameName, sx, sy, n.size.base * scale, n.size.base * scale);
        const jewel = sockets.get(n.id);
        if (jewel && isAlloc) {
          const art = jewel.title && A.has(jewel.title) ? jewel.title : jewel.baseName;
          if (art) A.draw(ctx, art, sx, sy, n.size.overlay * scale, n.size.overlay * scale);
        }
      } else {
        if (drawIcons && n.size.base > 0) {
          const icon = iconFor(n);
          if (!isAlloc && !heat) ctx.globalAlpha *= 0.7;
          A.draw(ctx, icon, sx, sy, n.size.base * scale, n.size.base * scale, !isAlloc && !heat);
          ctx.globalAlpha = dimAsc ? 0.6 : 1;
        }
        const frameName = frameFor(n, st);
        if (frameName && n.size.overlay > 0) {
          const half = n.size.overlay * scale;
          A.draw(ctx, frameName, sx, sy, half, half);
        }
      }
      ctx.globalAlpha = 1;

      if (hoverDep.has(n.id) && hover?.id !== n.id) {
        ctx.beginPath();
        ctx.arc(sx, sy, Math.max(n.r * scale, 3), 0, Math.PI * 2);
        ctx.fillStyle = "rgba(240,106,106,0.35)";
        ctx.fill();
      }
      if (matches.has(n.id)) {
        ctx.beginPath();
        ctx.arc(sx, sy, Math.max(n.r, 30) * scale + 6, 0, Math.PI * 2);
        ctx.strokeStyle = palette.search;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      if (compareAlloc) {
        const ca = compareAlloc.has(n.id);
        if (ca !== isAlloc) {
          ctx.beginPath();
          ctx.arc(sx, sy, Math.max(n.r, 30) * scale + 4, 0, Math.PI * 2);
          ctx.strokeStyle = ca ? "#67d38a" : "#f06a6a";
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      }
      if (hoverSocketSet?.has(n.id)) {
        ctx.beginPath();
        ctx.arc(sx, sy, Math.max(n.r, 30) * scale + 5, 0, Math.PI * 2);
        ctx.strokeStyle = hoverSocketColor;
        ctx.lineWidth = 1.75;
        ctx.stroke();
      }
    }

    // --- jewel radius rings ---
    const ring = (x: number, y: number, rad: JewelRadius, color: string, alpha: number, width: number) => {
      ctx.beginPath();
      ctx.arc(x, y, rad.outer * scale, 0, Math.PI * 2);
      if (rad.inner) {
        ctx.moveTo(x + rad.inner * scale, y);
        ctx.arc(x, y, rad.inner * scale, 0, Math.PI * 2);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.globalAlpha = alpha;
      ctx.stroke();
      ctx.globalAlpha = 1;
    };
    if (jewelRadii.length) {
      // Allocated sockets with a jewel show their radius persistently (PoB's shaded rings).
      for (const [nodeId, j] of sockets) {
        if (!j.radiusIndex || !allocated.has(nodeId) || hover?.id === nodeId) continue;
        const n = model.nodes.get(nodeId);
        const rad = jewelRadii[j.radiusIndex - 1];
        if (!n || !rad || !inView(n.x, n.y)) continue;
        const [sx, sy] = toScreen(n.x, n.y);
        ring(sx, sy, rad, "#e6e6ea", 0.25, 1);
      }
      // Hovered socket: the socketed jewel's radius, or every radius when empty.
      if (hover?.kind === "socket") {
        const [sx, sy] = toScreen(hover.x, hover.y);
        const socketed = sockets.get(hover.id);
        const own = socketed?.radiusIndex ? jewelRadii[socketed.radiusIndex - 1] : null;
        if (own) {
          ring(sx, sy, own, pobColor(own.color), 0.9, 1.5);
        } else {
          const variable = socketed?.radiusLabel === "Variable";
          for (const r of jewelRadii) {
            if (variable ? r.inner === 0 : r.inner !== 0) continue;
            ring(sx, sy, r, pobColor(r.color), 0.8, 1.25);
          }
        }
      }
    }
  }

  function pobColor(code: string): string {
    const m = /\^x([0-9a-fA-F]{6})/.exec(code);
    return m ? `#${m[1]}` : palette.search;
  }

  function drawFallback(ctx: CanvasRenderingContext2D, n: TNode, sx: number, sy: number, isAlloc: boolean, onPath: boolean, isHover: boolean) {
    const r = Math.max((n.size.overlay || n.size.base || 30) * 0.5 * scale, 1.2);
    ctx.beginPath();
    if (n.kind === "keystone") {
      ctx.moveTo(sx, sy - r);
      ctx.lineTo(sx + r, sy);
      ctx.lineTo(sx, sy + r);
      ctx.lineTo(sx - r, sy);
      ctx.closePath();
    } else if (n.kind === "socket") {
      ctx.rect(sx - r * 0.8, sy - r * 0.8, r * 1.6, r * 1.6);
    } else {
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
    }
    ctx.fillStyle = isAlloc ? palette.nodeAlloc : onPath ? "#1d2436" : palette.nodeFill;
    ctx.fill();
    ctx.lineWidth = isHover ? 2 : 1;
    ctx.strokeStyle = isHover || onPath ? palette.edgePath : isAlloc ? "#ffffff" : palette.nodeStroke;
    ctx.stroke();
  }

  function resize() {
    if (!canvas || !wrap) return;
    dpr = window.devicePixelRatio || 1;
    w = wrap.clientWidth;
    h = wrap.clientHeight;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    invalidate();
  }

  function focusClass() {
    if (!model) return;
    const id = currentClass ? model.classStart.get(currentClass) : undefined;
    const n = id != null ? model.nodes.get(id) : undefined;
    if (n) {
      cx = n.x;
      cy = n.y;
      scale = 0.13;
    } else {
      fitAll();
    }
    invalidate();
  }

  /** Centre on the current ascendancy ring, where its nodes live, far from the class start. */
  function focusAscendancy() {
    if (!model || !currentAsc) return;
    const asc = model.classes.flatMap((c) => c.ascendancies).find((a) => a.name === currentAsc);
    if (!asc) return;
    cx = asc.x;
    cy = asc.y;
    scale = Math.min(1.2, (Math.min(w, h) / (asc.half * 2)) * 0.85);
    invalidate();
  }

  $effect(() => {
    if (!build.ascendancyFocus || !model || !w) return;
    build.ascendancyFocus = false;
    focusAscendancy();
  });

  function fitAll() {
    if (!model) return;
    const b = model.bounds;
    cx = (b.minX + b.maxX) / 2;
    cy = (b.minY + b.maxY) / 2;
    scale = Math.min(w / (b.maxX - b.minX), h / (b.maxY - b.minY)) * 0.95;
    invalidate();
  }

  // --- input ---
  let drag: { sx: number; sy: number; cx0: number; cy0: number; moved: boolean; button: number } | null = null;
  let hoverTimer = 0;

  function onWheel(e: WheelEvent) {
    e.preventDefault();
    const rect = canvas!.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const [wx, wy] = toWorld(sx, sy);
    const factor = Math.exp(-e.deltaY * 0.0015);
    scale = Math.min(1.2, Math.max(0.012, scale * factor));
    cx = wx - (sx - w / 2) / scale;
    cy = wy - (sy - h / 2) / scale;
    invalidate();
  }

  function onPointerDown(e: PointerEvent) {
    attrMenu = null;
    if (e.button !== 0 && e.button !== 1 && e.button !== 2) return;
    canvas!.setPointerCapture(e.pointerId);
    drag = { sx: e.clientX, sy: e.clientY, cx0: cx, cy0: cy, moved: false, button: e.button };
  }

  function setHover(n: TNode | null) {
    if (n?.id === hover?.id) return;
    hover = n;
    if (shiftDown) {
      // Trace mode: extend the custom path instead of previewing the shortest one.
      clearTimeout(hoverTimer);
      hoverDep = new Set();
      if (n) extendTrace(n);
      hoverPath = new Set(trace);
      hoverCost = trace.length || null;
      invalidate();
      return;
    }
    hoverPath = new Set();
    hoverDep = new Set();
    hoverCost = null;
    clearTimeout(hoverTimer);
    if (n?.kind === "socket") {
      const j = sockets.get(n.id);
      if (j?.radiusIndex && !socketRadius.has(n.id)) {
        engine
          .socketNodes(n.id, j.radiusIndex)
          .then((r) => {
            socketRadius.set(n.id, new Set(r.nodes));
            invalidate();
          })
          .catch(() => {});
      }
    }
    if (n) {
      hoverTimer = window.setTimeout(async () => {
        try {
          const r = await engine.nodeHover(n.id);
          if (hover?.id === n.id) {
            hoverPath = new Set(r.path);
            hoverDep = new Set(r.depends);
            hoverCost = r.cost ?? null;
            invalidate();
          }
        } catch {
          /* unreachable node */
        }
      }, 30);
    }
    invalidate();
  }

  function onPointerMove(e: PointerEvent) {
    const rect = canvas!.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    mouse = { x: sx, y: sy };
    if (drag) {
      const dx = e.clientX - drag.sx;
      const dy = e.clientY - drag.sy;
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
      if (drag.moved) {
        cx = drag.cx0 - dx / scale;
        cy = drag.cy0 - dy / scale;
        invalidate();
      }
      return;
    }
    if (!index) return;
    const [wx, wy] = toWorld(sx, sy);
    setHover(index.nearest(wx, wy));
  }

  async function extendTrace(n: TNode) {
    if (!model || allocated.has(n.id)) return;
    if (trace.length === 0) {
      try {
        const r = await engine.nodeHover(n.id);
        if (shiftDown && hover?.id === n.id && r.path.length) {
          // node.path runs target → tree; the trace runs tree → target
          trace = r.path.slice().reverse();
          hoverPath = new Set(trace);
          hoverCost = trace.length;
          invalidate();
        }
      } catch {
        /* unreachable node */
      }
      return;
    }
    const last = trace[trace.length - 1];
    if (n.id === last) return;
    const idx = trace.indexOf(n.id);
    if (idx >= 0) {
      trace = trace.slice(0, idx + 1);
    } else if (model.nodes.get(last)?.links.includes(n.id)) {
      trace = [...trace, n.id];
    } else {
      return;
    }
    hoverPath = new Set(trace);
    hoverCost = trace.length;
    invalidate();
  }

  async function onPointerUp(e: PointerEvent) {
    if (!drag) return;
    const wasClick = !drag.moved;
    const button = drag.button;
    drag = null;
    if (!wasClick || !hover || build.busy > 0) return;
    const n = hover;
    if (button === 0 && shiftDown && trace.length) {
      const ids = trace;
      trace = [];
      hoverPath = new Set();
      await build.run(() => engine.allocTrace(ids));
      return;
    }
    if (button === 2) {
      if (n.isAttribute) attrMenu = { id: n.id, x: mouse.x, y: mouse.y };
      return;
    }
    if (button !== 0) return;
    hoverPath = new Set();
    hoverDep = new Set();
    const r = await build.clickNode(n.id);
    if (r?.needsAttribute) attrMenu = { id: n.id, x: mouse.x, y: mouse.y };
    else if (r?.needsConfirm === "class_change") classConfirm = { id: n.id, className: r.className ?? "?", ascendClassName: r.ascendClassName ?? null };
  }

  async function pickAttribute(attr: number) {
    if (!attrMenu) return;
    const id = attrMenu.id;
    attrMenu = null;
    if (allocated.has(id)) await build.switchAttribute(id, attr);
    else await build.clickNode(id, { attribute: attr });
  }

  async function confirmClass(mode: "reset" | "connect") {
    if (!classConfirm) return;
    const id = classConfirm.id;
    classConfirm = null;
    await build.clickNode(id, { confirm: mode });
  }

  function onLeave() {
    setHover(null);
  }

  function zoomBy(factor: number) {
    scale = Math.min(1.2, Math.max(0.012, scale * factor));
    invalidate();
  }

  function onKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;
    if (e.key === "+" || e.key === "=" || e.key === "PageUp") zoomBy(e.shiftKey ? 2.2 : 1.3);
    else if (e.key === "-" || e.key === "PageDown") zoomBy(e.shiftKey ? 1 / 2.2 : 1 / 1.3);
    else if (e.key === "Home" || e.key === "h") focusClass();
    else if (e.key === "a") focusAscendancy();
    else if (e.key === "p") powerOn = !powerOn;
    else if (e.key === "r" && powerOn) showReport = !showReport;
    else if (e.key === "f" && !e.ctrlKey) fitAll();
    else if (e.key === "/" || (e.key === "f" && e.ctrlKey)) {
      e.preventDefault();
      (wrap?.querySelector(".search") as HTMLInputElement | null)?.focus();
    } else return;
    e.preventDefault();
  }

  async function exportUrl() {
    const r = await build.run(() => engine.exportTreeUrl(), { sync: false });
    if (r) {
      urlDraft = r.url;
      urlPanel = "export";
      await writeText(r.url).catch(() => {});
    }
  }
  async function importUrl() {
    if (!urlDraft.trim()) return;
    const r = await build.importTreeUrl(urlDraft.trim());
    if (r) urlPanel = null;
  }

  async function onSpecChange(e: Event) {
    await build.selectSpec(Number((e.target as HTMLSelectElement).value));
    focusClass();
  }
  async function commitRename() {
    renaming = false;
    if (activeSpec && renameDraft.trim() && renameDraft !== activeSpec.title) await build.renameSpec(activeSpec.index, renameDraft.trim());
  }

  $effect(() => {
    allocated;
    overrides;
    sockets;
    currentAsc;
    currentClass;
    compareAlloc;
    invalidate();
  });

  $effect(() => {
    // Fetch the compare spec's allocation; refetch after any build change.
    const idx = compareIdx;
    build.rev;
    const valid = idx > 0 && build.specs.some((s) => s.index === idx && !s.active);
    untrack(() => {
      if (!valid) {
        if (compareAlloc) {
          compareAlloc = null;
          invalidate();
        }
        return;
      }
      engine
        .specAlloc(idx)
        .then((r) => {
          if (compareIdx === idx) {
            compareAlloc = new Set(r.allocatedNodes);
            invalidate();
          }
        })
        .catch(() => {});
    });
  });

  $effect(() => {
    // Recompute node power when enabled and the build, stat or depth changed.
    // Only the inputs are tracked; computePower's own state writes must not
    // re-trigger this effect.
    const key = `${powerStat}|${powerDepth}|${build.rev}`;
    const on = powerOn;
    untrack(() => {
      if (!on) {
        invalidate();
        return;
      }
      if (key !== powerKey) queueMicrotask(computePower);
      else invalidate();
    });
  });

  $effect(() => {
    const q = search.trim().toLowerCase();
    if (!model || q.length < 2) {
      matches = new Set();
      invalidate();
      return;
    }
    const s = new Set<number>();
    for (const n of model.nodes.values()) {
      if (n.hidden || n.r <= 0) continue;
      if (n.name.toLowerCase().includes(q) || n.stats.some((t) => t.toLowerCase().includes(q))) s.add(n.id);
    }
    matches = s;
    invalidate();
  });

  let loadedVersion = "";
  $effect(() => {
    const v = build.tree?.treeVersion;
    if (!v || v === loadedVersion) return;
    loadedVersion = v;
    (async () => {
      try {
        const [json, store, radii, pstats] = await Promise.all([
          readTreeJson(v),
          AssetStore.load(v, invalidate),
          engine.jewelRadii().catch(() => ({ radii: [] as JewelRadius[] })),
          engine.powerStats().catch(() => ({ stats: [] as PowerStat[] })),
        ]);
        model = parseTree(v, json);
        index = new NodeIndex(model.nodes.values());
        assets = store;
        assetsMissing = !store;
        jewelRadii = radii.radii;
        powerStats = pstats.stats;
        if (store) {
          for (const n of ["Background2", "BGTree", "BGTreeActive", "AscendancyMiddle"]) store.prefetch(n);
        }
        loadError = null;
        resize();
        focusClass();
      } catch (e) {
        loadError = String(e);
      }
    })();
  });

  onMount(() => {
    readPalette();
    const ro = new ResizeObserver(resize);
    if (wrap) ro.observe(wrap);
    resize();
    window.addEventListener("keydown", onKey);
    const onShift = (e: KeyboardEvent) => {
      if (e.key !== "Shift") return;
      const down = e.type === "keydown";
      if (shiftDown !== down) {
        shiftDown = down;
        if (!down && trace.length) {
          trace = [];
          hoverPath = new Set();
          hoverCost = null;
          invalidate();
        }
      }
    };
    window.addEventListener("keydown", onShift);
    window.addEventListener("keyup", onShift);
    return () => {
      ro.disconnect();
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keydown", onShift);
      window.removeEventListener("keyup", onShift);
      if (raf) cancelAnimationFrame(raf);
    };
  });
</script>

<div class="tree" bind:this={wrap}>
  <canvas
    bind:this={canvas}
    onwheel={onWheel}
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
    onpointerleave={onLeave}
    oncontextmenu={(e) => e.preventDefault()}
  ></canvas>

  <div class="hud">
    <div class="hud-row">
      {#if renaming}
        <input
          class="input spec"
          bind:value={renameDraft}
          onblur={commitRename}
          onkeydown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") renaming = false;
          }}
        />
      {:else}
        <select class="select spec" value={activeSpec?.index ?? 1} onchange={onSpecChange} disabled={build.busy > 0} title="Passive tree (spec)">
          {#each build.specs as s}
            <option value={s.index}>{s.title} · {s.allocatedNodeCount}</option>
          {/each}
        </select>
      {/if}
      <button class="btn sm ghost" title="New tree" onclick={() => build.createSpec()}>New</button>
      <button class="btn sm ghost" title="Copy current tree" onclick={() => build.copySpec()}>Copy</button>
      <button
        class="btn sm ghost"
        title="Rename"
        onclick={() => {
          renameDraft = activeSpec?.title ?? "";
          renaming = true;
        }}>Rename</button
      >
      <button class="btn sm ghost" title="Delete current tree" disabled={build.specs.length <= 1} onclick={() => activeSpec && build.deleteSpec(activeSpec.index)}>Delete</button>
      <span class="vr"></span>
      <select
        class="select sm cmp"
        value={compareIdx}
        onchange={(e) => (compareIdx = Number((e.target as HTMLSelectElement).value))}
        disabled={build.specs.length <= 1}
        title="Overlay another tree: green = allocate to match it, red = remove to match it"
      >
        <option value={0}>Compare: off</option>
        {#each build.specs.filter((s) => !s.active) as s}
          <option value={s.index}>vs {s.title}</option>
        {/each}
      </select>
    </div>
    <div class="hud-row">
      <input class="input search" placeholder="Search nodes…" bind:value={search} />
      {#if matches.size}<span class="dim num">{matches.size}</span>{/if}
      <button class="btn sm ghost" onclick={focusClass} title="Center on class start (h)">Class</button>
      <button class="btn sm ghost" onclick={focusAscendancy} disabled={!currentAsc} title={currentAsc ? "Center on the ascendancy ring, where its 8 points are spent (a)" : "Pick an ascendancy in the sidebar first"}>Ascendancy</button>
      <button class="btn sm ghost" onclick={fitAll} title="Fit whole tree">Fit</button>
      <button class="btn sm ghost" onclick={() => build.undo()} title="Undo (Ctrl+Z)">Undo</button>
      <button class="btn sm ghost" onclick={() => build.redo()} title="Redo (Ctrl+Y)">Redo</button>
      <span class="vr"></span>
      <button class="btn sm ghost" onclick={() => { urlPanel = urlPanel === "import" ? null : "import"; urlDraft = ""; }} title="Import a pathofexile.com tree link">Import link</button>
      <button class="btn sm ghost" onclick={exportUrl} title="Copy a pathofexile.com tree link">Export link</button>
      <span class="vr"></span>
      <button class="btn sm" class:on={powerOn} onclick={() => (powerOn = !powerOn)} title="Show node power (p): estimated value of each unallocated node">
        Power
      </button>
    </div>
    {#if powerOn}
      <div class="hud-row">
        <select class="select sm" value={powerStat ?? ""} onchange={(e) => (powerStat = (e.target as HTMLSelectElement).value || null)} title="Stat to score nodes by">
          {#each powerStats as s}
            <option value={s.stat ?? ""}>{s.label}</option>
          {/each}
        </select>
        <select class="select sm depth" value={powerDepth ?? 0} onchange={(e) => { const v = Number((e.target as HTMLSelectElement).value); powerDepth = v || null; }} title="Max path length to score (lower = faster)">
          <option value={0}>All</option>
          <option value={5}>≤ 5</option>
          <option value={10}>≤ 10</option>
          <option value={15}>≤ 15</option>
        </select>
        <button class="btn sm ghost" class:on={showReport} onclick={() => (showReport = !showReport)}>Report</button>
        {#if powerBusy}
          <span class="dim num small">scoring…{powerProgress ? ` ${powerProgress}%` : ""}</span>
        {:else if powerNote}
          <span class="dim num small" title="Time to score every eligible node, and how many engines shared the work">{powerNote}</span>
        {:else if power}
          <span class="dim num small">{Object.keys(power.nodes).length} nodes · {(power.ms / 1000).toFixed(1)}s</span>
        {/if}
      </div>
    {/if}
    {#if urlPanel}
      <div class="hud-row">
        <input class="input url" bind:value={urlDraft} placeholder="https://www.pathofexile.com/passive-skill-tree/…" readonly={urlPanel === "export"} onkeydown={(e) => e.key === "Enter" && urlPanel === "import" && importUrl()} />
        {#if urlPanel === "import"}
          <button class="btn sm primary" onclick={importUrl} disabled={!urlDraft.trim()}>Import</button>
        {:else}
          <span class="dim small">Copied to clipboard</span>
        {/if}
        <button class="btn sm ghost" onclick={() => (urlPanel = null)}>Close</button>
      </div>
    {/if}
  </div>

  {#if assetsMissing}
    <div class="notice">Tree art not found: run <span class="mono">pnpm sync -- --tree-assets</span>. Showing wireframe.</div>
  {/if}

  {#if build.meta && build.tree && build.tree.treeVersion !== build.meta.latestTreeVersion}
    <div class="banner">
      <span>This tree uses passive tree version <b class="mono">{build.tree.treeVersion.replace("_", ".")}</b>; the current game version is <b class="mono">{build.meta.latestTreeVersion.replace("_", ".")}</b>. Converting keeps the old tree as a separate spec; passives that no longer exist are dropped.</span>
      <button class="btn sm primary" onclick={() => build.convertTree(false)}>Convert this tree</button>
      {#if build.specs.length > 1}
        <button class="btn sm" onclick={() => build.convertTree(true)}>Convert all</button>
      {/if}
    </div>
  {/if}

  {#if powerOn && showReport}
    <aside class="report">
      <div class="report-head">
        <span class="label">Power report</span>
        <span class="dim small">{power?.label ?? ""}</span>
      </div>
      <div class="report-cols label">
        <span>Node</span><span class="r">{power?.stat ? "per point" : "off/pt"}</span><span class="r">{power?.stat ? "node" : "def/pt"}</span><span class="r">pts</span>
      </div>
      <div class="report-list">
        {#each reportRows as r (r.id)}
          <button class="report-row" onclick={() => jumpTo(r.id)} onmouseenter={() => { const n = model?.nodes.get(r.id); if (n) setHover(n); }}>
            <span class="rn">{r.name}</span>
            <span class="r num"><PobText text={r.a} /></span>
            <span class="r num"><PobText text={r.b} /></span>
            <span class="r num dim">{r.dist}</span>
          </button>
        {/each}
        {#if reportRows.length === 0}
          <div class="dim small pad">{powerBusy ? "Scoring nodes…" : "No unallocated node improves this stat within the depth limit."}</div>
        {/if}
      </div>
    </aside>
  {/if}

  {#if loadError}
    <div class="overlay err">{loadError}</div>
  {:else if !model}
    <div class="overlay dim">Loading tree…</div>
  {/if}

  {#if attrMenu}
    <div class="menu" style:left={`${Math.min(attrMenu.x, w - 160)}px`} style:top={`${Math.min(attrMenu.y, h - 120)}px`}>
      <div class="label">Attribute</div>
      <button class="mi" onclick={() => pickAttribute(1)}><span style:color="var(--c-life)">Strength</span> <kbd>S</kbd></button>
      <button class="mi" onclick={() => pickAttribute(2)}><span style:color="var(--ok)">Dexterity</span> <kbd>D</kbd></button>
      <button class="mi" onclick={() => pickAttribute(3)}><span style:color="var(--c-mana)">Intelligence</span> <kbd>I</kbd></button>
    </div>
  {/if}

  {#if classConfirm}
    <div class="modal">
      <div class="panel dialog">
        <div class="label">Class change</div>
        <p>
          Switching to <b>{classConfirm.ascendClassName ?? classConfirm.className}</b> changes your class to <b>{classConfirm.className}</b>. Your tree is not
          connected to that class's start, so it would be reset.
        </p>
        <div class="actions">
          <button class="btn" onclick={() => confirmClass("connect")}>Connect a path instead</button>
          <button class="btn primary" onclick={() => confirmClass("reset")}>Reset tree and switch</button>
          <button class="btn ghost" onclick={() => (classConfirm = null)}>Cancel</button>
        </div>
      </div>
    </div>
  {/if}

  {#if hover && !attrMenu}
    {@const ov = overrides[String(hover.id)]}
    <div class="tip" style:left={`${Math.min(mouse.x + 18, w - 340)}px`} style:top={`${Math.min(mouse.y + 18, h - 60)}px`}>
      <div class="tip-head">
        <span class="tip-name" class:key={hover.kind === "keystone"} class:notable={hover.kind === "notable"}>{ov?.name ?? hover.name}</span>
        <span class="label">{hover.asc ?? hover.kind}</span>
      </div>
      {#each ov?.stats?.length ? ov.stats : hover.stats as s}
        <div class="tip-stat">{s}</div>
      {/each}
      {#if hover.flavour}
        <div class="tip-flav">{hover.flavour}</div>
      {/if}
      <div class="tip-foot num">
        {#if allocated.has(hover.id)}
          <span style:color="var(--ok)">allocated</span>
          <span class="dim">{hoverDep.size > 1 ? `click removes ${hoverDep.size}` : "click to remove"}{hover.isAttribute ? " · right-click to switch" : ""}</span>
        {:else if hoverCost != null}
          <span>{hoverCost} point{hoverCost === 1 ? "" : "s"}</span>
          <span class="dim">{shiftDown && trace.length ? "tracing · click to allocate path" : "click to allocate · hold Shift to trace"}</span>
        {:else}
          <span class="dim">…</span>
        {/if}
        <span class="dim">#{hover.id}</span>
      </div>
    </div>
  {/if}
</div>

<style>
  .tree {
    position: relative;
    flex: 1;
    min-height: 0;
    overflow: hidden;
    background: var(--bg-0);
  }
  canvas {
    display: block;
    cursor: crosshair;
    touch-action: none;
  }
  .hud {
    position: absolute;
    top: 10px;
    left: 10px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 4px;
    background: color-mix(in srgb, var(--bg-1) 88%, transparent);
    border: 1px solid var(--line-0);
    border-radius: var(--r-2);
    backdrop-filter: blur(6px);
  }
  .hud-row {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .search {
    width: 220px;
    height: 24px;
  }
  .spec {
    width: 220px;
    height: 24px;
    font-size: var(--fs-xs);
  }
  .url {
    width: 420px;
    height: 24px;
    font-family: var(--font-mono);
    font-size: var(--fs-2xs);
  }
  .vr {
    width: 1px;
    height: 16px;
    background: var(--line-1);
    margin: 0 2px;
  }
  .btn.on {
    color: var(--fg-0);
    border-color: var(--fg-2);
    background: var(--bg-active);
  }
  .select.sm {
    height: 22px;
    font-size: var(--fs-xs);
    width: 180px;
  }
  .select.sm.depth {
    width: 72px;
  }
  .select.sm.cmp {
    width: 150px;
  }
  .report {
    position: absolute;
    top: 10px;
    right: 10px;
    bottom: 10px;
    width: 360px;
    display: flex;
    flex-direction: column;
    background: color-mix(in srgb, var(--bg-1) 92%, transparent);
    border: 1px solid var(--line-0);
    border-radius: var(--r-2);
    backdrop-filter: blur(6px);
    overflow: hidden;
  }
  .report-head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    padding: 8px 10px 6px;
    border-bottom: 1px solid var(--line-0);
  }
  .report-cols,
  .report-row {
    display: grid;
    grid-template-columns: 1fr 72px 72px 34px;
    gap: 8px;
    padding: 4px 10px;
    align-items: baseline;
  }
  .report-cols {
    border-bottom: 1px solid var(--line-0);
  }
  .report-list {
    flex: 1;
    overflow-y: auto;
  }
  .report-row {
    appearance: none;
    width: 100%;
    border: 0;
    border-bottom: 1px solid var(--line-0);
    background: transparent;
    color: var(--fg-1);
    font-size: var(--fs-xs);
    text-align: left;
    cursor: pointer;
  }
  .report-row:hover {
    background: var(--bg-2);
    color: var(--fg-0);
  }
  .rn {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .r {
    text-align: right;
  }
  .pad {
    padding: 10px;
  }
  .small {
    font-size: var(--fs-xs);
  }
  .banner {
    position: absolute;
    left: 10px;
    right: 10px;
    bottom: 10px;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 12px;
    font-size: var(--fs-xs);
    color: var(--fg-1);
    background: color-mix(in srgb, var(--bg-1) 92%, transparent);
    border: 1px solid var(--line-1);
    border-left: 2px solid var(--warn);
    border-radius: var(--r-1);
    backdrop-filter: blur(6px);
  }
  .banner span {
    flex: 1;
  }
  .notice {
    position: absolute;
    left: 10px;
    bottom: 10px;
    padding: 6px 10px;
    font-size: var(--fs-xs);
    color: var(--warn);
    background: color-mix(in srgb, var(--bg-1) 90%, transparent);
    border: 1px solid var(--line-1);
    border-radius: var(--r-1);
  }
  .overlay {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    font-size: var(--fs-sm);
    pointer-events: none;
  }
  .overlay.err {
    color: var(--bad);
  }
  .menu {
    position: absolute;
    min-width: 150px;
    padding: 6px;
    background: var(--bg-1);
    border: 1px solid var(--line-1);
    border-radius: var(--r-2);
    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.5);
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .menu .label {
    padding: 2px 6px 6px;
  }
  .mi {
    appearance: none;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    padding: 5px 8px;
    border: 0;
    border-radius: var(--r-1);
    background: transparent;
    color: var(--fg-0);
    font-size: var(--fs-sm);
    cursor: pointer;
    text-align: left;
  }
  .mi:hover {
    background: var(--bg-hover);
  }
  .modal {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    background: rgba(0, 0, 0, 0.45);
  }
  .dialog {
    width: 440px;
    padding: 16px 18px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .dialog p {
    margin: 0;
    font-size: var(--fs-sm);
    color: var(--fg-1);
    line-height: 1.45;
  }
  .actions {
    display: flex;
    gap: 6px;
    justify-content: flex-end;
    flex-wrap: wrap;
  }
  .tip {
    position: absolute;
    width: 320px;
    padding: 10px 12px;
    background: color-mix(in srgb, var(--bg-1) 94%, transparent);
    border: 1px solid var(--line-1);
    border-radius: var(--r-2);
    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.5);
    pointer-events: none;
    backdrop-filter: blur(8px);
    font-size: var(--fs-sm);
  }
  .tip-head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 8px;
    margin-bottom: 6px;
  }
  .tip-name {
    font-weight: 600;
    color: var(--fg-0);
  }
  .tip-name.key {
    color: var(--c-rare);
  }
  .tip-name.notable {
    color: var(--c-currency);
  }
  .tip-stat {
    color: var(--c-magic);
    line-height: 1.35;
  }
  .tip-flav {
    margin-top: 6px;
    color: var(--c-unique);
    font-style: italic;
    font-size: var(--fs-xs);
  }
  .tip-foot {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    margin-top: 8px;
    padding-top: 6px;
    border-top: 1px solid var(--line-0);
    font-size: var(--fs-xs);
    color: var(--fg-1);
  }
</style>
