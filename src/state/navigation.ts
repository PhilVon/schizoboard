/**
 * Camera navigation input — pan and zoom.
 *
 * Listeners accumulate into a pending buffer and mutate nothing; `flush()`
 * applies the accumulated delta and is called from the INPUT phase of the
 * frame loop. Nothing outside the loop is allowed to move the camera, or the
 * DOM write phase can no longer trust its version check.
 *
 * Board tools (select, pin, string, marker...) get their own state machine in
 * `state/tools/`. Navigation is ambient — it works in every tool — so it lives
 * here rather than as a tool.
 *
 * docs/DESIGN.md section 3.7:
 *   pan   space+drag, middle-drag, two-finger scroll
 *   zoom  wheel (at cursor), pinch, Ctrl+= / Ctrl+-
 *   fit   Ctrl+0 · actual size  Ctrl+1
 */

import type { Bounds, Camera } from "@/state/camera";
import { isChromeTarget, isTextTarget } from "@/state/input";

/** Wheel delta -> zoom factor. One 100px mouse notch is about 0.86x. */
const WHEEL_ZOOM_RATE = 0.0015;
/** Wheel deltas at or above this are a mouse notch, not trackpad inertia. */
const WHEEL_NOTCH_PX = 50;
const KEY_ZOOM_STEP = 1.2;
/** Breathing room around a framed selection, screen pixels. Generous, because
 *  the point of framing something is to look at it in its surroundings. */
const FRAME_MARGIN_PX = 140;

export type WheelIntent = "zoom" | "pan";

/**
 * Mouse wheel and trackpad two-finger scroll are the same event, and the
 * design wants them to do different things. The classification:
 *
 *   - ctrl/meta held      -> zoom. Trackpad pinch synthesises ctrl+wheel on
 *                            every engine, and Ctrl+wheel is the browser zoom
 *                            gesture users already expect.
 *   - non-pixel deltaMode -> zoom. Only real wheels report lines or pages.
 *   - horizontal movement -> pan. A mouse wheel has no deltaX.
 *   - big vertical delta  -> zoom. A wheel notch is coarse.
 *   - otherwise           -> pan. Fine-grained vertical is trackpad inertia.
 *
 * The remaining ambiguity is a trackpad two-finger scroll that is perfectly
 * vertical and fast, which reads as a wheel notch. That is why an explicit
 * preference will eventually sit next to this function rather than replacing
 * the heuristic.
 */
export function classifyWheel(e: WheelEvent): WheelIntent {
  if (e.ctrlKey || e.metaKey) return "zoom";
  if (e.deltaMode !== 0) return "zoom";
  if (e.deltaX !== 0) return "pan";
  if (Math.abs(e.deltaY) >= WHEEL_NOTCH_PX) return "zoom";
  return "pan";
}

export interface NavigationOptions {
  /** Board bounds for Ctrl+0. Returns null while the board is empty. */
  contentBounds?: () => Bounds | null;
  /** Board bounds of the selection, for `F`. Null when nothing is selected. */
  selectionBounds?: () => Bounds | null;
}

export class Navigation {
  /** True for the frame in which a gesture produced input — the world layer
   *  uses it to drive the will-change discipline. */
  gestured = false;

  private readonly camera: Camera;
  private readonly target: HTMLElement;
  private readonly options: NavigationOptions;
  private readonly disposers: (() => void)[] = [];

  // Pending input, drained by flush().
  private panX = 0;
  private panY = 0;
  private zoomFactor = 1;
  private zoomAtX = 0;
  private zoomAtY = 0;
  private zoomPending = false;

  // Drag state.
  private spaceHeld = false;
  private dragPointer: number | null = null;
  private dragX = 0;
  private dragY = 0;

  constructor(camera: Camera, target: HTMLElement, options: NavigationOptions = {}) {
    this.camera = camera;
    this.target = target;
    this.options = options;
    this.attach();
  }

  /** INPUT phase. Applies everything the listeners accumulated. */
  flush(): void {
    this.gestured = false;

    if (this.panX !== 0 || this.panY !== 0) {
      this.camera.panByScreen(this.panX, this.panY);
      this.panX = 0;
      this.panY = 0;
      this.gestured = true;
    }

    if (this.zoomPending) {
      this.camera.zoomBy(this.zoomFactor, this.zoomAtX, this.zoomAtY);
      this.zoomFactor = 1;
      this.zoomPending = false;
      this.gestured = true;
    }
  }

  get panReady(): boolean {
    return this.spaceHeld || this.dragPointer !== null;
  }

  private queueZoom(factor: number, sx: number, sy: number): void {
    // Several wheel events can land in one frame; they compose by product.
    this.zoomFactor *= factor;
    this.zoomAtX = sx;
    this.zoomAtY = sy;
    this.zoomPending = true;
  }

