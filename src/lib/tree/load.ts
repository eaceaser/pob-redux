import { readTreeJson } from "$lib/engine.svelte";
import { AssetStore } from "./assets";
import { parseTree, type TreeModel } from "./model";

export interface LoadedTree {
  model: TreeModel;
  assets: AssetStore | null;
}

// The tree view unmounts on every tab switch; the last tree outlives it.
let last: { version: string; tree: Promise<LoadedTree> } | null = null;

export function loadTree(version: string): Promise<LoadedTree> {
  if (last?.version !== version) {
    const tree = Promise.all([readTreeJson(version), AssetStore.load(version)]).then(([json, assets]) => ({ model: parseTree(version, json), assets }));
    const entry = { version, tree };
    tree.catch(() => {
      if (last === entry) last = null;
    });
    last = entry;
  }
  return last.tree;
}
