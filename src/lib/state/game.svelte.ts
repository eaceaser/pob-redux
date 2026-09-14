import { invoke } from "@tauri-apps/api/core";
import { build } from "$lib/state/build.svelte";
import { app } from "$lib/state/app.svelte";
import { confirm } from "$lib/state/confirm.svelte";

export type Game = "poe1" | "poe2";

export interface GameStatus {
  game: Game;
  firstRun: boolean;
  available: Game[];
}

export const GAMES: Game[] = ["poe1", "poe2"];
export const GAME_LABEL: Record<Game, string> = { poe1: "Path of Exile 1", poe2: "Path of Exile 2" };
export const GAME_SHORT: Record<Game, string> = { poe1: "PoE1", poe2: "PoE2" };

/**
 * Which game the session is on. Each game runs its own Path of Building in
 * the engine, so a change reboots it and the app re-runs its boot sequence.
 * The choice is saved by the host; the first run asks.
 */
class GameStore {
  current = $state<Game>("poe2");
  firstRun = $state(false);
  available = $state<Game[]>(["poe2"]);
  switching = $state(false);
  error = $state<string | null>(null);

  get isPoe2() {
    return this.current === "poe2";
  }
  get isPoe1() {
    return this.current === "poe1";
  }
  has(g: Game) {
    return this.available.includes(g);
  }

  async init() {
    this.apply(await invoke<GameStatus>("game_status"));
  }

  private apply(s: GameStatus) {
    this.current = s.game;
    this.firstRun = s.firstRun;
    this.available = s.available;
  }

  /** Choose a game. A different game reboots the engine. Returns false if the user kept the current one. */
  async choose(g: Game): Promise<boolean> {
    if (g === this.current) {
      if (this.firstRun) this.apply(await invoke<GameStatus>("set_game", { game: g }));
      return true;
    }
    // On the first run nothing the user did is at stake: the app booted PoE2
    // and reopened its last snapshot on its own.
    if (build.info?.unsaved && !this.firstRun) {
      const ok = await confirm.ask({
        title: "Switch game",
        message: `The open build has unsaved changes. Switch to ${GAME_LABEL[g]} anyway?`,
        ok: "Switch",
        cancel: "Stay",
      });
      if (!ok) return false;
    }
    this.switching = true;
    this.error = null;
    try {
      this.apply(await invoke<GameStatus>("set_game", { game: g }));
      build.reset();
      await app.boot();
      return true;
    } catch (e) {
      this.error = String(e);
      return false;
    } finally {
      this.switching = false;
    }
  }
}

export const game = new GameStore();
