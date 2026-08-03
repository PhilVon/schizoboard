/**
 * The three objects a file that is not a photograph becomes, and what is
 * written on them.
 *
 * > | Kind | Object | Label |
 * > | Document | Manilla folder | Filename typed on the tab as the case number,
 * >   extracted title written under it |
 * > | Video | VHS cassette | Title and runtime on the spine |
 * > | Audio | Compact cassette | Title and duration on the J-card |
 * > — D-46 section 1
 *
 * Pure, and here rather than in `render/` for the reason `lib/polaroid.ts` is:
 * `app/ingest.ts` has to know how big a cassette is before there is anything to
 * render, and `crdt/schema.ts` has to know what a mime means before there is a
 * board. Both are below the renderer and neither may import it.
 */

// --- what a file is ---------------------------------------------------------

/**
 * What a file is, as far as the board is concerned — which is to say, which
 * object it becomes on the wall.
 *
 * > No new item types. The face is chosen from the asset's mime.
 * > — D-46 section 2
 *
 * `unknown` is not a face. It is a file this build cannot place, and it exists
 * so that `readAsset` can tell "a record describing something we do not
 * understand" from "a record describing a cassette", which are different
 * amounts of missing.
 */
export type AssetKind = "image" | "video" | "audio" | "document" | "unknown";

/**
 * The one place a mime becomes a kind.
 *
 * Derived rather than stored, and that is a decision rather than an omission
 * (Q-208): every asset record already on a board — every photograph anybody has
 * pasted since T-21 — was written before this existed, so a record without a
 * kind has to be classifiable anyway. Writing the kind as well would make it a
 * second statement of a fact the mime already makes, and two writers of one
 * fact can disagree where a derivation cannot.
 *
 * The cost, stated plainly: a peer on a later build that understands some mime
 * this one has never heard of gains nothing by knowing what it is. An
 * unfamiliar mime is unfamiliar here, permanently.
 */
export function assetKind(mime: string): AssetKind {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf") return "document";
  // The other kind of document, and the same object on the wall (Q-255). The
  // shell has one mime for all of it — a `.md`, a `.csv` and a `.log` are told
  // apart by their names and a name is not evidence the store keeps — so this
  // is a prefix for the same reason the three above are, and the folder does
  // not care which sort of text it is holding.
  if (mime.startsWith("text/")) return "document";
  return "unknown";
}

/**
 * Whether a file of this kind can be carrying a name of its own.
 *
 * The gate in front of the title probe (Q-211), and it is a gate rather than a
 * shrug because the probe is a round trip to the shell and a read off the disk:
 * a board of three hundred photographs would otherwise ask three hundred times
 * and be told nothing three hundred times.
 *
 * A **photograph is not on the list.** What a JPEG carries is EXIF, which says
 * what took it and when rather than what it is, and D-46 gives a polaroid a
 * caption in the person's own hand instead — a name somebody wrote beats one a
 * camera generated. `unknown` is not on it either: there is no container to ask.
 *
 * The three that are on it each have a field for it and each want it on a label:
 * a folder's tab, a spine, a J-card.
 */
export function carriesItsOwnName(kind: AssetKind): boolean {
  return kind === "document" || kind === "video" || kind === "audio";
}

/**
 * Whether this kind has something inside it to be opened — read, watched or
 * heard (T-274, Q-257).
 *
 * The same three as {@link carriesItsOwnName}, today, and written out again
 * rather than aliased because **they are two facts that happen to agree**. One
 * is about a container having a name in it; this one is about a container
 * having *content* in it. A photograph could earn an open — D-46 refuses it a
 * name from its EXIF and says nothing at all about a lightbox — and the day one
 * of the two moves, an alias would move the other with it silently.
 *
 * `unknown` is not on the list and cannot be: this build does not know what the
 * file is, so it has nothing to open it *as*. An object that offers to open and
 * then cannot is the failure D-46 section 6 names about embedded players — "an
 * object that lies about being playable is worse than not supporting the site".
 */
export function canBeOpened(kind: AssetKind): boolean {
  return kind === "document" || kind === "video" || kind === "audio";
}

/**
 * Whether this kind is one of D-46 section 1's three objects — the manilla
 * folder, the VHS and the compact cassette — rather than a photograph.
 *
 * **Derived rather than a fourth list of the same three names.** The family is
 * exactly the kinds that have an object size: a photograph's shape is a fact
 * about its bytes and `polaroidFor` answers for it, an unknown never gets past
 * the gate, and everything else is one of the three. Writing the names out
 * again is how a fourth reader of one fact starts disagreeing with the other
 * three.
 *
 * It exists because a case object is *made of its own furniture* — kraft, a
 * spine, a J-card — and several menus need to know that. There is no paper
 * stock to choose for a folder and no hand to set a cassette's label in.
 */
