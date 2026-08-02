/**
 * @vitest-environment happy-dom
 *
 * Playing a cassette where it hangs — T-277, D-46 section 4, D-50.
 *
 * What is asserted here is not that an element makes a sound; no test in this
 * repository can hear anything. It is the three things that are *ours* and that
 * D-48 measured going wrong when they are left to the browser:
 *
 * - a playing item is not culled, because a media element removed from the
 *   document is paused by the user agent and nothing would press play again;
 * - the element is re-parked every DOM phase, because views are pooled and a
 *   recording left in one is inherited by whatever mounts next; and
 * - the position lives on the deck rather than on the view, so a cassette
 *   paused, culled and brought back is still where it was.
 *
 * The last one is why `hush` and a cull are different acts: one is the tape
 * coming out of the machine, the other is only the object leaving the room.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { Deck } from "@/render/items/deck";
import { DomItemLayer, NO_FACTS, type AssetView } from "@/render/items/dom";
import { DirtySets } from "@/state/dirty";
import { Scene, type ItemCold } from "@/state/scene";

const HASH = "3f2a91cc".padEnd(64, "0");
const OTHER = "88b40e17".padEnd(64, "0");
const URL = `asset://sha256/${HASH}`;
const CASSETTE = { w: 155, h: 99 };

let host: HTMLDivElement;
let scene: Scene;
let dirty: DirtySets;

beforeEach(() => {
  document.body.innerHTML = "";
  host = document.createElement("div");
  document.body.append(host);
  scene = new Scene();
  dirty = new DirtySets();
});

const asset = (sha: string): AssetView => ({
  url: `asset://sha256/${sha}`,
  phase: "ready",
  fraction: 0,
});

function layer(): DomItemLayer {
  return new DomItemLayer(host, asset, (sha) => ({
    ...NO_FACTS,
    kind: "audio",
    duration: 96,
    // The name is how a test tells two mounted cassettes apart: nothing in this
    // layer stamps an item id on a node, and node *order* is exactly what
    // pooling makes unreliable.
    name: sha === OTHER ? "second.mp3" : "interview-2019.mp3",
  }));
}

function put(id: string, assetId = HASH, at = 0, over: Partial<ItemCold> = {}): void {
  scene.putItem(
    {
      id,
      type: "polaroid",
      z: `a${at}`,
      seed: 1,
      assetId,
      createdBy: 1,
      createdAt: 0,
      text: "",
      ...over,
    },
    { x: at * 400, y: 0, rot: 0, ...CASSETTE },
  );
  dirty.item(id);
}

/** Whichever node currently holds the element — pooling makes "the view for an
 *  item" a question that has to be re-asked. */
const holder = (): HTMLElement | null =>
  (host.querySelector("audio")?.parentElement?.closest(".item") as HTMLElement | null) ?? null;

/** The case number a mounted node is wearing, which is what says whose it is. */
const numberOn = (el: Element | null): string => el?.querySelector(".case-number")?.textContent ?? "";

/** The mounted node whose case number came off `name`. */
function nodeFor(name: string): HTMLElement | null {
  for (const el of host.querySelectorAll(".item")) {
    if (numberOn(el).toLowerCase().includes(name)) return el as HTMLElement;
  }
  return null;
}

