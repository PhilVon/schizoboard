/**
 * Entry point. Builds the layer stack, binds the document, wires the nine
 * phases, starts the loop.
 *
 * This is the one module allowed to know about every layer at once — it is
 * where `crdt/`, `state/` and `render/` are introduced to each other. The
 * one-way flow they form is the whole architecture:
 *
 *     interaction -> crdt/ops -> Y.Doc -> observer -> binding -> Scene -> render
 */

import { ASSET_SWEEP_DELAY_MS, sweepAssets } from "@/app/assetgc";
import { PosterGrabber } from "@/app/poster";
import { Binding } from "@/crdt/binding";
import {
  assetOrigName,
  boardSchemaVersion,
  boardSeed,
  boardTitle,
  encodedSize,
  futureSchema,
  initialiseBoard,
  openBoardDoc,
  assetKindsOf,
  sealBoard,
  snapshot,
} from "@/crdt/doc";
import { PageReader } from "@/app/pages";
import { TextIndex } from "@/app/textindex";
import * as ops from "@/crdt/ops";
// `readItem` is aliased because this file already has one: `readItem` here is
// T-273's *verb*, which turns a case file up and flies to it. Two very
// different things with one obvious name, and the schema's is the one that
// gets renamed because the local one is what this file is mostly about.
import { readAsset, readItem as readItemFields, SCHEMA_VERSION } from "@/crdt/schema";
import {
  attachPoster,
  bringToFront,
  commitStrokes,
  createItems,
  createPin,
  createStringThrough,
  deleteBoardStrokes,
  deleteItems,
  deletePins,
  deleteStrokes,
  deleteStrings,
  insertPinIntoString,
  movePins,
  placePin,
  rehomePins,
  resizeItems,
  scaleNodeSlack,
  scaleStringSlack,
  setItemPoses,
  setItemStyle,
  sendToBack,
  setNodeSlack,
  setStringSlack,
  setStringStyle,
} from "@/crdt/ops";
import { Origin } from "@/crdt/origins";
import { Persistence } from "@/crdt/persistence";
import { AssetExchange, Priority } from "@/crdt/sync/exchange";
import { WireProvider } from "@/crdt/sync/provider";
import { UndoHistory } from "@/crdt/undo";
import {
  exportBounds,
  phaseTicks,
  phraseFor,
  type ExportPhase,
} from "@/app/export";
import { BoardClipboard } from "@/app/clipboard";
import { exportImage } from "@/app/exportImage";
import { exportPdf, type Stage as PdfStage } from "@/app/exportPdf";
import { noteSizeFor } from "@/app/ingest";
import { Paste } from "@/app/paste";
import { Mesh } from "@/app/mesh";
import { HOME_DELAY_MS, homeBoard, Pack, packSpec } from "@/app/pack";
import { formatInvite, inviteSearch, openingPlan, parseInvite } from "@/app/invite";
import * as prefs from "@/app/prefs";
import { dialAddress, identityFor } from "@/app/sync";
import { fileSize } from "@/lib/filesize";
import { DEFAULT_ERASER_SIZE, type InkSurface, type WetStroke } from "@/lib/ink";
import {
  canBeOpened,
  carriesItsOwnName,
  caseNumber,
  filesLabel,
  PAGE_TEXT_SIZE,
  titleWorthWriting,
  type AssetKind,
} from "@/lib/objects";
import { initPlatform } from "@/platform";
import { variantFor } from "@/platform/types";
import { Cork } from "@/render/cork";
import { Culler } from "@/render/cull";
import { BoardInkLayer } from "@/render/ink/board";
import { DomItemLayer, NO_FACTS, type AssetFacts, type AssetView } from "@/render/items/dom";
import { NO_AGEING, WALL_CLOCK } from "@/render/items/wear";
import { Lod, readingZoomFor, READING_ZOOM } from "@/render/lod";
import { FrameLoop } from "@/render/loop";
import { Overlay, type PendingRun } from "@/render/overlay";
import { Janitor } from "@/crdt/janitor";
import { Peers, readPeer } from "@/render/presence/peers";
import { RemoteDebugPainter } from "@/render/presence/remotedebug";
import { PinLayer } from "@/render/pins/dom";
import { RopeLayer } from "@/render/ropes/paint";
import { World } from "@/render/world";
import { RopeSet, type RopeHit } from "@/sim/ropes";
import { Torsion } from "@/sim/torsion";
import { SIM_MARGIN } from "@/sim/tuning";
import { AssetStates } from "@/state/assets";
import { MissingAssets } from "@/state/missing";
import { Camera, type Bounds, type ScreenBox } from "@/state/camera";
import { DirtySets } from "@/state/dirty";
import { dirtyFacing } from "@/state/facing";
import { Flashes } from "@/state/flash";
import { PaperTurn, TURN_UP } from "@/state/turn";
import { Flight } from "@/state/flight";
import { chromeFrame, emptyFrame, handleAt, handleCursor } from "@/state/handles";
import { isChromeTarget, isTextTarget } from "@/state/input";
import { Navigation } from "@/state/navigation";
import { Presence } from "@/state/presence";
import { RemoteMotion } from "@/state/remote";
import { reveal, widen } from "@/state/reveal";
import { Scene, type PinHome } from "@/state/scene";
import { Search } from "@/state/search";
import { Selection } from "@/state/selection";
import { ToolMachine } from "@/state/tools/machine";
import { EraserTool } from "@/state/tools/eraser";
import { MarkerTool } from "@/state/tools/marker";
import { NoteTool } from "@/state/tools/note";
import { PinTool } from "@/state/tools/pin";
import { isScissors, stringAt } from "@/state/tools/frame";
import { SelectTool } from "@/state/tools/select";
import { StringTool } from "@/state/tools/string";
import type { BoardWriter, Tool, WritePose } from "@/state/tools/tool";
import {
  boardMenuRows,
  itemMenuRows,
  penMenuRows,
  pinMenuRows,
  recentBoards,
  stringMenuRows,
  type BoardRow,
} from "@/ui/boardmenu";
import { Crt, type CrtFilm } from "@/ui/crt";
import { Hud, type HudStats } from "@/ui/hud";
import { RAIL, Toolbar } from "@/ui/toolbar";
import type { BoardStatus } from "@/ui/toolhint";
import { ToolInfo } from "@/ui/toolinfo";
import { Flash } from "@/ui/flash";
import { Notice } from "@/ui/notice";
import {
  CLIP_MIME,
  CLIP_QUALITY,
  Clipper,
  readingCorners,
  screenQuad,
  figureCrossed,
  passageBoxes,
  passageSpan,
  quotationIn,
} from "@/app/clipping";
import { SearchField, type Unsearched } from "@/ui/search";
import { TuningPanel } from "@/ui/tuning";
import { ContextMenu, type MenuEntry } from "@/ui/menu";

/**
 * How often the missing-photograph notice checks that what it is counting is
 * still on the board.
 *
 * Half a second, which is far slower than anything a person can delete and far
 * faster than they can wonder why the count is wrong. The sweep is a scene walk,
 * and it only runs at all while something is missing.
 */
const NOTICE_SWEEP_MS = 500;

/** No pen in hand, or one holding nothing — the same array every frame, because
 *  the two readers of it run sixty times a second on a board with no ink on it
 *  at all. */
const NO_WET_RUNS: readonly WetStroke[] = Object.freeze([]);

