/**
 * What a string is *made of*.
 *
 * > | Restyle | Context menu | Colour (red is default — also blue, green,
 * > yellow, black, white), thickness, material (string / yarn / wire)
 * > — DESIGN section 3.4
 *
 * > | `material` | plain string | `'string' | 'yarn' | 'wire'` — affects sag
 * > stiffness and texture. — DATA-MODEL section 5
 *
 * Two words in the schema, and they are the whole specification: **sag
 * stiffness** and **texture**. So this file is a table of five numbers with an
 * argument for each, and the two readers take three of them each.
 *
 * ## Why sag is a multiplier on slack rather than a stiffness in the solver
 *
 * The physically-literal reading is that wire resists bending, which means a
 * bending term in `verlet.ts` — a second constraint, per particle, on every
 * awake rope, competing for the substep budget `tuning.ts` argues over at
 * length. It would also fight the sleep rule: a bending constraint that is
 * still relaxing is a rope that is still moving.
 *
 * The multiplier gets the same picture for nothing. Slack is a ratio and rest
 * length is `chord × (1 + slack)` (DATA-MODEL section 5.2), so scaling the
 * slack scales how much string there is between two pins — and a taut span of
 * wire and a stiff one *look the same*, because the thing you see is the depth
 * of the belly. Wire at 0.3 hangs like string at about 0.1, which is what a
 * coat-hanger between two pins does.
 *
 * The tell would be a wire pulled into a deep drape and refusing to bend, and
 * there is no such gesture: slack is authored, so a wire the user has hauled to
 * 2.0 is a wire they have asked to hang, and it hangs — less than yarn would,
 * which is the whole of what AC-268 asks for.
 *
 * What is *not* bought: a plucked wire should ring longer and higher than yarn,
 * because damping is a property of the fibre. That is `ROPE_DAMPING`, one
 * global in `tuning.ts`, and per-material damping is a change to `verlet.ts`'s
 * signature rather than to this table. Worth doing; not this task.
 *
 * ## Why here
 *
 * The same argument `palette.ts` and `slack.ts` make. `lib/` is dependency-free
 * and importable by anyone, and this is the only place `sim/`, `render/`, `ui/`
 * and `crdt/ops/` can all reach: the solver needs the sag, the painter needs the
 * texture, the menu needs the list to draw chips of, and the op needs the
 * default to create a string with. `crdt/schema.ts` keeps its own fallback,
 * because that one is an invariant it enforces on everything a peer sends
 * rather than policy about what an untouched string looks like — the same split
 * `slack.ts` draws between `DEFAULT_SLACK` and `MIN_SLACK`, and
 * `material.test.ts` holds the two together so they cannot drift in silence.
 */

import { MIN_SLACK } from "@/lib/slack";

/**
 * One of the three.
 *
 * `sag` is read by `sim/ropes.ts`; `weight`, `sheen`, `gloss` and `halo` are
 * read by `render/ropes/paint.ts`. Nothing reads all five, and that is the
 * seam: a material is a physical fact about a fibre, and the two consumers
 * disagree only about which half of it they care about.
 */
export interface StringFibre {
  readonly id: "string" | "yarn" | "wire";
  /** What the menu says out loud. */
  readonly label: string;
  /**
   * Multiplies the authored slack to give the sag the solver actually hangs.
   * Below 1 is stiff, above 1 is limp — see the argument above.
   */
  readonly sag: number;
  /** Multiplies the drawn body width. A fibre's thickness is a fact about the
   *  fibre; the ladder in `palette.ts` is what the user asked for on top. */
  readonly weight: number;
  /** Multiplies the highlight's lift toward white — how bright the specular is. */
  readonly sheen: number;
  /** Multiplies the highlight's width — how *tight* the specular is. Bright and
   *  narrow reads as hard; dim and wide reads as soft. */
  readonly gloss: number;
  /** Alpha of an extra wide pass under the body, which is what stray fibres
   *  look like from a distance. Zero for anything that does not have any. */
  readonly halo: number;
}

/**
 * The three, in DESIGN section 3.4's order — plain string first, because it is
 * the default and because the other two are described against it.
 *
 * The numbers are all *relative to string*, which is why every one of string's
 * is exactly 1 and 0: a board built before this file existed is entirely plain
 * string, and it must not move or change colour on the frame this ships. That
 * is a stronger constraint than it looks — it rules out re-centring the scale
 * so that string sits in the middle of the two, which would have been the
 * tidier table and would have re-posed every rope on every existing board.
 *
 * - **Yarn** is wool: thick, limp and fuzzy. It hangs further because there is
 *   no stiffness in it at all, it draws half again as wide, and its highlight
 *   is dim and spread because light lands on a hundred fibre ends rather than
 *   on a cylinder. The halo is what those ends look like at any distance.
 * - **Wire** is picture wire: thin, stiff, and the only thing on the board with
 *   a real specular. A third of the sag, a fraction under the width, and a
 *   highlight pushed bright and squeezed narrow, which is the whole difference
 *   between metal and cotton in three strokes.
 */
export const STRING_MATERIALS: readonly StringFibre[] = [
  { id: "string", label: "String", sag: 1, weight: 1, sheen: 1, gloss: 1, halo: 0 },
  { id: "yarn", label: "Yarn", sag: 1.5, weight: 1.5, sheen: 0.5, gloss: 1.5, halo: 0.5 },
  { id: "wire", label: "Wire", sag: 0.35, weight: 0.8, sheen: 1.75, gloss: 0.6, halo: 0 },
];

/** > `'string' | 'yarn' | 'wire'` — DATA-MODEL section 5. The first is what a
 *  new string gets, and what an unreadable value falls back to. */
export const DEFAULT_STRING_MATERIAL = STRING_MATERIALS[0]!.id;

/**
 * Look one up. An unknown name — a peer running a later version, a hand-edited
 * document — comes back as plain string rather than throwing, because this is
 * called from inside the frame loop and DATA-MODEL section 8.1's rule for a
 * field it cannot make sense of is to render something rather than nothing.
 */
export function fibre(material: string): StringFibre {
  for (const entry of STRING_MATERIALS) if (entry.id === material) return entry;
  return STRING_MATERIALS[0]!;
}

/**
 * The slack the solver should hang, given what the document authored and what
 * the string is made of.
 *
 * Clamped at the bottom to `MIN_SLACK` for exactly the reason that constant
 * exists:
 *
 * > At rest length equal to the chord the solver has no slack to absorb error
 * > and the rope jitters visibly.
 *
 * The schema enforces that floor on the *authored* number, and a stiffness
 * multiplier is the one thing that can push a legal value back under it — wire
 * at the minimum slack is a third of the minimum. So the floor is re-applied
 * here, on the effective figure, which is the one the solver actually sees.
 * Without it the stiffest material would be the one that jitters, which reads
 * as wire being broken rather than as wire being stiff.
 */
export function sagFor(slack: number, material: string): number {
  return sagWith(slack, fibre(material).sag);
}

/**
 * The same, given a multiplier that is already resolved.
 *
 * Which is not the same question, because `sim/ropes.ts` does not hand the
 * solver a material's number directly — it *eases* toward it over a couple of
 * hundred milliseconds, and what the rope hangs at meanwhile is a value that is
 * between two materials and is not either of them. See `MATERIAL_EASE`.
 */
export function sagWith(slack: number, multiplier: number): number {
  return Math.max(MIN_SLACK, slack * multiplier);
}
