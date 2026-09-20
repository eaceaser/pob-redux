import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { paraglideVitePlugin } from "@inlang/paraglide-js";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [
    // Options live in project.inlang/paraglide.config.js.
    paraglideVitePlugin({ project: "./project.inlang" }),
    svelte(),
  ],
  resolve: {
    alias: { $lib: fileURLToPath(new URL("./src/lib", import.meta.url)) },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**", "**/crates/**", "**/target/**"] },
  },
  build: {
    // WebView2 on Windows, WebKitGTK on Linux: both are evergreen. The floor is
    // set by `color-mix(in oklab, ...)` and `oklch()`, which the themes rely on.
    target: ["es2022", "chrome111", "safari16.4"],
    outDir: "dist",
    sourcemap: false,
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
});
