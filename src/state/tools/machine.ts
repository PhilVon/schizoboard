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
  /**
   * Where the *paper* is rather than where the rectangle is — see
   * `ToolContext.inkHitTest` (T-186).
   *
   * Optional here alone, and it falls back to `hitTest`. A machine driven in a
   * test is almost never asking about the few board units between a sheet's
   * edge and its silhouette, and every one of those harnesses would otherwise
   * have to declare a second hit test identical to its first. The real one is
   * wired in `app/main.ts`, where it is emphatically not the same function.
   */
  inkHitTest?: (boardX: number, boardY: number) => string | null;
  /** Screen space, not board — see `ToolContext.hitPin`. */
  hitPin: (screenX: number, screenY: number) => string | null;
  /** Board space, and against the rope particles — see `ToolContext.hitString`. */
  hitString: (boardX: number, boardY: number, reach: number) => StringHit | null;
  /**
   * Put a caret in an item's text — see `ToolContext.edit`.
   *
   * Optional here alone: a machine driven in a test has no presentation to put
   * a caret in, and defaulting to a no-op is what keeps every one of those
   * harnesses from having to declare it. The real one is wired in `app/main.ts`.
   */
  edit?: (itemId: string) => void;
  /** True when navigation owns the pointer — space held, or mid-pan. */
  suppressed?: () => boolean;
  /**
   * True when the document must not be edited at all — a board written by a
   * newer build, open to be looked at and not touched (T-224, Q-170).
   *
   * Its own predicate rather than more work for [`suppressed`]: that one is a
   * statement about who owns the pointer for the next few hundred milliseconds
   * and is asked at the three points a gesture can begin. This is a standing
   * fact about the board, and it has to reach the keys as well.
   */
  readOnly?: () => boolean;
  /** Wall clock, injected so the double-click window is testable — the same
   *  seam `state/tools/string.ts` has for the same reason. */
  now?: () => number;
}

function sample(e: PointerEvent | MouseEvent): PointerSample {
  const pointer = e as Partial<PointerEvent>;
  return {
    x: e.clientX,
    y: e.clientY,
    shift: e.shiftKey,
    ctrl: e.ctrlKey,
    alt: e.altKey,
    // Only the ink tools read either, and both are absent on a plain MouseEvent
    // — the wheel arrives as one — so neither is defaulted. A tool that needs a
    // number has to decide what a missing one means, which is the point:
    // `pressure` of 0.5 from a mouse and no pressure at all are different
    // situations and must not arrive looking the same (see `PointerSample`).
    pressure: pointer.pressure,
    pointer: pointer.pointerType,
    // The OS's stamp for this sample, which is the only one that means anything
    // once a batch of them arrives together — see `PointerSample.time`.
    time: e.timeStamp,
  };
}

/**
 * Every sample the OS delivered for this move, oldest first, ending at the
 * event's own position.
 *
 * `getCoalescedEvents` is the whole of AC-76's input half. The browser fires one
 * `pointermove` per frame and hides the rest inside it; a 1000 Hz mouse or a pen
 * moving fast has a dozen in there, and they are the difference between a curve
 * and a polygon (DESIGN section 6.5).
 *
 * Two fallbacks, both real rather than defensive. The method is absent outside
 * Chromium-family engines, and it returns an *empty* list for a synthetic or
 * untrusted event — which is every event a test dispatches, and would silently
 * turn a stroke into nothing at all.
 */
