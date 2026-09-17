import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./app.css";
import { mount } from "svelte";
import { invoke } from "@tauri-apps/api/core";
import App from "./App.svelte";

// Uncaught page errors go to the app log, so a diagnostics report carries them.
const logError = (message: string) => void invoke("log_frontend", { level: "error", message }).catch(() => {});
window.addEventListener("error", (e) => logError(`${e.message} (${e.filename}:${e.lineno}:${e.colno})`));
window.addEventListener("unhandledrejection", (e) => {
  const r = e.reason;
  logError(`unhandled rejection: ${r instanceof Error ? (r.stack ?? r.message) : String(r)}`);
});

const app = mount(App, { target: document.getElementById("app")! });

export default app;
