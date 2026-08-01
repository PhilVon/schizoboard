/**
 * Undeveloped film: what a photograph looks like before its bytes arrive.
 *
 * > The waiting state is treated as an art direction opportunity rather than an
 * > error: an undeveloped-film look, grain and a faint chemical wash, animating
 * > gently while the transfer runs. A photo that no connected peer holds gets a
 * > torn-photograph treatment and a retry. — DESIGN section 7.5
 *
 * The five states this draws are `state/assets.ts`'s, and they are local state
 * that is never in the document (DATA-MODEL section 10) — two windows on one
 * board legitimately show the same item as developed and as blank at the same
 * moment. That is why this is a render concern and not an item field.
 *
 * ## Nothing animates because it is waiting
 *
 * DESIGN says "animating gently **while the transfer runs**", and taking that
 * literally is also the only version that is affordable. An opacity keyframe
 * promotes a compositor layer per element, so animating every un-arrived
 * photograph would promote one per waiting item — a board opened cold has all
 * of them. The number that are actually mid-transfer is bounded by the
 * exchange's in-flight window, so `transferring` is the state that breathes and
 * the other three are still bitmaps.
 *
 * The emerge below is the second animation and takes the same bound from the
 * other direction: it is one-shot, about a second long, and runs once per item
 * per session, so what it promotes is a layer per develop *in flight* rather
 * than one per photograph.
 *
 * These two are the only places in `render/` that animate outside the frame
 * loop, and items.css states the rule they are standing next to. They are
 * admissible because nothing here is board *content*: no geometry, nothing
 * hit-tested, nothing the sim or the scene mirror can observe. It is the inside
 * of a photograph — one that does not exist yet, and one that has just started
 * to.
 */

import { mulberry32, valueAt } from "@/lib/seed";
import type { AssetPhase } from "@/state/assets";

/**
 * Which *variation* on undeveloped film a phase gets, if any.
 *
 * Blank film is the base — it is `is-waiting`, which the view already puts on
 * whenever the window is showing something other than a photograph, including
 * the moment between `ready` and the decode landing. So this names only the two
 * departures from it.
 *
 * `unknown` and `requesting` share that base on purpose: "nobody has told me
 * yet" and "I have asked and am waiting" are the same blank sheet of film to
 * anyone looking at the board, and separating them would be drawing the network
 * rather than drawing the photograph.
 *
 * ## Three classes, four faces
 *
 * `CaseView` wears these too (T-271), and it is the same three names rather than
 * a parallel set. The *state* is one state — five phases of one hash, out of
 * `state/assets.ts` — and what differs between a photograph and a cassette is
 * only what the missing thing looks like, which is a stylesheet's question. A
 * second vocabulary would be two spellings of one fact, and the release paths
 * would have to strip both.
 *
 * What is not shared is the drawing or the variable that drives it: a polaroid's
 * `--develop` is a percentage up the film and a case object's `--arrived` is a
 * unitless fraction of its own contents. `paintContents` says why they cannot be
 * one property.
 */
export function filmClass(phase: AssetPhase): string {
  if (phase === "transferring") return "is-developing";
  if (phase === "unavailable") return "is-torn";
  return "";
}

/** Every class `filmClass` can return, for the release path to strip blindly. */
export const FILM_CLASSES = ["is-developing", "is-torn"] as const;

/**
 * The print coming up: the class an item wears for the second or so between its
 * photograph decoding and the emulsion clearing off it.
 *
 * Not one of `FILM_CLASSES`, and not returned by `filmClass`, because it is not
 * a *phase*. Every one of those five is a fact about bytes on a disk somewhere;
 * this is a fact about one window at one moment — the same asset is emerging in
 * this window and long since developed in the one beside it, and the phase is
 * `ready` in both.
 *
 * It is also the one film class that goes *off* by itself, on the animation's
 * own end event. Everything else here is put on and taken off by a bind.
 *
 * How long it lasts is the stylesheet's business and deliberately not stated
 * here. The class is not what makes the photograph visible — `film-emerge` fills
 * `backwards` rather than `both`, so an item is opaque before the animation and
 * opaque after it, and only the animation itself ever takes that away. A build
 * with no stylesheet, a harness that runs no animations, an `animationend` that
 * never arrives: every one of those shows the photograph. The failure mode of a
 * duration the renderer also knew would be a picture nobody could see.
 */
export const IS_EMERGING = "is-emerging";

