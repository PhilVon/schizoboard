/**
 * The tool state machine: listeners in, one tool out.
 *
 * Every pointer and key event on the board arrives here, is turned into a
 * `ToolInput`, and is *buffered*. Nothing reaches the active tool until
 * `flush()` runs in the INPUT phase of the frame.
 *
 * That indirection is the whole point of the module, and it is the same
 * discipline `state/navigation.ts` applies to the camera. A listener that acted
 * immediately would mutate the scene between the LAYOUT and DOM phases of a
 * frame already in flight, and the write phase would then be working from
 * geometry the layout phase never saw. It shows up as items whose pins lag them
 * by a frame, occasionally, under load — which is close to undiagnosable.
 *
 * ## Two things are levels, not events
 *
 * Held keys and the active tool are read by the tool when it needs them rather
 * than delivered. `R`+drag asks "is R down *now*", partway through a gesture;
 * queueing a keydown would answer a different question.
 *
 * ## Coexisting with navigation
 *
 * Navigation claims middle-drag and space+drag; this claims primary-button
 * drags. They listen on the same element and stay out of each other's way by
 * button and by the `suppressed` predicate, which is wired to
 * `Navigation.panReady` — space going down mid-hover must not leave the board
 * able to start a drag.
 */

import type { Camera } from "@/state/camera";
import type { DirtySets } from "@/state/dirty";
import { isChromeTarget, isTextTarget } from "@/state/input";
import type { Scene } from "@/state/scene";
import type { Selection } from "@/state/selection";
import type {
  BoardWriter,
  PointerSample,
  Tool,
  ToolContext,
  ToolInput,
} from "@/state/tools/tool";

export interface ToolMachineOptions {
  scene: Scene;
  dirty: DirtySets;
  camera: Camera;
  selection: Selection;
  write: BoardWriter;
  hitTest: (boardX: number, boardY: number) => string | null;
  /** Screen space, not board — see `ToolContext.hitPin`. */
  hitPin: (screenX: number, screenY: number) => string | null;
  /** True when navigation owns the pointer — space held, or mid-pan. */
  suppressed?: () => boolean;
}

function sample(e: PointerEvent | MouseEvent): PointerSample {
  return { x: e.clientX, y: e.clientY, shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey };
}

export class ToolMachine {
  private readonly target: HTMLElement;
  private readonly ctx: ToolContext;
  private readonly suppressed: () => boolean;
  private readonly disposers: (() => void)[] = [];

  private tool: Tool;
  private readonly queue: ToolInput[] = [];
  private readonly heldKeys = new Set<string>();
  private pointer: number | null = null;
  private hover: { x: number; y: number } | null = null;
  private pendingEnd = false;
  private ended = false;

  constructor(tool: Tool, target: HTMLElement, options: ToolMachineOptions) {
    this.tool = tool;
    this.target = target;
    this.suppressed = options.suppressed ?? (() => false);
    this.ctx = {
      scene: options.scene,
      dirty: options.dirty,
      camera: options.camera,
      selection: options.selection,
      write: options.write,
      hitTest: options.hitTest,
      hitPin: options.hitPin,
      held: this.heldKeys,
    };
    this.attach();
  }

  get active(): Tool {
    return this.tool;
  }

  /**
   * Where the cursor is, in screen space, or null when it is not over the
   * board. Paste needs it ("the cursor if it's over the board, otherwise the
   * viewport centre" — DESIGN section 3.7), and so will the pin tool and the
   * awareness cursor.
   *
   * A level rather than an event, and read straight from the listener rather
   * than buffered — nobody wants last frame's hover, and there is nothing to
   * coalesce.
   */
  get cursor(): { x: number; y: number } | null {
    return this.hover;
  }

  /**
   * True for the frame in which the active tool was handed a release or a
   * cancel — a gesture just finished, one way or the other. A level, in the
   * same spirit as `Navigation.gestured`, rather than a callback nobody would
   * be able to order against the frame.
   *
   * Undo reads it to close an entry (DATA-MODEL section 11 — "call
   * `stopCapturing()` on pointer-up"), and must do so through the write queue:
   * the gesture's final pose is queued during this same flush and has to join
   * the entry before it is sealed.
   */
  get gestureEnded(): boolean {
    return this.ended;
  }

  /** Switching tools abandons whatever the old one had hold of, rather than
   *  leaving a half-finished gesture nobody will ever deliver an up for. */
  /** Which tool has the board. Read by `main.ts` so a tool that wants chrome
   *  drawn — the string run in progress — is only asked while it is active. */
  get current(): Tool {
    return this.tool;
  }

  setTool(tool: Tool): void {
    if (tool === this.tool) return;
    this.tool.cancel(this.ctx);
    this.queue.length = 0;
    this.tool = tool;
    // Cancelling is ending. A tool change is one of the three explicit undo
    // boundaries, and here it is already the same event as a gesture ending.
    this.pendingEnd = true;
  }