export function isCaseObject(kind: AssetKind): boolean {
  return objectSizeFor(kind) !== null;
}

/**
 * What to call the file behind an item when it is handed back to the disk.
 *
 * A photograph was the only thing an item could wear when that row was written,
 * so it said so; T-260 opened the gate to four kinds and the row was not told
 * (T-317). The verb underneath was right the whole time — the original bytes,
 * under a name from the store — so this is what it should have been calling
 * them, in the idiom D-46 section 1 already uses for the objects themselves.
 */
export function fileNoun(kind: AssetKind): string {
  switch (kind) {
    case "image":
      return "photograph";
    case "document":
      return "document";
    case "video":
      return "film";
    case "audio":
      return "recording";
    default:
      return "file";
  }
}

// --- how big each one is ----------------------------------------------------

/**
 * Board units per millimetre, for the three objects.
 *
 * They are in true proportion to *each other* — a case file really is two and a
 * half times the width of a cassette — and knocked back against a photograph,
 * which is not in the same scale at all. `lib/polaroid.ts` puts a print's 136 mm
 * long edge at 300 units, which is 2.2 units to the millimetre; at that scale a
 * letter-size folder would be 539 units across and would be the only thing on
 * the wall. So the family gets its own scale, chosen so the largest of the three
 * sits alongside the largest note (`NOTE_MAX_W`, 380) rather than dwarfing it.
 *
 * A single number for all three, rather than three sizes picked by eye, because
 * the relative sizes are the whole point: what says one of these is a cassette
 * and not a tape is being two thirds the size of the tape beside it.
 */
const UNITS_PER_MM = 1.55;

/**
 * A folder, closed, holding **A4 lying horizontal** — which is what settles both
 * of its numbers rather than a guess at either.
 *
 * A4 is 297 by 210 mm, so a folder for it is a little over 297 across and a
 * little over 210 down: wide and flat, and flatter than any of the three
 * attempts before this one. It was portrait first, on the reasoning that a
 * folder holds portrait paper, then landscape at 300 by 247 from the shape of
 * the reference photograph — and still too tall, because that shape was being
 * eyeballed rather than derived from the sheets inside it.
 *
 * The same 1.55 units to the millimetre as the tape and the cassette, so all
 * three stay in true proportion to each other.
 */
const FOLDER_MM = { w: 310, h: 222 } as const;
/** A VHS cassette: 187 x 103 x 25 mm, seen face on. */
const VHS_MM = { w: 187, h: 103 } as const;
/** A compact cassette: 100 x 64 x 12 mm. */
const CASSETTE_MM = { w: 100, h: 64 } as const;

export interface ObjectSize {
  w: number;
  h: number;
}

function units(mm: { w: number; h: number }): ObjectSize {
  return { w: Math.round(mm.w * UNITS_PER_MM), h: Math.round(mm.h * UNITS_PER_MM) };
}

/**
 * **A4 upright, in board units** — the sheet a case file holds, and the sheet the
 * reading surface draws on (T-319).
 *
 * It is here rather than in the renderer because it is the *other half* of
 * `FOLDER_MM`. The folder above is 310 by 222 mm "holding A4 lying horizontal",
 * so these two numbers and those two are one decision: turn the folder up to
 * read it and this sheet stands portrait inside it with about six millimetres of
 * board showing either side, which is what the reference photograph shows.
 *
 * `items.css` writes the same sheet as a percentage of the folder, because that
 * is the only form a stylesheet can hold it in, and `folder-open-css.test.ts`
 * asserts the two agree. This is the writer; the percentages are the copy.
 */
export const A4_UNITS: ObjectSize = units({ w: 210, h: 297 });

/**
 * The type a page inside a case file is set in, as a fraction of the folder's
 * width — 0.01746 of 481 units, which is 8.4.
 *
 * Here beside `A4_UNITS` and the folder it belongs to, rather than in the
 * renderer that draws it, because **two sides need it and neither owns it**.
 * `render/items/dom.ts` sizes the page with it; `app/main.ts` derives the zoom a
 * camera has to reach for that page to be legible (`readingZoomFor`). A number
 * exported from the renderer to the wiring module would be a layout constant
 * doing camera work from the wrong side of a boundary.
 *
 * It was **measured rather than derived**, and the measurement is written up on
 * T-320: a glyph in the board's hand advances 0.377 em on average, so the
 * sheet's 277.8-unit measure holds about 85 characters at this size, and a page
 * of real prose draws in 34 lines of the 37 that fit. Deriving it twice, from
 * the printed measure a text face would have, gave 6.8 and left the bottom two
 * fifths of every page blank.
 */
export const PAGE_TEXT_SIZE = 0.01746;