  private attach(): void {
    const add = <K extends keyof HTMLElementEventMap>(
      el: HTMLElement | Window,
      type: K | string,
      fn: (e: never) => void,
      opts?: AddEventListenerOptions,
    ): void => {
      el.addEventListener(type, fn as EventListener, opts);
      this.disposers.push(() => el.removeEventListener(type, fn as EventListener, opts));
    };

    add(this.target, "wheel", (e: WheelEvent) => {
      // The page must never scroll and the webview must never browser-zoom.
      e.preventDefault();
      if (classifyWheel(e) === "zoom") {
        this.queueZoom(Math.exp(-e.deltaY * WHEEL_ZOOM_RATE), e.clientX, e.clientY);
      } else {
        this.panX -= e.deltaX;
        this.panY -= e.deltaY;
      }
    }, { passive: false });

    add(this.target, "pointerdown", (e: PointerEvent) => {
      const middle = e.button === 1;
      const spacePan = e.button === 0 && this.spaceHeld;
      if (!middle && !spacePan) return;
      if (isChromeTarget(e.target)) return;
      e.preventDefault();
      this.dragPointer = e.pointerId;
      this.dragX = e.clientX;
      this.dragY = e.clientY;
      this.target.setPointerCapture(e.pointerId);
      this.updateCursor();
    });

    add(this.target, "pointermove", (e: PointerEvent) => {
      if (this.dragPointer !== e.pointerId) return;
      // Coalesced events recover every sample the OS delivered between frames.
      // For a pan only the total matters, but the same call is what ink will
      // depend on, so the shape stays consistent.
      const samples = e.getCoalescedEvents?.() ?? [];
      if (samples.length > 0) {
        const last = samples[samples.length - 1]!;
        this.panX += last.clientX - this.dragX;
        this.panY += last.clientY - this.dragY;
        this.dragX = last.clientX;
        this.dragY = last.clientY;
      } else {
        this.panX += e.clientX - this.dragX;
        this.panY += e.clientY - this.dragY;
        this.dragX = e.clientX;
        this.dragY = e.clientY;
      }
    });

    const endDrag = (e: PointerEvent): void => {
      if (this.dragPointer !== e.pointerId) return;
      this.dragPointer = null;
      if (this.target.hasPointerCapture(e.pointerId)) {
        this.target.releasePointerCapture(e.pointerId);
      }
      this.updateCursor();
    };
    add(this.target, "pointerup", endDrag);
    add(this.target, "pointercancel", endDrag);

    add(window, "keydown", (e: KeyboardEvent) => {
      // Space is a space and F is an F when someone is writing on a note. The
      // Ctrl shortcuts further down are not: nobody types Ctrl+0 into a note,
      // and refusing to move the camera mid-sentence would be its own bug.
      const typing = isTextTarget(e.target);

      if (e.code === "Space" && !e.repeat) {
        if (typing) return;
        this.spaceHeld = true;
        this.updateCursor();
        e.preventDefault();
        return;
      }
      // `F` frames the selection (DESIGN section 3.7). Unmodified, so it has to
      // be checked before the Ctrl gate — and skipped when Alt or Ctrl is down,
      // or it would fire inside a shortcut that merely contains an F.
      if (e.code === "KeyF" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (typing) return;
        const bounds = this.options.selectionBounds?.() ?? null;
        if (bounds) {
          this.camera.fit(bounds, FRAME_MARGIN_PX);
          e.preventDefault();
        }
        return;
      }

      if (!(e.ctrlKey || e.metaKey)) return;
      const cx = this.camera.width / 2;
      const cy = this.camera.height / 2;
      switch (e.key) {
        case "0": {
          const bounds = this.options.contentBounds?.() ?? null;
          if (bounds) this.camera.fit(bounds);
          else this.camera.resetZoom();
          e.preventDefault();
          break;
        }
        case "1":
          this.camera.resetZoom();
          e.preventDefault();
          break;
        case "=":
        case "+":
          this.queueZoom(KEY_ZOOM_STEP, cx, cy);
          e.preventDefault();
          break;
        case "-":
          this.queueZoom(1 / KEY_ZOOM_STEP, cx, cy);
          e.preventDefault();
          break;
        default:
          break;
      }
    });

    add(window, "keyup", (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      this.spaceHeld = false;
      this.updateCursor();
    });

    // Losing focus mid-gesture otherwise leaves the board stuck in pan mode.
    add(window, "blur", () => {
      this.spaceHeld = false;
      this.dragPointer = null;
      this.updateCursor();
    });

    add(this.target, "contextmenu", (e: Event) => e.preventDefault());
  }

  private updateCursor(): void {
    this.target.style.cursor =
      this.dragPointer !== null ? "grabbing" : this.spaceHeld ? "grab" : "";
  }

  destroy(): void {
    for (const dispose of this.disposers) dispose();
    this.disposers.length = 0;
  }
}
