import { ITEM_BLEED } from "@/render/items/raster";
import { PhotoSnapshots } from "@/render/items/photoSnapshots";

export interface CardEntry {
  id: string;
  el: HTMLElement;
  rank: number;
  x: number;
  y: number;
  rot: number;
  w: number;
  h: number;
  identity: object;
  stamp: string;
  eligible: boolean;
}
export interface CardCamera { x: number; y: number; zoom: number; width: number; height: number }
interface Cached {
  identity: object;
  stamp: string;
  scale: number;
  bytes: number;
  image: HTMLCanvasElement | null;
  failed: boolean;
}
const LIMIT = 128 * 1024 * 1024;
const MIN_RUN = 16;
const MAX_BATCHES = 4;

/** A bounded, disposable presentation cache. The item DOM remains the source of truth. */
export class CardBatches {
  private readonly cache = new Map<string, Cached>();
  private readonly canvases: HTMLCanvasElement[] = [];
  private hidden = new Set<HTMLElement>();
  private readonly admitted = new Set<string>();
  private bytes = 0;
  private active = 0;
  private lastZoom: number | null = null;
  private rising = false;
  private changed = false;
  private destroyed = false;
  private readonly snapshots = new PhotoSnapshots();

  private readonly assetChanged = (): void => { this.changed = true; };

  constructor(private readonly host: HTMLElement, private readonly snapshot: (entry: CardEntry, scale: number) => Promise<HTMLCanvasElement | null> = (entry, scale) => this.capture(entry, scale)) {
    host.addEventListener("load", this.assetChanged, true);
    host.addEventListener("error", this.assetChanged, true);
    host.addEventListener("animationend", this.assetChanged, true);
  }

  get pending(): boolean { return this.changed || this.active > 0; }

  private capture(entry: CardEntry, scale: number): Promise<HTMLCanvasElement | null> {
    return this.snapshots.capture(entry, scale);
  }

  private discard(id: string): void {
    const cached = this.cache.get(id);
    if (!cached) return;
    this.bytes -= cached.bytes;
    this.cache.delete(id);
    if (cached.image) { cached.image.width = 0; cached.image.height = 0; }
  }

  /** Exports and detailed views always use the original elements. */
  reveal(): void {
    for (const el of this.hidden) el.classList.remove("is-card-cached");
    this.hidden.clear();
    this.admitted.clear();
    for (const canvas of this.canvases) { canvas.style.display = "none"; if (canvas.width) canvas.width = 0; if (canvas.height) canvas.height = 0; }
    this.changed = false;
  }