  /** INPUT phase. Drains the frame's input, then steps the tool once. */
  flush(dtMs: number): void {
    this.ended = this.pendingEnd;
    this.pendingEnd = false;
    for (let i = 0; i < this.queue.length; i++) this.tool.handle(this.queue[i]!, this.ctx);
    this.queue.length = 0;
    this.tool.tick(dtMs, this.ctx);
  }

  /**
   * Several pointer moves can land in one frame and only the last one is a
   * position — the ones before it are history the tool has no use for. Down
   * and up are edges and are never collapsed.
   */
  private push(input: ToolInput): void {
    if (input.kind === "up" || input.kind === "cancel") this.pendingEnd = true;
    if (input.kind === "move") {
      const last = this.queue[this.queue.length - 1];
      if (last?.kind === "move") {
        this.queue[this.queue.length - 1] = input;
        return;
      }
    }
    this.queue.push(input);
  }

  private attach(): void {
    const add = (
      el: HTMLElement | Window,
      type: string,
      fn: (e: never) => void,
      opts?: AddEventListenerOptions,
    ): void => {
      el.addEventListener(type, fn as EventListener, opts);
      this.disposers.push(() => el.removeEventListener(type, fn as EventListener, opts));
    };

    add(this.target, "pointerdown", (e: PointerEvent) => {
      if (e.button !== 0 || this.suppressed() || isChromeTarget(e.target)) return;
      // One gesture at a time. A second finger arriving mid-drag would
      // otherwise take the machine over, and the first finger's release —
      // filtered out by the pointer-id check below — would never arrive, so
      // whatever it was carrying would stay stuck to nothing.
      if (this.pointer !== null) return;
      e.preventDefault();
      this.pointer = e.pointerId;
      // Capture, so a drag that leaves the window still delivers its up. The
      // board is a direct-manipulation surface; losing the release is what
      // leaves an item stuck to the cursor.
      this.target.setPointerCapture?.(e.pointerId);
      this.push({ kind: "down", at: sample(e) });
    });

    add(this.target, "pointermove", (e: PointerEvent) => {
      this.hover = { x: e.clientX, y: e.clientY };
      if (this.pointer !== e.pointerId) return;
      // The last coalesced sample is the true current position; the OS may
      // have delivered several between frames.
      const samples = e.getCoalescedEvents?.() ?? [];
      const latest = samples.length > 0 ? samples[samples.length - 1]! : e;
      this.push({ kind: "move", at: sample(latest) });
    });

    const end = (e: PointerEvent, cancelled: boolean): void => {
      if (this.pointer !== e.pointerId) return;
      this.pointer = null;
      if (this.target.hasPointerCapture?.(e.pointerId)) {
        this.target.releasePointerCapture(e.pointerId);
      }
      this.push(cancelled ? { kind: "cancel" } : { kind: "up", at: sample(e) });
    };
    add(this.target, "pointerup", (e: PointerEvent) => end(e, false));
    add(this.target, "pointercancel", (e: PointerEvent) => end(e, true));

    add(window, "keydown", (e: KeyboardEvent) => {
      if (isTextTarget(e.target)) return;
      this.heldKeys.add(e.code);
      if (e.repeat) return;

      switch (e.code) {
        // > Enter/Esc end run — DESIGN section 3.9's key table. `Enter` joined
        // this list with the string tool (T-42); before that nothing had a
        // gesture that ended on a keystroke rather than on a pointer.
        case "Enter":
        case "NumpadEnter":
        case "Escape":
        case "Delete":
        case "Backspace":
          this.push({ kind: "key", code: e.code, shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey });
          e.preventDefault();
          break;
        case "KeyA":
          if (!(e.ctrlKey || e.metaKey)) break;
          this.push({ kind: "key", code: "KeyA", shift: e.shiftKey, ctrl: true, alt: e.altKey });
          // Otherwise the webview selects the whole page behind the board.
          e.preventDefault();
          break;
        default:
          break;
      }
    });

    add(this.target, "pointerleave", () => {
      this.hover = null;
    });

    add(window, "keyup", (e: KeyboardEvent) => {
      this.heldKeys.delete(e.code);
    });

    // A key held when focus leaves never delivers its keyup, so the board would
    // come back believing R is still down. The gesture is abandoned through the
    // queue rather than directly, because a listener must not touch the scene.
    //
    // The queue is *appended to*, not cleared. A release that landed earlier in
    // this same frame is a completed drag, and throwing it away to cancel
    // instead would silently undo work the user had already finished — losing
    // focus within 16 ms of letting go is not rare.
    add(window, "blur", () => {
      this.heldKeys.clear();
      this.pointer = null;
      this.push({ kind: "cancel" });
    });
  }

  destroy(): void {
    // Cancel first: nothing will tick the tool again, so anything it was
    // holding mid-gesture would keep whatever transient state it had.
    this.tool.cancel(this.ctx);
    for (const dispose of this.disposers) dispose();
    this.disposers.length = 0;
    this.queue.length = 0;
    this.heldKeys.clear();
  }
}