async function boot(): Promise<void> {
  const native = await initPlatform();

  const root = document.querySelector<HTMLDivElement>("#board-root");
  if (!root) throw new Error("#board-root missing from index.html");

  // --- document ------------------------------------------------------------
  const board = openBoardDoc();
  /**
   * Where a refused *write* goes, so that a board which has stopped saving
   * itself says so (T-220).
   *
   * ## Not the read-only case, which already has a louder sign
   *
   * `giveUp` — the store that would not open at all — comes through the same
   * `onError`, and it is deliberately dropped here: the tool info bar already
   * opens with THIS BOARD IS NOT BEING SAVED in that state (`ui/toolhint.ts`),
   * permanently and in the reading order somebody scanning the board actually
   * uses. A flash saying it a second time would be the same news
   * twice, and the flash is the wrong shape for it besides — a read-only board
   * is permanent for the session and can never recover, which is exactly what
   * `hold`/`say` is not for. `readOnly` is true by the time `onError` runs
   * because `giveUp` sets it first.
   *
   * What was left with no sign at all is the case in between: the store opened,
   * the board is being written, and then the disk starts refusing. That one is
   * recoverable, is invisible today, and is what these two callbacks carry.
   *
   * ## Why it is held rather than said straight away
   *
   * `open()` is awaited a few lines below — it has to be, so a board that
   * already exists keeps its own cork seed — and `open()` can start a
   * compaction on a long log before returning. The `Flash` that speaks for all
   * this is built with the rest of the UI, a long way down. So the first thing
   * to fail can fail before the board has a mouth; held here and said the
   * moment there is one, rather than dropped for being early.
   */
  /**
   * Two tiers can be in trouble and there is one line to say so in, so they are
   * held separately and the worse one wins (T-362).
   *
   * They are not the same news and must not be able to overwrite one another.
   * `doc` is the document not reaching the disk, which is the user's work; the
   * `pack` is the board's own *file* not being brought up to date, which is a
   * copy of a copy — the workshop still has everything, and `board_open` reads
   * the workshop over the pack for exactly this reason. A pack failing while
   * the document was also failing must not take down the sentence about the
   * document, and a pack recovering must not either.
   */
  /**
   * Another window has this board's file (T-368) — settled for the session, so
   * this is a plain flag rather than a slot in `held` below.
   *
   * `sayTaken` is the same shape as `sayTrouble`: null until there is a UI to
   * say it to, because the first flush of a session can be refused before the
   * board has been drawn.
   */
  let packTaken = false;
  let sayTaken: (() => void) | null = null;
  const held: { doc: string | null; pack: string | null } = { doc: null, pack: null };
  let sayTrouble: ((message: string | null) => void) | null = null;
  const trouble = (tier: "doc" | "pack", message: string | null): void => {
    held[tier] = message;
    sayTrouble?.(held.doc ?? held.pack);
  };
  const pack = new Pack(board, native, {
    onError: (error) => {
      console.error("[pack] the board's own file could not be written", error);
      trouble(
        "pack",
        "The board's own file is not being updated — your changes are safe here, but the file is behind",
      );
    },
    onRecovered: () => trouble("pack", null),
    // Read again whenever the file changes, which is what makes the row
    // appear at all: the answer moves on every flush, not only on a
    // compaction. `readTidy` is set below, when there is a shell to ask.
    onFlushed: () => readTidy?.(),
    // T-368. Not `trouble`, which is the standing-and-recoverable channel: this
    // is settled for the session, so it goes on the one surface built for a
    // condition that cannot be taken down again. `sayTaken` is set below,
    // beside the rest of the UI; before that line it is a boot-time condition
    // and `restateBoard` picks it up on its own.
    onTaken: () => {
      packTaken = true;
      sayTaken?.();
    },
  });
  const persistence = new Persistence(board, native, {
    onError: (error) => {
      // The console keeps the reason. The flash gets the consequence, because
      // the reason is `EBUSY` and the consequence is somebody's afternoon.
      console.error("the board could not be written to disk:", error);
      if (persistence.readOnly) return;
      trouble("doc", "The board is not being saved — your changes are here, but they are not reaching the disk");
    },
    onRecovered: () => trouble("doc", null),
    // The coarse tier's only input. Not a second subscriber to the document —
    // `crdt/persistence.ts` argues that out in full at the option's own note.
    onWrote: () => pack.wrote(),
  });
  // Before `initialiseBoard`, so a board that already exists keeps its own cork
  // seed and creation date rather than having fresh ones merged over the top,
  // and before the binding starts, so the scene is mirrored once.
  await persistence.open();
  // A store that would not open never writes, so `onWrote` never fires and the
  // coarse tier would sit idle anyway. Said out loud rather than left as a
  // property of two other files: a board opened read-only because its log could
  // not be read must not write that board over its own file, and "it happens
  // not to" is not the same promise as "it does not".
  if (persistence.readOnly) pack.seal();
  initialiseBoard(board);
  // After `pack.seal()`, so a board this build may not write is not caught up
  // either, and after `initialiseBoard`, whose own write already arms the tier
  // on the one board that needs it — a brand new one. Not awaited: it asks the
  // shell one boolean about a file nobody is waiting on, and the answer only
  // ever starts the idle timer that the first edit would have started anyway.
  void pack.catchUp();

  /**
   * A document written by a build newer than this one, open to be looked at
   * and not touched — T-224 and Q-170, which chose this over a dismissible
   * notice and over saying nothing.
   *
   * ## Why the safest answer, when additive migration is the house policy
   *
   * DATA-MODEL section 12 prefers additive migrations, so a version-2 board is
   * *usually* perfectly editable by a version-1 build — which is the argument
   * against this and the reason the question was asked rather than settled.
   * What decided it is that the failure is silent in both directions. An item
   * type this build does not recognise is skipped by the binding, so it is
   * invisible; edit around it and every write is made against a board you can
   * only see part of, by someone with no way to know that. There is no version
   * of that which announces itself.
   *
   * ## Read-only is a fact about the *document*, not a mode in this file
   *
   * `sealBoard` is what stops the writing, and it stops it at `mutate` — one
   * line downstream of every op there is. Everything below is the other half:
   * closing the routes *before* they get there, so that a board you cannot edit
   * looks like one rather than like one that has stopped responding. The seal
   * throwing would mean a route was missed.
   *
   * ## And it can arrive mid-session
   *
   * A peer on a newer build syncing `meta.schemaVersion` upward is the same
   * situation as opening the file — the document in memory is now one this
   * build cannot fully read. So it is watched rather than only checked once,
   * and the sentence at the bottom of the window is rewritten when it lands.
   */
  let readOnly = false;
  /** Set once there is a window to change — see `sayTrouble` for the pattern. */
  let onSealed: (() => void) | null = null;
  /**
   * The manual way to give this board a file, when the automatic one failed
   * (T-361).
   *
   * Null is the ordinary state and it means the row is absent: either this
   * board already has a file of its own, or the attempt to give it one has not
   * finished yet. It becomes a function only on a failure, which is the one
   * state where somebody is looking at a board that is *not* in a file and
   * nothing else on screen would ever tell them so.
   *
   * Declared up here for `onSealed`'s reason — the menu that reads it is built
   * long before the boot step that can set it.
   */
  let homeRetry: (() => void) | null = null;
  /**
   * Read again whether this board's file is worth tidying (T-367).
   *
   * Up here for `homeRetry`'s reason: the coarse tier is built a few lines
   * below and calls this on every flush, and the thing that answers the
   * question is put together a long way down.
   */
  let readTidy: (() => void) | null = null;
  const sealIfFuture = (): void => {
    if (readOnly || !futureSchema(board)) return;
    readOnly = true;
    sealBoard(board);
    // The coarse tier stops for good. `packSpec` reads the document through
    // `readItem`, so a future build's item has its photograph in no asset list
    // — a pack written from here would silently be missing photographs that are
    // plainly on the board, and it is the pack that gets handed to somebody.
    // The workshop still holds every byte; what is refused is writing the copy.
    pack.seal();
    console.warn(
      `[schema] this board is version ${boardSchemaVersion(board)} and this build reads ` +
        `${SCHEMA_VERSION}; it is open read-only so that nothing here writes to a document ` +
        `it can only partly see`,
    );
    onSealed?.();
  };
  sealIfFuture();
  // Cheap: `meta` is five keys and this fires on a write to one of them, which
  // on a board nobody is migrating is never. Not `observeDeep` — `schemaVersion`
  // is a number on this map and nothing nested reaches it.
  board.meta.observe(() => sealIfFuture());

  const scene = new Scene();
  const dirty = new DirtySets();
  const binding = new Binding(board, scene, dirty);
  binding.start();
  /**
   * What the last undo changed, fading — DESIGN section 7.6.
   *
   * Next to the dirty sets because that is where it reads from: an undo is a
   * transaction like any other, and the binding above has already turned its
   * events into the ids of the things that moved.
   */
  const flashes = new Flashes();
  /**
   * The match a search has just taken you to, fading — T-85, Q-151.
   *
   * Its own instance rather than more ids in the one above, and `state/flash.ts`
   * gives the reason: `changedBounds()` below reads that map back to work out
   * where an undo should fly the camera, and a note you merely searched for is
   * not something an undo changed.
   */
  const found = new Flashes();
  /**
   * Which item a search has chosen and not yet lit.
   *
   * The flash is raised when the *flight lands* rather than when the match is
   * chosen, because a flash lasts 800ms and a flight takes 300 of them: raised
   * at the start, more than a third of it is spent on the journey and what you
   * see on arrival is already fading. Null on almost every frame.
   */
  let foundPending: string | null = null;

  // --- presentation --------------------------------------------------------
  const camera = new Camera();
  const world = new World(root);
  // T-231. The pin source is a thunk because the cork is built before the
  // document has finished loading and outlives every pin on it; `scene` is
  // declared below, and by the time a frame asks it is there.
  const cork = new Cork(world.layers.cork, boardSeed(board), () => scene.pins.values());
  /**
   * What this machine can show of each photograph, and how far off the rest are.
   *
   * `platform/types.ts` says `assetUrl` "returns an empty string for an asset
   * this process has never seen, which the item renders as its `unknown` state
   * rather than as an error" — and under the shell it cannot keep that promise
   * on its own, because building the URL is pure string work that knows
   * nothing about what is on disk. So the knowledge lives here, and this is
   * the local per-asset state DATA-MODEL section 10 says is never in the
   * document.
   *
   * It matters more than a contract detail. Without it an item points an
   * `<img>` at bytes that have not arrived, gets a 404, and the only thing
   * standing between the user and a broken-image icon is an error handler. With
   * it, an item with no photograph yet is simply an item with no photograph
   * yet — undeveloped film, which is what DESIGN section 7.5 asks for.
   *
   * This module is wiring for it and nothing else: every transition below is one
   * line next to the event that causes it, and `state/assets.ts` owns which of
   * them are allowed to win.
   */
  const assets = new AssetStates();
  /**
   * And whose laptop the ones nobody here has are on (T-75, DESIGN 7.5).
   *
   * Separate from `assets` because it answers a different question and lives on
   * a different timescale: `assets` says which of five states a hash is in and
   * is read by the renderer every frame; this says who claimed a hash we then
   * failed to get, and it keeps peers' names after they leave — which is the
   * only reason it can answer at all, since by the time anything is unavailable
   * the holder has almost always gone and awareness has dropped them.
   */
  const missing = new MissingAssets();
  /**
   * Fetches the bytes `assets` is waiting for, once there is a wire (T-74).
   *
   * Declared here and assigned with the provider a long way below, because the
   * two things that drive it are at opposite ends of this function: an item
   * being drawn is what says an asset is wanted *now*, and that happens in
   * `assetUrl` a few lines down. Null on a board with no relay, where every
   * asset that is not already on this disk is simply not coming.
   */
  let exchange: AssetExchange | null = null;
  /**
   * Which stored variant serves an item that is about to be drawn `screenPx`
   * across.
   *
   * The renderer says how big; this says which file, because which variants exist
   * and how large they are is a fact about the asset store rather than about
   * drawing. Getting it wrong is expensive in a way that is easy to miss: an
   * `<img>` decodes at first paint, so a 16-pixel item pointed at a 2560-pixel
   * photograph pays for the whole decode and throws almost all of it away. D-15
   * measured that as a 243 ms frame, and it is culling that made it visible —
   * before culling every item was mounted from the start and had already paid.
   *
   * The choice itself is `variantFor`, over in `platform/`, because this module
   * is wiring and nothing tests it.
   */
  /**
   * The bytes are on this disk.
   *
   * Both things, always, because they are one fact. The exchange clears a want
   * when a transfer commits, which covers every photograph that *arrived* - and
   * misses the much more common one that was never absent. Boot mounts items and
   * `assetUrl` asks for every photograph it cannot yet show, and that happens
   * before `reconcileAssets` has finished asking the store whether they are
   * already here; the answer comes back yes, and the want stays.
   *
   * Left alone it never goes: nothing removes a want but bytes landing, and no
   * bytes are coming for a file that was already there. So a board where every
   * photograph is present reads "N missing" in the HUD's alert colour for the
   * whole session - which is the row a person would look at to tell whether
   * transfers are stuck - and we broadcast WANT to every peer for photographs we
   * are holding, which is a message per asset per peer saying something untrue
   * about us.
   */
  const holdsAsset = (sha256: string): void => {
    assets.ready(sha256);
    exchange?.forget(sha256);
  };

  const assetUrl = (sha256: string, screenPx: number): AssetView => {
    if (assets.isReady(sha256)) {
      return { url: native.assetUrl(sha256, variantFor(screenPx)), phase: "ready", fraction: 0 };
    }
    // Asked for a photograph we do not have the bytes of, which means an item
    // wearing it is being drawn — and culling only binds what is on screen, so
    // this *is* "an asset whose item is in or near the viewport" (ARCHITECTURE
    // section 5.2). No viewport arithmetic of its own: the layer that already
    // decides what to mount is a better answer than a second opinion about it.
    //
    // Only a board with a wire is *requesting* anything. Without one there is
    // nobody to ask, so saying so here would be a promise this process cannot
    // keep; `reconcileAssets` is what calls that case what it is, once it has
    // asked the store and knows the bytes are genuinely not here.
    if (exchange !== null) {
      exchange.want(sha256, Priority.VISIBLE);
      assets.requesting(sha256);
    }
    // Read after asking, so the first frame an item appears on already draws it
    // as film somebody has been asked for rather than as film nobody has
    // mentioned. Both are blank, and the difference is one repaint.
    return { url: "", phase: assets.phase(sha256), fraction: assets.fraction(sha256) };
  };
  /**
   * What a file says it is called — the derived local index of Q-211.
   *
   * Local because that is the answer: a title never enters the document, never
   * crosses the wire and is never written down, so a machine holding no bytes
   * has none and that is the intended state. `""` means asked and there is not
   * one; absent means not yet asked.
   *
   * In memory only. It is rebuilt by asking the shell again on the next boot,
   * which costs one read per object the person actually looks at — and is what
   * makes this the same code path for a paste, a transfer that has just
   * committed, a board reopened tomorrow and an opened bundle.
   */
  const titles = new Map<string, string>();
  /**
   * What the *document* says an asset is, for the renderer to choose a face from
   * (D-46 section 2) and write a label out of.
   *
   * Read through on every ask rather than mirrored into the scene, and that is
   * deliberate: nothing observes `board.assets`, so a cached copy would have no
   * way of learning that a peer's record had landed. A `Y.Map` get and a
   * coercion per bind of an asset item is a great deal cheaper than the write
   * this sits in front of.
   *
   * The one side effect is the title probe, and it is the same shape as
   * `assetUrl`'s want: the layer that already decides what to mount is a better
   * answer to "which documents are worth reading off the disk" than a second
   * opinion about it. Asked once per hash — `titles.set` before the await, so a
   * board of forty folders is forty probes and not forty a frame.
   */
  /**
   * The hash whose *words* an object is read for — T-287, Q-299.
   *
   * The identity for a case file and the sidecar for a recording. It is asked at
   * the hash rather than at the item because two of its three callers only ever
   * have a hash: the page resolver the renderer holds, which `dom.ts` calls with
   * whatever the item is wearing, and the index that is filled when a record
   * appears. `readableHash` is the same question from an item id.
   *
   * **The renderer's call is the one that made this necessary**, and it is worth
   * saying why rather than leaving it as symmetry. The layer draws a page by
   * asking `pageOf(cold.assetId)`, which for a tape is the tape — so without
   * this, turning a cassette up on its transcript asks `PageReader` for page one
   * *of the recording*, which does not refuse it: it queues a document read of a
   * four hundred megabyte film and draws a sheet saying it could not be read.
   */
  const readableAsset = (sha256: string): string | null => {
    const map = board.assets.get(sha256);
    const record = map ? readAsset(sha256, map) : null;
    if (record === null) return null;
    return record.kind === "video" || record.kind === "audio" ? record.transcript : sha256;
  };

  const assetFacts = (sha256: string): AssetFacts => {
    const map = board.assets.get(sha256);
    const record = map ? readAsset(sha256, map) : null;
    if (record === null) return NO_FACTS;
    const title = titles.get(sha256);
    if (title === undefined && carriesItsOwnName(record.kind) && assets.isReady(sha256)) {
      titles.set(sha256, "");
      void native
        .assetTitle(sha256)
        .then((found) => {
          if (!found) return;
          titles.set(sha256, found);
          // The record did not change, so nothing else would have redrawn it.
          refreshAsset(sha256);
        })
        .catch(() => {
          // A shell that cannot answer is an object with no title on it, which
          // is already three quarters of the folders (D-47) and all but one of
          // the films (D-52). Nothing to report.
        });
    }
    // The still, on the same argument the title probe is made on and from the
    // same place: the layer that already decided to mount this object is a
    // better answer to "which films are worth decoding a frame off" than any
    // second opinion about the viewport. It says what the record currently
    // holds, which may be a hash whose bytes are not here — `PosterGrabber`
    // treats that as *not done* rather than as done, so a tape that arrives
    // naming a still nobody transferred grabs the same frame back.
    if (record.kind === "video") posters.wants(sha256, record.poster);
    // And what a case file says, on the third turn of the same argument
    // (Q-271). This is the eager half of that answer: a folder appearing is
    // what starts the read, so `Ctrl+F` is complete from the first keystroke
    // rather than becoming complete a few seconds into the first search. The
    // bytes are the one thing it cannot work around, and a document whose
    // transfer has not committed becomes ready later and is asked then.
    if (record.kind === "document" && assets.isReady(sha256)) {
      textIndex.wants(sha256, record.markdown);
    }
    // And what a *recording* says, which is the same question asked of a
    // different hash — T-287. The transcript is a text asset in its own right,
    // so what goes into the index is the sidecar rather than the tape, and the
    // readiness that matters is the sidecar's: an interview whose 400 MB is
    // still in flight has a transcript of a few kilobytes that arrived long ago,
    // and there is no reason to make the search wait for the film to be able to
    // find the words in it.
    if (record.transcript !== null && assets.isReady(record.transcript)) {
      textIndex.wants(record.transcript);
    }
    return {
      kind: record.kind,
      name: record.origName,
      title: title ?? "",
      duration: record.duration,
      pages: record.pages,
      poster: record.poster ?? "",
      // The same answer `readableAsset` gives, handed to the renderer so a
      // recording can say on its own face that there are no words in it to find
      // (T-334). The hash rather than a flag, for the reason `AssetFacts` says.
      transcript: record.transcript ?? "",
    };
  };
  /** Phase 3, after the torsion: the note being written on, laid flat (T-178). */
  const flatten = new PaperTurn();
  /**
   * And the case file being read, turned up on its side (T-273).
   *
   * Its own clock rather than a second target on the one above, because the two
   * are not exclusive: a folder can be open on one side of the board while a
   * note is being written on somewhere else. They are exclusive on a single
   * item, and nothing has to enforce that — a case file has no text to edit.
   */
  const opening = new PaperTurn(TURN_UP);
  /**
   * Assigned near the bottom of this function, where there is somewhere to say
   * a sentence — T-282. Declared here because the tool machine is built long
   * before that and has to be handed something to call.
   */
  let clipper: Clipper | null = null;
  /**
   * The caret, when there is one (DESIGN section 3.6).
   *
   * The layer owns the field — see `render/items/view.ts` on why nothing that
   * crosses that seam may be an element — and these two are what it reports.
   * `onInput` is wired to the document in T-180; for now the field is a
   * scratchpad, and closing it throws the text away.
   */
  /**
   * The pages of whatever case file is open (T-320).
   *
   * Here rather than inside the layer for the reason `assetUrl` is here: it
   * needs the shell, and the layer is a renderer. What it hands back is what is
   * known *now* plus a phase, because a view cannot await — the same shape every
   * asynchronous thing this renderer draws already takes.
   */
  const reader = new PageReader(native, (sha256) => {
    // Whatever is wearing this file, redrawn. Narrow enough that a page landing
    // costs one item: a document is open on one folder at a time, and a board
    // holding the same file twice is a case nobody has ever produced.
    for (const id of scene.itemIds()) {
      if (scene.cold(id)?.assetId === sha256) dirty.item(id);
    }
  });

  const items = new DomItemLayer(world.layers.world, assetUrl, assetFacts, {
    /**
     * Straight to the document, not queued to phase 9 like a tool's writes.
     *
     * The queue exists so a *tool* cannot change the document out from under
     * the renderer halfway through a frame — it runs in phase 1 and the flush
     * is phase 9. An `input` event is not in a frame at all; it fires between
     * them, exactly as the paste handler does, and holding a keystroke back
     * for a frame would only make the caret and the paper disagree.
     */
    onInput: (id, text) => {
      // A read-only board has no way *into* an editor — the machine takes no
      // double-click and the menu row is absent — so this is the backstop for
      // a caret already in the paper on the frame a peer raises the schema
      // version. It keeps typing and the paper keeps it until the blur, which
      // is the least surprising way to end a sentence nobody can save.
      if (readOnly) return;
      ops.setItemText(board, id, text);
    },
    onClosed: (id) => {
      // Let the paper back down. The clock runs from wherever it got to, so
      // clicking away mid-rise does not snap.
      if (flatten.itemId === id) flatten.close();
    },
  },
  // The page open on a case file (T-320). A hash and not an item id, because a
  // page is a fact about the file: two folders of one document are one set of
  // pages. Which page the reader is on is T-321's, so this answers for
  // whichever that is.
  // Through `readableAsset`, so a tape turned up on its transcript is asked for
  // a page of the *transcript* (T-287). Without it the hash the item wears is
  // handed straight to the reader, which does not refuse a film — it starts
  // reading one as a document and draws a sheet saying it could not.
  (sha256) => {
    const words = readableAsset(sha256);
    return words === null ? null : reader.page(words);
  },
  // And which face each item is showing (T-278) — the same function the pen is
  // handed, deliberately: what a mark is filed against and what is drawn have to
  // be one answer. Declared below, hoisted to here.
  (itemId) => shownPage(itemId));

  /**
   * How old the board thinks its items are — DESIGN section 4.7, and Q-105,
   * which settled the clock as wall-clock since each item was made.
   *
   * Local, because whether paper should visibly age is a taste rather than a
   * fact about the board (`app/prefs.ts`), so the two people looking at one
   * board may legitimately disagree and neither is out of date. Turning it off
   * hands the layer [`NO_AGEING`], which is the same picture as a board where
   * nothing is older than this morning — the renderer has no way to tell them
   * apart and no reason to want one.
   */
  const setAgeing = (on: boolean): void => {
    prefs.setAgeing(on);
    items.setAgeClock(on ? WALL_CLOCK : NO_AGEING);
    // Every sheet at once, which is the one thing this switch is: nothing about
    // any item has changed, so nothing narrower would repaint any of them.
    dirty.everything();
  };
  setAgeing(prefs.ageing());

  /**
   * Put the caret in an item — the whole of "start writing on this", in one
   * place, because two things ask for it (DESIGN section 3.6).
   *
   * The double-click gets here through `ToolContext.edit`, and the context
   * menu's *Edit text* row calls it directly. One function rather than two
   * closures, so the two routes cannot drift into laying the paper flat by
   * different amounts or seeding the field from different text.
   *
   * The flatten first: it steps in phase 3 and the field is parked in phase 5,
   * so the paper has already begun to turn by the time the caret lands.
   */
  const startEditing = (itemId: string): void => {
    flatten.open(itemId);
    items.edit(itemId, scene.cold(itemId)?.text ?? "");
  };

  /** Ink on the bare cork — its own layer, under the string and under the paper
   *  (T-61). Nothing else on this board draws below the items. */
  const boardInk = new BoardInkLayer(world.layers.boardInk);

  /**
   * Re-bind every item wearing this asset. A walk, on a once-per-photograph
   * event.
   *
   * Or *naming* it: a poster frame is an asset no item wears (T-270) — it hangs
   * off a film's record — so a still landing on this disk would redraw nothing
   * and the tape would keep its blank print until something else dirtied it.
   * Asked of the document rather than of the scene, because the scene mirrors
   * items and this is a fact about a record.
   */
  const refreshAsset = (sha256: string): void => {
    for (const id of scene.itemIds()) {
      const worn = scene.cold(id)?.assetId;
      if (!worn) continue;
      if (worn === sha256) {
        dirty.item(id);
        continue;
      }
      const map = board.assets.get(worn);
      if (map && readAsset(worn, map)?.poster === sha256) dirty.item(id);
    }
  };
  // One subscription rather than a `refreshAsset` beside every transition. A
  // state that changed and did not redraw is the bug this makes impossible, and
  // there are five places that change one.
  assets.onChange(refreshAsset);

  /**
   * The television (T-276), and the only surface in this application that ever
   * covers the board — `ui/crt.ts` carries the argument.
   *
   * Built at boot beside the other panels rather than on demand. It costs a
   * `display: none` div and one capture-phase listener that returns immediately
   * while nothing is on, and the alternative — constructing it the first time
   * somebody presses `Enter` on a tape — would put a DOM build inside a gesture
   * for no saving worth measuring.
   */
  const crt = new Crt(world.layers.ui);

  /**
   * What a tape needs to go on the set, or `null` for an item that is not
   * wearing one.
   *
   * The want is raised here rather than left to `assetUrl`, and the difference
   * is what it means. `assetUrl`'s want says *an item wearing this is on
   * screen*; this one says *somebody has asked to watch this*, which is the
   * strongest claim anything on this board makes about an asset. `VISIBLE` is
   * the top of the two-value scale (`crdt/sync/exchange.ts`) and is already
   * what it deserves — the scale gaining a third value is a change to make when
   * something is actually behind a film, not in advance of it.
   *
   * The original, not a variant, for the reason `PosterGrabber` gives at its own
   * call site: there is no downscale of a film in the store, because the shell
   * only makes those for pictures.
   */
  const filmFor = (sha256: string): CrtFilm | null => {
    const map = board.assets.get(sha256);
    const record = map ? readAsset(sha256, map) : null;
    if (record === null) return null;
    const here = assets.isReady(sha256);
    if (!here && exchange !== null) {
      exchange.want(sha256, Priority.VISIBLE);
      assets.requesting(sha256);
    }
    const poster = record.poster ?? "";
    return {
      id: sha256,
      url: here ? native.assetUrl(sha256, "original") : "",
      // The still is what the glass has to show while the film is coming, which
      // is the whole reason T-270 grabbed it — so a poster whose own bytes have
      // not landed is simply no poster, not a hole to fill in.
      poster: poster !== "" && assets.isReady(poster) ? native.assetUrl(poster, "display") : "",
      // The same two lines the spine carries, so the plate under the set names
      // the tape the person picked up rather than a second opinion about it.
      title: titleWorthWriting(titles.get(sha256) ?? "", record.origName),
      number: caseNumber(record.origName || null, sha256),
      w: record.w,
      h: record.h,
      fraction: assets.fraction(sha256),
      lost: assets.phase(sha256) === "unavailable",
    };
  };

  /**
   * A tape arriving, or its still, while somebody is sat watching the set.
   *
   * Separate from `refreshAsset` because it is a different job: that one dirties
   * every item wearing a hash so the board redraws, and this one re-reads one
   * film for one surface that is not in the scene at all. Folding them together
   * would make the set's contents depend on the culler having mounted something.
   *
   * The second half is the poster: a still that reaches this disk after the set
   * is already on is announced under *its* hash, not the film's, so the record
   * is asked which film claims it. That is the same walk `refreshAsset` does and
   * for the same reason — a poster is an asset no item wears (T-270).
   */
  assets.onChange((sha256) => {
    const showing = crt.showing;
    if (showing === "") return;
    if (sha256 !== showing) {
      const map = board.assets.get(showing);
      if ((map ? readAsset(showing, map)?.poster : null) !== sha256) return;
    }
    const film = filmFor(showing);
    if (film !== null) crt.update(film);
  });

  /**
   * The still that stands for a film (T-270), grabbed off bytes this machine
   * holds and never more than one at a time — D-48 section 8 measured the
   * *second* decoding video taking the board from 144 Hz to 72, and a board of
   * tapes mounting at once would otherwise start one decode each.
   */
  const posters = new PosterGrabber({
    // The original, not a variant: `variantFor` picks a *stored* size and there
    // is no downscale of a film in the store — the shell only makes those for
    // pictures (`assets.rs`).
    url: (sha256) => native.assetUrl(sha256, "original"),
    isReady: (sha256) => assets.isReady(sha256),
    ingest: (bytes, mime) => native.assetIngestBytes(bytes, mime),
    record: (film, poster) => {
      attachPoster(board, film, poster.sha256, {
        w: poster.w,
        h: poster.h,
        mime: poster.mime,
        size: poster.size,
      });
      // The bytes went into this store a moment ago, so this machine is a
      // holder — say so rather than waiting for `reconcileAssets` to notice at
      // idle priority, which is a still that appears on the next boot.
      holdsAsset(poster.sha256);
      refreshAsset(poster.sha256);
    },
  });

  /**
   * What the case files say, so `Ctrl+F` can look inside them (T-280).
   *
   * Beside `posters` because it is the same shape for the same reason: a queue
   * of one, fed from the record probe, doing work that costs a file read per
   * object and would otherwise all start at once when a board of them mounts.
   *
   * The hook is the search field's (T-286), and it is installed *later* rather
   * than written here: `search` and `searchField` are five hundred lines down
   * and there is an `await` between the two, so a folder whose read lands in
   * that window would touch a `const` in its dead zone — a `ReferenceError`
   * thrown inside a `.catch(() => undefined)`, which is the shape of a bug that
   * costs a session. The default does nothing, which is also the right
   * behaviour for a board with no search open.
   */
  let documentTextArrived: (sha256: string) => void = () => {};
  const textIndex = new TextIndex(native, (sha256) => documentTextArrived(sha256));

  // Awaited, not fired and forgotten: `listen` is itself a round trip, and an
  // `asset:ready` emitted before it resolves is simply lost — which would
  // strand that one photograph undeveloped for the session while every later
  // one worked.
  await native.on("asset:ready", ({ sha256 }) => {
    holdsAsset(sha256);
    // We are now somebody who has it, whether it was pasted here or fetched
    // from a peer. Saying so immediately rather than waiting for a periodic
    // sweep is what makes a photograph dropped on one machine appear on the
    // other one while the person who dropped it is still looking at it.
    exchange?.announce([sha256]);
  });
  const overlay = new Overlay(world.layers.overlay);
  /**
   * The two rope canvases — DESIGN section 6.2's "two rope canvases, not one".
   * Real boards have string running behind photographs that were pinned on top
   * of it later, and one overlay would force every string above or every string
   * below. Same painter twice; the string's own `layer` field picks.
   */
  const ropesUnder = new RopeLayer(world.layers.ropesUnder, "under");
  const ropesOver = new RopeLayer(world.layers.ropesOver, "over");
  /**
   * Pins, in their own screen-space layer above everything else on the board.
   * Not inside the world transform, and `render/pins/dom.ts` explains why: a
   * pin's head has a floor in *screen* pixels so that a zoomed-out board still
   * has something visible holding it together (DESIGN section 4.5).
   */
  const pins = new PinLayer(world.layers.pins);
  /**
   * Which items are worth having in the DOM. The spike (D-12) measured the
   * gesture-end repaint at 777 ms with 500 live nodes, so this is load-bearing
   * rather than an optimisation — see `render/cull.ts`.
   */
  const culler = new Culler();
  /** Phase 3: "pin count is the item's physics" (DESIGN section 2.2). */
  const torsion = new Torsion();
  /** Phase 3, the other half. Empty until something makes a string (T-41), and
   *  free while it is — a rope set with no ropes steps nothing. */
  const ropes = new RopeSet();
  /**
   * Phase 2: every other peer's in-flight drag, rendered 100 ms in the past.
   *
   * Fed from the awareness subscription below, which is also where its arrival
   * times come from. Empty and free on a board with no wire.
   */
  const remote = new RemoteMotion();
  /**
   * Phase 8: the same peers, as a picture — where they are pointing and what
   * they have hold of.
   *
   * The other half of the same awareness state. `remote` takes the `grab`, which
   * moves items and is therefore a write into the scene; this takes the cursor
   * and the selection, which are never anything but chrome on the overlay. One
   * subscription, split by what the payload is *for*.
   */
  const peers = new Peers();
  const loop = new FrameLoop();
  const selection = new Selection();
  // Both annotated, and they have to be: `offerWheel` below reaches forward to
  // `tools` and `tools`' `suppressed` reaches back to this, so inference has a
  // cycle to walk and gives up. The truce being mutual is the reason.
  const navigation: Navigation = new Navigation(camera, root, {
    contentBounds: () => scene.contentBounds(),
    selectionBounds: () => scene.boundsOfMany(selection.members),
    /**
     * The wheel is the one input the camera and the board both want — it zooms
     * (DESIGN section 3.7) and it adjusts a selected segment's slack (section
     * 3.4) — so the camera offers each notch to the active tool first. True
     * means the tool took it.
     *
     * `tools` is declared below and this closes over it, which is safe because
     * nothing calls it until a wheel event arrives. The two objects need each
     * other: this is the truce in one direction and `suppressed` below is the
     * same truce in the other.
     */
    offerWheel: (e): boolean => tools.claimWheel(e),
  });

  // --- interaction ---------------------------------------------------------

  /**
   * Document writes a tool asks for are *queued*, not made. They land in phase
   * 9, below, so no observer can move the scene out from under a frame that
   * phases 4 and 5 have already read (ARCHITECTURE section 3).
   */
  const queued: (() => void)[] = [];
  /**
   * A settle map, copied and normalised for the queue.
   *
   * Copied like every other queued write, because this runs in phase 9 and the
   * tool has moved on by then; and an empty one becomes `undefined` so that the
   * ops below can keep asking "was I given any poses" rather than "was I given
   * a map, and if so does it contain anything".
   */
  const settled = (
    settle?: ReadonlyMap<string, WritePose>,
  ): Map<string, WritePose> | undefined =>
    settle && settle.size > 0 ? new Map(settle) : undefined;
  /**
   * Queue the re-home that this edit may have caused — D-31, and the second
   * clause of the pin request T-176 built the first half of.
   *
   * **Pushed immediately behind its cause, and that placement is the design.**
   * The queue drains in order at the end of phase 9, and phase 1 queues
   * `undo.boundary()` rather than calling it, so a re-home pushed here lands
   * inside the same undo entry as the write above it. Undo then restores a pin's
   * frame along with the geometry that changed it, instead of towing the pin
   * back with an item it had not been stuck through yet.
   *
   * **Off local edits only, never off an observed one.** Two peers can differ on
   * a drawn pose, so "whoever notices a mismatch fixes it" is two clients
   * rewriting the same field at each other forever. The one who moved something
   * decides, and everybody else takes the answer off the wire.
   *
   * **Not during a live drag.** A throttled pose is a crash-safety write in the
   * middle of a gesture, and a re-parent per frame would be a write storm for an
   * answer that is about to change again. The pin is not moving in the meantime —
   * the item is sliding onto it — so waiting for the release costs nothing
   * visible and the picture at rest is always right.
   *
   * The scan itself returns nothing at all on a board that is already correct —
   * which is every frame except the handful this exists for. It runs in phase 9,
   * so if anything this frame moved an item or a pin, some earlier phase has
   * already paid for the rebuild and this reads what it built; and if nothing
   * did, there is nothing here to find. No phase rebuilds the index on a
   * schedule — the setters invalidate and the first reader pays
   * (`Scene.overStale`).
   */
  const rehomed: PinHome[] = [];
  const rehome = (): void => {
    queued.push(() => rehomePins(board, scene.rehomes(rehomed)));
  };
  const writer: BoardWriter = {
    setPoses: (poses, phase) => {
      const snapshot = new Map(poses);
      queued.push(() =>
        setItemPoses(
          board,
          snapshot,
          // A live pose is the throttled crash-safety write; the undo manager
          // (T-29) merges it into the release's entry rather than stacking one
          // entry per half second of dragging.
          phase === "live" ? Origin.DRAG_THROTTLE : Origin.LOCAL_USER,
        ),
      );
      if (phase !== "live") rehome();
    },
    setSizes: (sizes, phase) => {
      const snapshot = new Map(sizes);
      queued.push(() =>
        resizeItems(
          board,
          snapshot,
          phase === "live" ? Origin.DRAG_THROTTLE : Origin.LOCAL_USER,
        ),
      );
      if (phase !== "live") rehome();
    },
    deleteItems: (ids, keepPins) => {
      const snapshot = [...ids];
      queued.push(() => deleteItems(board, snapshot, { keepPins }));
      // `keepPins` is Shift+Delete, which re-parents the survivors to null in
      // its own cascade — and to null is not where they belong if there is other
      // paper under them. The plain delete needs this too: taking the top
      // photograph away leaves its pins to whatever was beneath.
      rehome();
    },
    /**
     * Appearance only, so no `rehome`: a paper stock or a strip of tape changes
     * nothing about where anything is, and the over-index is a question about
     * geometry (Q-146). The one write on this list that does not move the board.
     */
    setItemStyle: (ids, patch) => {
      const snapshot = [...ids];
      queued.push(() => setItemStyle(board, snapshot, patch));
    },
    /**
     * The two ends of the stack. Copied and queued like every other write here,
     * which matters more than usual for these two: the ops read the whole
     * board's keys to find the end they are generating against, and doing that
     * in phase 9 means they read the board after the frame's other writes have
     * landed rather than the one the menu was built from.
     */
    bringToFront: (ids) => {
      const snapshot = [...ids];
      queued.push(() => bringToFront(board, snapshot));
      // Nothing moved, and every pin in the overlaps has a new answer anyway:
      // topmost is a question about order, and this is the only pair of writes
      // on the board that changes order without changing a coordinate.
      rehome();
    },
    sendToBack: (ids) => {
      const snapshot = [...ids];
      queued.push(() => sendToBack(board, snapshot));
      rehome();
    },
    /**
     * A blank sheet — what DESIGN section 2.1 calls a scrap, which is "a note
     * that happens to have no text yet".
     *
     * Sized by the same function that sizes a pasted note, asked for the empty
     * string, so an empty one and a one-word one are the same piece of paper.
     * The pin and the scatter angle are not passed: `createItems` defaults both,
     * which is exactly why they are defaults — "a caller that has to remember to
     * jitter is a caller that will forget".
     */
    createNote: (x, y) => {
      queued.push(() => {
        const size = noteSizeFor("");
        const made = createItems(board, [{ type: "note", x, y, w: size.w, h: size.h }]);
        if (made.length > 0) selection.replace(made.map((item) => item.itemId));
      });
      // A new sheet is minted above everything, so any pin it lands on is now
      // pushed through it.
      rehome();
    },
    /**
     * The three pin writes. The coordinates arrive already in the frame the
     * parent implies — the tool converts, because only the tool knows the pose
     * a hanging item is actually drawn at (`state/tools/frame.ts`).
     *
     * **No `rehome` behind any of them**, alone among the writes that put a pin
     * somewhere new. These three already resolve the parent through
     * `ctx.hitTest`, which walks paint order downwards, so they arrive at the
     * topmost item by a shorter road — and one of them arrives somewhere else on
     * purpose. `Ctrl` during a pin drag means "stay in the parent you have"
     * (`state/tools/pindrag.ts`), and a re-home queued behind the drop would
     * overrule the modifier in the same frame the user held it.
     */
    createPin: (parent, lx, ly, settle) => {
      const poses = settled(settle);
      queued.push(() => createPin(board, { parent, lx, ly }, poses));
    },
    placePin: (pinId, parent, lx, ly, settle) => {
      const poses = settled(settle);
      queued.push(() => placePin(board, pinId, parent, lx, ly, poses));
    },
    createString: (anchors, closed, settle) => {
      // Copied, like every other queued write: this runs in phase 9 and the
      // tool has moved on by then.
      const run = anchors.map((a) => ({ ...a }));
      const poses = settled(settle);
      queued.push(() => createStringThrough(board, run, { closed }, poses));
    },
    /**
     * The headline gesture: a loop of string pulled out to a new pin (DESIGN
     * section 3.4). The pin and the node it hangs on are one transaction, so
     * `Ctrl+Z` takes the pin with the node rather than leaving it in the cork.
     *
     * The chords arrive measured, because geometry lives in the scene and
     * `crdt/` may not read it. Two things deliberately do not: the segment's
     * own slack, and *which* segment it is. Both are read inside the op's
     * transaction — one from the node, one by resolving `after` — which is what
     * makes the `queued.push` below safe. The write runs at the next flush, and
     * by then the number the gesture saw may be a peer's edit old and the
     * position it counted may be a peer's insert out (DATA-MODEL section 5.4).
     */
    insertPin: (stringId, after, anchor, split, settle) => {
      const at = { ...anchor };
      const cut = { ...split };
      const poses = settled(settle);
      queued.push(() => insertPinIntoString(board, stringId, after, at, cut, poses));
    },
    deletePins: (ids, settle) => {
      const snapshot = [...ids];
      const poses = settled(settle);
      queued.push(() => deletePins(board, snapshot, poses));
    },
    /**
     * The four slack writes — DESIGN section 3.4's editing table, which is one
     * gap or the whole run, set or scaled.
     *
     * The two scaling ones hand over a factor rather than a value on purpose:
     * a tool's read of the scene is a frame older than the write it produces,
     * so a roll of the wheel that multiplied in the tool would keep deriving
     * the same answer from the same stale number. `crdt/ops/strings.ts` says it
     * at length.
     */
    setNodeSlack: (stringId, nodeId, slack) => {
      queued.push(() => setNodeSlack(board, stringId, nodeId, slack));
    },
    scaleNodeSlack: (stringId, nodeId, factor) => {
      queued.push(() => scaleNodeSlack(board, stringId, nodeId, factor));
    },
    setStringSlack: (stringIds, slack) => {
      const snapshot = [...stringIds];
      queued.push(() => setStringSlack(board, snapshot, slack));
    },
    scaleStringSlack: (stringIds, factor) => {
      const snapshot = [...stringIds];
      queued.push(() => scaleStringSlack(board, snapshot, factor));
    },
    /**
     * Tuck behind, and the only thing in the app that writes `layer`.
     *
     * `setStringStyle` takes the whole style and applies only the fields it is
     * given, so this hands over the one field rather than reading the other
     * four out of the scene and writing them back — a restyle that echoed the
     * colour and thickness would collide with a concurrent restyle of those
     * fields for no reason at all.
     */
    setStringLayer: (stringIds, layer) => {
      const snapshot = [...stringIds];
      queued.push(() => setStringStyle(board, snapshot, { layer }));
    },
    /** Restyle — DESIGN section 3.4. Straight through: `setStringStyle` already
     *  applies only the fields it is given, which is exactly the contract. */
    setStringStyle: (stringIds, style) => {
      const snapshot = [...stringIds];
      const fields = { ...style };
      queued.push(() => setStringStyle(board, snapshot, fields));
    },
    /** DESIGN section 3.4's *Delete*. The pins stay; `deleteStrings` deletes
     *  the string map and nothing else, which is the whole of the rule. */
    deleteStrings: (stringIds) => {
      const snapshot = [...stringIds];
      queued.push(() => deleteStrings(board, snapshot));
    },
    /**
     * The free pins a dragged or rotated thread carries with it.
     *
     * Snapshotted, like every other queued write here: the tool hands over the
     * positions it computed this frame and goes on moving the pins in the
     * mirror, so a map read at flush time would be a frame ahead of the poses
     * it is supposed to travel with.
     *
     * `lx`/`ly` rather than `x`/`y` at this boundary because that is what the
     * document calls a pin's stored position — and for a free pin the two are
     * the same numbers, which is exactly why only free pins are ever in here.
     */
    movePins: (positions, phase) => {
      const snapshot = new Map<string, { lx: number; ly: number }>();
      for (const [id, at] of positions) snapshot.set(id, { lx: at.x, ly: at.y });
      queued.push(() => movePins(board, snapshot));
      // Free pins carried along by a thread drag, which is the one way a pin
      // travels without anybody choosing a parent for it — so it is also the one
      // way a pin can be set down on paper that nothing has told it about.
      // Phased like the pose writes, and skipped mid-drag for the same reason.
      if (phase !== "live") rehome();
    },
    /**
     * One finished stroke, and the near end of the wet/dry handoff.
     *
     * Not copied, which is the one write on this interface that is not. Every
     * other one snapshots because the tool goes on mutating what it handed over;
     * the marker instead swaps in a fresh array the moment a stroke ends
     * (`state/tools/marker.ts`), so the samples here are already dead to it — and
     * a stroke is the largest thing any gesture hands over, in the one gesture on
     * this board with a latency budget.
     *
     * The far end is [`drying`] below. What is settled here is only the case
     * where no ink is coming at all.
     */
    commitStrokes: (runs) => {
      queued.push(() => {
        const written = commitStrokes(
          board,
          runs.map((run) => ({
            // The pen named this run at pen-down, so that a peer already
            // drawing it can recognise the record when it arrives (DATA-MODEL
            // section 9.2). Dropping it here would leave the ghost on their
            // overlay with nothing to match.
            id: run.id,
            item: run.item,
            tool: run.tool,
            color: run.color,
            size: run.size,
            opacity: run.opacity,
            // Which page it was drawn on, when it was drawn on one — T-278.
            page: run.page,
            samples: run.samples,
          })),
        );
        // Which surfaces to wait for, one per run that actually landed. Both
        // halves come back from the op — the runs it refused are simply absent,
        // so nothing here has to match results to inputs by position.
        drying = written.map((one): InkSurface =>
          one.tile === null ? { kind: "item", id: one.item! } : { kind: "tile", key: one.tile },
        );
        if (drying.length > 0) return;
        // Nothing was written: a click rather than a stroke, or paper that left
        // the board while the pointer was down. No re-raster is coming, so the
        // overlay copies are all that is holding the mark up and they stop being
        // drawn now.
        drying = null;
        dried();
      });
    },
    /**
     * The eraser's whole output. No re-raster to wait for and nothing drying —
     * a record that has gone leaves the item's or the tile's canvas repainting
     * from what is left, which the INK phase does anyway.
     */
    eraseStrokes: (surface, ids) => {
      queued.push(() => {
        if (surface.kind === "item") deleteStrokes(board, surface.id, ids);
        else deleteBoardStrokes(board, surface.key, ids);
      });
    },
  };

  /**
   * The surfaces a pen is still drawing on the overlay because their canvases
   * have not caught up — the far end of `BoardWriter.commitStrokes`, and the
   * whole of what stops a pen-up from blinking.
   *
   * A list, because one gesture can be several runs on several surfaces (T-137),
   * and each is an item or a board-ink tile — the two things a stroke can land on,
   * rastered by different layers with different budgets. A plain string would
   * collapse them and the wrong layer would be asked.
   *
   * One list, not a queue of them: a press drops whatever that pen had drying
   * (see `MarkerTool.runsInFlight`), so there is never a second gesture's worth to
   * hold.
   */
  let drying: InkSurface[] | null = null;
  /**
   * Both pens, rather than the one that committed.
   *
   * Only the current tool's stroke is ever drawn (see the OVERLAY phase), so the
   * other pen's slot is invisible either way — and clearing it is what stops a
   * stroke drawn with the marker, switched away from and switched back to, from
   * being drawn a second time over ink that has long since landed. `dry` is
   * idempotent, which is what makes asking both of them free.
   */
  const dried = (): void => {
    marker.dry();
    highlighter.dry();
    smudge.dry();
  };

  /**
   * Undo.
   *
   * The camera and the selection are not in the document, but "undo takes me
   * back to where I was" still matters (DESIGN section 7.6), so they are
   * stashed on the way out and put back on the way in. Both restores land in
   * phase 9, one phase after the DOM was written, so they show on the next
   * frame — which is what `Camera.version` and `Selection.version` are for.
   */
  const undo = new UndoHistory(board, {
    captureView: () => ({
      x: camera.x,
      y: camera.y,
      zoom: camera.zoom,
      selection: selection.snapshot(),
    }),
    restoreView: (view) => {
      camera.setView(view.x, view.y, view.zoom);
      // Undoing a paste un-creates what it selected, so a stashed selection
      // can name things that no longer exist. A selection holding a ghost
      // makes the next Delete an op that quietly does nothing, which is the
      // confusing kind of nothing.
      selection.restore(
        view.selection,
        (id) => scene.has(id),
        (id) => scene.strings.has(id),
        (id) => scene.pins.has(id),
      );
    },
  });

  /**
   * Ctrl+F — the search, DESIGN section 3.7, T-85.
   *
   * Three pieces and each knows nothing of the other two: `Search` walks the
   * scene's mirrored text and holds a cursor into the answer, `SearchField` is
   * the box you type into, and `Flight` carries the camera. What is here is the
   * wiring, and the whole of the policy is these thirty lines.
   *
   * **Nothing is filtered, hidden, dimmed or listed** (DESIGN section 2.5). The
   * board you are looking at while you search is the same board, item for item;
   * all that changes is where the camera is standing and which one thing is lit.
   *
   * The fourth piece is `TextIndex`, and it is handed in as one function (T-286)
   * so that `Search` keeps knowing nothing about assets: what is *inside* an
   * item, asked as "which page of it says this". Three hops, all of them ones
   * something else here already makes — the item wears an asset, the index was
   * filled when that asset appeared, and a hash nobody indexed answers null.
   * Not gated on the record's kind: a photograph's hash has no pages, so it
   * misses on the same line rather than on a check that could disagree with the
   * one `assetFacts` makes.
   */
  const search = new Search((itemId, needle) => {
    // `readableHash` rather than the item's own asset, so a tape is searched by
    // its transcript (T-287). Still three hops and still nothing about kinds
    // here: what changed is which hash the second hop lands on, and a recording
    // with no sidecar answers null on the same line a photograph does.
    const sha256 = readableHash(itemId);
    return sha256 === null ? null : textIndex.find(sha256, needle);
  });
  const flight = new Flight();
  /** The board coordinates a match's box occupies; reused, like every other
   *  bounds in this file. */
  const foundBox: Bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  /**
   * Take the camera to `id` and queue its flash, or do nothing for null.
   *
   * Null is the ordinary case rather than the failure: `Search.run` answers null
   * when refining a query has left you on the match you were already reading,
   * and moving then would be the bug.
   *
   * A null **does not cancel a flight already under way**, and that is the one
   * case worth stating. Type one more character mid-journey and find nothing,
   * and the camera finishes its trip to the last thing that did match — which
   * is a place you asked to be taken and can read. Stopping dead would leave it
   * in mid-air, at a view nobody chose and nothing on screen explains.
   */
  const flyTo = (id: string | null): void => {
    if (id === null) return;
    // A match inside a case file is a match on a *page*, and the folder shut on
    // the cork is not where it is — D-46 section 4: "a match flies the camera to
    // the folder and opens it at the page". So the open carries the flight, at
    // its own zoom floor, which is the one a page can be read at rather than the
    // one the board's handwriting can (T-321).
    const page = search.pageOf(id);
    if (page !== null && readInside(id, page)) {
      foundPending = id;
      return;
    }
    const box = scene.boundsOf(id, 0, foundBox);
    if (box === null) return;
    // A floor under the landing zoom, not a target — Q-153. From a fitted board
    // every sheet is a flat card (T-198), so arriving at the current zoom means
    // arriving at a rectangle; searching from 100% changes no zoom at all.
    flight.toBox(camera, box, undefined, READING_ZOOM);
    foundPending = id;
  };
  /**
   * Is there anything inside this item to open? — T-274, Q-257.
   *
   * Three hops and no shortcut: the item wears an asset, the asset record says
   * what its bytes are, and `lib/objects.ts` says whether that kind of thing has
   * an inside. Every one of those is already how something else on this board
   * decides what an item is, and re-deriving beats a fourth statement of it.
   *
   * Deliberately **not** gated on the bytes having arrived. A folder whose
   * transfer has not finished is still a folder with pages in it, and hiding
   * the row until then would make the verb flicker in and out of the menu while
   * a peer sends a file. What a half-arrived document does when you open it is
   * the reading surface's answer to give (T-275), not this predicate's.
   */
  /**
   * What an item is wearing, or `unknown` for one wearing nothing.
   *
   * `unknown` covers a note, a bare polaroid and a record that has not arrived,
   * and all three want the same answer from the menu: a note is not a case
   * object and has no file behind it to name.
   */
  const kindOfItem = (itemId: string): AssetKind => {
    const sha256 = scene.cold(itemId)?.assetId ?? null;
    if (sha256 === null) return "unknown";
    const map = board.assets.get(sha256);
    return (map ? readAsset(sha256, map)?.kind : undefined) ?? "unknown";
  };

  /**
   * The hash of the words this item can be read for, which is not always the
   * hash it wears — T-287.
   *
   * A case file's words are its own bytes. A recording's are its sidecar's: a
   * tape has no text in it and nothing on this board will ever put any there
   * (D-46 section 6 refuses transcription outright), so the only words a
   * recording has are the ones that arrived beside it. Null for everything with
   * neither, which is every photograph, every note, and every interview nobody
   * had a `.srt` for.
   *
   * One function rather than the two hops written out at each caller, because
   * there are three of them now — the search, the reader and the quote gesture —
   * and a board where `Ctrl+F` finds a tape it cannot then open is worse than
   * one where it never found it.
   */
  const readableHash = (itemId: string): string | null => {
    const sha256 = scene.cold(itemId)?.assetId ?? null;
    return sha256 === null ? null : readableAsset(sha256);
  };

  /**
   * Is there something to turn this item up and *read* — T-287, Q-299.
   *
   * Not the same question as {@link openable}, and the two have to stay apart.
   * `openable` is about the gesture: `Enter` and the menu's *Open* start
   * whatever this object does, which for a tape is playing it. This is about the
   * reading surface, and it is true of exactly the things that have words —
   * every case file, and a recording that arrived with a transcript beside it.
   *
   * A record that has not arrived answers false rather than throwing, which is
   * the same answer it gives every other predicate in this file.
   */
  const readable = (itemId: string): boolean => readableHash(itemId) !== null;

  const openable = (itemId: string): boolean => {
    const sha256 = scene.cold(itemId)?.assetId ?? null;
    if (sha256 === null) return false;
    const map = board.assets.get(sha256);
    const record = map ? readAsset(sha256, map) : null;
    return record !== null && canBeOpened(record.kind);
  };

  /**
   * Open an item: turn it up to be read, and take the camera to it.
   *
   * > The folder opens where it lies, at board scale, with the camera flying to
   * > it the way search already flies to a match. Everything else on the board
   * > stays visible and live behind it. — D-46 section 4, Q-197
   *
   * **A turn, not a resize** (T-273). The folder ends up square on its side,
   * which is what stands the sheets filed in it upright — see `Scene.setOpen`
   * for why that is true to the object as well as cheap. Nothing about the item
   * changes: not its width, not its height, and nothing in the document. It is
   * the same lie the editor's lay-flat tells, told at a different angle and
   * taken back the same way.
   *
   * Pressing it on the folder already open closes it, which is the behaviour
   * every disclosure on every board has and costs one comparison.
   *
   * The flight rather than `F`'s frame, and the difference is not decoration.
   * `F` jumps and *fits*, which fills the viewport with whatever you had
   * selected; this eases, and its zoom is a floor rather than a target, so
   * opening from 100% changes no zoom at all. The eased half is DESIGN section
   * 3.7's argument about spending spatial memory, and it is why search is the
   * only camera move on this board that animates.
   *
   * No flash. The amber belongs to search and means *this is the match you
   * asked for among the others*; there is nothing to disambiguate here, and the
   * thing that will say "it is open" is the folder opening.
   */
  const openItem = (itemId: string | null): boolean => {
    if (itemId === null) return closeOpen();
    if (!openable(itemId)) return false;
    // A tape is the one kind that does not turn up to be read. It goes on the
    // set — the fork Q-197 settled, and the reason the two branches are not one
    // gesture with a flag: a document is read *against* the board and a film
    // takes the board away.
    /**
     * **Shutting comes before every kind, and it did not used to** — T-335.
     *
     * > | Shut it | `Escape`, or `Enter` again — DESIGN section 3.9
     *
     * That row was true of everything openable until a recording could be *read*
     * (T-287). Below this line a tape goes to `watchItem` and a cassette to
     * `hearItem` on any press at all, so `Enter` on a transcript standing open
     * put the film on the set instead of shutting it — and the second half of
     * the documented way out simply did not exist for the one object that had
     * just gained a new way in. Phil found it by trying to close one.
     *
     * Above the kinds rather than repeated inside each, because "press it again
     * and it goes away" is a fact about *being open* and not about what kind of
     * file is behind it. A recording that is **not** open still reaches the
     * branches below and still plays, which is the whole of what `Enter` meant
     * before.
     */
    if (opening.itemId === itemId) return closeOpen();
    if (kindOfItem(itemId) === "video") return watchItem(itemId);
    // And the third object, which takes over nothing at all (T-277). A cassette
    // does not turn up to be read and does not go on a set: it plays where it
    // hangs, the spools turn, and the board is exactly as usable as it was —
    // which D-46 section 4 calls the strongest reading of *nothing blocks
    // thinking* anywhere in this feature.
    if (kindOfItem(itemId) === "audio") return hearItem(itemId);
    // The toggle used to be here, where only a case file could reach it. It is
    // above the kinds now — see the note there.
    readItem(itemId);
    return true;
  };

  /**
   * Turn this folder up and fly to it — the open itself, with no toggle in it.
   *
   * Split out of `openItem` for the search (T-286), which must be able to land
   * on the same folder twice without the second landing shutting it. The toggle
   * is a property of the *gesture* — `Enter` on a selection, the menu's Open —
   * rather than of opening, and a search stepping through four matches in one
   * filing is not four presses.
   */
  const readItem = (itemId: string): void => {
    // One open thing at a time, held here rather than trusted to the two
    // branches above. `opening.open` replaces a turn already in progress on its
    // own; the set is a different object and would otherwise be left on behind
    // a folder, which is a state no single `Escape` could get out of.
    crt.close();
    opening.open(itemId);
    // Say which file is being read, so the shell holds that one open and lets
    // go of whatever it was holding. Not the *page* — asking for one is what
    // fetches it, and the layer does that when it draws.
    // `readableHash` and not the item's own asset, so a recording opens on its
    // transcript (T-287, Q-299). The page count comes off that same hash for the
    // same reason — a tape's record says how many *seconds* it is and a
    // transcript's says how many pages, and reading the wrong one would put "1
    // of 92" at the head of a two page sheaf.
    const reading = readableHash(itemId);
    if (reading !== null) {
      const record = board.assets.get(reading);
      // Both facts off the same read: how thick the folder is, and how its text
      // is to be read (T-347). The second is the record's because Rust never
      // sees a filename and a peer that was sent these bytes never had one.
      const asset = record ? readAsset(reading, record) : null;
      reader.open(reading, asset?.pages ?? null, asset?.markdown ?? false);
    }
    // Where the folder is going, not where it is. The turn has only just been
    // started and takes 300 ms; aiming at the closed box lands the camera on
    // the spot a *pinned* folder is about to turn out of (T-323).
    const box = scene.openBoundsOf(itemId, 0, foundBox);
    if (box !== null) flight.toBox(camera, box, undefined, pageReadingZoom(itemId));
  };

  /**
   * Open this case file at `page`, and say whether it could be — T-286.
   *
   * False for anything without a readable inside, which is the whole of the
   * caller's fallback: the flight it would have made is the flight it makes.
   *
   * **A recording is now let through, and only because of what it opens onto**
   * (T-287, Q-299). The line this replaced refused a tape outright, on the
   * argument that "a search that started the film would be the loudest thing on
   * this board happening because somebody typed a third character" — and that
   * argument is untouched, because this does not start the film. It turns the
   * tape up on its transcript, which is a sheet of paper and is silent. A
   * recording with no transcript still fails, one line down, on having nothing
   * readable rather than on being a recording.
   */
  const readInside = (itemId: string, page: number): boolean => {
    if (!readable(itemId)) return false;
    readItem(itemId);
    // After the open rather than inside it: `reader.open` is idempotent on the
    // document already being read and leaves its page where it is, which is
    // what lets the second match in one filing turn a page instead of
    // reopening the file underneath itself.
    reader.goto(page);
    return true;
  };

  /**
   * Follow a thread back to where it was quoted from — T-285, and the other half
   * of the two-way link `createQuoteCard` wrote when it taped the card on.
   *
   * There is no citation record to look this up in and there was never going to
   * be one: the tape *is* the citation. `crdt/ops/quote.ts` stuck it to the page
   * the rectangle was drawn on, with the page number on the pin (T-330), and
   * this reads back the same two facts — which item, which page — and hands them
   * to the open that the search already uses. So a quote card knows its source
   * because it is tied to it, which is D-1's claim about pins doing the work
   * once more, and nothing about following a thread has to survive a migration.
   *
   * **False for every ordinary pin**, which is the contract `ToolContext.follow`
   * depends on rather than a guard bolted on: a pushpin is not a citation, and a
   * tape with no page is stuck to the object rather than to a leaf of it. Both
   * answer no, and the double-click that asked goes back to meaning taut.
   *
   * A pin whose parent is gone answers no as well. It can outlive its item by a
   * frame — a peer deleting the folder while the card still hangs here — and
   * `readInside` would be asked to open an id the scene no longer has.
   */
  const followTape = (pinId: string): boolean => {
    const pin = scene.pins.get(pinId);
    if (pin === undefined || pin.kind !== "tape") return false;
    if (pin.parent === null || pin.page === null) return false;
    return readInside(pin.parent, pin.page);
  };

  /**
   * The zoom floor for arriving at an open case file — T-321.
   *
   * **Not `READING_ZOOM`**, which is what this used until now and is the wrong
   * question by about a factor of two. That floor is the board's own hand at 19
   * units; a page is typed at `PAGE_TEXT_SIZE` of the folder's width, which is
   * 8.4 — so arriving at 55 per cent over a document put you in front of type
   * less than half the size the number was measured on. A legible board and an
   * unreadable page.
   *
   * One expression rather than a new idea: the same `READABLE_PX`, asked about
   * the type the thing is actually set in. It comes out around 125 per cent,
   * where the board's-hand floor gives 55.
   *
   * A floor and not a target, like every other use of it. Opening a document you
   * are already reading at 300 per cent changes no zoom at all.
   */
  const pageReadingZoom = (itemId: string): number => {
    const slot = scene.slotOf(itemId);
    const w = slot === undefined ? 0 : (scene.w[slot] ?? 0);
    // A folder with no width yet is a folder whose record has not arrived. The
    // board's own floor is the honest answer there rather than a division by
    // zero, and the flight is a floor so being conservative costs nothing.
    return w > 0 ? readingZoomFor(w * PAGE_TEXT_SIZE) : READING_ZOOM;
  };

  /**
   * Shut whatever is open, and answer whether there was anything to shut.
   *
   * The answer is what lets `Escape` fall through: a board with nothing open
   * must still have `Escape` drop the selection, which is what it has always
   * done — so this reports rather than swallowing, and the caller decides.
   *
   * **The camera stays where it is.** AC-672 asks that closing be one
   * undo-irrelevant camera act rather than a document change, and flying back
   * would be a second act taking away the one thing the open bought you: you
   * are looking at the folder because you asked to be, and shutting it does not
   * mean you have stopped looking.
   */
  const closeOpen = (): boolean => {
    // Both, and answered as one. `Escape` means "shut what is open", and there
    // is no reading of it under which one press should leave the other up.
    const wasWatching = crt.close();
    // Left of the `||` so it always runs: this is the act, and `wasWatching` is
    // only how the answer is worded when there was no folder.
    return shutFolder() || wasWatching;
  };

  /**
   * Turn the open folder back down and let its file go — and answer whether
   * there was one.
   *
   * The two acts are one function because they drifted apart once (T-326).
   * `watchItem` shut the folder with a bare `opening.close()` and left the shell
   * holding the file: on a 51 MB scan that is 51 MB of working set held until
   * some *other* document is opened, because `pages.ts` only evicts the previous
   * file on the next `open`. Nothing on this side asks again — `Escape` off the
   * set finds `opening.itemId` already null and returns on the CRT.
   *
   * Not `closeOpen` itself, which is the version that cannot drift and is still
   * the wrong call from `watchItem`: that one shuts the set, which is the thing
   * about to be put on.
   */
  const shutFolder = (): boolean => {
    if (opening.itemId === null) return false;
    // Let the file go. On a 51 MB scan that is 51 MB of working set the shell
    // was holding open, and it is held until somebody says — Rust cannot infer
    // that a folder has been shut.
    // The hash that was being *read*, which for a recording is its transcript
    // and not the tape (T-287). Closing the tape's hash instead is silently
    // wrong in exactly T-326's way: `PageReader.close` matches on what it is
    // reading, so a mismatched hash leaves the document open, its pages held and
    // its blob URLs unrevoked — and tells the shell to let go of a file it was
    // never holding.
    const wasReading = readableHash(opening.itemId);
    if (wasReading !== null) reader.close(wasReading);
    opening.close();
    return true;
  };

  /**
   * The web address an item stands in for, or null — T-290, Q-305.
   *
   * Off the *document* rather than off `scene.cold`, which does not carry it:
   * this is asked when a menu opens rather than every frame, so there is no case
   * for widening the record the renderer walks.
   *
   * **Validated here as well as in Rust**, and the repetition is deliberate. An
   * item is a thing a peer can write, so `source` is untrusted input on both
   * sides of the boundary — this is what stops the *row* appearing for an
   * address that could never be opened, and Rust's check is what stops the
   * address reaching the shell. Neither makes the other redundant: one is about
   * what the menu offers and one is about what the OS is handed.
   */
  const sourceOf = (itemId: string): string | null => {
    const map = board.items.get(itemId);
    const source = map ? readItemFields(itemId, map)?.source : null;
    return source && /^https?:\/\//i.test(source) ? source : null;
  };

  /**
   * Which page of this item is the face on show — T-278, and null for every
   * item on the board except the one case file that is open.
   *
   * This is the join the pen and the renderer both need and neither can make.
   * `opening` knows which item is turned up and nothing about what is written on
   * it; `reader` knows which page is drawn and, deliberately, nothing about
   * items (`app/pages.ts` — "an item id would be a second fact about the same
   * page"). Here is the only place that holds both, which is why it is a
   * function passed down rather than a method on either of them.
   *
   * **`opening.itemId` rather than `scene.openOf`**, and the difference shows
   * for 300 ms twice per open. The scene's number is how far the turn has got,
   * so it is 0 on the frame the fold begins and a fraction on the ones after;
   * this is the *answer*, true from the press. A mark made while the cover is
   * still coming up belongs to the page you asked to see, because asking to see
   * it is what you did. Shutting is the same claim from the other side: the item
   * is let go of at the press, so ink drawn over a folder that is folding back
   * down goes on its cover, which is what it is turning into.
   *
   * A tape and a cassette never reach here: neither turns up to be read, so
   * neither is ever `opening.itemId` (see `openItem`).
   */
  const shownPage = (itemId: string): number | null =>
    opening.itemId === itemId ? reader.pageAt : null;

  /**
   * Press play on a cassette — T-277.
   *
   * **The camera does not move, nothing opens, and nothing is taken over.** The
   * tape's `watchItem` below says the board is about to be covered so moving the
   * camera first would be waste; this one says something stronger, which is that
   * the board is not going anywhere at all. You press play and carry on working,
   * and the only thing that changes on screen is the tape moving between two
   * reels on an object you can still drag, pin, string and draw on.
   *
   * The want is raised here rather than in the renderer, and it is the same
   * claim `filmFor` makes for a film: `assetUrl`'s want says *an item wearing
   * this is on screen*, and this one says *somebody has asked to hear it*. A
   * recording whose bytes have not arrived plays nothing and says so by doing
   * nothing audible — the press is not refused, because the file is on its way
   * and pressing again when it lands is the whole of what the person has to do.
   *
   * The original rather than a variant, on the same line the film takes: the
   * shell makes downscales of pictures and nothing else.
   */
  const hearItem = (itemId: string): boolean => {
    const sha256 = scene.cold(itemId)?.assetId ?? null;
    if (sha256 === null) return false;
    const here = assets.isReady(sha256);
    if (!here && exchange !== null) {
      exchange.want(sha256, Priority.VISIBLE);
      assets.requesting(sha256);
    }
    items.hear(itemId, here ? native.assetUrl(sha256, "original") : "");
    // True whether or not a sound came out: the press was understood, and a
    // caller falling through to some other reading of the key because a
    // transfer had not finished would be a worse answer than silence.
    return true;
  };

  /**
   * Put a tape on.
   *
   * > Watching a tape is linear, full-attention and done once. — D-46 section 4
   *
   * **The camera does not move and nothing about the board changes** — AC-676.
   * That is the difference from the folder, which flies the camera because you
   * are going to work at it; here the board is about to be covered, so moving it
   * first would be spending the one thing a camera move costs (DESIGN section
   * 3.7's spatial memory) on a view nobody is going to see. Shutting the set
   * puts you back exactly where you were, with no flight either way.
   */
  const watchItem = (itemId: string): boolean => {
    const sha256 = scene.cold(itemId)?.assetId ?? null;
    const film = sha256 === null ? null : filmFor(sha256);
    if (film === null) return false;
    // Pressed on the tape that is already on: the same toggle the folder has.
    // By hash rather than by item, because two items wearing one film are two
    // labels on one recording and putting it on twice is putting it on.
    if (crt.showing === film.id) return closeOpen();
    // The folder goes down and its file is released — the set replaces it, and a
    // document nobody is reading has no claim on the shell's working set.
    shutFolder();
    // One thing plays at a time (DESIGN section 3.7). A cassette playing behind
    // a film is two recordings at once out of one pair of speakers, which is
    // the one case where "carry on working" is not what anybody meant — and
    // unlike the folder, which may stay open behind nothing at all, this is a
    // sound competing with a sound.
    items.hush();
    crt.open(film);
    return true;
  };

  /**
   * How much of what matched has pages nobody can read — T-286, Q-273.
   *
   * Over the matches rather than over the board, which is what makes it a
   * footnote to *this* answer: a filing full of scans that has nothing to do
   * with the query is not something the field should be talking about.
   *
   * A folder is counted `whole` when the shell could not read it at all or
   * every page of it is silent, and `part` when some of it was readable. Only
   * things with words can be either — a note and a photograph are never asked,
   * so they sit at `unasked` and fall out here.
   *
   * **A recording is asked about its transcript**, through the same
   * `readableHash` the search itself walks (T-287), so an interview whose `.srt`
   * turned out to be unreadable is counted rather than passed over. What this
   * still cannot say is anything about a recording that has *no* transcript:
   * that one never becomes a match, so it is never in this loop to be counted.
   * Q-273 settled the reporting to be about the matches rather than about the
   * board, and this is the corner of that decision where the two genuinely
   * differ — so **the answer is not here** (T-334). A tape nobody transcribed is
   * a fact about the tape, and it says so on its own face: `CaseView.sticker`
   * draws `NO TRANSCRIPT` on it, which reports on the object rather than on the
   * board and leaves this rule exactly as Q-273 left it.
   */
  const unsearchedAmongMatches = (): Unsearched => {
    let whole = 0;
    let part = 0;
    for (const id of search.ids) {
      const sha256 = readableHash(id);
      if (sha256 === null) continue;
      const found = textIndex.of(sha256);
      if (found.phase === "unreadable") {
        whole += 1;
        continue;
      }
      if (found.phase !== "read" || found.pages.length === 0) continue;
      const silent = found.silence.scan + found.silence.empty + found.silence.unreadable;
      if (silent === 0) continue;
      if (silent === found.pages.length) whole += 1;
      else part += 1;
    }
    return { whole, part };
  };

  /** The count and its footnote, from wherever the answer last changed. */
  const reportSearch = (): void => {
    searchField.report(search.ordinal, search.count, unsearchedAmongMatches());
  };

  const searchField = new SearchField(world.layers.ui, {
    typed: (query) => {
      flyTo(search.run(scene, query));
      reportSearch();
    },
    stepped: (delta) => {
      // Re-walked before stepping, and forced, because the board moves under a
      // search: a collaborator can delete the note you were about to step onto,
      // and you can leave the field open while you work. The alternative is a
      // cursor into a list that was true when you stopped typing.
      search.run(scene, searchField.value, true);
      flyTo(search.step(delta));
      reportSearch();
    },
    closed: () => {
      // The query is dropped with the field. A search you closed is over, and a
      // held id would outlive the document if a bundle were opened next.
      search.clear();
      // The flight is not cancelled: you asked to be taken somewhere and then
      // put the field away, and snapping back mid-journey would undo the one
      // thing you did ask for.
    },
  });

  /**
   * The one keydown on this board that does **not** stand down for a text field.
   *
   * Every other listener here bails on `isTextTarget`, and rightly: `Delete`
   * inside a note is a character, not the board's. This one cannot, for a
   * circular reason — the thing it opens *is* a text field, so a Ctrl+F that
   * respected the bail could be pressed exactly once and never again from
   * inside its own box.
   *
   * Which also means it fires while a note is being edited, and that is the
   * browser's behaviour with find-in-page and the right one here: the editor
   * commits on blur (T-179), so the sentence is kept and the search opens.
   *
   * `preventDefault` unconditionally, because in a plain browser this is the
   * webview's own find bar — which would search the *DOM*, and on a board at
   * 30% zoom where two hundred items are not mounted at all, that is a search
   * that quietly lies about what is on the board.
   */
  window.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    if (e.code !== "KeyF") return;
    e.preventDefault();
    const reopened = searchField.isOpen;
    searchField.open();
    // Pressed again on an open field with something in it: say "yes, that one"
    // — re-walk, re-fly and re-flash the current match rather than doing
    // nothing. `open()` has selected the text, so typing still replaces it.
    if (reopened) {
      flyTo(search.run(scene, searchField.value, true));
      reportSearch();
    }
  });

  /**
   * A case file finishing its read, with the field open — T-286.
   *
   * The hook `TextIndex` was built without and now has one caller. Deferred to
   * here rather than written at the index's construction because `search` and
   * `searchField` did not exist yet at that line; see there.
   *
   * `refresh` rather than `run(force)`: the answer changes, the camera must
   * not. Somebody typing a query while twenty filings are still being read
   * would otherwise be flown at each one as it landed.
   */
  documentTextArrived = () => {
    if (!searchField.isOpen) return;
    search.refresh(scene);
    reportSearch();
  };

  /**
   * Ctrl+Z · Ctrl+Shift+Z (DESIGN section 3.7), and Ctrl+Y because this is a
   * Windows-first application and that is the other muscle memory.
   *
   * Ambient, like navigation — undo works in every tool, so it is not the tool
   * machine's. The intent is *queued* rather than acted on: `undo()` opens a
   * transaction, and a listener that writes to the document does it in the
   * middle of a frame whose layout phase has already read the scene.
   */
  window.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    // Inside a text field, Ctrl+Z belongs to the text field.
    if (isTextTarget(e.target)) return;
    // Undo is the one write that does not pass through `mutate` — `UndoManager`
    // opens its own transaction — so a sealed board has to refuse it here or
    // nowhere (T-224). Nothing this session put on the stack anyway.
    if (readOnly) return;
    const intent =
      e.code === "KeyZ" ? (e.shiftKey ? "redo" : "undo") : e.code === "KeyY" ? "redo" : null;
    if (!intent) return;
    e.preventDefault();
    // Held down, the key repeats and each repeat is another step back. That is
    // the point of holding it.
    //
    // Wrapped in `flashes.around` so that whatever the step turns out to move
    // is lit for a moment: undo is origin-scoped, so it can put back a value a
    // collaborator has since changed, in a corner of the board nobody is
    // looking at (DESIGN section 7.6, `state/flash.ts`).
    queued.push(
      intent === "undo"
        ? () => {
            if (flashes.around(dirty, scene, () => undo.undo())) revealChanged = true;
          }
        : () => {
            if (flashes.around(dirty, scene, () => undo.redo())) revealChanged = true;
          },
    );
  });

  /**
   * An undo landed and the camera has not yet been asked whether it can see
   * what moved — Q-79, `state/reveal.ts`.
   *
   * A flag rather than the check itself, because the check runs a phase and a
   * frame later. A pin's world position is recomputed in LAYOUT from the item
   * it hangs on, and the undo lands in phase 9 — so asking here would measure
   * the board as it was before the write it is asking about.
   */
  let revealChanged = false;

  const select = new SelectTool();
  /**
   * One placement and the board is back in `select` — see `state/tools/note.ts`
   * for why a tool nothing on screen advertises must not stay armed.
   *
   * Queued rather than switched on the spot: `setTool` cancels whatever the old
   * tool had hold of, which writes to the scene, and this runs from inside the
   * note tool's own `handle` in phase 1 — swapping the machine's tool out from
   * under the loop mid-drain is how a gesture ends up half delivered to each.
   */
  const note = new NoteTool({ onDone: () => queued.push(() => tools.setTool(select)) });
  const pinTool = new PinTool({ onDone: () => queued.push(() => tools.setTool(select)) });
  /** `S`. The primary verb — DESIGN section 1.3, "the string is the product". */
  const stringTool = new StringTool({ onDone: () => queued.push(() => tools.setTool(select)) });
  /**
   * `M` and `H` — the two pens of DESIGN section 3.9.
   *
   * Both sticky, unlike the note and pin tools, and for the reason they are not:
   * those place one thing and a second click would place another by accident,
   * while nobody draws exactly one stroke. `Escape` or `V` hands the board back.
   *
   * One class twice. The two differ in width, colour, opacity and compositing and
   * in nothing else about the gesture — `state/tools/marker.ts` takes a tool name
   * and reads the rest of it off `lib/ink.ts`, so the only thing said here is
   * which pen this is.
   */
  const marker = new MarkerTool({ onDone: () => queued.push(() => tools.setTool(select)) });
  const highlighter = new MarkerTool({
    tool: "highlighter",
    onDone: () => queued.push(() => tools.setTool(select)),
  });
  /**
   * `E` — the rubber, and the one tool that draws nothing.
   *
   * Not a `MarkerTool` and not a variant of one: it makes no mark, has no colour
   * and writes a delete rather than an insert (`state/tools/eraser.ts`). What it
   * shares with the pens is the gesture — a held pointer, the coalesced trail,
   * and a surface fixed at the press — and that is a shape, not a class.
   *
   * The `Shift+E` smudge is a mark and *is* the marker again — built fifteen
   * lines below and bound with the rest of the tool keys.
   */
  const eraser = new EraserTool({ onDone: () => queued.push(() => tools.setTool(select)) });
  /**
   * `Shift+E` — the smudge, which is a mark rather than an absence and is
   * therefore `MarkerTool` a third time.
   *
   * > A `Shift+E` smudge eraser paints a `destination-out` stroke for partial
   * > rubbing-out. — DESIGN section 2.4
   *
   * Everything about the gesture, the space rule and the commit is the pens'.
   * What differs is one line of compositing and the fact that it has no colour —
   * `lib/ink.ts` answers the palette with an empty list, and the menu drops the
   * row rather than offering four swatches that all do the same nothing.
   */
  const smudge = new MarkerTool({
    tool: "erase",
    size: DEFAULT_ERASER_SIZE,
    onDone: () => queued.push(() => tools.setTool(select)),
  });
  /**
   * The pen currently in hand, or null when the tool is not one.
   *
   * Asked by the three things that treat the two pens as one tool with a
   * variable in it: the right-click menu that loads it, the `[` and `]` keys
   * that walk its ladder, and the overlay, which draws whichever one is holding
   * the board.
   */
  const penInHand = (): MarkerTool | null =>
    tools.current === marker
      ? marker
      : tools.current === highlighter
        ? highlighter
        : tools.current === smudge
          ? smudge
          : null;
  /** The pen whose stroke the *overlay* draws — every one but the smudge, whose
   *  mark is an absence and belongs on the ink canvas. See the OVERLAY phase. */
  const wetPen = (): MarkerTool | null => {
    const pen = penInHand();
    return pen === null || pen.kind === "erase" ? null : pen;
  };
  /**
   * The three hit tests, named once. The tool machine is handed them, and so is
   * the hover in phase 4 — which asks the same questions between gestures that
   * a press asks during one, and has to get the same answers.
   */
  const hitItem = (bx: number, by: number): string | null => items.hitTest(scene, bx, by);
  // The pen's, and it is a *different answer* rather than a stricter one — the
  // strip a torn edge gave up is grabbable and is not writable (T-186, Q-149).
  const hitPaper = (bx: number, by: number): string | null => items.inkHitTest(scene, bx, by);
  // Where a sheet's paper ends, for the wet stroke's clip. The item layer owns
  // the answer and caches it; the overlay asks rather than deriving a second one
  // (T-186) — a wet stroke stopping somewhere the committed one does not is a
  // mark that changes shape at pen-up.
  overlay.setPaperResolver((forScene, id) => items.silhouetteOf(forScene, id));
  // And which face of an item is showing, so a peer's mark on page four is not
  // drawn on the cover of a folder that is shut here (T-278).
  overlay.setShownPage(shownPage);
  // And the three layers that draw what is *stuck to* a page (T-330): a tape on
  // page four is inside a shut folder and behind the sheet on show while you
  // read page twelve, and the thread it holds goes with it. One function, four
  // layers, for the reason the item layer is handed it — what a thing is filed
  // against and what is drawn have to be one answer.
  pins.setShownPage(shownPage);
  ropesUnder.setShownPage(shownPage);
  ropesOver.setShownPage(shownPage);
  // Screen space, because a pin's grab radius is in screen pixels and has a
  // floor — see `render/pins/dom.ts`.
  const hitPin = (sx: number, sy: number): string | null => pins.hitTest(scene, camera, sx, sy);
  // Board space, and against the particles: where a string *hangs*, which is
  // the only thing that knows about the sag.
  const hitString = (bx: number, by: number, reach: number): RopeHit | null =>
    ropes.nearest(bx, by, reach);

  const tools: ToolMachine = new ToolMachine(select, root, {
    scene,
    dirty,
    camera,
    selection,
    write: writer,
    hitTest: hitItem,
    inkHitTest: hitPaper,
    // And which face of it is showing, for the pen and the rubber both (T-278).
    shownPage,
    hitPin,
    hitString,
    /** A double-click on paper puts a caret in it (Q-92). */
    edit: startEditing,
    /** `Enter` on a selection of exactly one opens it (T-274, Q-257). */
    open: openItem,
    // Turning a page in whatever is open (T-321). The tool knows a keystroke
    // happened and nothing about documents; the reader knows which document is
    // open and how many pages it has, and answers whether anything moved.
    turnPage: (by) => reader.turn(by),
    /** Double-clicking a citation string opens what it was quoted from (T-285). */
    follow: followTape,
    // A rectangle dragged over an open page (T-282). The tool measured it in
    // the page's own frame and knows nothing else about it — what it turns
    // into is `app/clipping.ts`'s, because it needs the DOM, an await and a
    // round trip to Rust, and a tool may have none of the three.
    clip: (itemId, rect) => clipper?.cut(itemId, rect),
    // Space+drag and middle-drag belong to the camera, not to the board.
    suppressed: () => navigation.panReady,
    readOnly: () => readOnly,
  });

  /**
   * The seven tools of the drawer, paired with the instances they name.
   *
   * One list, two readers: the keydown listener below looks up by `Key${key}`,
   * and `ui/toolbar.ts` draws the same seven in the same order from its own
   * `RAIL`, which is where the letters and the glyphs live. Before this there
   * were two places a tool's letter was written down and nothing stopping them
   * disagreeing — which is a bug that would show as the rail lighting the wrong
   * button, and would survive every test in the project.
   *
   * The `Shift+E` smudge is deliberately not in here. It is not one of the
   * seven (D-44), it has no button, and its key is the only one carrying a
   * modifier — so it stays a branch of the listener rather than a row that
   * would have to be filtered out of the drawer.
   */
  const BY_ID: Readonly<Record<string, Tool>> = {
    [select.id]: select,
    [pinTool.id]: pinTool,
    [stringTool.id]: stringTool,
    [note.id]: note,
    [marker.id]: marker,
    [highlighter.id]: highlighter,
    [eraser.id]: eraser,
  };
  const RAIL_TOOLS = RAIL.map(({ id, key }) => {
    const tool = BY_ID[id];
    // A rail id with no tool behind it is a wiring mistake, and a silent one:
    // the button would draw, take a click and do nothing at all. Keyed off the
    // tools' own `id` fields above rather than off string literals, so this can
    // only fire if `ui/toolbar.ts` names a tool that does not exist.
    if (!tool) throw new Error(`[tools] the rail names "${id}", which is not a tool`);
    return { id, key, tool };
  });

  /** What a click on the rail, or a press of a tool letter, ends up doing. */
  const pickTool = (tool: Tool): void => {
    // Queued for the same reason `onDone` is: switching cancels the outgoing
    // tool's gesture, which touches the scene — and a DOM event listener is the
    // one place that must not happen.
    queued.push(() => tools.setTool(tool));
  };

  /**
   * Picking a tool (DESIGN section 3.9).
   *
   * All eight of DESIGN section 3.5's rows, `E` and `Shift+E` included.
   *
   * Unmodified keys, plus the one `Shift`. `Ctrl+V` is paste and must not also
   * change tool, and inside a note an `n` is an `n`.
   */
  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    if (isTextTarget(e.target)) return;
    // The one key with a modifier on it. `E` takes whole records away and
    // `Shift+E` rubs part of one out — two different tools, and DESIGN section
    // 3.5 lists them as two rows of the same table.
    const next =
      e.code === "KeyE" && e.shiftKey
        ? smudge
        : (RAIL_TOOLS.find((row) => e.code === `Key${row.key}`)?.tool ?? null);
    if (!next) return;
    e.preventDefault();
    pickTool(next);
  });

  /**
   * > Size is `[` and `]`. — DESIGN section 3.9
   *
   * Only while something with a nib is in hand, and silent otherwise: the two
   * keys mean nothing to the select tool, and a board that quietly resized an
   * invisible nib when they were pressed would be teaching the wrong thing.
   *
   * The eraser has one too. It makes no mark, but its width is what decides how
   * much of a sweep it takes, and a rubber you cannot make smaller is one you
   * cannot aim at a mark next to a mark you want to keep.
   *
   * Not queued, unlike a tool change. Nothing about loading a pen touches the
   * scene or the document — it is the tool's own state, read at the next release
   * (`state/tools/marker.ts`) — so there is nothing for phase 9 to protect.
   *
   * Separate from the tool-picking listener above rather than another branch in
   * it, because that one is a switch over which tool to *become* and returns
   * early on anything else.
   */
  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (isTextTarget(e.target)) return;
    const by = e.code === "BracketRight" ? 1 : e.code === "BracketLeft" ? -1 : 0;
    if (by === 0) return;
    const nibbed = penInHand() ?? (tools.current === eraser ? eraser : null);
    if (nibbed === null) return;
    e.preventDefault();
    nibbed.step(by);
  });

  /**
   * The context menu (DESIGN sections 3.2, 3.3 and 3.4).
   *
   * Ambient, like navigation and undo: a right-click means the same thing in
   * every tool, so it is not the tool machine's. The rows themselves are
   * `ui/boardmenu.ts`, which is a pure function of ids — this is only the part
   * that has to happen here, which is the hit test.
   *
   * ## Which of the three menus opens
   *
   * A pin, then a string, then an item, then bare cork — the same order a
   * left-click resolves in, because it is the order the things are physically
   * stacked in. `hitPin` first and in screen space, since a pin's grab radius
   * has a floor in pixels and is what `anchorAt` asks first too. `stringAt` for
   * the middle one, which is the *same* function the press and the hover
   * highlight go through, so the menu cannot offer a string a left-click would
   * not have grabbed: a string tucked under a photograph is not right-clickable
   * through the photograph either — and it is the item's menu that opens there,
   * which is the honest answer to a right-click on a photograph.
   *
   * `preventDefault` is duplicated with `Navigation`'s blanket one, which stops
   * the webview menu everywhere on the board including where this opens
   * nothing. Two calls, deliberately — the menu must not depend on some other
   * module happening to suppress the native one first.
   */
  const menu = new ContextMenu(world.layers.ui);

  /**
   * This board's invite link, or null when there is nothing to give away
   * (T-164).
   *
   * Declared here rather than beside the rest of the sync wiring below because
   * the context-menu handler closes over it, and the handler is registered
   * first. `board.ts` fills it in once the shell has answered with a secret, and
   * `rewire` replaces it when an invite moves this window to another board — so
   * it is a `let` on purpose, and reading it at any other time than menu-open is
   * a bug.
   */
  let invite: string | null = null;

  /**
   * Put the link where somebody can paste it, and say so.
   *
   * `navigator.clipboard` rather than a shell call: the webview is a secure
   * context, the click is the user activation the API wants, and adding a
   * clipboard *write* to `platform/types.ts` for one caller would mean building
   * it twice — the mock would need one too, and a browser's answer would be this
   * exact line.
   *
   * The failure path names the console rather than apologising, because there is
   * genuinely somewhere to go: the link is logged, and it can be copied from
   * there. A confirmation that only said "sorry" would leave somebody with no
   * next move.
   */
  const copyInvite = async (link: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(link);
      flash.say("Invite link copied — send it to whoever should join this board");
    } catch (error) {
      console.warn(`[sync] the invite could not be copied: ${link}`, error);
      flash.say("Could not reach the clipboard — the invite link is in the console");
    }
  };

  /**
   * Zip the whole board up somewhere the user picks (T-84).
   *
   * The three things Rust is told are all reads of the document, taken here
   * rather than in the shell because only this side can read a document at all
   * — `referencedAssets` is the same set the janitor spares, so what survives
   * collection is what a bundle embeds.
   *
   * Reads them at pick time, not at menu-open time. The rows are a snapshot and
   * every other one here is too, but a board can perfectly well have a
   * photograph arrive from a peer between the right-click and the dialog
   * closing, and the version that goes in the file should be the later one.
   *
   * ## The three things that can come back
   *
   * A cancelled dialog is `null` and says nothing — the user changed their
   * mind, and a line telling them so would be the application narrating its own
   * inaction.
   *
   * A complete export says how much went in it, because "it saved" and "it
   * saved and it is 40 MB of photographs" are different pieces of news to
   * somebody about to attach it to something.
   *
   * An export missing a photograph says *which count*, out loud. DESIGN section
   * 11.1's fourth risk is a board state a user can genuinely be in and the file
   * is still worth having, so this is not an error — but "export always embeds
   * assets" is a promise the file is quietly not keeping, and the person
   * handing it over is the one who needs to know that.
   */
  const exportBoard = async (): Promise<void> => {
    try {
      // The same three lines this used to hold, moved to `app/pack.ts` under
      // T-361 because homing and flushing a board write the same file out of
      // the same document, and three copies of that reader would drift.
      const spec = packSpec(board);
      const doc = snapshot(board);
      /**
       * What it will weigh, said before the dialog rather than after the file —
       * T-291, Q-314.
       *
       * A board with three interviews on it is several gigabytes, and D-64
       * measured why that cannot be fixed by compressing it: film and
       * recordings are already compressed. So the size is a fact about the
       * board rather than a fault in the format, and the honest thing to do
       * with a fact somebody is about to spend two minutes and six gigabytes of
       * disk on is to say it while they can still decide.
       *
       * It holds rather than fades, so it is also the progress line the export
       * never had — a six-gigabyte write is a long time for a window to sit
       * there saying nothing, which is the state `flash.hold` exists for.
       *
       * A weighing that fails is not an export that fails. The shell may be a
       * browser, or the store may have gone; either way the export below is the
       * thing being asked for, and it says what it wrote when it is done.
       */
      let held = false;
      try {
        const forecast = await native.bundleWeigh(spec);
        flash.hold(`Exporting about ${fileSize(forecast.bytes + doc.byteLength)}…`);
        held = true;
      } catch (error) {
        console.warn("[bundle] the board could not be weighed before export", error);
      }
      const written = await native.bundleSaveAs(spec, doc);
      if (written === null) {
        // A cancelled dialog says nothing, which now means taking down the line
        // that said what it would have weighed — it is a sentence about a file
        // that is not going to exist. Only ours: with no forecast up there is
        // nothing of this export's on screen, and clearing anyway would take
        // down whatever the last thing to happen had said.
        if (held) flash.clear();
        return;
      }
      const size = fileSize(written.bytes);
      /**
       * What went in it, called what it is — T-344.
       *
       * These two lines said *photographs* until a board could hold anything
       * else, and then went on saying it: a board with a film, a photograph and
       * a transcript on it exported and reported four photographs. The count
       * stays the shell's, because that is the one about the file; the noun
       * comes from the document, because only this side can read what an asset
       * is. A mixed board says `files` rather than picking one of the four
       * kinds to stand in for the other three.
       */
      const missing = new Set(written.missing);
      if (missing.size > 0) {
        flash.say(
          `Board exported (${size}) — without ` +
            `${filesLabel(missing.size, assetKindsOf(board, missing))} this machine does not have`,
        );
        return;
      }
      const inside = spec.assets.filter((hash) => !missing.has(hash));
      flash.say(
        `Board exported (${size}) — ` +
          `${filesLabel(written.embedded, assetKindsOf(board, inside))} ${written.embedded === 1 ? "is" : "are"} inside it`,
      );
    } catch (error) {
      // Names the console for the same reason `copyInvite` does: there is
      // genuinely somewhere to go, and a line that only apologises leaves
      // somebody with no next move.
      console.warn("[bundle] the board could not be exported", error);
      flash.say("The board could not be exported — the reason is in the console");
    }
  };

  /**
   * One photograph back out onto the disk, under the name it came in with
   * (T-101).
   *
   * The last thing in the application to reach `asset_export`, which has been
   * built and callable since T-94 and — until this row — had no caller at all,
   * so the save dialog it opens had never opened. Everything interesting about
   * it is on the far side: the path, the dialog, and the extension, which comes
   * from the stored bytes rather than from the name suggested here.
   *
   * ## Read at pick time, and there is no other honest moment
   *
   * `assetOrigName` walks the document, which is exactly what `exportBoard`
   * above does and for the same reason: the rows are a snapshot taken at the
   * press, and a photograph's metadata can arrive from a peer between the
   * right-click and the dialog opening. The later read is the better one.
   *
   * ## What each of the three outcomes says
   *
   * `false` is a cancelled dialog and says **nothing at all** — the contract in
   * `platform/types.ts` calls it an ordinary outcome, not a failure, and a line
   * announcing that nothing happened is the application narrating its own
   * inaction. `copyInvite` and `exportBoard` both stay quiet on the same
   * grounds.
   *
   * `true` says so, and says no more than that. It is tempting to name the file
   * — every other confirmation on this board carries a detail — but the name in
   * the sentence would be the one *suggested*, and the whole point of a save
   * dialog is that the user may have typed a different one. A confirmation that
   * quietly renamed their file back would be worse than a plain one.
   *
   * A rejection names the console, like the other two, because there is
   * genuinely somewhere to go: Rust stringifies the real error — a disk that is
   * full, a hash the store does not hold — and that sentence is worth more than
   * anything this side could guess at.
   */
  const savePhoto = async (sha256: string): Promise<void> => {
    try {
      const saved = await native.assetExport(sha256, assetOrigName(board, sha256));
      if (!saved) return;
      flash.say("Photograph saved");
    } catch (error) {
      console.warn("[asset] the photograph could not be saved", error);
      flash.say("The photograph could not be saved — the reason is in the console");
    }
  };

  /**
   * The board as a picture of itself, on one page (T-207).
   *
   * This assembles the [`Stage`] and nothing else: the ordering — pose, settle,
   * three frames, print, and a restore in a `finally` — is `app/exportPdf.ts`,
   * and the file is Chromium's. Every field below is something this function
   * already had to hand, which is the point of the interface: there is no state
   * an export owns, only a moment it arranges.
   *
   * `resizeCanvases` invalidates the two rope caches for the reason the window
   * `resize` above does — a resized canvas has a blank backing store, so every
   * cached screen-space path is a picture of a canvas that no longer exists.
   */
  const exportStage = (): PdfStage => ({
    camera,
    resizeCanvases: (width, height) => {
      world.resizeCanvases(width, height);
      ropesUnder.invalidate();
      ropesOver.invalidate();
    },
    hold: () => lod.hold("full"),
    settle: (zoom) => world.settle(zoom),
    redraw: () => dirty.everything(),
    frames: (count) =>
      new Promise<void>((resolve) => {
        let left = count;
        const tick = (): void => {
          left -= 1;
          if (left <= 0) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    // Both export routes wait on this. A re-raster is rationed across frames,
    // so three of them is enough for the mount and the layout and is not always
    // enough for the bitmaps — and a board photographed mid-raster comes out
    // with its ink half-drawn.
    settling: () => boardInk.settling,
  });

  const printBoard = async (): Promise<void> => {
    const stage = exportStage();
    const progress = exportProgress();

    try {
      const outcome = await exportPdf(
        stage,
        exportBounds(scene, selection.members),
        boardTitle(board),
        {
          // A format comes back where this route only ever wanted a yes:
          // one dialog command serves both, and the PDF has one format.
          choose: async (title) => (await native.exportChoose(title, "pdf")) !== null,
          write: (page) => native.exportPdfWrite(page),
        },
        {},
        progress.report,
      );
      if (outcome.done === "cancelled") return;
      if (outcome.done === "empty") {
        flash.say("There is nothing on this board to export yet");
        return;
      }
      // What came out, and — when a ceiling brought the scale down — that it
      // did. A softer file is not a failure and is not silence either: the
      // person handing it over is the one who needs to know it is not 1:1.
      const size = `${Math.round(outcome.view.inches.width)} × ${Math.round(
        outcome.view.inches.height,
      )} inches`;
      flash.say(
        outcome.view.reduced
          ? `Board saved as a PDF (${size}, reduced to fit one page)`
          : `Board saved as a PDF (${size})`,
      );
    } catch (error) {
      console.warn("[export] the board could not be printed", error);
      flash.say("The board could not be saved as a PDF — the reason is in the console");
    } finally {
      // Always, and for the reason the image route does it: a ticking line left
      // running goes on rewriting the flash *over* whatever sentence replaced
      // it, once a second, for ever.
      progress.done();
    }
  };

  /**
   * The board as a picture of itself (T-206).
   *
   * The six painters, in `render/world.ts`'s own stack order, which is the one
   * thing about this list that is not free to change: a string that passes
   * behind a photograph on screen and in front of it in the file is wrongness
   * nobody can prove without the two side by side.
   *
   * Every painter here is the application's own, and the ropes go through
   * `drawInto` rather than `draw` for a reason that cost a driven run to find:
   * `draw` clears the canvas first, which is right for a layer that owns one
   * and wipes the cork, the ink and the items off an export canvas that four
   * other painters have already drawn on. What came out was one blue curve on
   * white — the last painter's, alone — which looks nothing like the bug it is.
   */
  /**
   * WebP's quality, and the one number in this export nobody can derive.
   *
   * 0.9 rather than Chromium's 0.8 default: the board is photographs and
   * handwriting, and handwriting is thin dark strokes on pale paper — the first
   * thing a lossy encoder softens and the thing this whole export exists to
   * carry. It costs perhaps a third more bytes than the default and is still a
   * twentieth of the PNG.
   */
  const WEBP_QUALITY = 0.9;

  /**
   * The progress line, and the seconds ticking under it.
   *
   * A phase on its own is not enough for the encode: it is ninety seconds on a
   * large board, `toBlob` offers no progress of its own, and a sentence that
   * has not changed in a minute reads exactly like a window that has stopped.
   * A number going up is the smallest thing that says otherwise.
   *
   * `setInterval` rather than the frame loop, and that is not laziness: the
   * painters hold the main thread for seconds at a time and the loop is not
   * running frames during an export anyway. A one-second timer fires in the
   * gaps between awaits, which is exactly when there is something new to say.
   */
  const exportProgress = (): { report: (phase: ExportPhase) => void; done: () => void } => {
    let ticking: ReturnType<typeof setInterval> | null = null;
    const stop = (): void => {
      if (ticking !== null) clearInterval(ticking);
      ticking = null;
    };
    return {
      report: (phase) => {
        stop();
        const phrase = phraseFor(phase);
        flash.hold(phrase);
        // Only the long ones get a clock — see `phaseTicks`. On the others it
        // would be a counter that never left zero, which says "this is slow"
        // about something that is not.
        if (!phaseTicks(phase)) return;
        const startedAt = performance.now();
        ticking = setInterval(() => {
          flash.hold(`${phrase} — ${Math.round((performance.now() - startedAt) / 1000)}s`);
        }, 1000);
      },
      done: stop,
    };
  };

  const saveBoardImage = async (): Promise<void> => {
    const progress = exportProgress();
    try {
      const outcome = await exportImage(
        {
          ...exportStage(),
          canvas: (width, height) => {
            const canvas = document.createElement("canvas");
            canvas.width = width;
            canvas.height = height;
            return canvas;
          },
          painters: [
            { name: "cork", paint: (ctx, view) => cork.paintInto(ctx, view) },
            { name: "board-ink", paint: (ctx, view) => boardInk.drawInto(ctx, view) },
            { name: "ropes-under", paint: (ctx) => ropesUnder.drawInto(ctx, scene, ropes, camera) },
            { name: "items", paint: (ctx, view) => items.rasterise(scene, ctx, view) },
            { name: "ropes-over", paint: (ctx) => ropesOver.drawInto(ctx, scene, ropes, camera) },
            // Last, where DESIGN section 6.2 puts this layer: above the items
            // and above both rope canvases, because a pin is physically on top
            // of what it holds. It was missing entirely until T-214 — the
            // export was built on "only the items are DOM", and the pins are
            // DOM too.
            { name: "pins", paint: (ctx, view) => pins.drawInto(ctx, scene, view) },
          ],
          now: () => performance.now(),
          /**
           * `toBlob` resolving `null` is how a canvas says no, and WebP says it
           * for a reason PNG never does: past roughly 220 megapixels of
           * photographic content Chromium's encoder simply gives up
           * (`MAX_WEBP_PIXELS`). The ceiling keeps an ordinary export well
           * clear of that, but it is a bound on something content-dependent, so
           * the message names the format and points at the one that always
           * works rather than saying the board could not be saved.
           */
          encode: async (canvas, format) => {
            const blob = await new Promise<Blob | null>((resolve) =>
              canvas.toBlob(resolve, `image/${format}`, format === "webp" ? WEBP_QUALITY : undefined),
            );
            if (blob === null) {
              throw new Error(
                format === "webp"
                  ? "this board is too large to encode as WebP — PNG will take it"
                  : "the board would not encode as a PNG",
              );
            }
            return new Uint8Array(await blob.arrayBuffer());
          },
          /**
           * Read the file back and say how big it is.
           *
           * `createImageBitmap` rather than an `<img>`: it takes the blob
           * directly, needs no object URL to revoke, and decodes off the main
           * thread — which matters, because the thing being measured is up to
           * a couple of hundred megapixels.
           */
          measure: async (bytes, format) => {
            const bitmap = await createImageBitmap(
              new Blob([bytes], { type: `image/${format}` }),
            );
            const { width, height } = bitmap;
            bitmap.close();
            return { width, height };
          },
        },
        exportBounds(scene, selection.members),
        boardTitle(board),
        {
          // The dialog picks the format, not this call — see `ImageWriter`.
          choose: async (title) => {
            const chosen = await native.exportChoose(title, "image");
            return chosen === "webp" ? "webp" : chosen === null ? null : "png";
          },
          write: (bytes) => native.exportImageWrite(bytes),
        },
        {},
        progress.report,
      );
      if (outcome.done === "cancelled") {
        // Nothing was said, because nothing happened: `choose` comes before the
        // board moves, so a cancelled export never reached a phase.
        return;
      }
      if (outcome.done === "empty") {
        flash.say("There is nothing on this board to export yet");
        return;
      }
      // The console rather than the flash: an export of a large board takes
      // minutes and the interesting part is *which* minute. The flash gets the
      // one sentence somebody standing there needs.
      console.info(
        `[export] ${outcome.format}, ${outcome.view.width}×${outcome.view.height}, ` +
          `${Math.round(outcome.bytes / 1048576)} MB, ` +
          `${outcome.painted.map((p) => `${p.name} ${p.ms}ms`).join(", ")}, ` +
          `encode ${outcome.encodeMs}ms`,
      );
      // Pixels *and* megabytes. A whole-board export at the canvas ceiling is
      // 22181 × 12096 and 456 MB of PNG — measured, on a board of two dozen
      // photographs — and somebody about to attach that to an email is better
      // off finding out here than from the thing that refuses it.
      const size = `${outcome.view.width} × ${outcome.view.height}`;
      const mb = outcome.bytes / 1048576;
      const weight = mb >= 10 ? `, ${Math.round(mb)} MB` : "";
      // The format is in the sentence because the two are not interchangeable —
      // one is lossless and one is a twentieth of the size — and the file it
      // went to is named for it.
      const what = outcome.format === "webp" ? "WebP" : "PNG";
      flash.say(
        outcome.view.reduced
          ? `Board saved as ${what} (${size}${weight}, reduced to fit)`
          : `Board saved as ${what} (${size}${weight})`,
      );
    } catch (error) {
      console.warn("[export] the board could not be saved as an image", error);
      flash.say("The board could not be saved as an image — the reason is in the console");
    } finally {
      // The timer, always. A held progress line is replaced by whichever
      // sentence follows it, but a ticking one left running would go on
      // rewriting the flash *over* that sentence, once a second, for ever.
      progress.done();
    }
  };

  /**
   * Put this window on another board (T-356).
   *
   * **The gesture that used to destroy a board and no longer does.** Until
   * T-356 this replaced the document on disk with the one out of a `.schizo`,
   * which is why it came with a native "Replace this board?" and why the row
   * sat last on the menu. A board is a file now: opening board B leaves board A
   * intact in its own file, so there is nothing to warn about, nothing to agree
   * to, and no room to mint (Q-114 moved into `board.rs`, which mints one on
   * first sight of a file it has never seen).
   *
   * The picker is `board_open_picked` and the switch is `board_open`, and they
   * are two calls rather than one for a reason this file has to honour: the
   * order below is load-bearing. `close()` unsubscribes and *then* awaits its
   * own flush, so past that line nothing can enqueue — and past that line the
   * shell may point `doc_append_update` at another board's log. Closing before
   * the picker would leave a window that had stopped saving every time somebody
   * cancelled a dialog.
   *
   * Then the window reloads, which is Q-77's answer to the same shape of
   * problem. It reads like avoiding the work and is the opposite: half the
   * application holds a reference to this `Y.Doc` — the binding, the scene
   * mirror, undo, the rope set, the sync provider — and swapping it underneath
   * all of them is a great deal more machinery than `boot()` already is, to
   * arrive at a board `boot()` produces correctly by construction.
   *
   * ## What happened to the schema check
   *
   * A `.schizo` from a newer build used to be refused here (T-224), and the
   * reason was that the route past read-only mode was *destructive*: exporting a
   * future board and opening it wrote the document over this window's log, and
   * by the time the reload found out, there was nothing to go back to. Nothing
   * is written over now. A board this build cannot fully read opens read-only,
   * exactly as one that arrived over sync does, and the board you were on is
   * still in its own file — so the check that has to happen is the one at boot,
   * which was always there.
   */
  /**
   * A board nothing has ever been on — *New board…* (T-364).
   *
   * No dialog, and the asymmetry with `openBoard` below is the design rather
   * than an omission: a new board has no file to find. It gets one from
   * `homeBoard` a second and a half after the reload, which is the same road
   * the board adopted from before T-356 takes.
   *
   * The order past `boardNew` is `switchToBoard`'s and for the same reasons —
   * the shell has already pointed this window's log at the new board by the
   * time it returns, so there is no way back that is not a reload.
   */
  const newBoard = async (): Promise<void> => {
    try {
      await pack.settle();
      await persistence.close();
      await native.boardNew();
    } catch (error) {
      // Past `close()` this window is not saving and cannot be made to again,
      // so this reloads whatever happened — onto the new board if the shell got
      // that far, and onto the old one if it did not, because `board_new`
      // takes its own entry back out of the register when the workshop will not
      // open. A window left running and silently not saving is much the worse
      // of the two.
      console.error("[board] a new board could not be started; this window is reloading", error);
    }
    window.location.search = "";
  };

  /**
   * Fold this board's file back into one — the row (T-367).
   *
   * Held rather than said, because on a board of any size this is seconds of
   * disk and a line that had already faded would leave somebody wondering
   * whether anything happened. `ui/flash.ts` reserves `hold` for a thing that
   * is happening and stays true until it stops, which is exactly this.
   */
  const tidyBoard = async (): Promise<void> => {
    flash.hold("Tidying up this board's file…");
    const outcome = await pack.compact();
    if (outcome === null) {
      // A board with no file of its own, which the row should not have been
      // offered on — so this is a race with `board_home` rather than a state,
      // and taking the line down is the whole of what it needs.
      flash.clear();
      return;
    }
    if ("error" in outcome) {
      console.warn("[pack] this board's file could not be tidied up", outcome.error);
      flash.say("This board's file could not be tidied up — the reason is in the console");
      return;
    }
    const missing = new Set(outcome.missing);
    if (missing.size > 0) {
      // The same news `exportBoard` gives, and it matters more here: this
      // rewrote the file, so a photograph that was not in the new one is a
      // photograph that has just left it.
      flash.say(
        `This board's file is tidied up — without ` +
          `${filesLabel(missing.size, assetKindsOf(board, missing))} this machine does not have`,
      );
      return;
    }
    /**
     * A proportion, not a size. `lib/filesize.ts` floors at 1 MB on purpose —
     * "0 MB" reads as nothing having been written — which is right for the
     * sentence about a file somebody is handing over and wrong for this one: an
     * eight-kilobyte board tidies to one and a half, and *1 MB* is both
     * uninformative and, read quickly, alarming. It said exactly that until a
     * run put it on screen.
     *
     * And nothing at all when there was nothing to reclaim, rather than
     * "0% smaller", which is a sentence about arithmetic instead of about the
     * board.
     */
    const saved = Math.round(outcome.reclaimed * 100);
    flash.say(
      saved > 0
        ? `This board's file is tidied up — ${saved}% smaller`
        : "This board's file is tidied up",
    );
  };

  /**
   * Whether the row is worth offering, read the way the recents are.
   *
   * A boolean rather than a fraction, so the threshold stays in the one place
   * that also acts on it. A number here would be the same decision written down
   * in two languages, which is a decision that will eventually disagree with
   * itself.
   *
   * The answer only changes when this window writes the file, so it is read
   * after every flush rather than when the menu opens — `boardMenuRows` is
   * synchronous because every other row on it is, and an awaited row would pop
   * the menu a frame or two after the click.
   *
   * **After every flush, and that is not a detail.** Reading it once at boot is
   * what this was first written as, and the row then never appeared: at boot a
   * pack has nothing superseded in it, and everything that supersedes anything
   * happens later. Every test passed and the shell answered correctly to
   * nobody; only driving it found that.
   *
   * That leaves it a beat stale between a flush landing and this resolving,
   * which is the right way round to be wrong — the row appears a moment late
   * rather than offering to reclaim what has already been reclaimed.
   */
  let worthTidying = false;
  readTidy = () => {
    void native
      .boardWorthTidying()
      .then((worth) => {
        worthTidying = worth;
      })
      .catch((error) => {
        console.warn("[pack] this board's file could not be measured", error);
        worthTidying = false;
      });
  };
  readTidy();

  const openBoard = async (): Promise<void> => {
    let picked;
    try {
      picked = await native.boardOpenPicked();
    } catch (error) {
      console.warn("[board] that board could not be opened", error);
      flash.say("That board could not be opened — the reason is in the console");
      return;
    }
    if (picked === null) return;
    await switchToBoard(picked.packId);
  };

  /**
   * Stop writing to this board, point the shell at another, and reload.
   *
   * Past `close()` this window is no longer saving and cannot be made to again
   * — it is a one-way door, and the reload is what comes through it. So a
   * failure below does not return: it reloads anyway, onto the board this
   * window was already on, because the register is written last on the far side
   * and a switch that failed changed nothing there. A window left running and
   * silently not saving would be the worse of the two by a long way.
   */
  const switchToBoard = async (packId: string): Promise<void> => {
    try {
      // The pack first, and D-67 fixes this order rather than leaving it to
      // taste: this reads the *document*, and `close()` is the one-way door
      // past which this window may no longer be writing to the board it thinks
      // it is. A board left behind is left with its file up to date — and
      // tidied, if enough of it has been superseded to be worth the rewrite
      // (T-367, Q-350). The shell holds that threshold.
      await pack.settle();
      await persistence.close();
      const opened = await native.boardOpen(packId);
      if (opened.missing.length > 0) {
        // Said to the console rather than to the person: this window is about
        // to stop existing and a flash lasts 2.4 seconds. `files` rather than a
        // kind is the only honest word going — these hashes are the *incoming*
        // board's, and the document that could say what they are is the one
        // this window is about to load (T-344).
        console.warn(`[board] ${opened.missing.length} files were not in that board's file`);
      }
    } catch (error) {
      console.error("[board] the switch failed; this window is reloading where it was", error);
    }
    // The whole query string, not just `board=`: every parameter this
    // application reads off one names a board or somewhere to look for it
    // (`planSync`), and none of them is about the board being opened. The room
    // comes from the shell's register now, through `board_remembered`.
    window.location.search = "";
  };

  /**
   * The boards you had, for the menu (T-364, D-69).
   *
   * ## Read once, and that is not a shortcut
   *
   * The register only changes when a window changes boards, and a window that
   * changes boards *reloads* — so within one session this list cannot go stale
   * by anything this window does. Another window could add a board, and there
   * is one window per board, so the case is a second Schizoboard opening a
   * board this one has never seen; that shows up on the next launch. Reading it
   * when the menu opens would be the alternative and is worse: `boardMenuRows`
   * is synchronous because every other row on it is, and an awaited row would
   * pop the menu a frame or two after the click that asked for it.
   *
   * Capped at five in `list.slice`, which is D-69's number and lives here
   * rather than in the shell: the register is the whole record and this is one
   * menu's opinion about how much of it is a menu.
   */
  let recents: BoardRow[] = [];
  const readRecents = async (): Promise<void> => {
    try {
      recents = recentBoards(await native.boardList(), (packId) => void switchToBoard(packId));
    } catch (error) {
      // A menu with no recents on it, which is also what a fresh installation
      // looks like. Nothing else on this menu depends on the answer.
      console.warn("[board] the other boards could not be listed", error);
    }
  };
  void readRecents();

  root.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    // A right-click on the menu itself, or on the HUD. Chrome takes its own.
    if (isChromeTarget(e.target)) return;

    /**
     * Open, and queue the selection those rows were computed against.
     *
     * Queued to phase 9 with every other consequence of an input, so the halo
     * and the menu appear on the same frame rather than a frame apart. A
     * `select` of `undefined` means the target was already selected and the
     * selection is what the rows act on, so there is nothing to move.
     */
    const open = (rows: readonly MenuEntry[], select?: () => void): void => {
      if (rows.length === 0) return;
      if (select) queued.push(select);
      menu.openAt(e.clientX, e.clientY, rows);
    };

    /**
     * Right-clicking something already selected acts on the whole selection;
     * right-clicking something else acts on that one thing and takes the
     * selection with it.
     *
     * The second half is what stops the menu being a trap. Without it, a
     * right-click on an unselected string would offer verbs against whatever
     * happened to be selected somewhere off-screen — and the halo, which is the
     * only thing on the board that says what a verb will hit, would be pointing
     * at it rather than at the string under the cursor.
     */
    /**
     * On a read-only board there is one menu and it is the board's (T-224).
     *
     * The four below are verbs against a document this build may not write to —
     * a paper stock, a slack preset, *Add pin*, *Bring to front* — and a menu of
     * rows that do nothing is the disabled row this file has refused to draw
     * everywhere else (see `boardmenu.ts` on absent, not disabled). What is left
     * is the cork's own menu, which is where the things that are still true live:
     * the exports, the invite link, and whether the board ages. The one row cut
     * out of *that* is *Open a board…*, which replaces this one.
     *
     * The string rows go with `[]`: on this path they are the selection's, and
     * every one of them writes.
     */
    if (readOnly) {
      open(
        boardMenuRows(
          scene,
          writer,
          [],
          selection.toArray(),
          { link: invite, copy: copyInvite },
          { on: prefs.ageing(), set: setAgeing },
          native.kind === "tauri"
            ? {
                export: () => void exportBoard(),
                // Offered on a sealed board, which is the whole of T-356 in one
                // line: opening board B writes nothing to board A, so there is
                // nothing here to refuse (T-364, AC-1016).
                open: () => void openBoard(),
                // And the guard moved here. Minting a board changes what boards
                // this installation has, and a build that cannot fully read the
                // document in front of it is not the one to make that change.
                new: null,
                // Absent for the same reason `recents` is not: this list is a
                // way to leave, and leaving is allowed.
                recents,
                pdf: native.canPrintPdf ? () => void printBoard() : null,
                image: () => void saveBoardImage(),
                // Never offered here, and `giveThisBoardAHome` refuses on the
                // same grounds: this build can only partly read this document,
                // so the file it wrote would be missing whatever it cannot see.
                home: null,
                // And the same, one step further: a compaction rewrites the
                // file out of `packSpec`, so on a sealed board it would drop
                // every photograph this build cannot see (T-367).
                tidy: null,
              }
            : null,
        ),
      );
      return;
    }

    /**
     * A pen in hand short-circuits the four hit tests below, because with one
     * held a right-click is not about the paper under the cursor: there is no
     * selection to act on and no verb to offer a photograph that drawing on it
     * would want. The menu loads the pen instead — DESIGN section 3.9's palette,
     * which is given a page of colours and no key to pick them with.
     *
     * Before the tests rather than after, so it holds over a pin and a string
     * too. A pen does not care what is underneath, and a menu that changed its
     * mind depending on what a stray pixel of string was doing under the cursor
     * would be the worse surprise.
     */
    const pen = penInHand();
    if (pen !== null) {
      open(penMenuRows(pen));
      return;
    }

    const pinId = hitPin(e.clientX, e.clientY);
    if (pinId !== null) {
      const held = selection.hasPin(pinId);
      open(
        pinMenuRows(scene, writer, held ? [...selection.pins] : [pinId]),
        held ? undefined : () => selection.replaceThread([], [], [pinId]),
      );
      return;
    }

    const hit = stringAt(scene, camera, hitItem, hitPin, hitString, e.clientX, e.clientY, shownPage);
    if (hit !== null) {
      const held = selection.hasString(hit.string);
      open(
        stringMenuRows(scene, writer, held ? [...selection.strings] : [hit.string]),
        held ? undefined : () => selection.replaceStrings([hit.string]),
      );
      return;
    }

    const board = camera.screenToBoard(e.clientX, e.clientY);
    const itemId = hitItem(board.x, board.y);
    if (itemId !== null) {
      const held = selection.has(itemId);
      open(
        itemMenuRows(
          scene,
          writer,
          itemId,
          held ? selection.toArray() : [itemId],
          board.x,
          board.y,
          startEditing,
          // Absent in a plain browser, where `mock.ts`'s `assetExport` rejects
          // — the same standing the board's own file rows are on below.
          //
          // `gone` is the one state `AssetStates` is certain about: the exchange
          // asked every peer that claimed the hash and ran out of people to ask
          // (`state/assets.ts`), which is also what draws the item torn. Every
          // other phase — including the `unknown` a photograph sits at until
          // something asks for it — leaves the row up, because a save that is
          // going to work must not be hidden by a state that only means "nobody
          // has looked yet".
          native.kind === "tauri"
            ? {
                gone: (sha256: string) => assets.phase(sha256) === "unavailable",
                save: (sha256: string) => void savePhoto(sha256),
              }
            : undefined,
          // Not gated on the shell, unlike the row above it: opening happens on
          // this board rather than through a file dialog, so a plain browser
          // can do it exactly as well as the app can.
          // The wrapper is T-273's: `openItem` answers whether it did anything,
          // so that Escape can fall through, and a menu row has no use for that.
          { can: openable, run: (id: string) => void openItem(id) },
          // What it is, for the rows that name it rather than merely act on it
          // (T-317). The same three hops `openable` makes, and the same reason
          // the menu cannot make them itself: a kind comes off an asset record.
          kindOfItem,
          // Following a pasted link back to its page (T-290, Q-305). The
          // address is read from the document rather than from the caption,
          // which is a thing somebody can rewrite — and validated here as well
          // as in Rust, because an item is a thing a peer can write.
          {
            can: (id: string) => sourceOf(id) !== null,
            run: (id: string) => {
              const source = sourceOf(id);
              if (source === null) return;
              void native.openLink(source).catch((error: unknown) => {
                // Said, not swallowed. A row that does nothing and explains
                // nothing is indistinguishable from a broken board (DESIGN 1.3).
                console.warn(`could not open ${source}:`, error);
                flash.say("That link could not be opened.");
              });
            },
          },
          // Reading a recording's transcript (T-287, Q-299). Narrower than
          // `readable` on purpose: a case file is readable and must not get this
          // row, because *Open* above already turns it up on its own pages and
          // two rows for one act is worse than one row nobody can find.
          {
            can: (id: string) => {
              const kind = kindOfItem(id);
              return (kind === "video" || kind === "audio") && readable(id);
            },
            showing: (id: string) => opening.itemId === id,
            // The toggle, not `openItem`'s: that one plays a recording that is
            // not open, which is right for `Enter` and wrong for a row that
            // says *Read the transcript*. Same row, same verb, both directions.
            run: (id: string) => {
              if (opening.itemId === id) void closeOpen();
              else readItem(id);
            },
          },
        ),
        held ? undefined : () => selection.replace([itemId]),
      );
      return;
    }

    /**
     * Bare cork — the one case with nothing under the cursor to name, so the
     * menu is about the string selection as it stands, and about the board
     * itself (Q-76).
     *
     * The string rows are kept because a right-click *near* a string is a
     * right-click that missed by a few pixels, and a menu that vanished for it
     * would be worse than one that offers the string you are plainly pointing
     * at. What changed with T-164 is that empty cork with nothing selected is no
     * longer a gesture that opens nothing: it is where the invite lives, because
     * it was the only surface left and because the honest answer to "what is
     * here" on bare cork is the board.
     */
    open(
      boardMenuRows(
        scene,
        writer,
        [...selection.strings],
        // Only to word the PDF row — the export itself reads the selection when
        // it runs, which is a beat later and is the one that matters.
        selection.toArray(),
        { link: invite, copy: copyInvite },
        { on: prefs.ageing(), set: setAgeing },
        native.kind === "tauri"
          ? {
              export: () => void exportBoard(),
              // No read-only guard, and its removal is the whole of T-356 in
              // one line: opening another board writes nothing to this one, so
              // a sealed board may still do it.
              open: () => void openBoard(),
              new: () => void newBoard(),
              recents,
              // The one row a platform can take away: `PrintToPdf` is
              // WebView2's, so macOS and Linux get the image and no PDF row at
              // all (T-210, Q-139).
              pdf: native.canPrintPdf ? () => void printBoard() : null,
              image: () => void saveBoardImage(),
              // Null on every board that has a file of its own, which is every
              // board a few seconds after boot. Read at open time like every
              // other row here, so a home that succeeded while the menu stood
              // open leaves the row behind until the next right-click — which
              // is harmless: `homeBoard` asks the register first and does
              // nothing at all for a board that already has a file.
              home: homeRetry,
              tidy: worthTidying ? () => void tidyBoard() : null,
            }
          : null,
      ),
    );
  });

  /**
   * The board's own clipboard, which cannot be built yet: it says what it did
   * through the flash, and the flash needs the UI layer that is put together
   * a hundred lines below. `Paste` needs to be able to *ask* it before then,
   * so the question goes through the binding rather than through the object.
   *
   * Null is the honest answer during boot — a paste arriving between these two
   * lines has no clip to be, because nothing has been copied yet.
   */
  let boardClipboard: BoardClipboard | null = null;

  const paste = new Paste({
    native,
    board,
    camera,
    // Nothing lands on a board somebody cannot see (T-324). The set is the only
    // thing in this application that takes the screen, and it cannot enforce
    // that itself: it is a keydown swallow, and neither a `paste` event nor the
    // shell's own file drop is a keydown.
    //
    // **`isOpen`, not `showing`.** That one hands back "the caller's own id" and
    // is the *empty string* when nothing is on, so `showing !== null` is true
    // forever — which typechecks, and which shipped in the first version of this
    // line. The unit tests could not see it because they inject this predicate;
    // what caught it was a run where the board would take no paste at all.
    covered: () => crt.isOpen,
    claim: (data, at) => boardClipboard?.claim(data, at) === true,
    cursor: () => tools.cursor,
    // Where a refused file says so (T-260). The same surface the export report
    // uses, because "this did not work" and "this worked" belong in one place —
    // a person learns where to look once.
    say: (message) => flash.say(message),
    // Putting something down and then wanting to move it is one gesture in two
    // halves, so the second half starts with it already held.
    onCreated: (ids) => {
      selection.replace(ids);
      // Paste writes straight through rather than queueing, so this is already
      // downstream of the create — but the pins it may have landed on are not
      // re-indexed until the next LAYOUT phase, which is why the re-home is
      // queued like the rest and not called here.
      rehome();
    },
  });
  await paste.attach();

  const hud = new Hud(world.layers.ui, loop, () => stats(), native.kind);
  /**
   * The board-level half of DESIGN 7.5 — how many photographs nobody here has,
   * and whose they are. Silent, and touching no DOM at all, until there is one.
   */
  const notice = new Notice(world.layers.ui);
  /**
   * Where a verb with no visible result says it happened (T-164).
   *
   * Copying an invite is the first thing on this board that changes nothing on
   * the board, so it is the first that needs telling.
   */
  const flash = new Flash(world.layers.ui);

  /**
   * The stretch of the open page a rectangle has hold of, or null.
   *
   * The one call in the quoting feature that needs a *document*, and both
   * halves of the gesture make it: the release reads the words out of this
   * ({@link Clipper}'s `passage`), and every frame of the drag before it
   * measures the same stretch to mark the words on the screen — T-283, Q-294.
   *
   * Written once for that reason. Two carets computed two ways would be two
   * answers to "which words", and the whole claim the marking makes is that
   * what is under the highlight is what will be on the card.
   *
   * `caretRangeFromPoint` rather than `caretPositionFromPoint`: both exist in
   * this webview and the first hands back a `Range` already, which is what
   * `passageSpan` takes. Which four points the rectangle is, which two of them
   * a passage runs between, and how far a caret is widened to make a word, are
   * all decided next door in `clipping.ts` — a decision left in this file is a
   * decision nothing tests.
   */
  const passageUnder = (itemId: string, rect: Bounds): Range | null => {
    const quad = screenQuad(scene, camera, itemId, rect);
    const ends = quad === null ? null : readingCorners(quad);
    if (ends === null) return null;
    const from = document.caretRangeFromPoint(ends[0].x, ends[0].y);
    const to = document.caretRangeFromPoint(ends[1].x, ends[1].y);
    if (from === null || to === null) return null;
    return passageSpan(from, to);
  };

  /**
   * The words the rectangle currently has hold of, in screen boxes — T-283.
   *
   * Asked once a frame while a clip drag is live and null on every other
   * frame, which is what keeps this off the cost of an ordinary board: it is a
   * caret hit test and a layout read, and neither happens unless somebody is
   * dragging over a page.
   *
   * **Only where there are words to take.** A scan is quotable by rectangle
   * alone (D-46) and a rectangle on one must go on looking exactly as it did —
   * marking nothing is the honest picture of what a cut off a scan produces,
   * which is pixels. The same test the cut itself forks on, asked a frame
   * earlier, so the marking and the card cannot disagree about which arm this
   * gesture is on.
   */
  const clipWords = (): readonly ScreenBox[] | null => {
    const at = select.clipTarget;
    if (at === null) return null;
    const page = clipper?.pageOf(at.itemId) ?? null;
    if (page === null) return null;
    if (page.content.kind !== "text" && page.content.kind !== "plain") return null;
    const span = passageUnder(at.itemId, at.rect);
    if (span === null) return null;
    return passageBoxes(span, (part) => part.getClientRects());
  };

  /**
   * Cutting a clipping out of an open page — T-282.
   *
   * Built here rather than beside the reader because it needs the one thing
   * that lives at the very end of this file: somewhere to say a sentence. The
   * tool reaches it through the indirection below, which is not ceremony —
   * `ToolMachine` is constructed a thousand lines above this, and a cut cannot
   * happen before there is a board to cut on.
   */
  clipper = new Clipper({
    board,
    scene,
    /**
     * Which page is on show and what is on it — the join neither half can make.
     *
     * `shownPage` above knows which item is open and which page number it is
     * showing; the reader holds the page itself; the document holds what the
     * file was called. This is the one place all three are in scope, which is
     * the same argument `shownPage` itself makes one level down.
     *
     * **Through `readableHash`, and that is the third caller to need it** —
     * T-287. The item's own hash is the *tape*, so asking the reader for page
     * one of it hands back nothing (the reader is open on the transcript), and
     * `Clipper.cut` treats nothing as "not a case file" and returns without a
     * word. The whole quoting half of a recording was unreachable that way, and
     * silently: the same class of failure `sayWhatWasRefused` exists to prevent,
     * reached by a resolver rather than by a refusal.
     */
    shownPage: (itemId) => {
      const index = shownPage(itemId);
      if (index === null) return null;
      const sha256 = readableHash(itemId);
      if (sha256 === null) return null;
      const page = reader.page(sha256, index).page;
      if (page === null) return null;
      const record = board.assets.get(sha256);
      // What the item itself is wearing, which for a recording is the tape and
      // for a case file is the same hash again. The difference between the two
      // is the whole of what makes this page a *transcript* rather than a
      // document, and it is the one thing a citation has to know: a quote off a
      // transcript names the recording and the moment, never the sidecar and a
      // page number (T-287, Q-301).
      const worn = scene.cold(itemId)?.assetId ?? null;
      const tape = worn !== null && worn !== sha256 ? board.assets.get(worn) : undefined;
      return {
        sha256,
        index: page.index,
        content: page.content,
        origName: (record ? readAsset(sha256, record)?.origName : null) ?? null,
        cues: page.cues,
        of:
          worn === null || tape === undefined
            ? null
            : { sha256: worn, origName: readAsset(worn, tape)?.origName ?? null },
      };
    },
    rasterise: (itemId, ctx, camera) => items.rasteriseInFrame(scene, itemId, ctx, camera),
    canvas: (w, h) => {
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      return canvas;
    },
    /**
     * The encoder's answer, not the one asked for — `poster.ts`'s rule, and for
     * its reason: a build without WebP hands back a PNG under the same call and
     * says so on the blob, so storing it as the type we requested would put a
     * mime in the record that the bytes disagree with.
     */
    encode: async (canvas) => {
      const blob = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob(resolve, CLIP_MIME, CLIP_QUALITY);
      });
      if (blob === null) return null;
      return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: blob.type || CLIP_MIME };
    },
    ingest: (bytes, mime) => native.assetIngestBytes(bytes, mime),
    /**
     * The words under the rectangle, off the document's own caret hit test.
     *
     * The two decisions this could have got wrong are both next door in
     * `clipping.ts` and neither is here: which four points the rectangle is
     * (`screenQuad`, through the pose the item is drawn at) and which two of
     * them a passage runs between (`readingCorners`, which is reading order and
     * not rectangle order — the page lies a quarter turn inside the folder, so
     * the rectangle's own first corner is the bottom left of what you can see).
     * What is left here is the one call that needs a document.
     *
     * `caretRangeFromPoint` rather than `caretPositionFromPoint`: both exist in
     * this webview and the first hands back a `Range` already, which is what
     * `passageBetween` takes.
     *
     * What those two carets are worth reading *as* is next door too, and since
     * T-332 it is not `toString()`: a page carrying a figure is built out of
     * blocks with the figure between them, so a range across one has three
     * elements in it and one of those can be the board's own sentence about a
     * figure it could not lift.
     */
    passage: (itemId, rect) => {
      const span = passageUnder(itemId, rect);
      if (span === null) return { text: "", at: 0 };
      // Where the passage began, in the page's own text — what a transcript's
      // citation is built from (T-287). `startOffset` is a `Range`'s offset in
      // its container, and a plain page is written with `textContent`, so its
      // whole text is one node and the two are the same number. A typed page is
      // built out of many nodes and this is an offset into whichever one the
      // caret landed in — which no citation reads, because a typed page has no
      // cues and is cited by its page number.
      return { text: quotationIn(span), at: span.startOffset };
    },
    /**
     * Whether the rectangle crossed a picture on the page — T-331, Q-290.
     *
     * A document-level query and not a walk down from the item, because only
     * one case file is open at a time and `shownPage` has already said this is
     * the one. The same reasoning `passage` runs on: the decision about what
     * "crossed" means is next door in `crosses`; what is here is the one call
     * that needs a document.
     *
     * A figure with pixels wins over one without, whatever order they are in
     * the page: the two answers are different sentences to whoever dragged the
     * rectangle, and a drag across both has caught a picture.
     */
    figureUnder: (itemId, rect) => {
      const quad = screenQuad(scene, camera, itemId, rect);
      if (quad === null) return null;
      return figureCrossed(
        quad,
        [...document.querySelectorAll(".leaf-figure")].map((figure) => ({
          drawn: figure.getAttribute("data-figure") === "image",
          box: figure.getBoundingClientRect(),
        })),
      );
    },
    stored: (sha256) => {
      // Written into this store a moment ago, so this machine is a holder —
      // `PosterGrabber` says the same thing for the same reason, and without it
      // the card draws as undeveloped film until the next idle reconcile.
      holdsAsset(sha256);
      refreshAsset(sha256);
    },
    say: (message) => flash.say(message),
  });
  /**
   * The tool drawer and the tool info bar — Phase 10, D-43.
   *
   * Until these, every tool on this board was reachable only from the keyboard
   * and nothing on screen said which one you were holding. That held while the
   * board was being built by the person who wrote the key map, and stops holding
   * the moment somebody else has to find their way in.
   *
   * The drawer reports and does not decide: a click arrives here as an id and
   * goes through `pickTool`, which is the same queue a keystroke uses, because
   * `setTool` cancels the outgoing gesture and touches the scene.
   *
   * Whether it is open is a fact about this *machine* rather than about the
   * board (`app/prefs.ts`), so it is read at construction and written back on
   * the handle — the panel itself never touches storage, since `ui/` imports
   * nothing from `app/`.
   */
  const drawer = new Toolbar(world.layers.ui, {
    open: prefs.toolbar(),
    pick: (id) => {
      const row = RAIL_TOOLS.find((each) => each.id === id);
      if (row) pickTool(row.tool);
    },
    // The handle puts *the chrome* away, not just the rail. The two are one
    // piece of furniture — which tool you are holding, and what it does — so
    // hiding one and leaving the other would be hiding half a sentence.
    toggled: (open) => {
      prefs.setToolbar(open);
      toolinfo.setVisible(open);
    },
  });
  const toolinfo = new ToolInfo(world.layers.ui);
  toolinfo.setVisible(drawer.open);
  /**
   * What the info bar has to say about the board itself, rather than about the
   * tool — the two sentences that used to be branches of `hintText`.
   *
   * Rebuilt on the two occasions it can change rather than on every frame: it
   * is an object, `sync` runs sixty times a second, and a fresh one per frame
   * would be an allocation for a value that is the same for whole sessions.
   * `readOnly` is a `let` because a peer can seal this board mid-session
   * (T-224), and `packTaken` because another window can take this board's file
   * mid-session (T-368). Those are the two things that move it after boot.
   */
  let boardStatus: BoardStatus = {};
  const restateBoard = (): void => {
    boardStatus = readOnly
      ? { sealed: { boardVersion: boardSchemaVersion(board), buildVersion: SCHEMA_VERSION } }
      : persistence.readOnly
        ? { unsaved: true }
        : packTaken
          ? { taken: true }
          : {};
  };
  restateBoard();
  /**
   * And now the store has somewhere to complain to — see `trouble` at the top
   * of `boot`.
   *
   * `hold` rather than `say` for the failure: `ui/flash.ts` reserves it for "a
   * thing that is happening and stays true until it stops", which is exactly a
   * disk that is refusing writes, and it ends by being replaced with the
   * sentence that says it finished. A 2.4-second `say` for this would be a
   * board quietly not saving itself for the rest of the afternoon.
   */
  sayTrouble = (message) => {
    if (message === null) flash.say("The board is being saved again");
    else flash.hold(message);
  };
  // A store that failed to open did so before this line existed.
  if ((held.doc ?? held.pack) !== null) sayTrouble(held.doc ?? held.pack);

  /**
   * T-368, and it is `onSealed`'s shape rather than `sayTrouble`'s.
   *
   * A held flash **and** the standing line, because the two answer different
   * questions: the line is there for somebody who looks down in an hour and
   * wonders why the file has not changed, and the flash is for the moment it
   * happens, which is otherwise completely silent — nothing on the board moves
   * when a window stops writing a file.
   *
   * The flash is the one thing here that can be replaced by the next message, and
   * that is correct: it is news, and the line behind it is the record.
   */
  sayTaken = () => {
    restateBoard();
    flash.hold(
      "Another window has this board's file — your work is still being saved here, " +
        "but the file has stopped being updated",
    );
  };
  // Refused before there was anywhere to say so: the first flush of a session
  // lands five seconds in, and a slow boot can still be behind it.
  if (packTaken) sayTaken();

  /**
   * And now `Ctrl+C`, `Ctrl+X` and `Ctrl+D` have somewhere to say what they did
   * — see the `let` above `paste` for why this is here rather than there.
   *
   * `write` and not the document: cut deletes through the same queued writer
   * every other verb uses, because it is the same delete `Delete` performs
   * (`state/erase.ts`).
   */
  boardClipboard = new BoardClipboard({
    board,
    camera,
    selection,
    // Nothing lands on a board somebody cannot see (T-324). The set is the only
    // thing in this application that takes the screen, and it cannot enforce
    // that itself: it is a keydown swallow, and neither a `paste` event nor the
    // shell's own file drop is a keydown.
    //
    // **`isOpen`, not `showing`.** That one hands back "the caller's own id" and
    // is the *empty string* when nothing is on, so `showing !== null` is true
    // forever — which typechecks, and which shipped in the first version of this
    // line. The unit tests could not see it because they inject this predicate;
    // what caught it was a run where the board would take no paste at all.
    covered: () => crt.isOpen,
    scene,
    write: writer,
    cursor: () => tools.cursor,
    // A paste puts down items, free pins and the strings between them, and the
    // gesture that usually follows is moving the lot — so it arrives held, the
    // same way `Paste` hands over what it created.
    onPasted: (pasted) => {
      selection.replaceThread(pasted.items, pasted.strings, pasted.freePins);
      // Fresh paper lands above everything, so any pin it came down on top of
      // has a new topmost item — the same re-home every create queues.
      rehome();
    },
    say: (message) => flash.say(message),
  });
  boardClipboard.attach();

  /**
   * > `Ctrl+D` duplicate — DESIGN section 3.9
   *
   * Ambient, like undo and unlike `Ctrl+A`: it acts on the selection rather than
   * on a gesture, and the selection survives a tool change. Nothing about
   * putting a second copy of a note on the board is the pen's business or the
   * pin's, so a person who drew on something and wants two of it should not
   * have to press `V` first.
   *
   * `preventDefault` because in a plain browser this is *bookmark this page*.
   */
  window.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    if (e.code !== "KeyD" || isTextTarget(e.target)) return;
    if (readOnly) return;
    e.preventDefault();
    // Queued so that it lands *in order* with whatever else this frame is about
    // to write. A duplicate that ran ahead of the pose a release queued moments
    // earlier would copy the note from where it used to be.
    queued.push(() => boardClipboard?.duplicate());
  });
  /**
   * When the notice last checked that what it is counting is still on the board.
   *
   * The check is a scene walk, so it is throttled and — more to the point — only
   * runs at all once something is actually missing. A healthy board never pays
   * for it.
   */
  let noticeSweptAt = 0;
  let docBytes = 0;
  let docMeasuredAt = 0;
  const stats = (): HudStats => {
    // Encoding the whole document is cheap now and will not always be, so it
    // is measured at 1 Hz rather than at the HUD's 5 Hz paint rate.
    const now = performance.now();
    if (now - docMeasuredAt > 1000) {
      docMeasuredAt = now;
      docBytes = encodedSize(board);
    }
    // A board with no wire wants nothing, because nothing could bring it.
    const transfers = exchange?.stats() ?? { wanted: 0, inFlight: 0, percent: 0 };
    return {
      zoom: camera.zoom,
      lodTier: lod.tier,
      cameraX: camera.x + camera.width / (2 * camera.zoom),
      cameraY: camera.y + camera.height / (2 * camera.zoom),
      // Everything phase 3 is stepping: items mid-swing plus ropes not yet
      // settled. One number, because it answers one question — is the
      // simulation asleep? — and a board at rest must read zero.
      // Particles for the ropes rather than a rope count, because that is what
      // the field is called, what DESIGN section 9.5 asks for, and what
      // `MAX_AWAKE_PARTICLES` is spent in — a number that has to mean the same
      // thing as the cap for the HUD to be any use in watching it. A rope
      // force-slept by the viewport gate leaves this count, which is the
      // cheapest way to see the gate working at all.
      awakeParticles: torsion.awake + ropes.awakeParticles,
      docBytes,
      items: scene.size,
      mounted: items.mounted,
      // Board-ink tiles count as inked surfaces and their backing stores count
      // as pixels. The HUD's ink numbers exist to make the memory risk (DESIGN
      // section 9.5, risk 5) watchable, and a tile is the largest single bitmap
      // on the board — leaving it out would be the one omission that matters.
      janitorPending: janitor.pending,
      janitorSwept: swept,
      assetsWanted: transfers.wanted,
      assetsInFlight: transfers.inFlight,
      assetsPercent: transfers.percent,
      assetsUnavailable: assets.countUnavailable(),
      inked: items.inked + boardInk.mounted,
      inkPixels: items.inkPixels + boardInk.pixels,
    };
  };

  /**
   * The debounced gesture end, where everything holding a bitmap re-rasterises
   * at the scale it is actually being displayed at (DESIGN section 6.6). A
   * photograph's "bitmap" is whichever stored variant it is pointed at, so this
   * is where it reconsiders.
   *
   * `everything()` because the choice depends on each item's size and there is no
   * cheaper way to say "every item may want a different file now". Once per
   * gesture, on the frame the whole world layer is repainting regardless.
   */
  world.onRasterize((scale) => {
    items.setRasterScale(scale);
    boardInk.setRasterScale(scale);
    dirty.everything();
  });

  /**
   * How much of an item is worth drawing at this zoom (T-90, DESIGN section
   * 6.6).
   *
   * Beside the re-raster because it is woken by the same event, and separate
   * from it because the raster gate would swallow it — `render/world.ts`'s
   * `SettleListener` says why. Constructed here rather than inside `World`
   * because a tier is a statement about *content*, and the world is the layer
   * stack: it owns the camera transform and the will-change discipline, and has
   * never heard of an item.
   *
   * `dirty.everything()` only when the tier actually moved, which is what makes
   * this affordable to hang off every gesture end: the ordinary zoom that
   * settles somewhere between the boundaries costs one comparison.
   */
  const lod = new Lod();
  lod.on((tier) => items.setTier(tier));
  world.onSettle((zoom) => {
    if (lod.settle(zoom)) dirty.everything();
    // Every settle, not only the ones that changed tier (T-202): a pan at 100%
    // mounts thirty items in one tier and those thirty are the ones owed their
    // detail. No dirty pass — the layer drains ahead of its own clean-frame
    // guard, precisely because a resting camera produces clean frames.
    items.settled();
  });

  // --- sync ----------------------------------------------------------------
  /**
   * The wire, if there is one.
   *
   * Everything above this line is a board that works alone; everything Phase 7
   * builds needs a provider to exist, and until now nothing constructed one.
   * `app/sync.ts` owns the decision of what to connect to — that part has cases
   * and is tested — and this owns the wiring, which does not.
   *
   * `provider` is null on a plain browser with no `?relay=`, which is the fast
   * dev loop working as designed rather than a failure: `platform/mock.ts`
   * refuses `syncStart` and the board is simply local. Every use below is
   * therefore guarded, and none of them is on a hot path.
   */
  /**
   * The compaction section 8.1 names, ticked in phase 9.
   *
   * It collects the records no cascade can reach — a string left with fewer than
   * two nodes that resolve to a pin, which two peers produce between them
   * without either of them being wrong (T-76 found both ways). Constructed
   * unconditionally because a board with no wire has them too, from a document
   * loaded off disk that was shared earlier.
   */
  const janitor = new Janitor(board);
  /** How many records it has collected this session, for the dev HUD. */
  let swept = 0;
  /**
   * Whether a collaborator has hold of a segment of this string — DATA-MODEL
   * section 5.4's advisory lock, which the janitor waits on rather than obeys.
   *
   * A walk of everybody's claims, which is a handful of peers holding almost
   * always nothing, and it is asked only about a string that is already ripe.
   * The lock lives in `render/presence/peers.ts` because it is drawn; the
   * janitor may not reach for it, so it is handed over.
   */
  const heldByAPeer = (stringId: string): boolean => {
    for (const peer of peers.peers()) {
      for (const lock of peer.locks) if (lock.string === stringId) return true;
    }
    return false;
  };

  // The address bar, or the invite that launched this window — see
  // `openingPlan`. Cold arrivals cost nothing here: there is no provider yet, so
  // the link is simply the plan.
  const plan = await openingPlan(
    () => native.syncTakeInvite(),
    () => native.rememberedBoardId(),
    window.location.search,
  );
  if (plan.complaint !== null) console.warn(`[sync] ignored: ${plan.complaint}`);
  const address = await dialAddress(native, plan.config);
  const provider = address === null ? null : new WireProvider(board.doc, address);
  if (provider === null) console.info("[sync] local board — no relay to dial");
  else console.info(`[sync] ${plan.config.mode} · ${address}`);
  provider?.on("error", (error) => console.warn("[sync] error", error));
  provider?.on("denied", (reason) => console.warn(`[sync] denied: ${reason}`));

  /**
   * The peers this client finds for itself (T-70).
   *
   * One more provider per board the shell finds on the network, on this same
   * document and sharing this same awareness — see `app/mesh.ts` for why nobody
   * is elected and why no second `AssetExchange` is needed.
   *
   * Only where there is already a provider, because the awareness object to
   * share comes from it: with no wire at all there is nothing to join a peer
   * *to*, and under `platform/mock.ts` no peer is ever announced anyway.
   */
  const mesh =
    provider === null
      ? null
      : new Mesh({
          connect: (url) => {
            console.info(`[sync] found a peer at ${url.replace(/token=[^&]*/, "token=…")}`);
            const found = new WireProvider(board.doc, url, { awareness: provider.awareness });
            found.on("denied", (reason) => console.warn(`[sync] a found peer refused us: ${reason}`));
            found.on("error", (error) => console.warn("[sync] found peer error", error));
            return found;
          },
        });
  // Awaited for the same reason `asset:ready` is: `listen` is a round trip, and
  // a peer announced before it resolves is a peer this window never dials.
  if (mesh !== null) await native.on("sync:peer-found", (peer) => mesh.found(peer));

  /**
   * Work out what this board's invite says, now that the shell has a secret for
   * it (T-164).
   *
   * Asked of `syncStatus` rather than read off `plan.config`, because the plan
   * is what was *requested* and the secret is very often not in it: the ordinary
   * first launch of a board asks for no secret at all and the shell answers with
   * the one it found on disk or invented (Q-75). So the shell is the only place
   * that knows, and this is the round trip that gets it.
   *
   * Null on a plain browser, which is correct and not a gap — `platform/mock.ts`
   * has no relay to hold a secret, and the invite row simply does not appear.
   */
  const refreshInvite = async (boardId: string): Promise<void> => {
    const status = await native.syncStatus();
    invite = status.secret === null ? null : formatInvite({ boardId, secret: status.secret });
  };
  await refreshInvite(plan.config.boardId);

  /**
   * An invite clicked while this board is already open (T-165, Q-77).
   *
   * The **warm** arrival, and the one that has something to tear down: a
   * provider, a mesh, an asset exchange and a presence, all bound to the
   * connection this window has been using. Q-77 settled how — the window
   * reloads, and the whole boot path runs again against the new plan.
   *
   * That is not the lazy answer, it is the safe one. Nothing about the document
   * changes when you join another board — there is one per installation, and it
   * is on disk — so all that is really moving is the wire. Four things
   * individually detached and reattached is four ways to be left half-connected,
   * and the symptom of any of them is a board that looks synced and is not,
   * which is the most expensive kind of wrong this application has.
   *
   * The link's own query string is what the window reloads with, unchanged. That
   * is `inviteSearch`, and it is the whole "an invite is the address bar" idea
   * being spent rather than merely stated.
   */
  await native.on("deeplink:open", ({ url }) => {
    const search = inviteSearch(url);
    if (search === null) return;

    // Already here. Worth saying rather than silently doing nothing: somebody
    // who clicks an invite twice, or who clicks their own, has asked a question
    // and deserves the answer — and reloading for it would throw away their
    // camera and selection to arrive exactly where they already were.
    //
    // Compared as links rather than field by field, so there is one notion of
    // what "the same board" means and it is the one the user was handed. A link
    // carrying no secret cannot match — it is not a link this window would ever
    // have produced — so it reloads, and settles on the second pass once the
    // shell has answered with the secret it kept (Q-75).
    const arriving = parseInvite(url)?.config;
    const asLink =
      arriving?.secret === undefined
        ? null
        : formatInvite({ boardId: arriving.boardId, secret: arriving.secret });
    if (asLink !== null && asLink === invite) {
      flash.say("You are already on that board");
      return;
    }

    // The menu may be standing open with the *old* board's invite in it, which
    // would otherwise be copyable for the moment before the page goes. It is
    // also about to be a menu belonging to a board nobody is on.
    menu.close();
    flash.say("Joining that board…");
    window.location.search = search;
  });

  /**
   * The bytes behind the document (T-74).
   *
   * The document syncs an item saying "a 4032x3024 JPEG, sha256 abc…"; nothing
   * in it says what the pixels are, so without this a fully synced board is a
   * wall of empty frames.
   */
  if (provider !== null) {
    exchange = new AssetExchange(provider, native, {
      onProgress: (sha256, received, total) => {
        assets.transferring(sha256, received, total);
        // Bytes are moving, so whatever the notice said about this hash is over.
        // On `transferring` rather than on `ready` for the reason `assets` also
        // clears its sticky `unavailable` there: somebody who holds it has
        // turned up, and that is the news, not the last chunk.
        missing.arrived(sha256);
      },
      onUnavailable: (sha256, tried) => {
        assets.unavailable(sha256);
        // Who claimed it and could not produce it, kept so the board can say so
        // (DESIGN 7.5). This is the only moment those ids exist — the exchange
        // drops the want, and the set with it, on the line after this call.
        missing.unavailable(sha256, tried);
        console.warn(`[sync] nobody on this board has ${sha256.slice(0, 8)}`);
      },
    });
  }

  /**
   * What this client tells everybody else, every other frame (T-71).
   *
   * The scene is handed over as the pose source for the `grab` field: a drag is
   * published as where the held items *are*, which is a question only the scene
   * can answer, and `state/presence.ts` is what decides how much of that answer
   * reaches the wire.
   */
  const presence =
    provider === null
      ? null
      : new Presence(
          provider.awareness,
          camera,
          selection,
          scene,
          identityFor(board.doc.clientID),
        );

  /**
   * Everybody else's states, as they arrive.
   *
   * The arrival *time* is the reason this is a subscription rather than a poll of
   * `getStates()` in phase 2: `state/remote.ts` needs to know when a sample
   * landed, and only the moment it lands knows that. `change` rather than
   * `update` because `Awareness` bumps its own clock every fifteen seconds
   * whether anything changed or not, and a heartbeat is not a sample.
   *
   * Our own state is skipped. It is in `getStates()` like everyone else's, and
   * interpolating our own drag would fight the gesture making it.
   */
  /**
   * Remember a peer's name, for the notice about photographs only they have.
   *
   * `readPeer` is the same validation the cursors are drawn through, so the name
   * in the notice and the label on the cursor cannot disagree - and a state with
   * no `user` in it is skipped by both.
   */
  const nameFor = (client: number, state: unknown): void => {
    const peer = readPeer(state);
    if (peer !== null) missing.seen(client, peer.name, peer.color);
  };
  provider?.awareness.on(
    "change",
    ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
      const arrived = performance.now();
      const states = provider.awareness.getStates();
      for (const client of added) {
        const state = states.get(client);
        remote.observe(client, state, arrived);
        peers.observe(client, state);
        nameFor(client, state);
      }
      for (const client of updated) {
        const state = states.get(client);
        remote.observe(client, state, arrived);
        peers.observe(client, state);
        nameFor(client, state);
      }
      // Awareness drops a peer's state on disconnect by design, and this is the
      // only notice of it there is.
      for (const client of removed) {
        remote.forget(client);
        peers.forget(client);
        // Not a matching `forget`. A peer who has gone is the ordinary reason a
        // photograph is unavailable, so this is exactly when their name becomes
        // worth having (DESIGN 7.5) - `missing` keeps it and marks them absent.
        missing.left(client);
      }
    },
  );
  if (provider !== null) {
    remote.ignore(board.doc.clientID);
    peers.ignore(board.doc.clientID);
  }

  const resize = (): void => {
    const { innerWidth: w, innerHeight: h } = window;
    camera.resize(w, h);
    world.resizeCanvases(w, h);
    // Resizing blanks the backing store, so every cached screen-space path is
    // now a picture of a canvas that no longer exists.
    ropesUnder.invalidate();
    ropesOver.invalidate();
  };
  window.addEventListener("resize", resize);
  resize();

  // Best effort, and only worth the line because the window closing is the one
  // moment a whole batch can be in flight: a gesture that ended 199ms ago is
  // otherwise the one thing a clean exit loses.
  window.addEventListener("pagehide", () => {
    void persistence.flush();
    // And the coarse tier, which cannot be awaited here either. What a quit
    // loses at worst is one idle interval of the *pack* and never of the
    // document — the workshop is what the next launch reads, and it reads it in
    // preference to the pack precisely because of this moment.
    pack.flushBestEffort();
  });

  // --- the nine phases (docs/ARCHITECTURE.md section 3) ---------------------

  let undoSelectionVersion = selection.version;
  /**
   * -1 rather than the camera's current version, so the first frame is dirty and
   * the culler and the screen-space layers all get one guaranteed pass.
   */
  let cameraVersion = -1;
  /**
   * The zoom the camera was last seen at, so a *zoom* can be told from a *pan*
   * (T-202). NaN so the first comparison is false and the opening fit does not
   * read as a zoom gesture.
   */
  let lastZoom = Number.NaN;
  loop.on("input", (frame) => {
    navigation.flush();
    /**
     * One frame of a search's camera flight (T-85).
     *
     * **After `navigation.flush()`, and that ordering is the whole cancel.** A
     * hand on the mouse this frame has just had its say and bumped
     * `camera.version`; the flight compares that number against the one it left
     * behind and stands down when they differ. Stepped first, the flight would
     * write the camera, see its own value back, and fly on through a pan —
     * which is the one failure mode this feature has that would make the board
     * feel broken rather than merely wrong.
     *
     * Here in INPUT rather than anywhere later for `state/navigation.ts`'s
     * reason: the camera is read by every phase after this one, and a write
     * from outside the loop leaves the DOM phase's version check unable to
     * trust itself.
     */
    flight.step(camera, frame.dt);
    /**
     * The match is lit when the flight lands, not when it is chosen.
     *
     * `!flight.active` covers all three endings without any of them reporting
     * separately: it arrived, a hand took the camera off it, or it never took
     * off because the match was already under your nose. In the last of those
     * this is the same frame as the keystroke.
     */
    if (foundPending !== null && !flight.active) {
      found.raise(foundPending, scene);
      foundPending = null;
    }
    if (navigation.gestured) world.gestureTick(camera.zoom);
    tools.flush(frame.dt);
    // The camera is moved by navigation, by a resize, and by undo restoring a
    // stashed view in phase 9 of the frame before. Comparing the version once
    // per frame, here at the top, catches all three without any of them having
    // to remember to raise a flag — and it is phase 1, so phases 4 and 5 see it.
    if (camera.version !== cameraVersion) {
      cameraVersion = camera.version;
      dirty.camera = true;
      // Which of the two kinds of camera move this was. See `DirtySets.zoomed`:
      // the item layer mounts coarsely during a zoom and in full during a pan,
      // because a zoom is the one that brings items in by the hundred.
      if (camera.zoom !== lastZoom) {
        if (Number.isFinite(lastZoom)) dirty.zoomed = true;
        lastZoom = camera.zoom;
        // Detail may arrive mid-gesture; it may not leave (T-203). Zooming in
        // used to hold flat cards through the whole motion and then pop a
        // hundred and forty sheets into detail on the first still frame — a
        // change of appearance timed for the one moment nothing was moving.
        // `Lod.rise` says why the two directions are not symmetrical.
        // No dirty pass: the layer owes every mounted item its detail and pays
        // that off at a budget over the following frames (`UPGRADE_BUDGET`).
        // `dirty.everything()` here would rebind all hundred and forty on this
        // one frame, which measured at 493 ms.
        lod.rise(camera.zoom);
      }
      // Every camera change ends in a re-raster, not only a pointer gesture.
      // `Ctrl+0`, `F`, a resize and an undo restoring a stashed view all change
      // the zoom without `navigation.gestured` ever being true, and a bitmap
      // built for the old scale then stays stretched until somebody happens to
      // pan. Debounced like the rest — a keyboard fit is a gesture that took one
      // frame, and it re-rasters 180 ms later along with everything else.
      world.gestureTick(camera.zoom);
      // An open menu is anchored to a screen point that meant something when
      // it opened. Pan or zoom and it is a box of verbs pointing at whatever
      // has slid underneath it, so the camera moving dismisses it.
      menu.close();
    }
    // "Call stopCapturing() on pointer-up, tool change and selection change.
    // Explicit boundaries beat time-based grouping" — DATA-MODEL section 11.
    // Queued rather than called, so the gesture's own release write — queued a
    // line above, inside `tools.flush` — falls inside the entry this closes
    // instead of becoming the first thing in the next one.
    if (tools.gestureEnded || selection.version !== undoSelectionVersion) {
      undoSelectionVersion = selection.version;
      queued.push(() => undo.boundary());
    }
  });

  /**
   * Phase 2. Where everybody else's hands are.
   *
   * > PRESENCE — apply interpolated remote poses at (now − 100 ms)
   * > — ARCHITECTURE section 3
   *
   * Before phase 3, and that is the whole of AC-84: `RopeSet` pulls its anchors
   * out of the scene itself (`scene.layoutPin`), so a pose written here is the
   * anchor a rope swings from this frame, and a pose written any later would not
   * be. After phase 1, for the same reason the swing is: a remote peer's drag and
   * a local gesture both move items, and the sim has to see one frame's worth of
   * both rather than a mixture of this frame and last.
   */
  loop.on("presence", (frame) => {
    remote.apply(frame.now, frame.dt, scene, dirty);
  });

  /**
   * Phase 3. Two things move on their own — the swing of a single-pinned item
   * and the sag of a rope — and both are asleep unless something has just
   * disturbed them.
   *
   * After the tool machine, which is phase 1: the swing is composed on top of
   * whatever carry rotation a gesture in progress has built up, so it has to
   * read this frame's, not last frame's.
   *
   * Swings before ropes, and not the other way round: a rope hangs off pins,
   * a pin rides on an item, and an item's rendered pose is its stored one plus
   * the swing. Stepping ropes first would tie every string to where its
   * photograph was a frame ago. `RopeSet` pulls the pin positions it needs
   * current itself (`scene.layoutPin`), because the sweep that does that for
   * the whole board is phase 4 and runs after this.
   *
   * Both are gated to the viewport margin, which is the one thing in this phase
   * the camera is allowed to decide (DESIGN section 6.3 phase 3, section 9.2).
   * It is computed here and handed over as a plain board-space rectangle: `sim/`
   * may not import the camera any more than it may import the document, and a
   * rectangle is the whole of what it needs to know.
   */
  const simView: Bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  loop.on("sim", (frame) => {
    camera.visibleBounds(SIM_MARGIN, simView);
    torsion.step(
      scene,
      dirty,
      frame.dt,
      select.heldItems,
      select.carryLag,
      select.heldPivots,
      simView,
    );
    // After the torsion, never before it: the translation that holds a pin
    // still while its note is laid flat is computed from the settled angle,
    // and the torsion is what settles it.
    //
    // Ungated, and it should be: `flatten` only ever has the item you are
    // typing into, which is by construction the one item on the board you are
    // certainly looking at.
    flatten.step(scene, dirty, frame.dt);
    // Beside it and for the same reasons: after the torsion, because the
    // translation that holds the pin still is computed from the settled angle.
    opening.step(scene, dirty, frame.dt);
    ropes.step(scene, dirty, frame.dt, simView);
  });

  /**
   * The pin the cursor is over, or null — the eyelet (DESIGN section 3.4).
   *
   * Resolved in the LAYOUT phase and consumed in the DOM phase, like culling,
   * because it is a question about where things are and the write phase may
   * only consume answers. It is asked *after* `layoutPins`, so it is this
   * frame's positions rather than last frame's.
   */
  let hoveredPin: string | null = null;
  /**
   * And the point on the string under it, which is the affordance the headline
   * gesture has:
   *
   * > Hover a string. The nearest point on the rope highlights, tracking your
   * > cursor along the curve. — DESIGN section 3.4
   *
   * Asked here rather than delivered to the tool, for the reason the pin hover
   * is: between gestures nothing has pointer capture, so the tool is never
   * handed a `move`. The *rule* is not duplicated though — `stringAt` is the
   * same function `state/tools/select.ts` puts a press through, given the same
   * three hit tests — so the highlight cannot offer something a press would
   * not do.
   */
  let hoveredString: { x: number; y: number } | null = null;
  let hoverAskedX = Number.NaN;
  let hoverAskedY = Number.NaN;

  /**
   * The face that was on show last frame — T-330.
   *
   * The memory is here and the consequence is `dirtyFacing`, because only this
   * scope can hold the question: `opening` knows which item is turned up and
   * `reader` knows which page it is turned to, and the pair of them is what
   * changes. It is the same argument `shownPage` itself makes one line up, and
   * the same reason both are functions passed down rather than methods on
   * either half.
   *
   * Three ways it changes — the folder opens, the folder shuts, the reader turns
   * — and not one of them is a document edit. See `dirtyFacing` for what that
   * costs the two layers that draw off it.
   */
  let facingItem: string | null = null;
  let facingAt = 0;
  const facingChanged = (): void => {
    if (opening.itemId === facingItem && reader.pageAt === facingAt) return;
    const was = facingItem;
    facingItem = opening.itemId;
    facingAt = reader.pageAt;
    dirtyFacing(scene, dirty, was, facingItem);
  };
  loop.on("layout", () => {
    facingChanged();
    // World pin positions for items that moved. Nothing reads the DOM.
    // `dirty.pins` gets a pass too, and with the *item* set — which for a free
    // pin dragged across bare cork is empty, and an empty set is exactly right:
    // `layoutPins` always recomputes an unparented pin and skips every parented
    // one whose item is not in the set.
    if (dirty.all) scene.layoutPins();
    else if (dirty.items.size > 0 || dirty.pins.size > 0) scene.layoutPins(dirty.items);
    // And which items are near enough the viewport to be worth mounting. A read
    // phase, deliberately: the DOM phase below only consumes the answer.
    culler.update(scene, dirty, camera);

    // Asked only when the answer can have changed — the cursor moved, or the
    // board did. An idle board with the pointer at rest on it must stay free,
    // and a hit test is a walk over every pin.
    // Not while a stroke is being drawn, either. A lit pin or a highlighted
    // string tracking the nib is a second cursor arguing with the mark, and both
    // of them promise a gesture that the marker is not going to make.
    const cursor =
      navigation.panReady ||
      marker.stroking ||
      highlighter.stroking ||
      smudge.stroking ||
      eraser.sweeping
        ? null
        : tools.cursor;
    if (!cursor) {
      hoveredPin = null;
      hoveredString = null;
      hoverAskedX = Number.NaN;
    } else if (cursor.x !== hoverAskedX || cursor.y !== hoverAskedY || !dirty.isClean) {
      hoverAskedX = cursor.x;
      hoverAskedY = cursor.y;
      hoveredPin = pins.hitTest(scene, camera, cursor.x, cursor.y);
      // The select tool only, and not while it has hold of something. The
      // string tool's own affordance is the run it is building, and mid-gesture
      // the loop being pulled out is the feedback — a highlight tracking the
      // curve as well would be a second cursor.
      //
      // The exception is the scissors, which is every tool's (Q-186). While the
      // pair is held the next press cuts whatever is under it whichever pen is
      // in hand, so the highlight and the cursor have to say so there too —
      // an affordance that stopped at the select tool would be promising the
      // gesture in the one place it was least needed.
      const asking =
        tools.current === select || isScissors(tools.modifier("Control"), tools.modifier("Alt"));
      const offer =
        asking && !select.gesturing
          ? stringAt(scene, camera, hitItem, hitPin, hitString, cursor.x, cursor.y, shownPage)
          : null;
      hoveredString = offer && { x: offer.x, y: offer.y };
    }

    /**
     * An undo landed last frame: can the person see what it moved? (Q-79,
     * `state/reveal.ts`.)
     *
     * Here, at the end of LAYOUT, because this is the first moment the answer
     * is true — `layoutPins` above has just put every moved pin where it now
     * is, and a pin whose photograph a collaborator dragged away is exactly the
     * case this exists for. A frame later than the undo for the same reason.
     *
     * Almost always a no-op: the undo entry carried the camera it was made at,
     * that view has just been restored, and what you edited was on screen when
     * you edited it. See the module for the case where those come apart.
     */
    if (revealChanged) {
      revealChanged = false;
      if (reveal(camera, changedBounds())) dirty.camera = true;
    }
  });

  /**
   * The box round everything the last undo lit, in board space, or null.
   *
   * Read off `flashes` rather than recomputed, because that is already the
   * answer to "what did this undo change" and computing a second one would be
   * two definitions of the same thing that could disagree.
   */
  const revealBox: Bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  const revealOne: Bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  const changedBounds = (): Bounds | null => {
    let seeded = false;
    for (const id of flashes.items.keys()) {
      const box = scene.boundsOf(id, 0, revealOne);
      if (box === null) continue;
      widen(revealBox, box, seeded);
      seeded = true;
    }
    for (const id of flashes.pins.keys()) {
      const pin = scene.pins.get(id);
      if (pin === undefined) continue;
      // A point, not a box. A pin has no extent worth framing and the camera
      // centres on the union, so one contributes its position and nothing else.
      revealOne.minX = revealOne.maxX = pin.wx;
      revealOne.minY = revealOne.maxY = pin.wy;
      widen(revealBox, revealOne, seeded);
      seeded = true;
    }
    for (const id of flashes.strings.keys()) {
      // The pins it hangs from, not `ropes.boundsOf`.
      //
      // The rope's box is the *drape*, and a drape is transient: this is read
      // one frame after the undo, while the solver is still settling into the
      // slack that was just restored, and a mid-settle box is far bigger than
      // the one the string comes to rest in. Driven, that showed as a camera
      // that went to the right place and then sat two and a half times zoomed
      // out from what the string needed. The pins are where LAYOUT has just put
      // them and do not move again.
      const run = scene.strings.get(id);
      if (run === undefined) continue;
      for (const node of run.nodes) {
        const pin = scene.pins.get(node.pin);
        if (pin === undefined) continue;
        revealOne.minX = revealOne.maxX = pin.wx;
        revealOne.minY = revealOne.maxY = pin.wy;
        widen(revealBox, revealOne, seeded);
        seeded = true;
      }
    }
    return seeded ? revealBox : null;
  };

  /**
   * The cursor, which is the only affordance two of this board's gestures have.
   *
   * Nothing is drawn for a resize edge — "notes, cards and scraps resize from
   * their edges" and the edge is the handle — so without this the band is
   * invisible, and a drag that started 4 px inside a note's edge and made it
   * taller instead of moving it would read as the board misbehaving.
   *
   * The wheel is the same problem in a worse place. It zooms the camera unless
   * a selected segment is under the cursor, in which case it adjusts that
   * segment's sag (DESIGN section 3.4) — and until now nothing said which of
   * the two the next notch would be, so the first one was an experiment. Losing
   * that experiment is expensive: a notch meant for a string and taken by the
   * camera goes from 49% to 6% zoom in one roll, and the way back is `Ctrl`+`0`.
   *
   * `row-resize` for it — a line with an arrow either side of it, which is what
   * the gesture is: the string, and the sag going up or down. Deliberately not
   * one of `handleCursor`'s four resize cursors or its `grab`, because those
   * already mean "drag from here" on this board and this one means "roll here".
   *
   * A DOM write, so it belongs in phase 5 with the other ones, and it is written
   * only when the answer changes. `panReady` is the truce with `Navigation`,
   * which owns this same property while the space bar is down: null means "it
   * wrote something, so say it again when it hands back".
   */
  const handleFrame = emptyFrame();
  let writtenCursor: string | null = "";
  const applyCursor = (): void => {
    if (navigation.panReady) {
      writtenCursor = null;
      return;
    }
    const frame = chromeFrame(camera, scene, selection, handleFrame);
    const hover = tools.cursor;
    // The active handle wins: mid-gesture the pointer is nowhere near the edge
    // it took hold of, and a cursor that reverted would read as a dropped grab.
    const handle =
      select.activeHandle ?? (frame && hover ? handleAt(frame, hover.x, hover.y) : null);
    /**
     * The scissors, which needs this more than either of the other two.
     *
     * `Ctrl`+`Alt` was chosen (Q-183) precisely because nothing else can be
     * pressed by accident — and the cost of that is that nothing suggests it
     * either. This is the answer: hold the pair over a string and the pointer
     * says the next press cuts. `crosshair` rather than one of `handleCursor`'s
     * grabs, because a cut is a point on a curve and not a thing to drag.
     *
     * Only when a string is actually under the cursor. `hoveredString` is the
     * same `stringAt` the press will ask, so the cursor cannot promise a cut
     * that the press then declines — and holding the pair over open cork says
     * nothing, which is honest, because there it does nothing.
     */
    const scissors =
      hoveredString !== null && isScissors(tools.modifier("Control"), tools.modifier("Alt"));
    // The handle first, because a handle is something you are already touching
    // and the wheel is something you might do next — and the two overlap the
    // moment a selected string crosses a selected note's edge.
    const want =
      frame && handle
        ? handleCursor(handle, frame.angle)
        : scissors
          ? "crosshair"
          : tools.wheelClaimed
            ? "row-resize"
            : "";
    if (want === writtenCursor) return;
    writtenCursor = want;
    root.style.cursor = want;
  };

  loop.on("dom", () => {
    world.applyCamera(camera);
    // The pinhole layer redraws when a pin has moved as well as when the camera
    // has (T-231), and `items` is in that list because a parented pin travels
    // with its sheet without ever appearing in `dirty.pins` — that set is for
    // "the rest", as its own comment says.
    cork.apply(camera, dirty.all || dirty.pins.size > 0 || dirty.items.size > 0);
    /**
     * The paper somebody is writing on can be taken away underneath them — a
     * peer's delete, an undo, a document that resynced. Closing it here rather
     * than waiting for the field to be pulled out of the document, because a
     * focused node that is removed does not reliably fire `blur`, and the one
     * thing worse than losing the note is keeping a caret that belongs to it.
     */
    const writing = items.editing;
    if (writing !== null && !scene.has(writing)) items.edit(null, "");
    items.sync(scene, dirty, culler.visible);
    pins.sync(scene, camera, dirty, hoveredPin);
    applyCursor();
    // Last in the phase, and that position is the whole of T-201: dropping
    // `will-change` repaints the world subtree, so it has to happen *after* the
    // writes that change what the subtree contains — otherwise the browser
    // repaints five hundred items as they were and then again as they are.
    world.flushDemote();
  });

  /**
   * Phase 6. The committed ink, on each item's own canvas inside its rotated
   * node.
   *
   * A phase of its own rather than part of the DOM phase above, because the two
   * are woken by different things: that one writes a transform for everything
   * that moved, this one fills a bitmap for the few items somebody drew on. A
   * board where a photograph is being dragged runs the DOM phase every frame and
   * this one never — which is the whole of what "ink inside the item's
   * transform" buys (DESIGN section 6.2).
   */
  /**
   * Whether the document has this stroke *and* the canvas it belongs on is
   * showing it — the whole of DATA-MODEL section 9.2's handoff, asked of a run
   * id that arrived over awareness.
   *
   * Deliberately the same two questions the local wet/dry handoff below asks,
   * of the same two objects: a peer's mark and ours land on the same surfaces
   * through the same layers, and a ghost that retired on a weaker test than our
   * own would blink for exactly the frames the local one was written to cover.
   * The only extra step is `strokeSurface`, because a peer's run says which
   * *item* it is on and never which board tile — that is the sender's
   * bounding-box centre, and this client may hold a shorter piece of the mark.
   */
  const inkLanded = (id: string): boolean => {
    const surface = scene.strokeSurface(id);
    if (surface === null) return false;
    return surface.kind === "item"
      ? !items.awaitingInk(surface.id)
      : !boardInk.awaitingTile(surface.key);
  };

  loop.on("ink", (frame) => {
    items.paintInk(scene, dirty);
    // The cork's ink, in the same phase and for the same reason: it is a bitmap
    // filled for the few tiles somebody drew in, not a transform written for
    // everything that moved.
    boardInk.paint(scene, dirty, camera);
    /**
     * The live smudge, rubbed into the real bitmap — and it has to be here,
     * after both re-rasters and before the overlay.
     *
     * A hole cannot be previewed. `destination-out` on the wet overlay would
     * punch through the chrome and leave the ink untouched, because the ink is
     * on a different canvas; so the wet path writes to the dry surface for this
     * one tool, and the commit's full repaint from records is what makes it true
     * (`InkCanvas.rub`). Every frame of the gesture rather than once, because a
     * re-raster for any other reason wipes the hole.
     *
     * `runsInFlight` covers the drying runs as well as the live one, which is
     * exactly right: the hole has to keep being drawn until the record that
     * replaces it has reached the bitmap. And it is a list because a rub that
     * crosses off the paper is several runs like any other gesture (T-137) — the
     * piece on the photograph takes ink off the photograph and the piece on the
     * cork takes it off the cork, which is what you would expect of a rubber
     * dragged over the edge of a sheet of paper.
     */
    for (const rubbing of smudge.runsInFlight) {
      if (rubbing.item === null) boardInk.rub(rubbing.samples, rubbing.size);
      else items.rubInk(rubbing.item, rubbing.samples, rubbing.size);
    }
    // The handoff, and it is after the raster and before the overlay on purpose:
    // the frame that finally puts a committed stroke on its surface's canvas is
    // the frame that may stop drawing the wet copy of it, and neither an earlier
    // nor a later phase is both.
    //
    // Asked of whichever layer owns each surface rather than counted in frames,
    // because the answer is genuinely not a number of frames — see
    // `ItemLayer.awaitingInk`.
    //
    // *Every* surface, and the overlay copies all go together. Half a mark
    // lingering while the other half has landed would be a seam that brightens
    // for a frame, which is a worse artefact than the overlap it would save.
    const waiting =
      drying !== null &&
      drying.some((surface) =>
        surface.kind === "item" ? items.awaitingInk(surface.id) : boardInk.awaitingTile(surface.key),
      );
    if (drying !== null && !waiting) {
      drying = null;
      dried();
    }
    // And everybody else's, by the same rule in the same phase — section 9.2 is
    // one sentence about both pens. Not folded into the block above because the
    // two are the opposite way round: ours waits on a list of surfaces this
    // client committed to and then drops every overlay copy together, and
    // theirs asks per run, since a peer's ghosts arrive and land independently
    // and there is no gesture here to keep whole.
    if (provider !== null) peers.retire(frame.dt, inkLanded);
  });

  /**
   * Phase 7. Under first, then over, which is only a matter of taste — they are
   * separate canvases and the stacking is CSS. Both are cheap to *ask*: a frame
   * where the camera is still and no rope moved returns without touching either
   * context.
   */
  /** The board-space cursor, or null when the pointer is off the board. */
  const cursorBoard = (): { x: number; y: number } | null =>
    tools.cursor ? camera.screenToBoard(tools.cursor.x, tools.cursor.y) : null;
  /**
   * A run drawn on the overlay, from whichever gesture is drawing one: the
   * string tool building a run, `Alt`+drag pulling one out of a pin, or a loop
   * pulled out of the middle of an existing string.
   *
   * The loop is dashed end to end and the other two only in the leg chasing the
   * cursor, because that is the difference between them: the first two have
   * stops that were already decided, and the loop has nothing decided until it
   * is let go.
   */
  const pendingRun = (): PendingRun | null => {
    const cursor = cursorBoard();
    if (tools.current === stringTool) {
      const points = stringTool.preview(cursor);
      return points ? { points, dashed: "tail" } : null;
    }
    const loop = select.loopPreview(cursor);
    if (loop) return { points: loop, dashed: "all" };
    // Asked of whichever tool is active rather than of `select`, because the
    // quick pull is every tool's — "Alt+drag from a pin, in any tool" (T-229).
    const pull = tools.current.pullPreview?.(cursor);
    return pull ? { points: pull, dashed: "tail" } : null;
  };

  loop.on("ropes", () => {
    ropesUnder.draw(scene, ropes, camera, dirty);
    ropesOver.draw(scene, ropes, camera, dirty);
  });

  loop.on("overlay", (frame) => {
    // Before the draw, not after: a peer's cursor is sprung towards where they
    // last said it was, and the frame that moves it is the frame that has to
    // find the canvas stale (`render/presence/peers.ts`).
    if (provider !== null) peers.step(frame.dt);
    // Likewise before the draw, and for the same reason: a flash that faded
    // this frame is a different picture, and the frame it reaches zero on is the
    // frame the canvas has to clear it off.
    flashes.step(frame.dt);
    found.step(frame.dt);
    // Selection chrome is drawn here, not on the item nodes, so its width is in
    // screen pixels at every zoom (T-91). `dirty` comes along only so it can tell
    // "a selected photograph is being dragged" from "nothing has changed".
    overlay.draw(
      camera,
      scene,
      selection,
      select.marquee,
      dirty,
      select.pinCandidate,
      // The machine's hover, not a `move` the tool was handed: between clicks
      // nothing is captured, so the tool never hears about the pointer.
      // A run being drawn, by whichever gesture is drawing one — see
      // [`pendingRun`].
      pendingRun(),
      // Where the ropes hang, for haloing the selected ones, and the point on
      // one the cursor is over (DESIGN section 3.4).
      ropes,
      hoveredString,
      // > | See its threads | Hover | Every string through the pin highlights |
      // > — DESIGN section 3.3
      //
      // The same hover the pin layer uses for the eyelet ring, resolved once in
      // the layout phase and read by both.
      hoveredPin,
      // The stroke being drawn, if a pen is the tool holding the board.
      // Asked of the tool rather than tracked here for the same reason
      // `pendingRun` is: the gesture owns its own transient, and nothing about it
      // is in the scene.
      //
      // Never the smudge. That one is already on the ink canvas (the INK phase
      // above), and drawing it here as well would paint an opaque mark over the
      // hole it just made — the exact "visibly wrong" the erase tool spent a
      // task avoiding.
      wetPen()?.runsInFlight ?? NO_WET_RUNS,
      // Everybody else: their cursors, and the chrome for what they have hold
      // of. Null on a board with no wire, which costs the overlay one null check
      // and no walk at all.
      provider === null ? null : peers,
      // What the last Ctrl+Z moved, so an undo that reached somewhere you were
      // not looking is never silent (DESIGN section 7.6).
      flashes,
      // And the match a search flew you to (Q-151) — same painter, same amber,
      // separate lifetime.
      found,
      /**
       * And every other match, wearing a faint border for as long as the search
       * is open (T-236, Q-176).
       *
       * The `Search` itself, which is already the shape the overlay asks for.
       * Not `search.ids` — a getter call here would hand over the array and
       * lose the version beside it, and the version is the whole reason a
       * board with six borders on it does not restroke a full-viewport canvas
       * sixty times a second.
       */
      search,
      /**
       * The rectangle being cut out of an open page (T-282).
       *
       * Four turned corners rather than a box, and the tool has already put
       * them in board space — the rectangle is square with the page, and the
       * page is at whatever angle the folder was scattered to.
       */
      select.clipping,
      /**
       * And which of the words inside it are going onto the card (T-283).
       *
       * Computed here rather than held on the tool, because it is a caret hit
       * test and a layout read — a tool may touch neither. Null on every frame
       * that is not a clip drag over a page with words on it, which is every
       * frame on an ordinary board.
       */
      clipWords(),
    );
    hud.update(frame.now);
    /**
     * The drawer and the bar, in the phase the rest of the chrome repaints in.
     *
     * Both are asked every frame and both write DOM only when their answer has
     * changed — the drawer when the tool does, the bar when the tool or the set
     * of held keys does. That is what lets the tool be read here rather than
     * pushed from `setTool`: a tool picked by keystroke, by rail click, or by a
     * one-shot tool handing the board back all arrive the same way, and none of
     * them has to remember to tell the chrome.
     *
     * `tools.held` is the same set `applyCursor` reads through `modifier()` for
     * the scissors cursor, so the pointer and the bar cannot disagree about
     * whether `Ctrl`+`Alt` is down.
     */
    drawer.sync(tools.current.id);
    toolinfo.sync(tools.current.hint, tools.held, boardStatus);
    if (missing.count > 0 && frame.now - noticeSweptAt > NOTICE_SWEEP_MS) {
      noticeSweptAt = frame.now;
      // An item wearing a missing photograph can just be deleted, and nothing
      // announces that. This is the cheap way to notice, and it is behind the
      // count so a board with nothing missing never walks anything.
      const referenced = new Set<string>();
      for (const id of scene.itemIds()) {
        const asset = scene.cold(id)?.assetId;
        if (asset) referenced.add(asset);
      }
      missing.retain(referenced);
    }
    notice.update(missing.notice());
  });

  /**
   * Whether a gesture was holding anything on the frame before.
   *
   * `select.heldItems` empties on release, so the release itself is a *transition*
   * and cannot be read off the current state. One boolean, and it is what makes
   * the `final` grab go out — the message a peer needs to start section 9.2's
   * handoff, and the one thing a grab that merely vanished would not tell it.
   */
  let wasGrabbing = false;
  loop.on("flush", (frame) => {
    if (presence !== null) {
      const cursor = cursorBoard();
      if (cursor === null) presence.pointerGone();
      else presence.pointerAt(cursor.x, cursor.y, tools.active.id);
      // The segment a mid-string split has hold of, if any — a hint for
      // everybody else and nothing more (DATA-MODEL section 5.4). Published
      // beside the grab because it is the same kind of statement: this is what
      // I have hold of right now.
      presence.splitting(select.heldSegment);
      // The stroke under the pen, sampled every frame even though it is sent
      // every other one: the decimation that makes the window constant-size
      // (DATA-MODEL section 9.1) has to see the samples that arrive in between,
      // or a remote preview is half the resolution of the mark being made.
      // The same accessor the OVERLAY phase draws from, so a peer sees what is
      // on this client's overlay and never the smudge.
      presence.drawing(wetPen()?.runsInFlight ?? NO_WET_RUNS);
      const holding = select.heldItems.size > 0;
      if (holding) presence.grabbing(select.heldItems);
      else if (wasGrabbing) presence.released();
      wasGrabbing = holding;
      // Last, so it sends what the three lines above just staged. Every other
      // frame at most, and only when something changed (T-71).
      presence.flush(frame.index);
    }

    /**
     * Compaction, rate-limited to once a second inside `Janitor.tick` — so this
     * is a subtraction and a comparison on the frames it does nothing, which is
     * all but one in sixty.
     *
     * Two conditions on running at all, and both are about *not* collecting a
     * board this client has only half of:
     *
     *   - **Synced, if there is a wire.** `WireProvider` distinguishes connected
     *     from synced precisely because the handshake sits between them, and a
     *     connected-but-unsynced board is one whose pins may not have arrived
     *     yet. Every string on it reads as beyond repair.
     *   - **Present includes us.** `elected` refuses to act when the caller
     *     cannot say who is on the board, which is not the same as being alone.
     *     Our own id is passed explicitly rather than relied on from
     *     `getStates()`, because presence only puts this client in that map
     *     after its first publishing frame.
     *
     * The settle period inside the janitor is the real safety net for both, but
     * these cost nothing and mean it is never even asked.
     */
    /**
     * And a third, added with the read-only mode (T-224): **not on a document
     * this build cannot fully read.**
     *
     * The janitor's whole job is deciding that a reference is beyond repair, and
     * it decides that by reading records. A schema this build does not know
     * reads as nothing, and "nothing" is exactly the answer that makes a string
     * look dangling — so a version-1 build let loose on a version-2 board would
     * compact away the parts of it that it cannot see. `mutate` would refuse the
     * write anyway; this is so it is never even attempted.
     */
    if (!readOnly && (provider === null || provider.synced)) {
      swept += janitor.tick(
        frame.now,
        provider === null
          ? [board.doc.clientID]
          : [board.doc.clientID, ...provider.awareness.getStates().keys()],
        heldByAPeer,
      ).length;
    }

    // Everything downstream has consumed this frame's changes.
    dirty.clear();
    // Then, and only then, the document writes this frame's input asked for.
    // After the clear, so the dirty flags the binding sets in response belong
    // to the next frame instead of being wiped by this one.
    for (const write of queued) write();
    queued.length = 0;
  });

  /**
   * Settle the swing before framing anything.
   *
   * `contentBounds` is the box the board is *drawn* in: `boundsAt` turns an
   * item by `rot + swing` and centres it on `x + drift`, both of which phase 3
   * owns and neither of which exists until phase 3 has run once. Framing
   * before that frames every hanging item un-hung, so the opening view and
   * `Ctrl+0` a moment later disagreed by three percent of zoom on a real board
   * — and deterministically, every single time, which read as the shortcut
   * being subtly wrong rather than as the two being taken of different scenes
   * (T-135).
   *
   * Not a simulation. `binding.start()` has just resynced, so `dirty.all` is
   * up and phase 3 takes its settle branch: every item placed at its
   * equilibrium with no motion (DESIGN section 5.3, and T-110 for why an
   * arriving item never animates). `dt` of zero says so — there is no substep
   * to take, and nothing to integrate.
   *
   * Ropes need no equivalent. A rope is seeded analytically and asleep, and
   * `contentBounds` does not look at particles anyway.
   */
  torsion.step(scene, dirty, 0);

  // An empty board is the correct first thing to see. Nothing seeds it any
  // more: there is a real way to put things on it now, and a board that opens
  // holding somebody else's placeholders is a demo rather than a tool.
  // No margin argument: the opening view and `Ctrl+0` are the same view, so
  // they take the same default (T-135).
  camera.fit(scene.contentBounds() ?? { minX: -400, minY: -300, maxX: 400, maxY: 300 });
  // The zoom the board opens at is a zoom nobody gestured into, and until this
  // was here every bitmap was built for a scale of 1 — a board opened at 50%
  // spent twice the pixels it needed on ink, and one opened at 200% on a 2x
  // display drew it at a quarter of the resolution, both until the first pan.
  world.settle(camera.zoom);

  /**
   * `window.schizo` — a handle on the running board, for driving it from
   * outside the window.
   *
   * Dev builds only. `import.meta.env.DEV` is a compile-time constant, so the
   * whole block is dropped from a production bundle rather than merely being
   * unreachable in one.
   *
   * ## Why it exists
   *
   * "Does it actually work" is a question about the running application, and
   * the test suite cannot answer it. Three times now the answer has been no in
   * a way nothing else caught: the highlight on a default-thickness string
   * rasterised to a smear and made every string look flat; `Enter` never
   * reached tools at all, because `machine.ts` forwards a keydown allowlist
   * and nothing had previously ended a gesture on a keystroke; and the leg of
   * a string run chasing the cursor was simply missing, because a tool is only
   * handed `move` while a pointer is captured. Every one of those passed every
   * unit test, twice — before and after the fix.
   *
   * It also covers the gap where a capability lands before the interaction
   * that reaches it. The string ops, the simulation and the painter were all
   * finished before the tool that lets a person draw one, and without this
   * there was no way to put a string on screen and look at it.
   *
   * ## What belongs in it
   *
   * The board's own long-lived objects, and nothing that exists only to be
   * driven. It is a window onto the application, not an API for it: anything
   * here must be something the application already has and already uses, so
   * that reaching through this handle and reaching through the app cannot
   * disagree. `snapshot` is the one function rather than an object, and it is
   * a one-line call to something `crdt/doc.ts` already exports.
   *
   * Nothing in the application may read it. It is write-only from here.
   */
  if (import.meta.env.DEV) {
    /**
     * The physics panel, on Shift+backquote beside the HUD (T-232).
     *
     * Built here rather than beside the HUD, and behind this branch, because
     * every write it can make goes through `setTuning` — so a production
     * bundle loses the panel, the import and the only route by which one of
     * `sim/tuning.ts`'s values can ever be anything but the number written in
     * it. `sim/` itself is untouched: what the panel moves is the live binding
     * the solver was already reading.
     */
    const tuning = new TuningPanel(world.layers.ui);

    /**
     * The remote-drag debug overlay, on `Alt`+backquote (T-235, Q-185).
     *
     * Its own painter on its own `overlay` subscription rather than an argument
     * threaded into `overlay.draw` (Q-184), and registered *here* — after the
     * board's own overlay pass above, so its marks land on top of what they are
     * marking, and inside this branch, so a production bundle loses the painter,
     * its canvas, its key listener and the import together. `remote.debug()` is
     * the only thing left in a shipped build, and nothing calls it.
     */
    const remoteDebug = new RemoteDebugPainter(world.layers.ui);
    loop.on("overlay", () => {
      remoteDebug.draw(camera, remote.debug());
    });

    (window as unknown as { schizo: unknown }).schizo = {
      board,
      /** The dials, so a driven session can set one without a slider. */
      tuning,
      /**
       * The two poses the overlay draws, and the painter itself.
       *
       * `remote` because `observe(clientId, state, receivedAt)` takes its times
       * as arguments and validates an ordinary object through `readGrab` — so a
       * driven session can be a second peer in *one* window, which is the only
       * way any of this was ever going to be checked. A real second window puts
       * the interesting half of the picture in a background tab, and a
       * background tab's frame loop is throttled to something that has long
       * since moved on.
       */
      remote,
      remoteDebug,
      scene,
      camera,
      ropes,
      dirty,
      /**
       * What the last undo lit, and how far through its fade each one is.
       *
       * Next to `dirty` because it is read from it. A flash lasts under a
       * second and is the one piece of chrome on this board that a screenshot
       * can genuinely miss, so the pixels want a reading beside them that says
       * what was supposed to be on the canvas at the time.
       */
      flashes,
      /**
       * The search's own three, and here for exactly the reason `flashes` is.
       *
       * A flight is over in 300ms and a flash in 800, so the two things this
       * feature does are both gone before a screenshot of the window has been
       * encoded — and the third, the match list, is deliberately not drawn at
       * all, because DESIGN section 2.5 forbids a search from putting a view of
       * the board on the board. So `search.count` and `search.current` are the
       * only readout there is for whether the right thing was found, and
       * `flight.active` is the only one for whether the camera is on its way
       * somewhere or has been taken off it by a hand.
       */
      search,
      flight,
      found,
      /**
       * What the case files on this board say (T-280).
       *
       * Here for the reason `flashes` and `search` are, and more so than
       * either: an index is *by design* not drawn anywhere. There is no pixel
       * on this board that says whether a folder's text arrived, how many of
       * its pages were scans, or whether the shell refused the file — and until
       * T-286 puts a search field in front of it there is no pixel that could.
       * `textIndex.of(sha)` is the whole readout.
       */
      textIndex,
      /**
       * The pages of the case file somebody has open, and what is held of them.
       *
       * Here for the reason `textIndex` is: what a reader holds is by design
       * not drawn. One page is on the sheet and the rest are memory, so
       * `reader.pageAt` is the only readout for where a turn landed and
       * `reader.heldPages` the only one for what a long read has accumulated —
       * neither of which a screenshot of a single sheet could ever show.
       */
      reader,
      /**
       * Cutting a clipping (T-282).
       *
       * `cutting` is the readout that matters: a cut is fire-and-forget from a
       * gesture that is already over, so the one state a run cannot otherwise
       * see is whether the last one is still in flight — and a stuck `true`
       * makes every later rectangle do nothing at all, silently.
       */
      clipper,
      /**
       * Everybody else, as this board has them — the store the overlay draws
       * from, cursors and hold-chrome and claimed segments alike.
       *
       * Here for the same reason `flashes` is: what a peer has hold of is often
       * off screen, or is a fringe five pixels wide on a rope, and a screenshot
       * cannot say whether the claim arrived or merely was not drawn. This can.
       * Empty rather than absent on a board with no wire, which is the honest
       * answer for a board that is alone.
       */
      peers,
      /**
       * The wire, or null on a board that is alone — for the awareness channel
       * itself, which `peers` above only shows the drawn half of.
       *
       * `provider.awareness.getStates()` is the raw state of every client on
       * the board, and it is the only readout there is for a field that has
       * been published before anything renders it. That is not a hypothetical
       * gap: `wet` went on the wire in T-168 and is drawn in T-169, and without
       * this there was no way to tell a sliding window that never left the
       * machine from one that arrived and simply was not painted.
       */
      provider,
      loop,
      /**
       * Which LOD tier the camera settled into (T-90, `render/lod.ts`).
       *
       * Here because the HUD cannot answer for it from outside. The tier only
       * moves at gesture end and has hysteresis, so at 36% the board may
       * legitimately be in either tier and the zoom cannot say which — and the
       * HUD row that does say is written by the frame loop, which a background
       * window throttles to something that has long since moved on.
       */
      lod,
      /**
       * The item layer, for its export painter (T-206, D-37).
       *
       * The one thing here that is not just a handle on state: `rasterise` is
       * how the items become pixels, and it is the half of an image export
       * that no test can check. happy-dom neither loads an SVG into an `<img>`
       * nor fails to — it never fires — so whether a sheet actually draws, and
       * in the right hand, with its photographs and its shadow, is only ever
       * answerable in the real webview.
       */
      items,
      ops,
      tools,
      /**
       * The asset transfer, or null on a board with no wire (T-74).
       *
       * Here because the HUD cannot be trusted to answer for it: a second
       * browser window on the same board is a *background* window, and Chromium
       * throttles its rAF — so the HUD reads whatever frame it last managed,
       * which during a transfer is a number that has since moved. This is the
       * live one.
       */
      exchange,
      /**
       * What each photograph's bytes are doing (T-95).
       *
       * The HUD counts them; this says which hash is in which state, which is
       * the only way to check a transition from outside while T-75 has yet to
       * draw any of them.
       */
      assets,
      /** The document as persistence would write it — for reopening a board
       *  and checking it comes back still (Phase 3's AC-15). */
      snapshot: () => snapshot(board),
      /**
       * Export the board as a PDF (T-207) — the same call the menu row will
       * make (T-209), and until that row exists the only way to reach it.
       *
       * Here for the reason the whole handle exists: whether the file has the
       * handwriting in it as text is a question about the running application
       * and about a file on a disk, and no test in this repository can open
       * either. It is also the one place where a *native save dialog* is in the
       * middle of the thing being driven, so a driver has to be able to start
       * the export and then go and answer a window.
       */
      printBoard,
      /**
       * And the image, for the same reason and one more of its own: the picture
       * is composited here rather than by Chromium, so "does every layer reach
       * the file" is a question only a real webview and a real disk can answer.
       * happy-dom neither loads an SVG into an `<img>` nor fails to.
       */
      saveBoardImage,
    };
  }

  loop.start();

  // `asset:ready` only ever fires for something ingested *this run*, so on the
  // second launch of a board every photograph on it would sit undeveloped
  // forever. Ask the store what it has once the document is loaded, and let the
  // answer stand in for the events that already happened.
  const reconcileAssets = async (): Promise<void> => {
    const referenced = new Set<string>();
    for (const id of scene.itemIds()) {
      const asset = scene.cold(id)?.assetId;
      if (asset) referenced.add(asset);
    }
    if (referenced.size === 0) return;
    const hashes = [...referenced];
    const present = await native.assetHas(hashes);
    hashes.forEach((sha256, i) => {
      if (!present[i]) {
        // The backfill tier: an item somewhere on this board whose photograph
        // is not on this disk. Asked for at idle priority, so it queues behind
        // anything the person is actually looking at, which `assetUrl` raises
        // as it is drawn.
        if (exchange === null) {
          // No wire, and the store has just said it does not have this. Nothing
          // is going to bring it, and this is the only place that can tell —
          // `assetUrl` sees a missing photograph but not whether it is missing
          // because it is late or because it was never here.
          assets.unavailable(sha256);
          // And nobody to name, which is a notice in its own right (DESIGN 7.5):
          // this board has no wire, so the count is the whole of what can be
          // said about it.
          missing.unavailable(sha256);
          return;
        }
        exchange.want(sha256);
        assets.requesting(sha256);
        return;
      }
      holdsAsset(sha256);
    });
  };
  void reconcileAssets();

  // Again on every (re)connection. A peer that joined an hour after this window
  // opened brought a document full of photographs with it, and nothing else
  // walks the board to notice them — `assetUrl` catches only the ones that are
  // on screen.
  provider?.on("status", (status) => {
    if (status === "synced") void reconcileAssets();
  });

  /**
   * And the other direction: the photographs on this disk that the board has
   * stopped referring to (T-219). `reconcileAssets` above fetches what is
   * missing; this releases what is surplus, and until now nothing did — the
   * whole collector was built and never called.
   *
   * Scheduled rather than awaited, and once. `app/assetgc.ts` holds the policy
   * and the reasons for it; all that belongs here is that it happens at all.
   */
  window.setTimeout(() => {
    // `readOnly` covers both ways this build stops writing, and the second one
    // is the whole reason T-224 is filed as a defect rather than as a notice:
    // `referencedAssets` builds the keep-set through `readItem`, so on a
    // document from a newer build a future item's photograph is in no keep-set
    // and this sweep would reclaim bytes that are still on the board.
    void sweepAssets(native, board, {
      readOnly: persistence.readOnly || readOnly,
      // Read here rather than thirty seconds ago, which is the point of reading
      // it at all: the idle flush lands at five seconds, so by now an ordinary
      // session has written its file and the answer is yes.
      packedCleanly: pack.packedCleanly,
    }).then((result) => {
      if (result === null || result.freedBytes === 0) return;
      console.info(
        `[assets] reclaimed ${Math.round(result.freedBytes / 1024)} kB; ` +
          `${result.kept} photographs are still on the board`,
      );
    });
  }, ASSET_SWEEP_DELAY_MS);

  /**
   * The board this installation already had, given a file of its own (T-361).
   *
   * ## Why it happens here rather than in the shell
   *
   * A pack holds one merged snapshot, and what is on disk is `snapshot.bin`
   * plus however many log frames have landed since. Merging those is a Yjs
   * operation, so it belongs on the side that owns the schema (ARCHITECTURE
   * section 4.2) — `yrs` is linked for the relay and reaching for it here would
   * be a second implementation of the one thing section 4.1 says there is only
   * one of. So Rust adopts the old data directory at startup and leaves the
   * entry unhomed, and this is the step that finishes the job.
   *
   * It answers for *New board…* too, by construction rather than by a second
   * route: a minted board is unhomed for the same few seconds and reloads
   * through here.
   *
   * ## Delayed, and not for the reason the sweep is
   *
   * A moment, not thirty seconds. Long enough that the first frames are drawn
   * before `snapshot()` walks the whole document — on a large board that is a
   * real stall, and stalling the first paint of a session would be the most
   * visible possible moment to do it. Well short of the sweep, so the file
   * exists before anything starts reclaiming bytes.
   *
   * ## Not on a read-only board
   *
   * `packSpec` builds its asset list through `readItem`, so on a document from
   * a newer build a future item's photograph is in no list — the same hole
   * T-224 left in the sweep above. A build that can only partly read a document
   * cannot write an honest file out of it, and the board is not at risk either
   * way: it goes on running out of its workshop exactly as it has been, which
   * is the same place a failed home leaves it.
   */
  const giveThisBoardAHome = async (): Promise<void> => {
    if (readOnly) return;
    const homing = await homeBoard(native, board);
    if (homing === null) return;
    if (homing.kind === "failed") {
      // Named to the console for `copyInvite`'s reason: the reason is `ENOSPC`
      // or a Documents folder that is not there, and there is genuinely
      // somewhere to go and look.
      console.warn("[board] this board could not be given a file of its own", homing.error);
      homeRetry = () => void giveThisBoardAHome();
      flash.say("This board has no file of its own yet — right-click the cork to try again");
      return;
    }
    homeRetry = null;
    /**
     * Said out loud, because something has changed about where the person's
     * work lives and nothing else on screen would ever mention it. DESIGN
     * section 7.8's "it has been saving itself since the first thing landed on
     * it" is still true and is not what this sentence is about: it is about the
     * board having become a file they can find, move and hand over.
     *
     * A folder *name* and never a path, which is all this side was told
     * (`app/pack.ts`).
     */
    const where = homing.folder.length > 0 ? `, in your ${homing.folder} folder` : "";
    const missing = new Set(homing.missing);
    if (missing.size > 0) {
      // The same news `exportBoard` gives, for the same reason: "it is in a
      // file" and "it is in a file without four of its photographs" are
      // different pieces of news to the person whose board it is.
      flash.say(
        `This board is now a file of its own${where} — without ` +
          `${filesLabel(missing.size, assetKindsOf(board, missing))} this machine does not have`,
      );
      return;
    }
    flash.say(`This board is now a file of its own${where}`);
  };
  window.setTimeout(() => void giveThisBoardAHome(), HOME_DELAY_MS);

  /**
   * What a seal that lands *now* has to do, over and above what `sealIfFuture`
   * has already done to the document.
   *
   * Only ever runs for the mid-session case: at boot this is still null when
   * the check happens, which is exactly right — `restateBoard` has already read
   * the answer, and a flash announcing a board you have not seen yet is news
   * about nothing.
   */
  onSealed = () => {
    // The info bar reads this object once a frame, so restating it is the whole
    // of what the bar needs — there is no sentence here to rewrite any more.
    restateBoard();
    // A stroke half drawn, a marquee half dragged. Its pen-up will never
    // arrive, because the machine has stopped taking input.
    tools.abandon();
    menu.close();
    flash.hold(
      "Somebody on a newer version has this board open — it is read-only here from now on",
    );
  };

  /**
   * The HUD itself ships — backquote opens it anywhere — but *starting* open
   * is a development convenience, not a first impression. A person's first
   * frame of the board should be the board.
   */
  if (import.meta.env.DEV) hud.toggle();
}

/**
 * The phase-0 fidelity spike replaces the whole application when asked for.
 * `import.meta.env` is statically replaced, so with the variable unset this
 * branch and the module behind it are eliminated from the bundle entirely.
 *
 *   $env:VITE_SPIKE=1;      npm run tauri dev    # will-change discipline
 *   $env:VITE_SPIKE=pinned; npm run tauri dev    # the blurry control
 *   $env:VITE_SPIKE=culled; npm run tauri dev    # the discipline, with culling
 */
if (import.meta.env["VITE_SPIKE"]) {
  void import("@/spike/fidelity").then((spike) => spike.run());
} else {
  void boot();
}
