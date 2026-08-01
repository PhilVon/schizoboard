import { describe, expect, it } from "vitest";

import {
  assetKind,
  canBeOpened,
  carriesItsOwnName,
  caseNumber,
  folderBulk,
  objectSizeFor,
  pagesLabel,
  runtimeLabel,
  titleWorthWriting,
} from "@/lib/objects";

describe("what a file is", () => {
  it("chooses the face from the mime and nothing else", () => {
    expect(assetKind("image/jpeg")).toBe("image");
    expect(assetKind("video/x-matroska")).toBe("video");
    expect(assetKind("audio/flac")).toBe("audio");
    expect(assetKind("application/pdf")).toBe("document");
  });

  it("makes a folder of text as well, whichever sort of text it is", () => {
    // Q-255. The shell has one mime for all of it, because telling a `.md` from
    // a `.csv` means reading the name and a name is not evidence the store
    // keeps — so the prefix is the whole rule and the folder does not care.
    expect(assetKind("text/plain")).toBe("document");
    expect(assetKind("text/markdown")).toBe("document");
    // And it is still a face chosen from a mime rather than a second list: the
    // thing that decides is the same call every other object goes through.
    expect(carriesItsOwnName(assetKind("text/plain"))).toBe(true);
  });

  /** T-274, Q-257. */
  it("says which kinds have an inside worth opening", () => {
    expect(canBeOpened("document")).toBe(true);
    expect(canBeOpened("video")).toBe(true);
    expect(canBeOpened("audio")).toBe(true);
    expect(canBeOpened("image")).toBe(false);
    // The one that cannot change: this build does not know what the file is, so
    // it has nothing to open it *as*, and an object that offers to open and
    // then cannot is what D-46 section 6 refuses about embedded players.
    expect(canBeOpened("unknown")).toBe(false);
  });

  it("calls a mime it has never heard of unknown rather than guessing", () => {
    // Not a face. It is the state `readAsset` needs to tell "a record we do not
    // understand" from "a record describing a cassette", and it is permanent:
    // a later build that learns a mime cannot tell this one what it decided.
    expect(assetKind("application/octet-stream")).toBe("unknown");
    expect(assetKind("application/epub+zip")).toBe("unknown");
    expect(assetKind("")).toBe("unknown");
  });
});

describe("how big each object is", () => {
  it("gives the three their real proportions", () => {
    const folder = objectSizeFor("document")!;
    const vhs = objectSizeFor("video")!;
    const cassette = objectSizeFor("audio")!;

    // A VHS is 187 by 103 mm and a compact cassette 100 by 64. What makes one
    // read as the other's big brother is the ratio between them, so that is
    // what is asserted rather than either number.
    expect(vhs.w / vhs.h).toBeCloseTo(187 / 103, 2);
    expect(cassette.w / cassette.h).toBeCloseTo(100 / 64, 2);
    // Wide and flat, because it holds A4 lying horizontal — see `FOLDER_MM`.
    expect(folder.w / folder.h).toBeCloseTo(310 / 222, 2);
    expect(vhs.w / cassette.w).toBeCloseTo(187 / 100, 2);
  });

  it("sizes them the same whatever is in the file", () => {
    // The point of the whole function. A photograph is the one thing on this
    // board whose shape is a fact about its bytes; an hour of video and a
    // ten-second clip are the same cassette.
    expect(objectSizeFor("video")).toEqual(objectSizeFor("video"));
  });

  it("has no answer for the two kinds that are not objects", () => {
    // A picture is `polaroidFor`'s, and an unknown never gets past the gate.
    expect(objectSizeFor("image")).toBeNull();
    expect(objectSizeFor("unknown")).toBeNull();
  });
});

describe("a runtime, as a spine says it", () => {
  it("drops the hours when there are none", () => {
    expect(runtimeLabel(187)).toBe("3:07");
    expect(runtimeLabel(59)).toBe("0:59");
  });

  it("pads the minutes only once there is an hour in front of them", () => {
    expect(runtimeLabel(3600 + 7 * 60 + 5)).toBe("1:07:05");
    expect(runtimeLabel(7 * 60 + 5)).toBe("7:05");
  });

  it("says nothing for a tape nobody measured, and 0:00 for an empty one", () => {
    // The distinction `AssetMeta.duration` exists to keep: a blank spine is a
    // tape nobody has measured, and `0:00` is a tape with nothing on it.
    expect(runtimeLabel(null)).toBe("");
    expect(runtimeLabel(0)).toBe("0:00");
  });

  it("refuses a number that is not a measurement", () => {
    // What an older or hostile peer can put in a `Y.Map`. `readAsset` already
    // screens these; this is the second of the two places that must not print
    // `NaN:NaN` on a cassette if one ever gets through.
    expect(runtimeLabel(Number.NaN)).toBe("");
    expect(runtimeLabel(Number.POSITIVE_INFINITY)).toBe("");
    expect(runtimeLabel(-4)).toBe("");
  });
});

describe("a page count, as a folder says it", () => {
  it("counts pages", () => {
    expect(pagesLabel(142)).toBe("142 pp.");
    expect(pagesLabel(1)).toBe("1 p.");
  });

  it("says nothing for a document nobody could open", () => {
    // 6% of the files D-47 swept. A folder with no thickness written on it,
    // rather than a folder claiming to be empty.
    expect(pagesLabel(null)).toBe("");
    expect(pagesLabel(Number.NaN)).toBe("");
  });
});

