/**
 * @vitest-environment happy-dom
 */

/**
 * T-179. The caret in a note, and the four ways a field parked inside a pooled,
 * recycled, culled item node can go wrong.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DomItemLayer, type AssetView } from "@/render/items/dom";
import { DirtySets } from "@/state/dirty";
import { Scene, type ItemCold, type ItemPose } from "@/state/scene";

let host: HTMLDivElement;
let scene: Scene;
let dirty: DirtySets;
let layer: DomItemLayer;
let inputs: Array<{ id: string; text: string }>;
let closed: string[];

const ready = (url: string): AssetView => ({ url, phase: "ready", fraction: 0 });

beforeEach(() => {
  document.body.innerHTML = "";
  host = document.createElement("div");
  document.body.append(host);
  scene = new Scene();
  dirty = new DirtySets();
  inputs = [];
  closed = [];
  layer = new DomItemLayer(host, (sha) => ready(`asset://sha256/${sha}`), {
    onInput: (id, text) => inputs.push({ id, text }),
    onClosed: (id) => closed.push(id),
  });
});

/**
 * Not tidiness: the "click away" listener is on the *window*, so a layer
 * dropped without this outlives its own test and closes the next one's editor.
 * The app calls `destroy` for the same reason.
 */
afterEach(() => {
  layer.destroy();
});

function add(id: string, cold: Partial<ItemCold> = {}, pose: Partial<ItemPose> = {}): void {
  scene.putItem(
    {
      id,
      type: "note",
      z: "a0",
      seed: 1,
      assetId: null,
      createdBy: 1,
      createdAt: 0,
      text: "",
      ...cold,
    },
    { x: 0, y: 0, rot: 0, w: 200, h: 120, ...pose },
  );
  dirty.item(id);
}

function field(): HTMLTextAreaElement | null {
  return host.querySelector("textarea.item-field");
}

/** The item element for `id`, by the text it happens to be showing. */
function elementShowing(text: string): HTMLElement | null {
  for (const el of host.querySelectorAll<HTMLElement>(".item")) {
    if (el.querySelector(".paper-text")?.textContent === text) return el;
  }
  return null;
}

describe("putting a caret in a note", () => {
  it("parks a field in the item, wearing the class of the text it stands in for", () => {
    add("a", { text: "already here" });
    layer.sync(scene, dirty, null);

    layer.edit("a", "already here");
    expect(layer.editing).toBe("a");

    const f = field();
    expect(f).not.toBeNull();
    expect(f!.value).toBe("already here");
    // Inside the item, beside the static text rather than inside it — `bind`
    // writes `textContent` on that node and would take the field with it.
    expect(f!.parentElement?.className).toBe("paper-surface");
    expect(f!.classList.contains("paper-text")).toBe(true);
    expect(f!.previousElementSibling?.className).toBe("paper-text");
  });

  it("stands the static text aside rather than emptying it", () => {
    add("a", { text: "on the paper" });
    layer.sync(scene, dirty, null);
    layer.edit("a", "on the paper");

    const item = host.querySelector<HTMLElement>(".item")!;
    expect(item.classList.contains("is-editing")).toBe(true);
    // Still there, so nothing about the item's binding has to know.
    expect(item.querySelector("div.paper-text")!.textContent).toBe("on the paper");
  });

  it("focuses the field, and only once it is in the document", () => {
    add("a");
    layer.sync(scene, dirty, null);
    layer.edit("a", "hello");
    expect(document.activeElement).toBe(field());
    // And the caret is at the end, which is where `open` puts it.
    expect(field()!.selectionStart).toBe(5);
  });

  it("reports what is typed, and who closed it", () => {
    add("a");
    layer.sync(scene, dirty, null);
    layer.edit("a", "");

    const f = field()!;
    f.value = "wro";
    f.dispatchEvent(new Event("input"));
    f.value = "wrote";
    f.dispatchEvent(new Event("input"));
    expect(inputs).toEqual([
      { id: "a", text: "wro" },
      { id: "a", text: "wrote" },
    ]);

    f.dispatchEvent(new Event("blur"));
    expect(closed).toEqual(["a"]);
    expect(layer.editing).toBeNull();
  });

  /**
   * DESIGN 3.6's third sentence — "click away" — and the one that does not come
   * free. `machine.ts` calls `preventDefault` on every board `pointerdown` to
   * keep the webview's text selection out of a drag, and the implicit blur is
   * one of the defaults that suppresses. Without this, clicking onto the cork
   * left the caret in the paper and the note lying flat.
   */
  it("closes on a press anywhere else, which no blur would deliver", () => {
    add("a");
    layer.sync(scene, dirty, null);
    layer.edit("a", "");

    const elsewhere = document.createElement("div");
    document.body.append(elsewhere);
    const press = new Event("pointerdown", { bubbles: true, cancelable: true });
    press.preventDefault();
    elsewhere.dispatchEvent(press);

    expect(closed).toEqual(["a"]);
    expect(layer.editing).toBeNull();
  });

  it("but not on a press inside the field, which is the caret being moved", () => {
    add("a");
    layer.sync(scene, dirty, null);
    layer.edit("a", "some words");
    field()!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(closed).toEqual([]);
    expect(layer.editing).toBe("a");
  });

  it("closes on Escape, because the text is already written down", () => {
    add("a");
    layer.sync(scene, dirty, null);
    layer.edit("a", "");
    field()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(closed).toEqual(["a"]);
    expect(layer.editing).toBeNull();
  });

  it("takes the field out of the item when the edit ends", () => {
    add("a");
    layer.sync(scene, dirty, null);
    layer.edit("a", "");
    expect(field()).not.toBeNull();

    layer.edit(null, "");
    expect(field()).toBeNull();
    expect(host.querySelector(".is-editing")).toBeNull();
  });
});

