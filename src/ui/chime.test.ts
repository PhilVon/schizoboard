/**
 * The bell on a timer that has gone off — T-406.
 *
 * A double rather than a real `AudioContext`: the test environment has no audio
 * hardware, and what is worth asserting is not the sound but the *graph* — that
 * two strikes are scheduled, that each carries an inharmonic partial, that
 * every oscillator is given a stop time, and that a machine which will not give
 * us a context is a machine that goes quietly on with its other three surfaces
 * rather than throwing inside the expiry announcement.
 *
 * Whether it sounds like a bell is not a thing a table can answer and is
 * marked on the board for a person (AC-1152). What a table *can* answer is
 * whether it would make any sound at all, which is the failure that would
 * otherwise ship looking exactly like a preference being off.
 */

import { describe, expect, it, vi } from "vitest";

import { Chime, type MakeAudio } from "@/ui/chime";

interface Scheduled {
  readonly kind: "gain" | "frequency";
  readonly method: string;
  readonly value: number;
  readonly at: number;
}

/** One `AudioParam`, recording what was asked of it and when. */
function param(kind: Scheduled["kind"], log: Scheduled[]): AudioParam {
  return {
    setValueAtTime: (value: number, at: number) => log.push({ kind, method: "set", value, at }),
    exponentialRampToValueAtTime: (value: number, at: number) =>
      log.push({ kind, method: "ramp", value, at }),
  } as unknown as AudioParam;
}

interface Fake {
  readonly audio: AudioContext;
  readonly scheduled: Scheduled[];
  readonly oscillators: { hz: number; start: number; stop: number | null }[];
  readonly gains: number;
  readonly resumed: number[];
  readonly closed: number[];
  state: AudioContextState;
}

function fakeAudio(now = 10): Fake {
  const scheduled: Scheduled[] = [];
  const oscillators: Fake["oscillators"] = [];
  const resumed: number[] = [];
  const closed: number[] = [];
  let gains = 0;

  const fake = {
    scheduled,
    oscillators,
    resumed,
    closed,
    state: "running" as AudioContextState,
    get gains() {
      return gains;
    },
  };

  const audio = {
    destination: {} as AudioDestinationNode,
    currentTime: now,
    get state() {
      return fake.state;
    },
    resume: () => {
      resumed.push(1);
      fake.state = "running";
      return Promise.resolve();
    },
    close: () => {
      closed.push(1);
      return Promise.resolve();
    },
    createGain: () => {
      gains += 1;
      return { gain: param("gain", scheduled), connect: () => {} } as unknown as GainNode;
    },
    createOscillator: () => {
      const entry = { hz: 0, start: 0, stop: null as number | null };
      oscillators.push(entry);
      return {
        type: "sine",
        frequency: {
          setValueAtTime: (value: number, at: number) => {
            entry.hz = value;
            scheduled.push({ kind: "frequency", method: "set", value, at });
          },
        },
        connect: () => {},
        start: (at: number) => (entry.start = at),
        stop: (at: number) => (entry.stop = at),
      } as unknown as OscillatorNode;
    },
  } as unknown as AudioContext;

  // Assigned onto the same object rather than spread into a new one. A spread
  // copies `state` by value, so a test setting it to "suspended" would be
  // writing to a snapshot while the context's getter went on reading the
  // original — a double that quietly cannot be told to be suspended.
  return Object.assign(fake, { audio }) as unknown as Fake;
}

