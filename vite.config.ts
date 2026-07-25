import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";

// Set by `tauri dev --host` for mobile / LAN testing.
const host = process.env["TAURI_DEV_HOST"];

// https://vite.dev/config/
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },

  // Don't let Vite wipe the screen — it hides Rust compiler errors.
  clearScreen: false,

  server: {
    // Tauri expects a fixed port and should fail loudly if it is taken.
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: {
      ignored: ["**/src-tauri/**", "**/.kanban/**"],
    },
  },

  build: {
    // Tauri v2 desktop webviews: WebView2 / WKWebView / WebKitGTK.
    target: "es2022",
    sourcemap: true,
  },
});