describe("the ways a parked field can be lost", () => {
  /**
   * The failure this whole design is arranged around. Item nodes are pooled and
   * recycled between *different* items, so a field parked and forgotten is a
   * field inherited by whichever note gets the node next — a caret sitting in
   * somebody else's paper, holding somebody else's text.
   */
  it("does not travel to the next item that gets the recycled node", () => {
    add("a", { text: "mine" });
    layer.sync(scene, dirty, null);
    layer.edit("a", "mine");

    // "a" leaves the board; its node goes back to the pool and comes out again
    // on "b", which is what a cull-and-remount does on a real board.
    scene.removeItem("a");
    dirty.item("a");
    add("b", { text: "not mine" });
    layer.sync(scene, dirty, null);

    const b = elementShowing("not mine");
    expect(b).not.toBeNull();
    expect(b!.querySelector("textarea")).toBeNull();
    expect(b!.classList.contains("is-editing")).toBe(false);
  });

  it("keeps the note being written on mounted, whatever the culler says", () => {
    add("a", { text: "mid sentence" });
    add("b");
    layer.sync(scene, dirty, null);
    layer.edit("a", "mid sentence");
    const before = field();
    const node = before!.closest(".item");

    // The camera pans away and the culler drops both of them.
    dirty.item("a");
    dirty.item("b");
    layer.sync(scene, dirty, new Set<string>());

    expect(layer.mounted).toBe(1);
    expect(layer.editing).toBe("a");
    /**
     * The **same node**, not merely a field that ended up somewhere sensible.
     *
     * Unmounting the item releases its view, recycles the node and mounts a
     * fresh one — and in a real engine, taking a focused field out of the
     * document even for the rest of one frame is a blur, which is the event
     * that ends the sentence. Asserting the field is still *connected* does not
     * catch that, because it is re-parked on the replacement in the same call;
     * asserting the node never changed is what does.
     */
    expect(field()).toBe(before);
    expect(before!.closest(".item")).toBe(node);
    expect(before!.isConnected).toBe(true);
  });

  it("re-parks onto the view an item comes back with", () => {
    add("a", { text: "one" });
    add("b", { text: "two" });
    layer.sync(scene, dirty, null);
    layer.edit("a", "one");

    // "b" is culled, freeing a node; then everything is dirtied and redrawn.
    dirty.item("b");
    layer.sync(scene, dirty, new Set(["a"]));
    dirty.all = true;
    layer.sync(scene, dirty, null);

    const f = field();
    expect(f).not.toBeNull();
    // Still in the item showing "one", and in no other.
    expect(f!.closest(".item")).toBe(elementShowing("one"));
    expect(host.querySelectorAll("textarea.item-field").length).toBe(1);
    expect(host.querySelectorAll(".is-editing").length).toBe(1);
  });

  it("moves in one piece when the caret goes straight to another note", () => {
    add("a", { text: "one" });
    add("b", { text: "two" });
    layer.sync(scene, dirty, null);

    layer.edit("a", "one");
    layer.edit(null, "");
    layer.edit("b", "two");

    expect(host.querySelectorAll("textarea.item-field").length).toBe(1);
    expect(field()!.closest(".item")).toBe(elementShowing("two"));
    expect(host.querySelectorAll(".is-editing").length).toBe(1);
  });
});