describe("the bell", () => {
  it("builds nothing until something goes off", () => {
    // The very many boards that never have a timer on them must not start a
    // hardware audio graph, so the context is built on the first ring.
    const make = vi.fn<MakeAudio>(() => fakeAudio().audio);
    const chime = new Chime(make);
    expect(make).not.toHaveBeenCalled();
    chime.ring();
    expect(make).toHaveBeenCalledTimes(1);
    chime.ring();
    // And once, not once per expiry.
    expect(make).toHaveBeenCalledTimes(1);
  });

  it("strikes twice, and the second is quieter", () => {
    const fake = fakeAudio(10);
    const chime = new Chime(() => fake.audio);
    chime.ring();

    const peaks = fake.scheduled.filter((s) => s.kind === "gain" && s.method === "ramp" && s.value > 0.01);
    expect(peaks).toHaveLength(2);
    expect(peaks[1]!.value).toBeLessThan(peaks[0]!.value);
    // A hammer bouncing on a gong, not two separate notifications: the second
    // lands well inside the first's decay.
    expect(peaks[1]!.at - peaks[0]!.at).toBeLessThan(0.5);
  });

  it("gives each strike an inharmonic partial, which is what makes it metal", () => {
    const fake = fakeAudio();
    new Chime(() => fake.audio).ring();

    expect(fake.oscillators).toHaveLength(4);
    const [low, high] = [fake.oscillators[0]!.hz, fake.oscillators[1]!.hz];
    const ratio = high / low;
    // Not an octave and not a fifth. A struck bell's second mode sits at about
    // 2.76 times its fundamental, and a partial that landed on a harmonic would
    // make this a chord rather than a bell.
    expect(ratio).toBeGreaterThan(2.5);
    expect(ratio).toBeLessThan(3);
    expect(Math.abs(ratio - 2) > 0.3).toBe(true);
    expect(Math.abs(ratio - 3) > 0.2).toBe(true);
  });

  it("stops every oscillator it starts", () => {
    // An oscillator with no stop time is a node the graph keeps alive forever.
    // A kitchen timer used all afternoon would accumulate one per strike.
    const fake = fakeAudio();
    const chime = new Chime(() => fake.audio);
    chime.ring();
    chime.ring();
    expect(fake.oscillators).toHaveLength(8);
    for (const osc of fake.oscillators) {
      expect(osc.stop).not.toBeNull();
      expect(osc.stop!).toBeGreaterThan(osc.start);
    }
  });

  it("wakes a context the page has not earned yet", () => {
    // A webview will not start audio before the person has interacted, and a
    // board can be opened onto somebody else's already-running countdown.
    const fake = fakeAudio();
    fake.state = "suspended";
    new Chime(() => fake.audio).ring();
    expect(fake.resumed).toHaveLength(1);
    // Scheduled anyway rather than waited for: if the resume lands in time this
    // strike is heard, and if it does not, the next one is.
    expect(fake.oscillators).toHaveLength(4);
  });

  it("goes quietly on where there is no audio at all", () => {
    const chime = new Chime(() => null);
    expect(() => chime.ring()).not.toThrow();
    expect(chime.rings).toBe(0);
  });

  it("does not keep asking a machine that has already refused", () => {
    const make = vi.fn<MakeAudio>(() => {
      throw new Error("audio disabled");
    });
    const chime = new Chime(make);
    for (let i = 0; i < 5; i++) expect(() => chime.ring()).not.toThrow();
    expect(make).toHaveBeenCalledTimes(1);
    expect(chime.rings).toBe(0);
  });

  it("survives a context that goes away underneath it", () => {
    // A window on its way out, which is exactly when a countdown is most likely
    // to run out unwatched.
    const fake = fakeAudio();
    const chime = new Chime(() => fake.audio);
    chime.ring();
    expect(chime.rings).toBe(1);
    vi.spyOn(fake.audio, "createGain").mockImplementation(() => {
      throw new Error("context closed");
    });
    expect(() => chime.ring()).not.toThrow();
    // Not counted, because it did not happen — which is the whole use of the
    // readout: a driven run can tell a bell that rang from one that did not.
    expect(chime.rings).toBe(1);
  });

  it("lets the hardware graph go, once", () => {
    const fake = fakeAudio();
    const chime = new Chime(() => fake.audio);
    chime.ring();
    chime.dispose();
    chime.dispose();
    expect(fake.closed).toHaveLength(1);
    // And says nothing more afterwards.
    expect(() => chime.ring()).not.toThrow();
    expect(chime.rings).toBe(1);
  });
});
