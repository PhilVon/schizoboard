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
 *
 * The wheel is the exception, because it is the one input both of them want: it
 * zooms the camera (DESIGN section 3.7) *and* it adjusts a selected segment's
 * slack (section 3.4). So there is no wheel listener here at all. Navigation
 * owns the only one and offers each notch to `claimWheel` below before it acts —
 * which is why that method both decides and delivers, and why it is the only
 * thing on this class that reaches the tool from outside the frame.
 */

import type { Camera } from "@/state/camera";
import type { DirtySets } from "@/state/dirty";
import {
  DOUBLE_CLICK_MS,
  DOUBLE_CLICK_SLOP,
  isChromeTarget,
  isTextTarget,
} from "@/state/input";
import type { Scene } from "@/state/scene";
import type { Selection } from "@/state/selection";
import type {
  BoardWriter,
  PointerSample,
  StringHit,
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
  /** Board space, and against the rope particles — see `ToolContext.hitString`. */
  hitString: (boardX: number, boardY: number, reach: number) => StringHit | null;
  /** Board space, and not a question — see `ToolContext.pluck`. */
  pluck: (stringId: string, boardX: number, boardY: number) => void;
  /** True when navigation owns the pointer — space held, or mid-pan. */
  suppressed?: () => boolean;
  /** Wall clock, injected so the double-click window is testable — the same
   *  seam `state/tools/string.ts` has for the same reason. */
  now?: () => number;
}

function sample(e: PointerEvent | MouseEvent): PointerSample {
  return { x: e.clientX, y: e.clientY, shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey };
}

/**
 * The `1`-`9` presets, by `code` rather than by `key`.
 *
 * `Digit1` is the physical key and is the same on every layout; `key` is `"1"`
 * on a US keyboard and `"&"` on a French one. `0` is deliberately absent: the
 * ladder is nine wide and `Digit0` is only ever seen here as half of the
 * camera's `Ctrl`+`0`.
 */
const DIGIT_KEYS = /^(Digit|Numpad)[1-9]$/;

export class ToolMachine {
  private readonly target: HTMLElement;
  private readonly ctx: ToolContext;
  private readonly suppressed: () => boolean;
  private readonly now: () => number;
  private readonly disposers: (() => void)[] = [];

  private tool: Tool;
  private readonly queue: ToolInput[] = [];
  private readonly heldKeys = new Set<string>();
  private pointer: number | null = null;
  private hover: { x: number; y: number } | null = null;
  private pendingEnd = false;
  private ended = false;

  /** The last press, for deciding whether the next one is a double. */
  private lastDownAt = Number.NEGATIVE_INFINITY;
  private lastDownX = 0;
  private lastDownY = 0;

