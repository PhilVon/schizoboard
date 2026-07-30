/**
 * The one decision `platform/tauri.ts` makes rather than forwards.
 *
 * Everything else in that module is `invoke` with a name and some arguments,
 * which a test can only restate. `canPrintPdf` is different: it is a *rule*
 * about what the shell reported, it decides whether a menu row exists at all
 * (T-210, Q-139), and getting it wrong is a row that opens a save dialog and
 * then fails after somebody has already named the file.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  convertFileSrc: (path: string) => path,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const { TauriPlatform } = await import("@/platform/tauri");

describe("whether this shell can write a PDF", () => {
  // A block body, and it matters: `mockReset()` returns the mock, an arrow
  // that returns it hands vitest a *teardown function*, and vitest then calls
  // the mock after every test. With the rejecting implementation still in
  // place that is an unhandled rejection charged to the test that installed it.
  beforeEach(() => {
    invoke.mockReset();
  });

  it("says yes on Windows, which is where PrintToPdf is", async () => {
    invoke.mockResolvedValue({ os: "windows", name: "schizoboard", version: "0", arch: "x86_64" });
    expect((await TauriPlatform.create()).canPrintPdf).toBe(true);
    expect(invoke).toHaveBeenCalledWith("app_info");
  });

  /**
   * The whole of Q-139: macOS and Linux get the image export — already
   * cross-platform, because it composites in the renderer — rather than a
   * system print dialog that chooses its own paper and never says when it
   * finished.
   */
  it("says no everywhere else", async () => {
    for (const os of ["macos", "linux", "freebsd"]) {
      invoke.mockResolvedValue({ os });
      expect((await TauriPlatform.create()).canPrintPdf, os).toBe(false);
    }
  });

  /**
   * A shell that will not answer costs one menu row and not a boot — and the
   * row it costs is the one that could not have worked anyway. Refusing to
   * build a platform here would take the *image* export down with it, which is
   * the export that needs nothing from this question.
   */
  it("says no, and still builds, when the shell will not answer", async () => {
    // `mockImplementation` and not `mockRejectedValue`: the latter builds the
    // rejected promise here, before anything is waiting on it, and Node reports
    // that as an unhandled rejection whatever the code under test does with it.
    invoke.mockImplementation(() => Promise.reject(new Error("no such command")));
    const platform = await TauriPlatform.create();
    expect(platform.canPrintPdf).toBe(false);
    expect(platform.kind).toBe("tauri");
  });
});
