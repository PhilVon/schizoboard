// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Cork, corkPanPadding, pinholesFor, type Pinhole } from "@/render/cork";
import { Camera } from "@/state/camera";

beforeEach(() => {
  // Geometry tests isolate tile generation; native pixel checks cover the bitmaps.
  const raster = Cork.prototype as unknown as { bakeSprites(): void; generate(): void };
  vi.spyOn(raster, 'bakeSprites').mockImplementation(() => {});
  vi.spyOn(raster, 'generate').mockImplementation(() => {});
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => callback(null));
});
afterEach(() => vi.restoreAllMocks());

function fixture() {
  const host = document.createElement("div");
  const cork = new Cork(host, 12);
  const camera = new Camera();
  camera.resize(1600, 1000);
  camera.setView(-800, -500, 1);
  const grain = host.querySelector<HTMLElement>(".cork-grain")!;
  return { host, cork, camera, grain };
}

describe("cork pan buffer", () => {
  it("keeps world alignment during a fractional pan and rebases before exposing an edge", () => {
    const { cork, camera, grain } = fixture();
    cork.apply(camera);
    expect(grain.style.backgroundPosition).toBe("928px 628px");
    camera.setView(-723.375, -487.625, 1);
    cork.apply(camera);
    expect(grain.style.backgroundPosition).toBe("928px 628px");
    expect(grain.style.transform).toBe("translate(-76.625px, -12.375px)");
    camera.setView(-500, -500, 1);
    cork.apply(camera);
    expect(grain.style.backgroundPosition).toBe("628px 628px");
    expect(grain.style.transform).toBe("translate(0px, 0px)");
    cork.destroy();
  });

  it("releases overscan and promotion after idle without changing the surface origin", () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(100);
    const { cork, camera, grain } = fixture();
    cork.apply(camera);
    now.mockReturnValue(219);
    cork.apply(camera);
    expect(grain.style.inset).toBe("-128px");
    now.mockReturnValue(220);
    cork.apply(camera);
    expect(grain.style.inset).toBe("");
    expect(grain.style.transform).toBe("");
    expect(grain.style.willChange).toBe("");
    expect(grain.style.backgroundPosition).toBe("800px 500px");
    cork.destroy();
  });

  it("refreshes exact zoom and falls back when resize exceeds the surface budget", () => {
    const { cork, camera, grain, host } = fixture();
    cork.apply(camera);
    camera.setView(-400, -250, 2);
    cork.apply(camera);
    expect(grain.style.backgroundSize).toBe("1024px 1024px");
    expect(grain.style.inset).toBe("");
    expect(grain.style.willChange).toBe("");
    camera.resize(10000, 10000);
    cork.apply(camera);
    expect(grain.style.inset).toBe("");
    expect(grain.style.transform).toBe("");
    expect(grain.style.willChange).toBe("");
    expect(grain.style.backgroundPosition).toBe("800px 500px");
    cork.destroy();
    expect(host.children.length).toBe(0);
  });

  it("bounds the estimated three RGBA surfaces and rejects invalid dimensions", () => {
    expect(corkPanPadding(1600, 1000, 1)).toBe(128);
    expect(corkPanPadding(1600, 1000, 2)).toBe(128);
    expect(corkPanPadding(3840, 2160, 2)).toBe(0);
    expect(corkPanPadding(0, 1000, 1)).toBe(0);
    expect(corkPanPadding(1600, 1000, Infinity)).toBe(0);
  });
});



describe("cork pinhole pattern reuse", () => {
  it("reuses exact deterministic geometry and bounds retained pins", () => {
    const { cork } = fixture();
    const cache = cork as unknown as { holesFor(id: string): readonly Pinhole[]; holePatterns: Map<string, readonly Pinhole[]> };
    const first = cache.holesFor("pin-a");
    expect(first).toEqual(pinholesFor(12, "pin-a"));
    expect(cache.holesFor("pin-a")).toBe(first);
    for (let i = 0; i < 1024; i++) cache.holesFor(`pin-${i}`);
    expect(cache.holePatterns.size).toBe(1024);
    expect(cache.holePatterns.has("pin-a")).toBe(false);
    expect(cache.holesFor("pin-a")).toEqual(first);
    cork.destroy();
    expect(cache.holePatterns.size).toBe(0);
  });
});