  sync(entries: CardEntry[], camera: CardCamera, enabled: boolean, dpr: number, moving = false): void {
    if (this.lastZoom !== null && camera.zoom !== this.lastZoom) this.rising = camera.zoom > this.lastZoom;
    this.lastZoom = camera.zoom;
    this.changed = false;
    if (!enabled || entries.length < MIN_RUN) { this.reveal(); return; }
    const canvasBytes = Math.ceil(camera.width * dpr) * Math.ceil(camera.height * dpr) * 4;
    const maxBatches = Math.min(MAX_BATCHES, Math.floor(64 * 1024 * 1024 / canvasBytes));
    if (maxBatches < 1) { this.reveal(); return; }
    entries.sort((a, b) => a.rank - b.rank);
    const scale = 0.5 * dpr;
    const visible = new Set(entries.map(e => e.id));
    for (const id of this.admitted) if (!visible.has(id)) this.admitted.delete(id);
    let preparations = 8;
    for (const entry of entries) {
      let cached = this.cache.get(entry.id);
      if (cached && (cached.identity !== entry.identity || cached.stamp !== entry.stamp || cached.scale !== scale)) {
        this.discard(entry.id);
        cached = undefined;
      }
      if (!entry.eligible || cached || this.active >= 16 || preparations === 0) continue;
      if (moving && this.rising) { this.changed = true; continue; }
      const bytes = Math.ceil((entry.w + 2 * ITEM_BLEED) * scale) * Math.ceil((entry.h + 2 * ITEM_BLEED) * scale) * 4;
      // Oversized items and a full cache retain the ordinary renderer.
      if (bytes > 8 * 1024 * 1024) continue;
      if (this.bytes + bytes > LIMIT) {
        for (const id of this.cache.keys()) {
          if (!visible.has(id)) this.discard(id);
          if (this.bytes + bytes <= LIMIT) break;
        }
      }
      if (this.bytes + bytes > LIMIT) continue;
      const token: Cached = { identity: entry.identity, stamp: entry.stamp, scale, bytes, image: null, failed: false };
      this.cache.set(entry.id, token);
      this.bytes += bytes;
      this.active++;
      preparations--;
      void this.snapshot(entry, scale).then(image => {
        if (this.destroyed || this.cache.get(entry.id) !== token) {
          if (image) { image.width = 0; image.height = 0; }
          return;
        }
        token.image = image;
        token.failed = image === null;
      }).catch(() => { token.failed = true; }).finally(() => { this.active--; this.changed = true; });
    }

    // A DOM object between two cached objects splits the run. Never paint over
    // an intervening note, video or photograph that is still being prepared.
    let admissions = 6;
    for (const entry of entries) {
      if (!entry.eligible || !this.cache.get(entry.id)?.image || this.admitted.has(entry.id)) continue;
      if (admissions-- > 0) this.admitted.add(entry.id);
      else this.changed = true;
    }
    const runs: CardEntry[][] = [];
    let run: CardEntry[] = [];
    const finish = (): void => { if (run.length >= MIN_RUN && runs.length < maxBatches) runs.push(run); run = []; };
    for (const entry of entries) {
      if (entry.eligible && this.admitted.has(entry.id) && this.cache.get(entry.id)?.image) run.push(entry);
      else finish();
    }
    finish();
    const nextHidden = new Set<HTMLElement>();
    for (let index = 0; index < runs.length; index++) {
      const batch = runs[index]!;
      let canvas = this.canvases[index];
      if (!canvas) {
        canvas = document.createElement("canvas");
        canvas.className = "item-card-batch";
        this.host.append(canvas);
        this.canvases.push(canvas);
      }
      const width = Math.ceil(camera.width * dpr), height = Math.ceil(camera.height * dpr);
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      canvas.style.cssText = `position:absolute;left:0;top:0;pointer-events:none;transform-origin:0 0;width:${camera.width}px;height:${camera.height}px;transform:translate(${camera.x}px,${camera.y}px) scale(${1 / camera.zoom});z-index:${batch[0]!.rank}`;
      const ctx = canvas.getContext("2d");
      if (!ctx) continue;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.setTransform(camera.zoom * dpr, 0, 0, camera.zoom * dpr, -camera.x * camera.zoom * dpr, -camera.y * camera.zoom * dpr);
      for (const entry of batch) {
        ctx.save();
        ctx.translate(entry.x, entry.y);
        ctx.rotate(entry.rot);
        ctx.drawImage(this.cache.get(entry.id)!.image!, -entry.w / 2 - ITEM_BLEED, -entry.h / 2 - ITEM_BLEED, entry.w + 2 * ITEM_BLEED, entry.h + 2 * ITEM_BLEED);
        ctx.restore();
        nextHidden.add(entry.el);
      }
    }
    for (let index = runs.length; index < this.canvases.length; index++) {
      const canvas = this.canvases[index]!;
      canvas.style.display = "none"; if (canvas.width) canvas.width = 0; if (canvas.height) canvas.height = 0;
    }
    for (const el of this.hidden) if (!nextHidden.has(el)) el.classList.remove("is-card-cached");
    for (const el of nextHidden) if (!el.classList.contains("is-card-cached")) el.classList.add("is-card-cached");
    this.hidden = nextHidden;
  }

  destroy(): void {
    this.destroyed = true;
    this.host.removeEventListener("load", this.assetChanged, true);
    this.host.removeEventListener("error", this.assetChanged, true);
    this.host.removeEventListener("animationend", this.assetChanged, true);
    this.reveal();
    for (const id of this.cache.keys()) this.discard(id);
    for (const canvas of this.canvases) canvas.remove();
    this.canvases.length = 0;
    this.snapshots.destroy();
  }
}