/**
 * How big a file's object is, before a byte of it has arrived — and there is no
 * "before" about it, because none of the three has a size that depends on its
 * contents. A photograph is the odd one out on this board: it is the only thing
 * whose shape is a fact about the bytes, which is why `polaroidFor` takes the
 * pixel dimensions and this takes nothing but the kind.
 *
 * `null` for a picture and for an unknown, both of which are somebody else's
 * question — `polaroidFor` answers the first and the gate refuses the second.
 */
export function objectSizeFor(kind: AssetKind): ObjectSize | null {
  switch (kind) {
    case "document":
      return units(FOLDER_MM);
    case "video":
      return units(VHS_MM);
    case "audio":
      return units(CASSETTE_MM);
    default:
      return null;
  }
}

/**
 * A business card: 85 by 55 mm, at the family's 1.55 units to the millimetre —
 * 132 by 85 units, and the smallest object on the board (T-339).
 *
 * Here, beside the folder and the two tapes, because it is the same kind of
 * fact: an object with a real size, whose proportions are not a taste call. The
 * 85 by 55 is ISO 7810 ID-1, which is a credit card and is also what nearly
 * every business card outside North America is cut to, and being *the* card
 * size is most of what makes the shape recognisable at a glance.
 *
 * It is deliberately not `objectSizeFor`'s business, and that is the whole
 * modelling difference this task turns on. Those three sizes are chosen from
 * the file's **kind** — a PDF is a folder, an mp4 is a tape — and this one
 * cannot be, because the file behind a link card is a jpeg and a jpeg is a
 * photograph. What makes it a card is that the *item* has a `source`: it is not
 * a picture that came from a page, it is an object about a page that happens to
 * have a picture. `render/items/dom.ts`'s `archetypeOf` is where that reading is
 * written down; this is its size.
 *
 * The smallest of the family and it should be. A card is a small object, and
 * one that arrived the same size as the tape beside it would be claiming to
 * hold something.
 */
export const CARD_UNITS: ObjectSize = units({ w: 85, h: 55 });

/**
 * What the page an item stands in for was **about** — T-342, and the one bit
 * that separates the two objects a link can become.
 *
 * A business card and a printed still are both an item with a `source` and a
 * picture, so `source` alone cannot choose between them and D-63's rule needed
 * one more fact. This is it, and the direction it is written in is the whole
 * decision:
 *
 * - It names **what the page was**, never what the object should look like. A
 *   value spelling `card` or `still` would be storing a *face*, which D-46
 *   section 2 forbids for a reason that has not changed — a face an older build
 *   has never heard of is an item it cannot draw.
 * - `page` is the page talking about itself: an article, a repository, a recipe.
 *   The picture it offers is a banner, so it becomes the card's paper.
 * - `media` is a page about a film or a recording it would not hand over — a
 *   watch page, a track page. The picture it offers is a *still of the thing*,
 *   so it stays the subject, and the object is a photograph with the address
 *   written under it. T-290's title, restored.
 *
 * A string rather than a boolean because there are already three outcomes — the
 * third being a page that hands the file over, which never gets here because it
 * became the file — and a fourth is easy to imagine. Two booleans is how a
 * field grows a state that cannot happen.
 *
 * **Absent reads as `page`**, which is both the common case and the honest
 * reading of an item written before this existed: nobody asked. The cost is that
 * a watch page pasted before this stays a card until it is pasted again.
 *
 * Declared here rather than in `crdt/schema.ts` so there is exactly one of it.
 * `state/scene.ts` may not import from `crdt/`, and a union restated on both
 * sides of that boundary is the shape `tests/pin-kinds.test.ts` exists to guard
 * — `lib/` is below both, so nothing has to be held together by a test.
 */
export type SourceAbout = "page" | "media";

/**
 * The sheet inside an open case file, **in the folder's own unrotated frame** —
 * which is the frame ink is stored in, and the reason this exists (T-278).
 *
 * `items.css` already draws this box, as two percentages of the folder, and the
 * comment above `.folder-page` works the arithmetic out longhand. What it cannot
 * do is hand the numbers to anything: a mark on a page has to stop where the
 * paper stops, and the pen, the wet stroke and the raster all ask in board units
 * about an item's local frame. So the stylesheet keeps the copy it can express
 * and this is the writer, exactly as `A4_UNITS` is the writer of the percentages
 * — `folder-open-css.test.ts` is what holds the two together.
 *
 * **The swap is the quarter turn.** The sheet is A4 upright inside the folder
 * and then rotated -90 degrees to lie in it the way paper actually lies in a
 * folder, so the box it ends up occupying is A4's *height* across and its
 * *width* down. Taking `w` and `h` rather than reading `objectSizeFor` is what
 * keeps that true of a folder somebody has resized: both axes are a proportion
 * of the item, which is what a CSS percentage is.
 */
