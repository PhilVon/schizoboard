/**
 * Which shell are we in?
 *
 * The frontend must run in a plain browser against mocks as well as inside the
 * Tauri webview — see docs/ARCHITECTURE.md section 2.2. Every *call* into the
 * native side goes through `platform/tauri.ts` (T-15); this module only answers
 * the question that module branches on.
 */

export type Host = "tauri" | "browser";

declare global {
  interface Window {
    // Present only when the Tauri webview has injected its IPC bridge.
    __TAURI_INTERNALS__?: unknown;
  }
}

export function host(): Host {
  return typeof window !== "undefined" && window.__TAURI_INTERNALS__ !== undefined
    ? "tauri"
    : "browser";
}

export function isTauri(): boolean {
  return host() === "tauri";
}