describe("the deck itself", () => {
  it("plays, stops when pressed again, and keeps its place", () => {
    const moved: Array<[string, number]> = [];
    const letGo: string[] = [];
    const deck = new Deck({
      onMoved: (id, reeled) => void moved.push([id, reeled]),
      onLetGo: (id) => void letGo.push(id),
    });

    expect(deck.press("a", URL)).toBe(true);
    expect(deck.playing).toBe("a");

    // Pressing play again is the same button on the same object.
    expect(deck.press("a", URL)).toBe(false);
    deck.element.dispatchEvent(new Event("pause"));
    expect(deck.playing).toBe(null);
    // Loaded, though — which is the difference the culler reads, and the reason
    // the position is still here to come back to.
    expect(deck.loaded).toBe("a");
    expect(letGo).toEqual([]);
  });

  it("refuses a recording whose bytes are not here, rather than loading nothing", () => {
    const deck = new Deck({ onMoved: () => {}, onLetGo: () => {} });
    expect(deck.press("a", "")).toBe(false);
    expect(deck.playing).toBe(null);
    expect(deck.loaded).toBe(null);
    expect(deck.element.getAttribute("src")).toBe(null);
  });

  it("plays one thing at a time, by having one element", () => {
    const deck = new Deck({ onMoved: () => {}, onLetGo: () => {} });
    deck.press("a", URL);
    deck.press("b", `asset://sha256/${OTHER}`);
    expect(deck.playing).toBe("b");
    expect(deck.loaded).toBe("b");
  });

  it("rewinds when the tape comes out, and says so once", () => {
    const letGo: string[] = [];
    const deck = new Deck({ onMoved: () => {}, onLetGo: (id) => void letGo.push(id) });
    deck.press("a", URL);
    deck.stop();
    expect(deck.playing).toBe(null);
    expect(deck.loaded).toBe(null);
    expect(deck.reeled).toBe(0);
    expect(deck.element.getAttribute("src")).toBe(null);
    deck.stop();
    // Nothing to let go of the second time — a caller may say stop whenever it
    // likes, and this is called from a cull path that fires per frame.
    expect(letGo).toEqual(["a"]);
  });

  it("counts as playing before the element has answered", () => {
    const deck = new Deck({ onMoved: () => {}, onLetGo: () => {} });
    // A `play()` that has not settled and no `play` event yet — which is the
    // real state of affairs for a frame or two, and the frame in which the
    // culler decides what to unmount. Were the claim to wait for the event, the
    // cassette would be unexempted, its view removed, and the element paused by
    // the user agent before the sound ever came out: D-48's failure arriving
    // through a race rather than through a pan.
    deck.element.play = () => new Promise<void>(() => {});
    deck.press("a", URL);
    expect(deck.playing).toBe("a");
  });

  it("stops claiming to play when the element refuses", async () => {
    const deck = new Deck({ onMoved: () => {}, onLetGo: () => {} });
    deck.element.play = () => Promise.reject(new Error("not allowed"));
    deck.press("a", URL);
    await Promise.resolve();
    await Promise.resolve();
    expect(deck.playing).toBe(null);
    // Still loaded: the file is fine and the press is still the thing to
    // repeat, which is the difference between a refusal and a rewind.
    expect(deck.loaded).toBe("a");
  });

  it("reads a tape with no length as rewound rather than as NaN", () => {
    const moved: number[] = [];
    const deck = new Deck({ onMoved: (_id, reeled) => void moved.push(reeled), onLetGo: () => {} });
    deck.press("a", URL);
    // No metadata: `duration` is NaN, which is every recording for the first
    // few hundred milliseconds and a live stream for ever.
    deck.element.dispatchEvent(new Event("timeupdate"));
    // Every reading, not the count of them: loading a source is itself worth a
    // `durationchange` and this must be rewound at each of them rather than a
    // spool drawn from `sqrt(NaN)`.
    expect(moved.length).toBeGreaterThan(0);
    expect(moved.every((reeled) => reeled === 0)).toBe(true);
    expect(Number.isNaN(deck.reeled)).toBe(false);
  });
});

