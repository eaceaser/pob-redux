import { defineConfig } from "@inlang/paraglide-js";

// Read by both the Vite plugin and `paraglide-js compile`. Paths resolve against the repository root, not this file.
export default defineConfig({
  outdir: "./src/lib/paraglide",
  // The locale store overwrites getLocale(), so this chain only seeds the first run.
  strategy: ["localStorage", "preferredLanguage", "baseLocale"],
  localStorageKey: "pob-redux:locale",
  emitTsDeclarations: true,
  isServer: "false",
});
