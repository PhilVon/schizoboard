/** The OS preference stays live; no per-frame media-query allocations. */
let preference: MediaQueryList | undefined;
export function reducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  preference ??= window.matchMedia("(prefers-reduced-motion: reduce)");
  return preference.matches;
}
