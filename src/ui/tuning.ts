/**
 * The physics panel — every dial in `sim/tuning.ts`, on a slider.
 *
 * > All physics constants live in one module with a debug panel bound to them.
 * > Feel is found by fiddling, not by derivation, and the fiddling needs to be
 * > fast. — DESIGN section 5.8
 *
 * The module was built for this and said so in its own header for eight phases
 * (T-232). This is the second half of that sentence, and *fast* is the whole
 * brief: a value you have to edit, save and wait for a reload to see is a value
 * nobody fiddles with. Every write here lands on the next substep, because what
 * it writes is the live binding the solver reads.
 *
 * ## Dev only, and rebuilt from nothing
 *
 * Constructed inside `app/main.ts`'s `import.meta.env.DEV` block, so the whole
 * module — and the `setTuning` calls that are the only way to move a value —
 * leaves a production bundle entirely.
 *
 * ## Why it is not the HUD
 *
 * The HUD (DESIGN section 9.5) reports and this steers, and they want opposite
 * things from the same corner of the screen: the HUD repaints at 5 Hz and must
 * never be in the way, while this takes the pointer for as long as a drag lasts
 * and would eat every gesture underneath it if it were always up. So it is its
 * own panel on its own key, and the two can be open together — which is the
 * point, since the thing you are watching while you turn a dial is usually the
 * frame timing beside it.
 */

import { setTuning, resetTuning, tuningChanged, TUNABLES, type Knob } from "@/sim/tuning";

/**
 * How a value is written next to its slider.
 *
 * Not `toFixed` of a fixed width: the dials here span five orders of magnitude
 * — `SWING_SLEEP_ANGLE` is 0.0003 and `MAX_AWAKE_PARTICLES` is 2000 — and one
 * width would either round the first to zero or print the second with four
 * meaningless decimals. The step is what says how much precision a dial has, so
 * the step decides the format.
 */
function format(value: number, step: number): string {
  const decimals = Math.max(0, Math.min(6, Math.ceil(-Math.log10(step))));
  return value.toFixed(decimals);
}

export class TuningPanel {
  private readonly el: HTMLDivElement;
  private readonly rows: { knob: Knob; slider: HTMLInputElement; value: HTMLElement }[] = [];
  private readonly reset: HTMLButtonElement;
  private visible = false;
  private readonly disposers: (() => void)[] = [];

  constructor(host: HTMLElement) {
    this.el = document.createElement("div");
    this.el.className = "tuning";
    this.el.hidden = true;

    const title = document.createElement("div");
    title.className = "tuning-title";
    title.textContent = "physics";
    this.el.append(title);

    /**
     * The dials scroll; the reset does not. Its own element rather than a
     * sticky last child, which floated over the bottom row and hid it —
     * seventeen dials are taller than any ordinary window, so the list has to
     * move under something that stays.
     */
    const list = document.createElement("div");
    list.className = "tuning-list";
    for (const knob of TUNABLES) list.append(this.row(knob));
    this.el.append(list);

    this.reset = document.createElement("button");
    this.reset.className = "tuning-reset";
    this.reset.type = "button";
    this.reset.textContent = "put everything back";
    this.reset.addEventListener("click", () => {
      resetTuning();
      this.sync();
    });
    this.el.append(this.reset);

    host.append(this.el);

    const onKey = (e: KeyboardEvent): void => {
      // Shift+backquote, beside the HUD's own backquote — the two are read
      // together and the pairing is how the second one is ever found. The HUD
      // ignores the shifted press for exactly this.
      if (e.code !== "Backquote" || !e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
      this.toggle();
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    this.disposers.push(() => window.removeEventListener("keydown", onKey));
  }

  /**
   * One dial.
   *
   * `input` rather than `change`, so the board moves under the thumb while it
   * is being dragged rather than when it is let go — a swing you have to
   * release the mouse to see is one you cannot compare against the last value.
   */
  private row(knob: Knob): HTMLElement {
    const row = document.createElement("label");
    row.className = "tuning-row";

    const name = document.createElement("span");
    name.className = "tuning-name";
    name.textContent = knob.label;

    const value = document.createElement("span");
    value.className = "tuning-value";
    value.textContent = format(knob.read(), knob.step);

    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = String(knob.min);
    slider.max = String(knob.max);
    slider.step = String(knob.step);
    slider.value = String(knob.read());
    slider.addEventListener("input", () => {
      // Through `setTuning` rather than straight at the binding: the clamp and
      // the quantisation belong to the dial, and the panel showing a number the
      // simulation does not have is the one bug a panel must not have.
      const written = setTuning(knob.key, Number(slider.value));
      value.textContent = format(written, knob.step);
      this.reset.hidden = !tuningChanged();
    });

    row.append(name, value, slider);

    if (knob.lag !== undefined) {
      const lag = document.createElement("span");
      lag.className = "tuning-lag";
      lag.textContent = knob.lag;
      row.append(lag);
    }

    this.rows.push({ knob, slider, value });
    return row;
  }

  /** Put every row back in step with the values, after a reset. */
  private sync(): void {
    for (const { knob, slider, value } of this.rows) {
      slider.value = String(knob.read());
      value.textContent = format(knob.read(), knob.step);
    }
    this.reset.hidden = !tuningChanged();
  }

  toggle(): void {
    this.visible = !this.visible;
    this.el.hidden = !this.visible;
    // Read on the way up rather than on every write: a dial can be moved from
    // the console as easily as from here, and a panel that opens disagreeing
    // with the simulation is worse than no panel.
    if (this.visible) this.sync();
  }

  get open(): boolean {
    return this.visible;
  }

  destroy(): void {
    for (const dispose of this.disposers) dispose();
    this.disposers.length = 0;
    this.el.remove();
  }
}
