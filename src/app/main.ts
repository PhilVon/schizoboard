/**
 * Entry point. Mounts the board and hands control to the frame loop.
 *
 * Right now there is no frame loop — this is the phase-0 scaffold (T-10). It
 * exists to prove the dev loop end to end: Vite serves it in a plain browser,
 * and the Tauri shell serves the same bundle with the IPC bridge attached.
 *
 * T-13 replaces the boot panel with `render/loop.ts`.
 */

import { host, isTauri } from "@/platform/env";

interface AppInfo {
  name: string;
  version: string;
  os: string;
  arch: string;
}

async function nativeInfo(): Promise<AppInfo | null> {
  if (!isTauri()) return null;
  // Direct import is deliberate and temporary: from T-15 onward every invoke()
  // in the codebase lives in platform/tauri.ts and nowhere else.
  const { invoke } = await import("@tauri-apps/api/core");
  return await invoke<AppInfo>("app_info");
}

function row(label: string, value: string): string {
  return `<dt>${label}</dt><dd>${value}</dd>`;
}

async function boot(): Promise<void> {
  const root = document.querySelector<HTMLDivElement>("#board-root");
  if (!root) throw new Error("#board-root missing from index.html");

  const rows = [row("host", host())];

  try {
    const info = await nativeInfo();
    if (info) {
      rows.push(row("shell", `${info.name} ${info.version}`));
      rows.push(row("platform", `${info.os} ${info.arch}`));
    } else {
      rows.push(row("shell", "none — mocks (T-15) will stand in"));
    }
  } catch (err) {
    rows.push(row("shell", `IPC failed: ${String(err)}`));
  }

  root.innerHTML = `
    <div class="boot">
      <h1>Schizoboard</h1>
      <dl>${rows.join("")}</dl>
    </div>
  `;
}

void boot();
