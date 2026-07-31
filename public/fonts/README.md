# The board's two faces

## `patrick-hand.woff2` — the hand

Patrick Hand, chosen in T-81 (Q-101) out of four candidates rendered on the same
board. It is the face DESIGN 4.8 asks for, minus the word "connected": a letter
that leans has to be its own inline box, so no face on this board can join or
kern across letters, and an unjoined print hand is the one that loses least to
that.

It is Google's latin subset of the family — 23 KB, the same bytes their CSS API
serves — not the full face, and not a subset made here. Downloaded from
`fonts.gstatic.com`; `OFL-patrick-hand.txt` is the family's licence from
`google/fonts`, and the SIL Open Font License requires it to travel with the
font.

## `source-sans-3.woff2` — the clean one

Source Sans 3, chosen in T-243 (Q-166) out of three rendered on the board on
legal pad, so the ruling was a shared ruler. It is DESIGN 3.6's "clean typeface
available per item for anyone pasting something they actually need to read", and
an item reaches it by carrying `style.fontFamily` of `clean` — `lib/style.ts`.

Same provenance: Google's latin subset, 15 KB, licence in
`OFL-source-sans-3.txt`.

Bundled rather than a system stack, on the argument Q-100 made for the hand one
level down: a stack would make one shared board three different boards, and a
note somebody has chosen the clean face for is precisely a note whose exact
wrapping matters.

Unlike the hand it goes down as a **single text node** rather than a box per
glyph, which is what lets it kern. That is the trade it exists to offer.

## Both are served from `public/`

Rather than imported, so the URL is stable enough for the `<link rel="preload">`
in `index.html`. That preload is not a nicety: the face is applied to glyph boxes
whose advances differ from the fallback's, and the caret lives in a `<textarea>`
that can only ever hold plain text, so a swap after first paint re-wraps the note
(see `render/items/items.css`).

`render/items/raster.ts` carries **both** URLs in `BOARD_FONT_URLS`, because a
`data:` SVG cannot resolve a relative one and a font it cannot reach fails
silently — the writing comes out in whatever the machine has, wrapping
differently, with nothing in the file to say so.

## To change or add a face

Replace the woff2, replace its licence, update this README, add the URL to
`BOARD_FONT_URLS`, and **re-measure the two things**: that the paper and the
editing field still agree on where a line breaks, and that the size still matches
the paper it is written on.

The second is not optional and is not a taste call. A size is a property of the
face. Measured against Patrick Hand's own advance for one line of a note at 19px,
the three T-243 candidates needed 16.5px (Source Sans 3), 14.5px (Source Serif 4)
and 11.5px (IBM Plex Mono) to occupy the same width — at their nominal 19px the
serif ran four authored lines to six and the mono overflowed the sheet entirely.
`line-height` stays at 22px whatever the face, because it is the legal pad's rule
spacing rather than a typographic choice.
