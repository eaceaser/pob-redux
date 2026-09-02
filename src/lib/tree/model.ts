/**
 * Passive tree geometry and art bindings from PoB's TreeData/<version>/tree.json,
 * mirroring PassiveTree.lua: node positions from group + orbit angle tables,
 * connector arcs from BuildConnector, art sizes from GetNodeTargetSize.
 */

export type NodeKind = "normal" | "notable" | "keystone" | "socket" | "classStart" | "ascStart" | "onlyImage";

export interface NodeOverlay {
  alloc: string;
  path: string;
  unalloc: string;
}

export interface AttributeOption {
  name: string;
  icon: string;
  stats: string[];
}

export interface TNode {
  id: number;
  name: string;
  stats: string[];
  x: number;
  y: number;
  kind: NodeKind;
  asc: string | null;
  classesStart: string[] | null;
  group: number;
  orbit: number;
  icon: string;
  links: number[];
  flavour: string | null;
  switchable: boolean;
  isAttribute: boolean;
  options: AttributeOption[] | null;
  overlay: NodeOverlay | null;
  effect: string | null;
  /** Half extents in tree units (PoB draws 2× these). */
  size: { base: number; overlay: number; effect: number };
  /** Hit radius; 0 = not hoverable. */
  r: number;
  hidden: boolean;
}

export interface Arc {
  cx: number;
  cy: number;
  r: number;
  a1: number;
  a2: number;
  ccw: boolean;
}

export interface TEdge {
  a: number;
  b: number;
  asc: string | null;
  arc: Arc | null;
}

export interface TAscendancy {
  name: string;
  id: string;
  bg: string;
  x: number;
  y: number;
  half: number;
}

export interface TClass {
  name: string;
  id: number;
  bg: string;
  bgX: number;
  bgY: number;
  bgHalf: number;
  activeHalf: number;
  ringHalf: number;
  ascendancies: TAscendancy[];
  startNode: number | null;
}