describe("the cassette on the board", () => {
  it("takes the element into the item, and writes where the tape is", () => {
    const items = layer();
    put("a");
    items.sync(scene, dirty, null);

    expect(host.querySelector("audio")).toBe(null);
    expect(items.hear("a", URL)).toBe(true);
    expect(items.playing).toBe("a");
    // Inside the item, because the object is what is making the sound — and
    // because an item deleted or a board closed then takes it out with it.
    expect(holder()).not.toBe(null);
    expect(holder()).toBe(host.querySelector(".item"));
  });

  it("is not culled while it plays — D-50", () => {
    const items = layer();
    put("a");
    put("b", OTHER, 1);
    items.sync(scene, dirty, null);
    items.hear("a", URL);

    // The culler says only `b` is on screen. The note being written on has been
    // exempt from this since T-179; a playing cassette is the second exemption.
    const node = holder() as HTMLElement;
    const element = host.querySelector("audio");
    dirty.item("b");
    items.sync(scene, dirty, new Set(["b"]));
    expect(items.mounted).toBe(2);
    expect(items.playing).toBe("a");

    // **The same node, in the same place.** Mounted-and-playing is not the
    // assertion — a view released and immediately mounted again would satisfy
    // that, and would have taken the element out of the document on the way
    // past, which is the one thing that pauses a recording (D-48). A remount
    // re-appends, so the node would be last rather than first.
    expect(holder()).toBe(node);
    expect(host.querySelector("audio")).toBe(element);
    expect(host.children[0]).toBe(node);
  });

  it("moves the element when a second cassette is played", () => {
    const items = layer();
    put("a");
    put("b", OTHER, 1);
    items.sync(scene, dirty, null);

    items.hear("a", URL);
    expect(nodeFor("interview")?.querySelector("audio")).not.toBe(null);

    items.hear("b", `asset://sha256/${OTHER}`);
    expect(items.playing).toBe("b");
    // One element, so the first cassette has to have let go of it — a node left
    // holding it would be an object that looks like it is playing and is not,
    // and would take the sound out of the document when it was next culled.
    expect(nodeFor("interview")?.querySelector("audio")).toBe(null);
    expect(nodeFor("second")?.querySelector("audio")).not.toBe(null);
    expect(host.querySelectorAll("audio").length).toBe(1);
  });

  it("is culled like anything else once it is paused, and keeps its place", () => {
    const items = layer();
    put("a");
    put("b", OTHER, 1);
    items.sync(scene, dirty, null);
    items.hear("a", URL);
    const element = host.querySelector("audio") as HTMLAudioElement;
    Object.defineProperty(element, "duration", { value: 80, configurable: true });
    Object.defineProperty(element, "currentTime", { value: 20, configurable: true });
    element.dispatchEvent(new Event("timeupdate"));
    element.dispatchEvent(new Event("pause"));
    expect(items.playing).toBe(null);

    dirty.item("b");
    items.sync(scene, dirty, new Set(["b"]));
    // Gone from the board, and the element with it — but not let go of: the
    // recording and the position are on the deck, which is not what was pooled.
    expect(items.mounted).toBe(1);
    expect(nodeFor("interview")).toBe(null);
    expect(host.querySelector("audio")).toBe(null);

    // And it comes back with the tape a quarter of the way through rather than
    // rewound — the view it comes back on was released, and a released view
    // knows nothing, so this is the deck telling it again.
    dirty.item("a");
    items.sync(scene, dirty, new Set(["a", "b"]));
    const back = nodeFor("interview") as HTMLElement;
    expect(back.querySelector("audio")).not.toBe(null);
    expect(back.style.getPropertyValue("--reeled")).toBe("0.250");
  });

  it("stops when the item it belongs to is deleted", () => {
    const items = layer();
    put("a");
    items.sync(scene, dirty, null);
    items.hear("a", URL);

    // A peer's delete arriving mid-recording: the scene loses the item, and
    // there is no longer an object making the sound.
    scene.removeItem("a");
    dirty.item("a");
    items.sync(scene, dirty, null);
    expect(items.playing).toBe(null);
    expect(host.querySelector("audio")).toBe(null);
  });

  it("never leaves a recording in a pooled node for the next item", () => {
    const items = layer();
    put("a");
    put("b", OTHER, 1);
    items.sync(scene, dirty, null);
    items.hear("a", URL);
    const element = host.querySelector("audio") as HTMLAudioElement;
    element.dispatchEvent(new Event("pause"));

    // `a` leaves the viewport and its view goes into the pool; `b` mounts and
    // is very likely handed that same node. Inheriting a caret is somebody
    // else's sentence; inheriting this is somebody else's recording.
    dirty.item("b");
    items.sync(scene, dirty, new Set(["b"]));
    // `b` really is mounted — otherwise this passes because nothing is there.
    const second = nodeFor("second") as HTMLElement;
    expect(second).not.toBe(null);
    expect(items.mounted).toBe(1);
    expect(second.querySelector("audio")).toBe(null);

    // And when `a` comes back, the element goes to `a` — the deck still knows
    // whose recording it is holding.
    dirty.item("a");
    items.sync(scene, dirty, new Set(["a", "b"]));
    expect(nodeFor("interview")?.querySelector("audio")).not.toBe(undefined);
    expect(nodeFor("interview")?.querySelector("audio")).not.toBe(null);
    expect(nodeFor("second")?.querySelector("audio")).toBe(null);
  });

  it("hushes on request, and rewinds the spools when it does", () => {
    const items = layer();
    put("a");
    items.sync(scene, dirty, null);
    items.hear("a", URL);
    const item = holder() as HTMLElement;
    const element = host.querySelector("audio") as HTMLAudioElement;
    Object.defineProperty(element, "duration", { value: 96, configurable: true });
    Object.defineProperty(element, "currentTime", { value: 48, configurable: true });
    element.dispatchEvent(new Event("timeupdate"));
    expect(item.style.getPropertyValue("--reeled")).toBe("0.500");

    items.hush();
    expect(items.playing).toBe(null);
    expect(item.style.getPropertyValue("--reeled")).toBe("");
    expect(host.querySelector("audio")).toBe(null);
  });
});