/**
 * T-180, the half that only shows up with two people. A note's text arriving
 * from the document while somebody has the caret in it.
 */
describe("a peer typing into the note you are writing in", () => {
  function bindText(id: string, text: string): void {
    scene.putItem({ ...scene.cold(id)!, text }, scene.poseOf(id)!);
    dirty.item(id);
    layer.sync(scene, dirty, null);
  }

  it("costs nothing when it is only the echo of what was typed", () => {
    add("a", { text: "hello" });
    layer.sync(scene, dirty, null);
    layer.edit("a", "hello");
    const f = field()!;
    f.setSelectionRange(2, 2);

    bindText("a", "hello");
    expect(f.value).toBe("hello");
    expect(f.selectionStart).toBe(2);
  });

  it("brings the merged text in without moving the caret to the end", () => {
    add("a", { text: "world" });
    layer.sync(scene, dirty, null);
    layer.edit("a", "world");
    const f = field()!;
    // The caret sits after "wor".
    f.setSelectionRange(3, 3);

    // Somebody else types "hello " at the front.
    bindText("a", "hello world");

    expect(f.value).toBe("hello world");
    // Still after "wor", which is now at 9 — not at the end, and not left at 3
    // in the middle of their word.
    expect(f.selectionStart).toBe(9);
    expect(f.value.slice(0, f.selectionStart)).toBe("hello wor");
  });

  it("carries a selection over an edit ahead of it, both ends", () => {
    add("a", { text: "one two three" });
    layer.sync(scene, dirty, null);
    layer.edit("a", "one two three");
    const f = field()!;
    // "three" selected.
    f.setSelectionRange(8, 13);

    bindText("a", "ZERO one two three");

    expect(f.value.slice(f.selectionStart, f.selectionEnd)).toBe("three");
  });

  it("leaves a caret before the change exactly where it was", () => {
    add("a", { text: "one two" });
    layer.sync(scene, dirty, null);
    layer.edit("a", "one two");
    const f = field()!;
    f.setSelectionRange(3, 3);

    bindText("a", "one two three");
    expect(f.selectionStart).toBe(3);
  });

  it("says nothing to a field that is not open", () => {
    add("a", { text: "one" });
    layer.sync(scene, dirty, null);
    bindText("a", "one two");
    expect(layer.editing).toBeNull();
    expect(field()).toBeNull();
  });
});

describe("a polaroid's caption", () => {
  it("gets the field in the frame, wearing the caption's class and its size", () => {
    add("a", { type: "polaroid", text: "" }, { w: 300, h: 360 });
    layer.sync(scene, dirty, null);
    layer.edit("a", "");

    const f = field()!;
    expect(f.parentElement?.className).toBe("pol-frame");
    expect(f.classList.contains("pol-caption")).toBe(true);
    // The caption's size is written per item width rather than declared, so the
    // field has to be given the same number or the words change size the moment
    // the caret arrives.
    const caption = host.querySelector<HTMLElement>("div.pol-caption")!;
    expect(f.style.fontSize).toBe(caption.style.fontSize);
    expect(f.style.fontSize).not.toBe("");
    // And it is never `is-empty`: the point of clicking into an uncaptioned
    // photograph is to give it the caption it has not got.
    expect(f.classList.contains("is-empty")).toBe(false);
  });
});

describe("a layer with no editor wired to it", () => {
  it("ignores the request rather than throwing", () => {
    const plain = new DomItemLayer(host, (sha) => ready(sha));
    add("a");
    plain.sync(scene, dirty, null);
    plain.edit("a", "text");
    expect(plain.editing).toBeNull();
  });
});