export interface TreeModel {
  version: string;
  nodes: Map<number, TNode>;
  edges: TEdge[];
  classes: TClass[];
  classStart: Map<string, number>;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

interface RawNode {
  skill: number;
  name: string;
  icon: string;
  stats: string[];
  group: number;
  orbit: number;
  orbitIndex: number;
  connections: { id: number; orbit: number }[];
  isNotable?: boolean;
  isKeystone?: boolean;
  isJewelSocket?: boolean;
  isOnlyImage?: boolean;
  isAttribute?: boolean;
  isAscendancyStart?: boolean;
  isSwitchable?: boolean;
  containJewelSocket?: boolean;
  ascendancyName?: string;
  classesStart?: string[];
  flavourText?: string;
  aliasPassiveSocket?: string;
  nodeOverlay?: NodeOverlay;
  activeEffectImage?: string;
  options?: unknown;
}

interface RawBackground {
  image: string;
  x: number;
  y: number;
  width: number;
  height: number;
  active?: { width: number; height: number };
  bg?: { width: number; height: number };
}

interface RawTree {
  nodes: Record<string, RawNode>;
  // sparse: unused group ids are null
  groups: ({ x: number; y: number; orbits: number[]; nodes: number[] } | null)[];
  constants: { orbitRadii: number[]; skillsPerOrbit: number[]; orbitAnglesByOrbit: number[][] };
  classes: {
    name: string;
    integerId: number;
    background?: RawBackground;
    ascendancies: { id: string; name: string; internalId: string; background?: RawBackground }[];
  }[];
  nodeOverlay: Record<string, NodeOverlay>;
  min_x: number;
  min_y: number;
  max_x: number;
  max_y: number;
}

function targetSize(rn: RawNode, kind: NodeKind): { base: number; overlay: number; effect: number } {
  if (rn.isAscendancyStart) return { base: 0, overlay: 50, effect: 0 };
  if (kind === "normal" && rn.ascendancyName) return { base: 37, overlay: 80, effect: 0 };
  if (rn.containJewelSocket) return { base: 80, overlay: 80, effect: 0 };
  if (rn.ascendancyName) return { base: 54, overlay: 100, effect: 0 };
  switch (kind) {
    case "notable":
      return { base: 54, overlay: 80, effect: 380 };
    case "onlyImage":
      return { base: 380, overlay: 0, effect: 0 };
    case "keystone":
      return { base: 82, overlay: 120, effect: 380 };
    case "normal":
      return { base: 37, overlay: 54, effect: 0 };
    case "socket":
      return { base: 76, overlay: 76, effect: 0 };
    case "classStart":
      return { base: 37, overlay: 1, effect: 0 };
    default:
      return { base: 0, overlay: 0, effect: 0 };
  }
}

function overlayType(kind: NodeKind): string | null {
  switch (kind) {
    case "normal":
      return "Normal";
    case "notable":
      return "Notable";
    case "keystone":
      return "Keystone";
    case "socket":
      return "Socket";
    default:
      return null;
  }
}

/** Shorter arc from a to b on the circle (cx, cy, r), in canvas terms. */
function minorArc(cx: number, cy: number, r: number, ax: number, ay: number, bx: number, by: number): Arc {
  const a1 = Math.atan2(ay - cy, ax - cx);
  const a2 = Math.atan2(by - cy, bx - cx);
  let d = a2 - a1;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return { cx, cy, r, a1, a2, ccw: d < 0 };
}

export function parseTree(version: string, json: string): TreeModel {
  const raw = JSON.parse(json) as RawTree;
  const { orbitRadii, orbitAnglesByOrbit } = raw.constants;

  // tree.json ships groups as a JSON array while PoB reads it as a 1-based
  // Lua table; detect which convention node.group follows.
  const groupsArr = raw.groups;
  let oneBased = 0;
  let zeroBased = 0;
  for (const n of Object.values(raw.nodes)) {
    if (groupsArr[n.group - 1]?.nodes?.includes(n.skill)) oneBased++;
    else if (groupsArr[n.group]?.nodes?.includes(n.skill)) zeroBased++;
    if (oneBased + zeroBased > 200) break;
  }
  const gidx = (g: number) => (oneBased >= zeroBased ? g - 1 : g);

  const nodes = new Map<number, TNode>();
  const classStart = new Map<string, number>();

  for (const rn of Object.values(raw.nodes)) {
    const g = groupsArr[gidx(rn.group)];
    if (!g) continue;
    const angle = orbitAnglesByOrbit[rn.orbit]?.[rn.orbitIndex] ?? 0;
    const r = orbitRadii[rn.orbit] ?? 0;
    const x = g.x + Math.sin(angle) * r;
    const y = g.y - Math.cos(angle) * r;

    let kind: NodeKind = "normal";
    if (rn.classesStart) kind = "classStart";
    else if (rn.isAscendancyStart) kind = "ascStart";
    else if (rn.isOnlyImage) kind = "onlyImage";
    else if (rn.isJewelSocket) kind = "socket";
    else if (rn.isKeystone) kind = "keystone";
    else if (rn.isNotable) kind = "notable";

    if (rn.classesStart) for (const c of rn.classesStart) classStart.set(c, rn.skill);

    const size = targetSize(rn, kind);
    const otype = overlayType(kind);
    const overlay = rn.nodeOverlay ?? (otype ? (raw.nodeOverlay[otype] ?? null) : null);

    let options: AttributeOption[] | null = null;
    if (rn.isAttribute && Array.isArray(rn.options)) {
      options = (rn.options as { name: string; icon: string; stats: string[] }[]).map((o) => ({
        name: o.name,
        icon: o.icon,
        stats: o.stats ?? [],
      }));
    }

    nodes.set(rn.skill, {
      id: rn.skill,
      name: rn.name,
      stats: rn.stats ?? [],
      x,
      y,
      kind,
      asc: rn.ascendancyName ?? null,
      classesStart: rn.classesStart ?? null,
      group: gidx(rn.group),
      orbit: rn.orbit,
      icon: rn.icon,
      links: [],
      flavour: rn.flavourText ?? null,
      switchable: rn.isSwitchable === true,
      isAttribute: rn.isAttribute === true,
      options,
      overlay,
      effect: rn.activeEffectImage ?? null,
      size,
      r: overlay ? size.overlay : 0,
      hidden: rn.aliasPassiveSocket !== undefined,
    });
  }

  const edges: TEdge[] = [];
  const seen = new Set<string>();
  for (const rn of Object.values(raw.nodes)) {
    const a = nodes.get(rn.skill);
    if (!a) continue;
    for (const c of rn.connections ?? []) {
      const b = nodes.get(c.id);
      if (!b || b.id === a.id) continue;
      if (a.kind === "onlyImage" || b.kind === "onlyImage") continue;
      a.links.push(b.id);
      b.links.push(a.id);
      if (a.asc !== b.asc) continue;
      if (a.classesStart || b.classesStart) continue;
      const key = a.id < b.id ? `${a.id}:${b.id}` : `${b.id}:${a.id}`;
      if (seen.has(key)) continue;
      seen.add(key);

      let arc: Arc | null = null;
      const orbitR = orbitRadii[Math.abs(c.orbit)];
      if (c.orbit !== 0 && orbitR) {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy);
        if (dist < orbitR * 2 && dist > 0) {
          const perp = Math.sqrt(orbitR * orbitR - (dist * dist) / 4) * (c.orbit > 0 ? 1 : -1);
          const cx = a.x + dx / 2 + perp * (dy / dist);
          const cy = a.y + dy / 2 - perp * (dx / dist);
          arc = minorArc(cx, cy, orbitR, a.x, a.y, b.x, b.y);
        }
      } else if (a.group === b.group && a.orbit === b.orbit && c.orbit === 0 && orbitRadii[a.orbit]) {
        const g = groupsArr[a.group]!;
        arc = minorArc(g.x, g.y, orbitRadii[a.orbit], a.x, a.y, b.x, b.y);
      }
      edges.push({ a: a.id, b: b.id, asc: a.asc, arc });
    }
  }