  constructor(tool: Tool, target: HTMLElement, options: ToolMachineOptions) {
    this.tool = tool;
    this.target = target;
    this.suppressed = options.suppressed ?? (() => false);
    this.now = options.now ?? (() => Date.now());
    this.ctx = {
      scene: options.scene,
      dirty: options.dirty,
      camera: options.camera,
      selection: options.selection,
      write: options.write,
      hitTest: options.hitTest,
      hitPin: options.hitPin,
      hitString: options.hitString,
      pluck: options.pluck,
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

  /**
   * Offer a wheel notch to the active tool. True means it took it, and the
   * camera must leave this one alone.
   *
   * Called straight from `state/navigation.ts`'s wheel listener rather than from
   * a listener of our own, which is deliberate: the camera needs the answer
   * *now*, in the same event, and two listeners on one element deciding the same
   * thing independently is a truce that holds only as long as nobody changes the
   * order they were registered in.
   *
   * So the claim and the delivery are the same call. Asking twice — once to
   * decide and once to queue — would be two reads of a board that a write
   * queued for phase 9 can move between them, and a notch that the camera
   * declined and the tool then also declined is a notch that does nothing.
   *
   * `suppressed` applies here as it does to a press: while the space bar is down
   * the pointer belongs to the camera, and so does the wheel.
   */
  claimWheel(e: WheelEvent): boolean {
    if (this.suppressed() || isChromeTarget(e.target)) return false;
    const at = sample(e);
    if (this.tool.claimsWheel?.(at, this.ctx) !== true) return false;
    this.push({ kind: "wheel", at, dy: e.deltaY });
    return true;
  }

  /**
   * Would a notch arriving *now* be the tool's rather than the camera's?
   *
   * The same question `claimWheel` asks, minus the notch — so that something
   * can be drawn about the answer before the user has to spend a gesture
   * finding it out. The wheel is the one input the camera and the board both
   * want, and until this the only way to learn which of them had it was to roll
   * and see: a notch meant for a string's sag, landing on the camera instead,
   * takes the board from 49% to 6% zoom and the recovery is `Ctrl`+`0`.
   *
   * Read once a frame by `app/main.ts`, which turns it into a cursor. Safe to
   * ask that often because `claimsWheel` is pure by contract — it has to be,
   * since the camera needs its answer inside the wheel listener — and because
   * the tool that answers it (`state/tools/select.ts`) declines without a hit
   * test when nothing is selected, which is the resting state of the board.
   *
   * Null hover is the pointer off the board entirely, which is nobody's notch.
   */
  get wheelClaimed(): boolean {
    const at = this.hover;
    if (at === null || this.suppressed()) return false;
    return (
      this.tool.claimsWheel?.(
        {
          x: at.x,
          y: at.y,
          // From the held set rather than from an event, because there is no
          // event — this is a question about the state of the board between
          // gestures, and `Alt`+wheel means something different from a bare one.
          shift: this.modifier("Shift"),
          ctrl: this.modifier("Control"),
          alt: this.modifier("Alt"),
        },
        this.ctx,
      ) === true
    );
  }

  private modifier(name: "Shift" | "Control" | "Alt"): boolean {
    return this.heldKeys.has(`${name}Left`) || this.heldKeys.has(`${name}Right`);
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
    // Wheel notches collapse the other way round from moves: a position
    // supersedes, a delta accumulates. A fast roll delivers several notches
    // between frames and they are all part of the same turn of the wheel, so the
    // tool is handed the total at the latest position rather than being stepped
    // once per notch — which for a slack edit would be several document writes
    // in one frame, each read from a scene the previous one had not reached yet.
    if (input.kind === "wheel") {
      const last = this.queue[this.queue.length - 1];
      if (last?.kind === "wheel") {
        this.queue[this.queue.length - 1] = { ...input, dy: last.dy + input.dy };
        return;
      }
    }
    this.queue.push(input);
  }

  /**
   * Is this press the second of a double-click?
   *
   * Ours rather than the DOM's, because `pointerdown` below calls
   * `preventDefault` — which suppresses the compatibility mouse events, and
   * `dblclick` is one of them. The window and the slop live in
   * `state/input.ts`, shared with the string tool, which asks the same question
   * of the *click* rather than of the press.
   *
   * The clock is read once per press and the result is a flag on the input, so
   * what the tool acts on is still only ever something the frame handed it.
   */
  private doublePress(at: PointerSample): boolean {
    const now = this.now();
    const dx = at.x - this.lastDownX;
    const dy = at.y - this.lastDownY;
    const double =
      now - this.lastDownAt <= DOUBLE_CLICK_MS &&
      dx * dx + dy * dy <= DOUBLE_CLICK_SLOP * DOUBLE_CLICK_SLOP;
    // A third press in the same spot is not a second double-click. Resetting
    // the clock makes triple-click land as click, double, click rather than as
    // two overlapping doubles, which is what every text field does.
    this.lastDownAt = double ? Number.NEGATIVE_INFINITY : now;
    this.lastDownX = at.x;
    this.lastDownY = at.y;
    return double;
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
      const at = sample(e);
      this.push({ kind: "down", at, double: this.doublePress(at) });
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
        // `KeyB` was here: the interim tuck-behind binding, forwarded because
        // DESIGN section 3.4's row says *context menu* and there was no menu.
        // There is one now (`ui/menu.ts`), so the letter has gone back to being
        // free — it was never in DESIGN section 3.9's key table and a board with
        // an undocumented shortcut in it is a board nobody can learn.
        case "KeyA":
          if (!(e.ctrlKey || e.metaKey)) break;
          this.push({ kind: "key", code: "KeyA", shift: e.shiftKey, ctrl: true, alt: e.altKey });
          // Otherwise the webview selects the whole page behind the board.
          e.preventDefault();
          break;
        default:
          // > 1-9 slack presets — DESIGN section 3.9's key table.
          //
          // Bare only. `Ctrl`+`0` and `Ctrl`+`1` are the camera's (fit and
          // actual size), and forwarding those would have a preset fire every
          // time someone reset the zoom. Not `preventDefault`ed, unlike every
          // other key here: those all have a webview default worth stopping —
          // `Backspace` navigates back, `Enter` activates — and a bare digit
          // over a canvas has none.
          if (
            DIGIT_KEYS.test(e.code) &&
            !e.ctrlKey &&
            !e.metaKey &&
            !e.altKey &&
            !e.shiftKey
          ) {
            this.push({ kind: "key", code: e.code, shift: false, ctrl: false, alt: false });
          }
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