/**
 * How far the sheet is turned inside the folder — a quarter, anticlockwise.
 *
 * The angle behind [`openSheetOf`]'s swap, named because two things now need it
 * as a *number* rather than as a swap. `Scene.setOpen` turns the item by +90°
 * and this is the -90° that cancels it, which is what leaves the page upright on
 * screen and `text.rs`'s 66-by-46 grid the right way round.
 *
 * The second thing is cutting a clipping (T-282). A clipping is rasterised in
 * the item's own frame — that is the only frame the rectangle is square in — and
 * in that frame the page lies on its side. Turning the lifted canvas back by
 * this is what makes the clipping the right way up, and doing it with the same
 * constant the sheet's box comes from is what stops the two drifting apart.
 *
 * `folder-open-css.test.ts` holds this against the stylesheet's own
 * `rotate(-90deg)`.
 */
export const OPEN_PAGE_TURN = -Math.PI / 2;

export function openSheetOf(w: number, h: number): ObjectSize {
  const folder = units(FOLDER_MM);
  return { w: (h * A4_UNITS.h) / folder.h, h: (w * A4_UNITS.w) / folder.w };
}

// --- what is written on them ------------------------------------------------

/**
 * A runtime, as a spine says it.
 *
 * Hours only when there are any, because `0:03:07` on a three minute recording
 * is a clock rather than a label. Rounded to the second: the number came off a
 * container header and the last decimal of it is not a fact about the tape.
 *
 * `""` for no measurement, which is what an unmeasured tape has written on it.
 * Zero is a measurement and reads as `0:00` — a recording with nothing in it,
 * which is a true and useful thing for a spine to say.
 */
export function runtimeLabel(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return "";
  const whole = Math.round(seconds);
  const s = whole % 60;
  const m = Math.floor(whole / 60) % 60;
  const h = Math.floor(whole / 3600);
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}

/**
 * A page count, as a folder says it.
 *
 * `pp.` because that is what a page count is written as on a thing that holds
 * pages, and because `142 pages` is a sentence where `142 pp.` is a label.
 */
export function pagesLabel(pages: number | null): string {
  if (pages === null || !Number.isFinite(pages) || pages < 0) return "";
  const whole = Math.floor(pages);
  return whole === 1 ? "1 p." : `${whole} pp.`;
}

/**
 * The longest a line off an item's `source` may be before it is cut.
 *
 * `source` is a field in a shared document, so it is a string a peer chose and
 * this build has no say in its length. CSS already stops a long address showing
 * — one line, ellipsised — but it does not stop it being *in the DOM*, and a
 * card wearing a megabyte of text node is a card that costs a megabyte to lay
 * out on every bind. Two hundred is far past any address anybody would put on a
 * card and far short of anything that costs.
 */
const ADDRESS_MAX = 200;

/**
 * Who the card is *from*, as a business card says it — the host, which is the
 * nearest thing a page has to a company name.
 *
 * Not `og:site_name`, which the page usually also declares and which is not
 * stored: it would be a second field on the item saying a thing the address
 * already says, and it would be absent on exactly the pages that have no title
 * either. The host is on every link by construction, it is what a person reads
 * to know where something came from, and it needs nothing crossing the wire
 * that is not crossing already.
 *
 * `www.` comes off because nobody has said it out loud since about 2005 and no
 * card has ever been printed with it.
 *
 * `""` for anything that will not parse. This reads a field a peer wrote, so
 * "will not parse" is an ordinary state rather than a bug, and a card with no
 * company line is a card — where a card with the word `undefined` on it is a
 * defect somebody would have to report.
 */
export function siteLabel(url: string): string {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return "";
  }
  return host.startsWith("www.") ? host.slice(4) : host;
}

/**
 * The address itself, as it is printed on the card — the scheme taken off, for
 * the reason `www.` comes off the line above it.
 *
 * `https://` is not information. It is on essentially every link, it is what
 * the person's browser would put back for them, and eight characters of it at
 * the head of a five-point line on a 55 mm card is a real fraction of the only
 * line that says where this thing actually goes.
 *
 * The *stored* `source` keeps its scheme and is the one that gets opened — this
 * is a label and nothing reads it back. That split is why taking the scheme off
 * here is safe: `app/main.ts` validates `^https?://` against the field, not
 * against what is written on the object.
 */
