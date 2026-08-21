/**
 * The bell on a timer that has gone off — T-406, D-73.
 *
 * The fourth surface, and the only one that does not need you to be looking at
 * the screen. The flash line says the caption, the amber lights whatever the
 * timer points at, and the camera flies if you asked it to — and all three are
 * pixels, which is a poor way to tell somebody that the kettle timer they set
 * before going to make the tea has finished.
 *
 * ## Synthesised, not a file
 *
 * There is no audio asset in this application and this does not add one. A
 * struck bell is two sine partials and an envelope; a `.wav` of the same thing
 * is tens of kilobytes in the bundle, a second kind of binary for `raster.ts`'s
 * inlining rules to have an opinion about, and a fetch that can fail on a board
 * that has already opened. Nothing here loads anything.
 *
 * It also sidesteps the failure mode a media element has. `render/items/deck.ts`
 * plays *items* — a film somebody pinned up — through an `HTMLMediaElement`
 * with a source, and it has to cope with a source that will not load. A chime
 * has no source to fail.
 *
 * ## What makes it a bell rather than a beep
 *
 * The inharmonic partial. A struck metal bell's second mode sits at about 2.76
 * times its fundamental — not an octave, not a fifth, nothing in the harmonic
 * series — and that ratio is most of what the ear hears as *metal*. A single
 * sine with a decay is a doorbell chime from a synthesiser; the same sine with
 * a quiet 2.76 partial over it is a small bell being hit.
 *
 * Struck twice, because a mechanical timer's bell is a hammer bouncing on a
 * gong and one clean strike reads as a notification from a phone. The second is
 * quieter than the first, which is what a bounce is.
 *
 * ## It may never make a sound, and that is not an error
 *
 * A webview will not start an `AudioContext` until the person has interacted
 * with the page, and this board is opened by a person who then clicks on it —
 * so in practice the context is available by the time any timer has been set
 * and started. But *in practice* is not a guarantee: a board opened onto
 * somebody else's already-running countdown can expire before this window has
 * been touched at all.
 *
 * So every path here is wrapped and every failure is silent. A board that would
 * not open because a webview refused to make a noise would be an absurd way to
 * lose, which is the argument `app/prefs.ts` already makes about `localStorage`
 * — and the other three surfaces have already said the same thing in pixels.
 */

/** Concert A two octaves above the stave. Bright, small, and unmistakably a
 *  bell rather than an alert — the size of thing a travel clock contains. */
const FUNDAMENTAL_HZ = 1760;

/**
 * Where a struck bell's second mode actually sits, relative to the first.
 *
 * Not 2, not 3, and the fact that it is neither is the whole point — see the
 * header. Quiet enough to be colour rather than a second note.
 */
const PARTIAL_RATIO = 2.76;

/** How long one strike takes to die away. Long enough to ring, short enough
 *  that the second strike lands into it rather than after it. */
const DECAY_S = 1.1;

/** The bounce. A hammer on a gong does not stop dead. */
const STRIKES: readonly { at: number; gain: number }[] = [
  { at: 0, gain: 0.18 },
  { at: 0.17, gain: 0.11 },
];

/** How loud the inharmonic partial is against the fundamental. Colour, not a
 *  note: louder and it stops being a bell and becomes two beeps. */
const PARTIAL_GAIN = 0.34;

/**
 * Anything that can make the noise. `AudioContext` satisfies it.
 *
 * Named structurally rather than taken as the global type so a test can hand in
 * a double, and so this module holds no opinion about which of the two names a
 * webview has for it.
 */
export type MakeAudio = () => AudioContext | null;

/**
 * The default source: whichever of the two names this environment has, or null
 * where it has neither.
 *
 * Constructed lazily by [`Chime.ring`] rather than here, because building an
 * `AudioContext` at module load starts a hardware audio graph on every board
 * that opens, including the very many that never put a timer up.
 */