function trailOf(e: PointerEvent): PointerSample[] {
  const coalesced = e.getCoalescedEvents?.() ?? [];
  if (coalesced.length === 0) return [sample(e)];
  const trail: PointerSample[] = [];
  for (const each of coalesced) trail.push(sample(each));
  return trail;
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
  private readonly readOnly: () => boolean;
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
    this.readOnly = options.readOnly ?? (() => false);
    this.now = options.now ?? (() => Date.now());
    this.ctx = {
      scene: options.scene,
      dirty: options.dirty,
      camera: options.camera,
      selection: options.selection,
      write: options.write,
      hitTest: options.hitTest,
      inkHitTest: options.inkHitTest ?? options.hitTest,
      hitPin: options.hitPin,
      hitString: options.hitString,
      edit: options.edit ?? (() => undefined),
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
    this.abandon();
    this.tool = tool;
  }

  /**
   * Drop whatever gesture is in flight, without changing tool.
   *
   * What a tool change has always done to the outgoing tool, reached on its own
   * because a board can stop accepting input without anybody picking up
   * something else: a peer raising the schema version mid-stroke seals the
   * document (T-224), and a half-drawn line whose pen-up will never arrive is
   * a wet overlay that stays on the glass for the rest of the session.
   */
  abandon(): void {
    this.tool.cancel(this.ctx);
    this.queue.length = 0;
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
    // A notch this tool will never act on belongs to the camera, exactly as it
    // does while the space bar is down. Refusing it at `push` instead would
    // swallow it: `claimWheel` has already said yes by then.
    if (this.suppressed() || this.readOnly() || isChromeTarget(e.target)) return false;
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
    if (at === null || this.suppressed() || this.readOnly()) return false;
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

  /**
   * Is a modifier down *right now*, between gestures?
   *
   * A level, and the only way to ask one when there is no event to read it off
   * — which is the case for everything drawn or written before a press: the
   * wheel's claim above, and the scissors cursor in `app/main.ts`. Both boolean
   * and side-effect free, so asking once a frame costs nothing.
   */
  modifier(name: "Shift" | "Control" | "Alt"): boolean {
    return this.heldKeys.has(`${name}Left`) || this.heldKeys.has(`${name}Right`);
  }

  /**
   * Every key code down right now — the same set [`modifier`] answers from, and
   * the same one a tool reads as `ctx.held`.
   *
   * The set itself rather than a copy, because the info bar asks once a frame
   * and a fresh `Set` per frame for a question that is usually "nothing is
   * down" would be an allocation for nothing. Read-only to the caller by type,
   * and there is exactly one writer.
   */
  get held(): ReadonlySet<string> {
    return this.heldKeys;
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
   * position — the ones before it are history *as a position*. Down and up are
   * edges and are never collapsed.
   *
   * The samples themselves are not history, though, and the collapse keeps them:
   * the merged input carries the concatenated trail, so a tool that wants the
   * path the hand took gets every sample the OS gave us whether they arrived in
   * one `pointermove` or five. Discarding them here is the same bug as not
   * asking `getCoalescedEvents` in the first place — it just needs a busier
   * frame to show up, which makes it the worse of the two.
   */
  private push(input: ToolInput): void {
    /**
     * A board this build may not edit takes no tool input at all (T-224).
     *
     * Here rather than beside `suppressed` in the three claim points, because
     * this is the one funnel every input passes through — a press, a move, a
     * release, a wheel notch and the forwarded keys below all arrive by this
     * line, and `Delete` is exactly the one that does not go through a claim.
     *
     * Distinct from `suppressed`, which means "navigation owns the pointer" and
     * is about *this gesture*. This one is about the document, is decided long
     * before any gesture, and the caller cancels whatever was in flight on the
     * frame it becomes true — otherwise a stroke half drawn when a peer raises
     * the schema version would be a pen-up looking for a document to commit to.
     */
    if (this.readOnly()) return;
    if (input.kind === "up" || input.kind === "cancel") this.pendingEnd = true;
    if (input.kind === "move") {
      const last = this.queue[this.queue.length - 1];
      if (last?.kind === "move") {
        const trail =
          last.trail && input.trail ? [...last.trail, ...input.trail] : input.trail;
        this.queue[this.queue.length - 1] = { kind: "move", at: input.at, trail };
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
      // `readOnly` here as well as at `push`, and not only there: a press
      // that got this far would take pointer capture and `preventDefault` for a
      // gesture the funnel is about to drop, and the machine would go on
      // believing a finger was down (T-224).
      if (e.button !== 0 || this.suppressed() || this.readOnly()) return;
      if (isChromeTarget(e.target)) return;
      /**
       * A press inside a note being written on is text, not board input
       * (T-179).
       *
       * `isChromeTarget` cannot answer this one: the editor's field is parked
       * inside the item's own node, in the world layer, because that is what
       * gives it the paper's hand and the item's transform for free. So it is
       * board content by position and a text field by nature, and the second
       * one wins — both `preventDefault` below, which would stop the field
       * taking focus, and the drag this press would otherwise start on the very
       * note the caret is in.
       *
       * The keyboard listeners below have asked this question since before
       * there was anything to ask it about; this is the pointer catching up.
       */
      if (isTextTarget(e.target)) return;
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
      // Every sample, not just the current position: the OS may have delivered
      // several between frames, and a stroke needs all of them (see `trailOf`
      // and the `move` case of `ToolInput`). The last one is the true position.
      const trail = trailOf(e);
      this.push({ kind: "move", at: trail[trail.length - 1]!, trail });
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
