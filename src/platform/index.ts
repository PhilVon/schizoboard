/**
 * The one way to reach the native side.
 *
 * Nothing outside `platform/` should import `platform/tauri.ts` or
 * `platform/mock.ts` directly — call `platform()` and let it pick. That is
 * what makes "does this work in the browser?" a question with one answer
 * rather than a search.
 */

import { isTauri } from "@/platform/env";
import type { Platform } from "@/platform/types";

let instance: Platform | null = null;

export function platform(): Platform {
  if (instance) return instance;
  throw new Error("platform() called before initPlatform()");
}

/**
 * Chooses an implementation and loads only that one. The dynamic imports are
 * not ceremony: they keep `@tauri-apps/api` out of a browser bundle and keep
 * the mock out of the shipped app.
 */
export async function initPlatform(): Promise<Platform> {
  if (instance) return instance;
  if (isTauri()) {
    const { TauriPlatform } = await import("@/platform/tauri");
    // Awaited rather than constructed, because the shell has to be asked what
    // it is before the first right-click — see `TauriPlatform.create`.
    instance = await TauriPlatform.create();
  } else {
    const { MockPlatform } = await import("@/platform/mock");
    instance = new MockPlatform();
  }
  return instance;
}

/** Tests only. */
export function setPlatform(next: Platform | null): void {
  instance = next;
}

export * from "@/platform/types";
export { host, isTauri, type Host } from "@/platform/env";
