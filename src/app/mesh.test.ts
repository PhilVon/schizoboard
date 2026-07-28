/**
 * What the mesh does with the announcements the shell hands it.
 *
 * No sockets. Every rule here is about *which* URLs get dialled and how often,
 * and the failures being guarded against are all of the same kind: mDNS
 * re-announces constantly, so anything that opens a connection per announcement
 * opens one a minute for ever.
 */

import { describe, expect, it, vi } from "vitest";

import { Mesh } from "@/app/mesh";
import type { SyncProvider } from "@/crdt/sync/provider";

/** A provider that records being destroyed and does nothing else. */
function fakeProvider(): SyncProvider & { destroyed: boolean } {
  const provider = {
    destroyed: false,
    awareness: null as never,
    status: "offline" as const,
    synced: false,
    connect: () => {},
    disconnect: () => {},
    destroy: () => {
      provider.destroyed = true;
    },
    send: () => false,
    on: () => () => {},
  };
  return provider as SyncProvider & { destroyed: boolean };
}

function meshWithSpy(max?: number): {
  mesh: Mesh;
  dialled: string[];
  providers: ReturnType<typeof fakeProvider>[];
  dropped: string[];
} {
  const dialled: string[] = [];
  const providers: ReturnType<typeof fakeProvider>[] = [];
  const dropped: string[] = [];
  const mesh = new Mesh({
    connect: (url) => {
      dialled.push(url);
      const provider = fakeProvider();
      providers.push(provider);
      return provider;
    },
    max,
    onDropped: (reason) => dropped.push(reason),
  });
  return { mesh, dialled, providers, dropped };
}

function peer(instance: string, url: string) {
  return { instance, url, board: "demo" };
}

describe("the mesh", () => {
  it("dials a peer it is told about", () => {
    const { mesh, dialled } = meshWithSpy();
    mesh.found(peer("a", "ws://192.168.1.9:4321/demo?token=abc"));
    expect(dialled).toEqual(["ws://192.168.1.9:4321/demo?token=abc"]);
    expect(mesh.size).toBe(1);
  });

  it("ignores the same peer announcing itself again", () => {
    // mDNS re-announces on a timer and once per interface. A laptop on wifi and
    // a dock arrives twice immediately and again every minute after that.
    const { mesh, dialled } = meshWithSpy();
    for (let i = 0; i < 20; i += 1) mesh.found(peer("a", "ws://192.168.1.9:4321/demo"));
    expect(dialled).toHaveLength(1);
    expect(mesh.size).toBe(1);
  });

  it("dials two different peers", () => {
    const { mesh, dialled } = meshWithSpy();
    mesh.found(peer("a", "ws://192.168.1.9:4321/demo"));
    mesh.found(peer("b", "ws://192.168.1.22:5555/demo"));
    expect(dialled).toHaveLength(2);
    expect(mesh.size).toBe(2);
  });

  it("follows a peer that moved, and lets the old connection go", () => {
    // Off the dock and onto wifi, or a relay that restarted on a new port. The
    // connection in hand is to somewhere that peer no longer is, and leaving it
    // dialling would be a reconnect loop against a dead address.
    const { mesh, dialled, providers } = meshWithSpy();
    mesh.found(peer("a", "ws://192.168.1.9:4321/demo"));
    mesh.found(peer("a", "ws://10.0.0.4:4321/demo"));

    expect(dialled).toEqual(["ws://192.168.1.9:4321/demo", "ws://10.0.0.4:4321/demo"]);
    expect(providers[0]!.destroyed).toBe(true);
    expect(providers[1]!.destroyed).toBe(false);
    expect(mesh.size).toBe(1);
    expect(mesh.urls()).toEqual(["ws://10.0.0.4:4321/demo"]);
  });

  it("stops at its bound, and says what it dropped", () => {
    // Not a capacity target — a bound on what a misconfigured or hostile
    // network can talk this client into opening.
    const { mesh, dialled, dropped } = meshWithSpy(2);
    for (let i = 0; i < 10; i += 1) mesh.found(peer(`peer-${i}`, `ws://10.0.0.${i}:4321/demo`));
    expect(dialled).toHaveLength(2);
    expect(mesh.size).toBe(2);
    expect(dropped).not.toHaveLength(0);
    // Silent truncation would read as "everybody is connected".
    expect(dropped[0]).toContain("ws://10.0.0.2:4321/demo");
  });

  it("drops every connection when it is destroyed", () => {
    const { mesh, providers } = meshWithSpy();
    mesh.found(peer("a", "ws://192.168.1.9:4321/demo"));
    mesh.found(peer("b", "ws://192.168.1.22:4321/demo"));
    mesh.destroy();
    expect(providers.every((provider) => provider.destroyed)).toBe(true);
    expect(mesh.size).toBe(0);
  });

  it("does not dial after it has been destroyed", () => {
    // An announcement can arrive between teardown starting and the listener
    // being unhooked, and a socket opened then is one nobody owns.
    const { mesh, dialled } = meshWithSpy();
    mesh.destroy();
    mesh.found(peer("a", "ws://192.168.1.9:4321/demo"));
    expect(dialled).toEqual([]);
  });

  it("can be destroyed twice", () => {
    const { mesh } = meshWithSpy();
    mesh.found(peer("a", "ws://192.168.1.9:4321/demo"));
    mesh.destroy();
    expect(() => mesh.destroy()).not.toThrow();
  });

  it("warns rather than throwing when nobody said where to complain", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mesh = new Mesh({ connect: () => fakeProvider(), max: 1 });
    mesh.found(peer("a", "ws://a/demo"));
    mesh.found(peer("b", "ws://b/demo"));
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
