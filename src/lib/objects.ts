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
 * The size a typed label has to come down to for `text` to fit `box` units.
 *
 * Never larger than `size` — a short name does not get a bigger tab, because
 * the tab is a physical thing and the type on it is a physical size. And never
 * below the floor, past which the label truncates rather than shrinking on.
 */
export function fitLabel(text: string, box: number, size: number): number {
  if (text.length === 0 || box <= 0) return size;
  const wanted = box / (text.length * TYPED_ADVANCE);
  return Math.max(size * LABEL_FLOOR, Math.min(size, wanted));
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