  const classes: TClass[] = raw.classes.map((c) => ({
    name: c.name,
    id: c.integerId,
    bg: c.background?.image ?? "",
    bgX: c.background?.x ?? 0,
    bgY: c.background?.y ?? 0,
    bgHalf: c.background?.width ?? 1500,
    activeHalf: c.background?.active?.width ?? 2000,
    ringHalf: c.background?.bg?.width ?? 2000,
    ascendancies: c.ascendancies
      .filter((a) => a.background)
      .map((a) => ({
        name: a.name,
        id: a.id,
        bg: a.background!.image,
        x: a.background!.x,
        y: a.background!.y,
        half: a.background!.width,
      })),
    startNode: classStart.get(c.name) ?? null,
  }));

  return {
    version,
    nodes,
    edges,
    classes,
    classStart,
    bounds: { minX: raw.min_x, minY: raw.min_y, maxX: raw.max_x, maxY: raw.max_y },
  };
}

/** Coarse spatial hash for hit testing. */
export class NodeIndex {
  private cell = 600;
  private buckets = new Map<string, TNode[]>();
  constructor(nodes: Iterable<TNode>) {
    for (const n of nodes) {
      if (n.r <= 0 || n.hidden) continue;
      const k = this.key(n.x, n.y);
      let b = this.buckets.get(k);
      if (!b) this.buckets.set(k, (b = []));
      b.push(n);
    }
  }
  private key(x: number, y: number) {
    return `${Math.floor(x / this.cell)}:${Math.floor(y / this.cell)}`;
  }
  nearest(x: number, y: number, filter?: (n: TNode) => boolean): TNode | null {
    const cx = Math.floor(x / this.cell);
    const cy = Math.floor(y / this.cell);
    let best: TNode | null = null;
    let bestD = Infinity;
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        const b = this.buckets.get(`${cx + i}:${cy + j}`);
        if (!b) continue;
        for (const n of b) {
          if (filter && !filter(n)) continue;
          const d = Math.hypot(n.x - x, n.y - y);
          if (d <= n.r && d < bestD) {
            bestD = d;
            best = n;
          }
        }
      }
    }
    return best;
  }
}