/**
 * How many device pixels across an item has to be for its photograph to be
 * worth developing.
 *
 * The rule is "do not animate what is too small to watch", and it is the only
 * bound this effect has that bites when it matters. Everything else about a
 * develop is bounded by the fact that it happens once per item — which is a
 * bound on the whole session and no bound at all on the one moment it goes
 * wrong, because a board opened cold has *every* photograph on the screen
 * landing at once. Measured with no floor, on 300 polaroids fitted to the
 * window: p99 frame time 28 ms without the develop and 83-103 ms with it, and
 * the four seconds after boot fell from ~500 rendered frames to ~315.
 *
 * ## Why a size floor is a bound and not merely a discouragement
 *
 * Because of how the bad case arises. A cold open *fits the board*, so the zoom
 * falls as the item count rises — and the number of photographs that can both be
 * on the screen and be big enough to develop therefore has its maximum in the
 * middle rather than at the top end. Driven on packed grids, floor in:
 *
 * ```
 *    45 items   fit 0.28   30 develop at once
 *    70 items   fit 0.27   23
 *   110 items   fit 0.18    0 - the whole board is under the floor
 * ```
 *
 * Thirty simultaneous develops cost nothing measurable: p99 8.9 ms against the
 * control's 9.7 ms, four frames over 16.7 ms against three, medians identical.
 * That is inside the run-to-run noise, and it is the worst this gets.
 *
 * ## The number
 *
 * 96 device pixels, which is a polaroid at about 38% zoom. It was 128 for a
 * while and Q-96 moved it: 128 refused a develop to a photograph pasted onto a
 * board zoomed out past roughly half, and a single paste is not a storm — the
 * whole point of the effect is that an arrival is visible, and a paste is the
 * arrival people see most.
 *
 * Not the 256 of `VARIANT_MAX_EDGE.thumb`, which is the other threshold in this
 * area and answers a different question. That one asks how much detail is worth
 * decoding and is right to be strict; this asks whether there is a picture there
 * at all.
 *
 * What it still costs, further down: a photograph pasted onto a board zoomed out
 * past about a third does not develop, it simply appears. That is the price of
 * one rule and one number instead of a count, a clock and a special case — and
 * everything above is a measurement rather than an argument, so the number moves
 * by measuring again.
 */
export const EMERGE_MIN_PX = 96;

/**
 * The most a develop is held back so that a trayful do not come up in lockstep.
 *
 * Small on purpose. This is the difference between prints in a tray and a
 * synchronised blink, not a queue: a board that opens cold has every photograph
 * on screen landing within a few frames of each other, and without the scatter
 * the whole viewport flashes as one object.
 */
const EMERGE_STAGGER_MS = 260;

/**
 * This item's share of that scatter, in milliseconds.
 *
 * Off the item's seed, like the grain offset and the sheet tint, so a given
 * photograph always comes up in the same place in the order — which matters
 * because a develop can be watched twice, once per window, and two peers
 * dealing the same board in two different orders would look like a race.
 */
export function emergeDelay(seed: number): number {
  return Math.round(valueAt(seed, "emerge") * EMERGE_STAGGER_MS);
}

/**
 * Silver-halide grain. Generated once and shared by every waiting photograph;
 * each item shifts it by its own seed, exactly as paper sheets shift theirs.
 *
 * Isotropic and high-contrast, which is where it differs from `paperGrainUrl` —
 * paper is cross-hatched because pulp has a direction, and emulsion has none.
 * The clumps in the second pass are the point: even per-pixel speckle reads as
 * digital noise, and real grain is crystals of assorted sizes.
 *
 * Transparent, so it composites over whatever wash is underneath it rather than
 * needing a blend mode. Blend modes are the other way to do this and they cost
 * a stacking context per item.
 */
let grainUrl: string | null = null;

export function filmGrainUrl(size = 128): string {
  if (grainUrl) return grainUrl;

  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";

  // Fixed seed, not a board seed. This tile is shared by every item on every
  // board, so there is nothing for a per-board seed to vary.
  const rng = mulberry32(0x5f1cd0);

  const image = ctx.createImageData(size, size);
  const data = image.data;
  for (let i = 0, p = 0; i < size * size; i++, p += 4) {
    // Signed: half the crystals are brighter than the emulsion and half darker,
    // so the tile has a mean of zero and does not lift or sink the wash under it.
    //
    // Warm-white and warm-black rather than 255 and 0. Neutral speckle over a
    // warm ground is what made the first version of this read as poured concrete
    // — the grain sat on top of the emulsion colour instead of belonging to it.
    const v = rng() - 0.5;
    const light = v > 0;
    data[p] = light ? 255 : 34;
    data[p + 1] = light ? 246 : 25;
    data[p + 2] = light ? 230 : 16;
    // Cubed, so most of the field is nearly clear and the visible crystals are
    // a scatter rather than a carpet. A linear ramp gives every pixel a
    // noticeable value, which is television static — the thing grain is not.
    data[p + 3] = Math.round(Math.abs(v * 2) ** 3 * 40);
  }
  ctx.putImageData(image, 0, 0);

  // Clumps: a scatter of soft, slightly larger crystals over the fine speckle.
  for (let i = 0; i < size * 0.9; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const r = 0.5 + rng() * 1.3;
    ctx.fillStyle = rng() < 0.5 ? "rgba(255,248,235,0.06)" : "rgba(28,20,12,0.07)";
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  grainUrl = canvas.toDataURL("image/png");
  return grainUrl;
}