export function addressLabel(url: string): string {
  const bare = url.replace(/^https?:\/\//i, "").replace(/^www\./i, "");
  const cut = bare.length > ADDRESS_MAX ? bare.slice(0, ADDRESS_MAX) : bare;
  // A trailing slash on a bare host is punctuation the page put there.
  return cut.endsWith("/") ? cut.slice(0, -1) : cut;
}

/**
 * How much paper a folder is holding, `0` to `1`, from how many pages it holds.
 *
 * **Logarithmic, because paper is thin and reading is not.** A sheet is about a
 * tenth of a millimetre, so three pages and thirty are three millimetres apart
 * on a desk — a difference nobody could point to across a room, and this object
 * is looked at across a board. Three hundred is not that: it is a different
 * thing to pick up. What a person actually reads off a closed folder is the
 * *order* of magnitude, so that is what is drawn.
 *
 * {@link BULK_FULL} is where it stops. Past about five hundred sheets a manilla
 * folder is not fuller, it is failing — the fold has run out and the paper is
 * holding the shape. Drawing more would mean drawing a folder that cannot be
 * closed, and the object stops being the one it is.
 */
export function folderBulk(pages: number | null): number {
  // Not knowing is its own reading, and it is common: `pages` arrives with the
  // asset record, which is a peer's write and may be a network away (Q-211), and
  // a document this build cannot count pages in has none at all. A folder in
  // that state is drawn as a folder with something in it, because that is the
  // one thing that is certainly true of it.
  if (pages === null || !Number.isFinite(pages) || pages < 1) return BULK_UNKNOWN;
  return Math.min(1, Math.log(pages) / Math.log(BULK_FULL));
}

/** The page count that fills a folder. Past it, the fold has run out. */
const BULK_FULL = 500;

/**
 * What a folder looks like when nobody has said how many pages are in it.
 *
 * Deliberately not `0`: an empty folder is a *statement* — nobody has put
 * anything in this — and it is the wrong thing to say about a document that is
 * simply still being counted. Around twenty pages, which is where a folder
 * reads as holding something without reading as holding much.
 */
const BULK_UNKNOWN = 0.48;

/** Everything after the last dot, lowercased, or `""`. */
function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  // A leading dot is a hidden file's name, not an extension.
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** A name with its extension taken off. */
function stem(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * The applications a `/Title` names when it is naming the file this was printed
 * *from* rather than naming the document.
 *
 * Measured, not guessed: D-47 swept 7,897 real PDFs and found this shape all
 * over the corpus — `MPI Log book.cdr` on `MPI Log book.pdf`, `WAYNE LABELS.cdr`
 * on `cat paper labels.pdf`. Drawing offices and print shops print to PDF out of
 * a design tool and the tool writes its own document name into `/Title`.
 *
 * `pdf` is in the list because a producer that copied the output filename into
 * the title has told us nothing either.
 */
const AUTHORING_EXTENSIONS: ReadonlySet<string> = new Set([
  "cdr", "ai", "psd", "indd", "eps", "sla", "qxd", "qxp",
  "doc", "docx", "odt", "rtf", "pages", "wpd", "tex", "fm",
  "xls", "xlsx", "ods", "ppt", "pptx", "odp", "pub",
  "dwg", "dxf", "vsd", "pdf",
]);

/** `Untitled`, `Untitled-2`, `untitled 3` — a tool's placeholder, never a name. */
const PLACEHOLDER = /^untitled(?:[-_ ]?\d+)?$/i;

/** Anything with a letter in it. A title of `1` is not a title. */
const HAS_A_LETTER = /\p{L}/u;

/**
 * The title a folder is prepared to write under its case number, or `""`.
 *
 * **The line is earned rather than shown**, and D-47 is why. A `/Title` is
 * present on about a third of real multi-page documents and is junk about half
 * of the times it is there: the design file it was printed from, the authoring
 * tool's placeholder, a bare number, or the filename over again. Printing all of
 * them would put a second line of noise under a third of the folders on the
 * board, and a wrong name on a piece of evidence is worse than no name.
 *
 * Four refusals, each one a row of D-47's table:
 *
 * - the filename again, with or without an extension between them
 * - a name whose extension belongs to an authoring tool
 * - `Untitled-1`
 * - a title with no letter in it
 *
 * What survives is the case the feature exists for: `Configure Virtual Hosts` on
 * `configure-vhosts.pdf`, which says something the filename does not.
 *
 * The one shape this cannot catch is the producer *template* — `A4 Service
 * Inv\Crd Without Discount` is the deliberate `/Title` of more than a hundred
 * distinct invoices on the machine D-47 swept, and nothing inside any one of
 * them says it is not a title. Only seeing it twice does, and one folder cannot.
 *
 * This is presentation hygiene rather than interpretation. Nothing here reads
 * the document or decides what it is about; it declines to write down a string
 * that is demonstrably not a name.
 */
export function titleWorthWriting(title: string, filename: string): string {
  const clean = title.trim();
  if (clean.length === 0) return "";
  if (!HAS_A_LETTER.test(clean)) return "";
  if (PLACEHOLDER.test(clean)) return "";
  if (AUTHORING_EXTENSIONS.has(extension(clean))) return "";

  const name = filename.trim();
  if (name.length > 0) {
    const bare = stem(name).toLowerCase();
    // Both ways round, and with the extensions off both, because the common
    // case is the same words wearing a different suffix.
    if (clean.toLowerCase() === bare || stem(clean).toLowerCase() === bare) return "";
  }
  return clean;
}

/**
 * Rough advance width of the clean face, uppercased and letterspaced, as a
 * fraction of its own size.
 *
 * An estimate on purpose, and the same estimate `app/ingest.ts` makes for a
 * note's wrap: measuring would mean a layout read, and this runs in a bind.
 * Being a little high is the safe direction — it undershoots the size and
 * leaves a gap, where being low would clip the name it exists to show.
 */
const TYPED_ADVANCE = 0.62;

/**
 * How small a label will go before it gives up and truncates, as a fraction of
 * the size it wanted.
 *
 * A person with a long name and a small tab writes smaller, and then stops and
 * abbreviates. So does this. The floor is what keeps a forty-character filename
 * from writing the tab in something nobody can read at any zoom — past it the
 * name is cut with an ellipsis instead, which at least says it was cut.
 *
 * A half, and the half is measured rather than chosen: a third-cut tab on a
 * 380-unit folder has about 110 units of room, and `configure-vhosts` — sixteen
 * characters, a real filename off the corpus D-47 swept — needs to come down to
 * 11 px to fit it. At 0.62 the floor stopped it two points short and the tab
 * read `CONFIGUR…`, which is a worse label than a small one.
 */
const LABEL_FLOOR = 0.5;

/**
 * Rough advance width of a business card's title face — Source Sans 3 at 600,
 * letterspaced a hair tight — as a fraction of its own size.
 *
 * `fitLabel`'s constant for the third face on this board, and measured in the
 * running webview like the hand's rather than estimated like the tab's, because
 * what it decides is whether a *host* fits: a card's top line is the page's own
 * title, and when the page has none the host takes that line (T-339).
 *
 * | what was written | advance |
 * |---|---|
 * | `archive.org` | 0.419 |
 * | `en.wikipedia.org` | 0.430 |
 * | `open.spotify.com` | 0.448 |
 * | `docs.google.com` | 0.468 |
 * | `github.com` | 0.471 |
 * | `news.ycombinator.com` | 0.481 |
 * | `www.theguardian.com` | 0.494 |
 * | `example.com` | 0.505 |
 *
 * **0.52, above every one of them**, on the asymmetry the other two constants
 * state: high leaves a little air at the end of the line, low writes past it.
 * A host is a narrow alphabet — letters, digits, dots and hyphens, no capitals
 * and no `m`-heavy prose — which is why the spread here is tighter than the
 * hand's and why the safe margin can be small.
 */
const CARD_TITLE_ADVANCE = 0.52;

/**
 * The size a typed label has to come down to for `text` to fit `box` units.
 *
 * Never larger than `size` — a short name does not get a bigger tab, because
 * the tab is a physical thing and the type on it is a physical size. And never
 * below the floor, past which the label truncates rather than shrinking on.
 *
 * `advance` is the face's, and the default is the typed one this was written
 * for. It is a parameter rather than a second function because the *rule* is
 * one rule — a label that will not fit is written smaller and then, eventually,
 * cut — and only the alphabet changes between the tab of a folder and the top
 * line of a business card.
 */
export function fitLabel(
  text: string,
  box: number,
  size: number,
  advance: number = TYPED_ADVANCE,
): number {
  if (text.length === 0 || box <= 0) return size;
  const wanted = box / (text.length * advance);
  return Math.max(size * LABEL_FLOOR, Math.min(size, wanted));
}

/**
 * The size a **host** has to come down to for it to fit a card's top line —
 * T-341.
 *
 * ## Why a host is not the title it is standing in for
 *
 * The line is set for a page's own title, which is prose: it wraps, it clamps to
 * two lines, and `overflow-wrap: anywhere` is there so that one long word in a
 * real headline cannot ride out over the edge of the card. A host is not prose.
 * It is a single unbreakable token, so that same rule broke it wherever the line
 * ran out — `news.ycombinator.` on one line and `com` on the next, which is not
 * a name anybody would write on a card.
 *
 * So it is fitted as what it is: a label, in the same words `fitLabel` already
 * uses for a folder's tab. **The card does not grow**, which is the whole of the
 * instruction behind this — an 85 by 55 mm card is a physical object and a long
 * address is not a reason for a bigger one — and it does not silently overflow
 * either. A person with a long name and a small card writes smaller.
 *
 * `measure` and the answer are both in `em` of the block's own type, which is
 * what makes this independent of the card's size: every line on the card is an
 * `em` multiple of one number, so the ratio a host needs is the same whether the
 * card is at its own size or has been dragged out to twice it.
 */
export function fitHost(host: string, measure: number, size: number): number {
  return fitLabel(host, measure, size, CARD_TITLE_ADVANCE);
}

/**
 * Rough advance width of the board's **hand**, as a fraction of its own size —
 * `fitLabel`'s constant for the other face.
 *
 * Measured on Patrick Hand in the running webview rather than estimated, because
 * the estimate that was already in the codebase (`NOTE_CHAR_WIDTH`, 0.482 at a
 * 17 px body) is a different question — a note's *wrap*, where being wrong costs
 * a line of blank paper — and this one decides whether an address survives.
 *
 * | what was written | advance |
 * |---|---|
 * | `abcdefghijklmnopqrstuvwxyz` | 0.402 |
 * | a URL | 0.425 |
 * | ordinary prose | 0.362 |
 * | `ABCDEFGHIJKLMNOPQRSTUVWXYZ` | 0.491 |
 *
 * **0.5, which is above every one of them**, and the asymmetry is deliberate:
 * being high undershoots the size and leaves a little air, being low clips the
 * thing this exists to keep. `fitLabel` states the same rule for the typed face.
 * `writeHand` at full detail sets each glyph as its own inline-block and lays
 * out slightly *tighter* than one text node, so the probe erred the safe way
 * too.
 */
const HAND_ADVANCE = 0.5;

/**
 * How small the hand will go before it gives up and truncates.
 *
 * Lower than `LABEL_FLOOR`, and the difference is what the two surfaces are for.
 * A folder's tab is read across a room, so a tab nobody can read from there has
 * failed at its job. A caption is read by leaning in — on this board, by zooming
 * — and a caption that is small is still a caption, where a caption with the end
 * missing is a different sentence.
 */
const WRITING_FLOOR = 0.4;

/**
 * The line box the board's hand needs, as a multiple of its own size — the same
 * number `items.css` declares as `--hand-line`.
 *
 * T-306 measured it: `1.15` is tighter than Patrick Hand descends, so every `g`,
 * `y` and `j` met the `overflow: hidden` its label carries and was shaved off
 * flat. `1.32` is where the ink stops meeting the edge.
 *
 * Here as well as in the stylesheet because `fitWriting` has to know how tall a
 * line is to know how many fit in a box, and CSS cannot hand a number to
 * arithmetic. `tests/case-fitting-css.test.ts` asserts the two agree — the same
 * arrangement `A4_UNITS` has with the folder's percentages, and for the same
 * reason: one writer, one copy, and a test holding them together.
 */
export const HAND_LINE = 1.32;

/**
 * The size a **caption** has to come down to for all of `text` to fit a box
 * `measure` wide and `height` tall — the second of T-338's two mechanisms.
 *
 * ## Why this exists beside `fitLabel` rather than replacing it
 *
 * They answer the same question for text that fails differently. A label may be
 * shortened: nothing depends on the end of a filename, and a person writing past
 * the end of a tab expects the tab to run out. **A printed still's caption may
 * not.** That object exists *because* the film could not be brought onto the
 * board, so the address is the whole of what it owes anybody — and
 * `https://www.youtube.com/watch?v=dQw4w9WgXcQ` ellipsised after the host has
 * lost the only part that identifies anything. So this one shrinks where
 * `fitLabel` would eventually cut.
 *
 * ## Whole lines, and why it is a search rather than a formula
 *
 * A box does not hold a fraction of a line — the leftover draws a line sliced
 * through, which is the defect the other half of T-338 is about. So the answer
 * is always `height / (n * line)` for some whole `n`, and the only question is
 * which `n`. Capacity grows as roughly `n²` (more lines, each holding more
 * characters at the smaller size), so the smallest `n` that fits is the largest
 * writing, and walking up from one is both correct and short.
 *
 * The rows a string needs are counted the way `noteSizeFor` counts them, hard
 * line breaks included — a caption is a title and an address on two lines, and
 * treating it as one run would say it fits when the break makes it not.
 *
 * Never larger than `size`: a short caption does not get big writing, because
 * the band it sits in is a physical part of the print.
 */
export function fitWriting(
  text: string,
  measure: number,
  height: number,
  line: number,
  size: number,
): number {
  const rows = text.split("\n");
  if (text.length === 0 || measure <= 0 || height <= 0 || size <= 0) return size;

  const floor = size * WRITING_FLOOR;
  // Past this the writing is under the floor whatever it buys, so there is
  // nothing further to try — and the caller gets the floor, at which the box
  // clips and says so with an ellipsis.
  const most = Math.max(1, Math.floor(height / (floor * line)));

  for (let n = 1; n <= most; n++) {
    const at = Math.min(size, height / (n * line));
    if (at < floor) break;
    const perLine = Math.max(1, Math.floor(measure / (at * HAND_ADVANCE)));
    let needed = 0;
    for (const row of rows) needed += Math.max(1, Math.ceil(row.length / perLine));
    if (needed <= n) return at;
  }
  return floor;
}

/**
 * What goes on the tab, typed, as the case number.
 *
 * The filename without its extension. The extension is what a file *is*, and the
 * object it is written on has already said that — a manilla folder does not need
 * `.pdf` after its name to be a document.
 *
 * A file with no name at all is the ordinary case rather than the odd one: a
 * screenshot, a drag out of another window, a paste of raw bytes. Those get the
 * first eight characters of the hash, which is a genuine case number — it is
 * unique to this evidence, it is the same on every machine holding it, and it is
 * what the store already calls the file. Anything else here would be inventing a
 * name for something nobody named.
 */
export function caseNumber(filename: string | null, sha256: string): string {
  const name = (filename ?? "").trim();
  if (name.length > 0) return stem(name);
  return sha256.slice(0, 8).toUpperCase();
}

/**
 * What a citation calls the evidence — the name half of a page reference.
 *
 * **The extension stays on, and that is the one difference from
 * [`caseNumber`].** They are deliberately not the same string. A case number is
 * written on a physical tab, on an object that has already said what it is by
 * being a manilla folder rather than a cassette; `.pdf` after the name there is
 * noise. A citation is the opposite kind of thing: it is read away from the
 * object, on a card that may be across the board from the folder it came out
 * of, by somebody who wants to find the file again. That is what a filename
 * with its extension is *for*.
 *
 * The unnamed case falls back to `caseNumber`'s hash prefix rather than
 * inventing a second answer, because a screenshot or a paste of raw bytes is
 * the ordinary case and the store already calls it that.
 */
export function referenceName(filename: string | null, sha256: string): string {
  const name = (filename ?? "").trim();
  return name.length > 0 ? name : caseNumber(null, sha256);
}

/**
 * A page reference, as a card says it out loud — `scan.pdf p. 4`.
 *
 * ## Why this is a string and not a pair
 *
 * `crdt/ops/quote.ts` takes the reference already in words, and its header says
 * why: the three kinds reference themselves in three different units — a page,
 * a timestamp, a line — and the card only ever says one of them. So the *pair*
 * D-60 defines, `(sha256, page)`, is what the machine cites with, and this is
 * what a person reads. They are different jobs and the card is doing the second
 * one.
 *
 * ## `p. 4` and not `p. 4 of 51`
 *
 * The open sheet's own header reads `4 of 51`, and it is right to: it is a
 * position in something you are holding, and the count is what tells you where
 * in the document you are. A citation is not that. It is a pointer somebody
 * follows back, and `p. 4` is the whole of what they need to follow it — the
 * length of the document is a fact about the folder, which is still on the
 * board with `51 pp.` written on it. Two places saying the same number is two
 * places to get it wrong.
 *
 * A page that is not a real page — a document with none of its own, or a quote
 * of the whole thing — cites the file and stops. That is a weaker reference
 * rather than a broken one, and it is the honest form: there was no page.
 */
export function pageReference(
  filename: string | null,
  sha256: string,
  page: number | null,
): string {
  const name = referenceName(filename, sha256);
  if (page === null || !Number.isFinite(page) || page < 1) return name;
  return `${name} p. ${Math.floor(page)}`;
}

/**
 * The same sentence for a recording — `interview.mp4 12:04`.
 *
 * Here rather than at the gesture that will want it (T-287, a still off a tape)
 * for [`quoteCardText`]'s reason one level up: quoting is the same gesture on
 * all three kinds, and if the three ever disagree about how they name
 * themselves then one of them is wrong. The unit differs because a tape has no
 * pages; the shape must not.
 *
 * No `t.` or `at` before the time, unlike the page's `p.` — a clock is
 * self-announcing in a way a bare integer is not, and `interview.mp4 t. 12:04`
 * reads as a typo. An unmeasured recording cites the file and stops, exactly as
 * a page-less document does.
 */
export function timeReference(
  filename: string | null,
  sha256: string,
  seconds: number | null,
): string {
  const name = referenceName(filename, sha256);
  // **Floored, where a runtime is rounded** — and the difference is what the
  // two numbers are for. A runtime is a length, and a 90.6 second tape is
  // fairly called a minute and a half. A citation is a *place to go and
  // listen*, so it must never name a moment after the words: rounding a line
  // said at 15.6 seconds to `0:16` sends somebody to a point where it has
  // already been said. Half a second is nothing to a duration and is the whole
  // of a short answer. Driven out of a transcript, not reasoned into one.
  const at = runtimeLabel(seconds === null ? null : Math.floor(seconds));
  return at === "" ? name : `${name} ${at}`;
}
