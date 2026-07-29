# The board's hand

`patrick-hand.woff2` is Patrick Hand, chosen in T-81 (Q-101) out of four
candidates rendered on the same board. It is the face DESIGN 4.8 asks for, minus
the word "connected": a letter that leans has to be its own inline box, so no
face on this board can join or kern across letters, and an unjoined print hand
is the one that loses least to that.

It is Google's latin subset of the family — 23 KB, the same bytes their CSS API
serves — not the full face, and not a subset made here. Downloaded from
`fonts.gstatic.com`; `OFL.txt` is the family's licence from `google/fonts`, and
the SIL Open Font License requires it to travel with the font.

Served from `public/` rather than imported, so the URL is stable enough for the
`<link rel="preload">` in `index.html`. That preload is not a nicety: the face is
applied to glyph boxes whose advances differ from the fallback's, and the caret
lives in a `<textarea>` that can only ever hold plain text, so a swap after first
paint re-wraps the note (see `render/items/items.css`).

To change the face, replace both files and this README, and re-measure the two
things in `items.css`: that the paper and the field still agree on where a line
breaks, and that the size still matches the paper it is written on.