describe("how full a folder looks", () => {
  it("reads the order of magnitude rather than the count", () => {
    // The claim the log scale is making: the gap a person can see is between a
    // memo and a report, not between a memo and a slightly longer memo. So 3
    // to 30 has to move it further than 300 to 330 does — and by a lot.
    const memoToReport = folderBulk(30) - folderBulk(3);
    const reportToSlightlyLonger = folderBulk(330) - folderBulk(300);
    expect(memoToReport).toBeGreaterThan(reportToSlightlyLonger * 10);
  });

  it("fills up and stops", () => {
    // Past about five hundred sheets the fold has run out. A thousand-page
    // dump is drawn as a full folder rather than as an impossible one.
    expect(folderBulk(500)).toBe(1);
    expect(folderBulk(5_000)).toBe(1);
    expect(folderBulk(1)).toBe(0);
  });

  it("never goes backwards", () => {
    let last = -1;
    for (const pages of [1, 2, 5, 12, 40, 100, 250, 499, 500, 900]) {
      const bulk = folderBulk(pages);
      expect(bulk).toBeGreaterThanOrEqual(last);
      last = bulk;
    }
  });

  it("draws a folder with something in it when nobody has said what", () => {
    // Not zero. An empty folder is a statement — nobody has put anything in
    // this — and it is the wrong thing to say about a document that is still
    // being counted, or one whose record is still crossing the network.
    const unknown = folderBulk(null);
    expect(unknown).toBeGreaterThan(folderBulk(2));
    expect(unknown).toBeLessThan(folderBulk(100));
    // The three shapes of not knowing all arrive here, and a negative count is
    // not a thinner folder than none at all.
    expect(folderBulk(Number.NaN)).toBe(unknown);
    expect(folderBulk(0)).toBe(unknown);
    expect(folderBulk(-3)).toBe(unknown);
  });
});

describe("which files are asked what they are called", () => {
  it("asks the three that have a field for it", () => {
    // A PDF's /Title, a container's own name field. Each of the three has a
    // label with a line for it: a tab, a spine, a J-card.
    expect(carriesItsOwnName("document")).toBe(true);
    expect(carriesItsOwnName("video")).toBe(true);
    expect(carriesItsOwnName("audio")).toBe(true);
  });

  it("does not ask a photograph, and does not ask what it cannot name", () => {
    // Not a nicety. The probe is a round trip to the shell and a read off the
    // disk, so a board of three hundred photographs would ask three hundred
    // times to be told nothing. What a JPEG carries is EXIF — what took it,
    // not what it is — and a polaroid gets a caption in somebody's own hand.
    expect(carriesItsOwnName("image")).toBe(false);
    expect(carriesItsOwnName("unknown")).toBe(false);
  });
});

describe("the title line is earned", () => {
  it("writes a title that says something the filename does not", () => {
    // The case the feature exists for, and a real pair out of D-47's sweep.
    expect(titleWorthWriting("Configure Virtual Hosts", "configure-vhosts.pdf")).toBe(
      "Configure Virtual Hosts",
    );
  });

  it("refuses the filename over again", () => {
    expect(titleWorthWriting("ILMC005D Industrial Check Standards", "ILMC005D Industrial Check Standards.pdf")).toBe("");
    expect(titleWorthWriting("findings", "FINDINGS.pdf")).toBe("");
  });

  it("refuses the design file it was printed out of", () => {
    // The commonest junk shape in the corpus, both ways round: the same stem
    // with another suffix, and a different stem with an authoring suffix.
    expect(titleWorthWriting("MPI Log book.cdr", "MPI Log book.pdf")).toBe("");
    expect(titleWorthWriting("WAYNE LABELS.cdr", "cat paper labels.pdf")).toBe("");
    expect(titleWorthWriting("Chapter four.docx", "ch4-final.pdf")).toBe("");
  });

  it("refuses a placeholder and a bare number", () => {
    for (const junk of ["Untitled", "Untitled-1", "untitled 3", "1", "2019", "- -"]) {
      expect(titleWorthWriting(junk, "anything.pdf")).toBe("");
    }
  });

  it("keeps a real title that happens to have a number in it", () => {
    expect(titleWorthWriting("Interim report 2019", "scan007.pdf")).toBe("Interim report 2019");
  });

  it("works on a file that never had a name", () => {
    // A paste of raw bytes has no filename to compare against, and that must
    // not swallow the title.
    expect(titleWorthWriting("Grand jury exhibit B", "")).toBe("Grand jury exhibit B");
  });

  it("cannot catch the producer's template, and that is the known hole", () => {
    // `A4 Service Inv\\Crd Without Discount` is the deliberate /Title of more
    // than a hundred distinct invoices on the machine D-47 swept. Nothing
    // inside one document says it is not a title, so this writes it - the
    // failure is recorded here rather than pretended about.
    expect(titleWorthWriting("A4 Service Inv\\Crd Without Discount", "22718 N Sign.pdf")).toBe(
      "A4 Service Inv\\Crd Without Discount",
    );
  });
});

describe("the case number on the label", () => {
  const hash = "4f2a9c1b".padEnd(64, "0");

  it("is the filename with the extension taken off", () => {
    // The object has already said what kind of file it is; `.pdf` after the
    // name is the same statement twice.
    expect(caseNumber("permit to work at unfenced set 2.pdf", hash)).toBe(
      "permit to work at unfenced set 2",
    );
  });

  it("keeps a dot that is part of the name", () => {
    expect(caseNumber("SOP-19382 (003).v2.pdf", hash)).toBe("SOP-19382 (003).v2");
    expect(caseNumber(".hidden", hash)).toBe(".hidden");
  });

  it("falls back to the hash for a file nobody named", () => {
    // A screenshot, a drag out of another window, a paste of raw bytes. The
    // hash is a genuine case number: unique to this evidence, and the same one
    // on every machine holding it.
    expect(caseNumber(null, hash)).toBe("4F2A9C1B");
    expect(caseNumber("   ", hash)).toBe("4F2A9C1B");
  });
});