function defaultAudio(): AudioContext | null {
  try {
    const ctor =
      typeof AudioContext !== "undefined"
        ? AudioContext
        : (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    return ctor === undefined ? null : new ctor();
  } catch {
    // A webview with audio disabled outright. There are three other surfaces.
    return null;
  }
}

export class Chime {
  private readonly make: MakeAudio;
  private audio: AudioContext | null = null;
  /** Tried and failed. Kept so a board that cannot make a noise does not
   *  attempt to build a context on every expiry for the rest of the session. */
  private refused = false;

  /**
   * How many times this has actually put a sound into the graph.
   *
   * A readout, and it exists for the reason `Flashes` is on the debug handle: a
   * chime is over in a second and a screenshot cannot hear. Without this there
   * is no way for a driven run to tell "the bell rang" from "the expiry never
   * reached the bell", which are the two things a silent machine looks like.
   */
  rings = 0;

  constructor(make: MakeAudio = defaultAudio) {
    this.make = make;
  }

  /**
   * Ring it, if this machine can and if there is anything to ring with.
   *
   * Never throws and never reports. The caller is the expiry announcement,
   * which has already put the caption on the flash line and lit the amber; a
   * failure here is one of four surfaces being unavailable, not an event.
   */
  ring(): void {
    const audio = this.context();
    if (audio === null) return;
    try {
      // A context built before the person has touched the page starts
      // suspended, and every node scheduled into it is silent. Resuming is a
      // promise nobody waits on: if it lands in time this strike is heard, and
      // if it does not, the next one will be.
      if (audio.state === "suspended") void audio.resume().catch(() => {});
      const at = audio.currentTime;
      for (const strike of STRIKES) this.strike(audio, at + strike.at, strike.gain);
      this.rings += 1;
    } catch {
      // A context that was closed under us — a window on its way out, which is
      // exactly when a countdown is most likely to run out unwatched.
      this.refused = true;
    }
  }

  /**
   * One hit: two partials through one envelope.
   *
   * The envelope is on a shared gain node rather than one per oscillator, so
   * the two partials decay *together* and stay one object being struck. Given
   * separate envelopes they drift apart as they fade, and a bell whose overtone
   * outlives its fundamental is a sound nothing physical makes.
   */
  private strike(audio: AudioContext, at: number, peak: number): void {
    const envelope = audio.createGain();
    envelope.connect(audio.destination);
    envelope.gain.setValueAtTime(0.0001, at);
    // A hammer, so the attack is as close to instant as an exponential ramp is
    // allowed to be — a linear one from silence clicks, and a slower one is a
    // bell being stroked rather than hit.
    envelope.gain.exponentialRampToValueAtTime(peak, at + 0.002);
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + DECAY_S);

    for (const [ratio, share] of [
      [1, 1],
      [PARTIAL_RATIO, PARTIAL_GAIN],
    ] as const) {
      const osc = audio.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(FUNDAMENTAL_HZ * ratio, at);
      if (share === 1) {
        osc.connect(envelope);
      } else {
        const trim = audio.createGain();
        trim.gain.setValueAtTime(share, at);
        osc.connect(trim);
        trim.connect(envelope);
      }
      osc.start(at);
      // Stopped rather than left running: an oscillator with no stop time is a
      // node the graph keeps alive forever, and a kitchen timer used all
      // afternoon would accumulate one per strike.
      osc.stop(at + DECAY_S + 0.05);
    }
  }

  /** The context, built on first use and remembered — or null, once and for
   *  all, on a machine that will not give us one. */
  private context(): AudioContext | null {
    if (this.audio !== null || this.refused) return this.audio;
    try {
      this.audio = this.make();
    } catch {
      this.audio = null;
    }
    if (this.audio === null) this.refused = true;
    return this.audio;
  }

  /** Let the hardware graph go. Idempotent, and safe on a context that has
   *  already gone — a window closing is not a tidy sequence. */
  dispose(): void {
    const audio = this.audio;
    this.audio = null;
    this.refused = true;
    try {
      void audio?.close().catch(() => {});
    } catch {
      // Already closed, or a double that has no `close`. Nothing to do.
    }
  }
}
