import { describe, expect, it } from "vitest";

import {
  addressLabel,
  assetKind,
  canBeOpened,
  carriesItsOwnName,
  CARD_UNITS,
  fileNoun,
  isCaseObject,
  siteLabel,
  caseNumber,
  folderBulk,
  objectSizeFor,
  pageReference,
  pagesLabel,
  referenceName,
  runtimeLabel,
  timeReference,
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

  /** T-317. */
  it("knows which kinds are objects made of their own furniture", () => {
    expect(isCaseObject("document")).toBe(true);
    expect(isCaseObject("video")).toBe(true);
    expect(isCaseObject("audio")).toBe(true);
    // A photograph's shape is a fact about its bytes and `polaroidFor` answers
    // for it; an unknown never gets past the gate.
    expect(isCaseObject("image")).toBe(false);
    expect(isCaseObject("unknown")).toBe(false);
    // Derived from the object sizes rather than a fourth list of the same three
    // names, which is what stops it drifting from them.
    for (const kind of ["document", "video", "audio", "image", "unknown"] as const) {
      expect(isCaseObject(kind)).toBe(objectSizeFor(kind) !== null);
    }
  });

  it("calls a file what it is when handing it back to the disk", () => {
    expect(fileNoun("image")).toBe("photograph");
    expect(fileNoun("document")).toBe("document");
    expect(fileNoun("video")).toBe("film");
    expect(fileNoun("audio")).toBe("recording");
    // A caller that cannot say gets a general word rather than a wrong one.
    expect(fileNoun("unknown")).toBe("file");
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

  it("cuts a business card to a business card, in the family's own scale", () => {
    // 85 by 55 mm, which is ISO 7810 ID-1 and is also a credit card — being
    // *the* card size is most of what makes the shape recognisable at a glance.
    // Within a percent: the units are whole numbers, and 132 by 85 is as near
    // as a 1.55 scale gets to 85 by 55 without carrying a fraction of a unit
    // around for the rest of the object's life.
    expect(Math.abs(CARD_UNITS.w / CARD_UNITS.h - 85 / 55)).toBeLessThan(0.01);
    // And in true proportion to the three objects it stands beside, which is the
    // whole reason those three share one scale: a card really is a little
    // smaller than a compact cassette, and drawn any other way it would be
    // claiming to hold something.
    const cassette = objectSizeFor("audio")!;
    expect(CARD_UNITS.w / cassette.w).toBeCloseTo(85 / 100, 2);
    expect(CARD_UNITS.w).toBeLessThan(cassette.w);
  });

  it("is not `objectSizeFor`'s to answer, and that is the modelling difference", () => {
    // The three sizes above are chosen from the file's kind. A card's cannot be:
    // the file behind one is a jpeg, and a jpeg is a photograph. What makes it a
    // card is a field on the *item*, so its size is a separate export and
    // `objectSizeFor` goes on saying nothing about a picture.
    expect(objectSizeFor("image")).toBeNull();
  });
});

describe("what a card says about where it came from", () => {
  it("takes the host as the company line, without the www", () => {
    expect(siteLabel("https://www.example.org/a/b?c=d")).toBe("example.org");
    expect(siteLabel("https://en.wikipedia.org/wiki/Cork")).toBe("en.wikipedia.org");
  });

  it("says nothing where a peer wrote something that will not parse", () => {
    // `source` crosses the wire, so this reads a string somebody else chose. A
    // card with no company line is a card; one with `undefined` printed on it is
    // a defect somebody would have to report.
    expect(siteLabel("not a url")).toBe("");
    expect(siteLabel("")).toBe("");
  });

  it("prints the address without the scheme", () => {
    // Eight characters of `https://` at the head of the smallest line on a 55 mm
    // card is a real fraction of the only line that says where the thing goes —
    // and it is not information, because it is on essentially every link.
    expect(addressLabel("https://example.org/some/article?ref=x")).toBe(
      "example.org/some/article?ref=x",
    );
    expect(addressLabel("http://www.example.org/")).toBe("example.org");
  });

  it("cuts an address nobody could have meant", () => {
    // CSS already stops a long address *showing*. It does not stop it being in
    // the DOM, and this is a field a peer wrote.
    const long = `https://e.com/${"a".repeat(5000)}`;
    expect(addressLabel(long).length).toBeLessThan(250);
  });

  it("leaves the stored address alone, which is the one that gets opened", () => {
    // The split this depends on: these two are labels and nothing reads them
    // back. `app/main.ts` validates `^https?://` against the *field*, so taking
    // the scheme off here cannot widen what the shell will launch.
    const source = "https://example.org/x";
    expect(addressLabel(source)).not.toBe(source);
    expect(source.startsWith("https://")).toBe(true);
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

describe("the reference a card cites its source by", () => {
  const hash = "4f2a9c1b".padEnd(64, "0");

  it("keeps the extension the case number strips", () => {
    // The one deliberate difference between the two. A tab is written on an
    // object that has already said what it is; a citation is read away from
    // that object by somebody who wants to find the file again.
    expect(referenceName("scan.pdf", hash)).toBe("scan.pdf");
    expect(caseNumber("scan.pdf", hash)).toBe("scan");
  });

  it("falls back to the same hash the tab falls back to", () => {
    expect(referenceName(null, hash)).toBe("4F2A9C1B");
    expect(referenceName("   ", hash)).toBe(caseNumber(null, hash));
  });

  it("says a page the way a citation says one", () => {
    expect(pageReference("scan.pdf", hash, 4)).toBe("scan.pdf p. 4");
    expect(pageReference("deposition.pdf", hash, 301)).toBe("deposition.pdf p. 301");
  });

  it("does not carry the document's length", () => {
    // The open sheet's header reads "4 of 51" because that is a position in
    // something you are holding. A citation is a pointer somebody follows
    // back, and the folder is still on the board with "51 pp." on it.
    expect(pageReference("scan.pdf", hash, 4)).not.toContain("51");
    expect(pageReference("scan.pdf", hash, 4)).not.toContain(" of ");
  });

  it("cites the file and stops when there was no page", () => {
    // A weaker reference rather than a broken one: there was no page.
    expect(pageReference("notes.txt", hash, null)).toBe("notes.txt");
    expect(pageReference("notes.txt", hash, 0)).toBe("notes.txt");
    expect(pageReference("notes.txt", hash, -1)).toBe("notes.txt");
    expect(pageReference("notes.txt", hash, Number.NaN)).toBe("notes.txt");
  });

  it("never cites half a page", () => {
    // A page number reaches this from a reader whose cursor is an integer, but
    // a citation is stored forever and "p. 4.5" is not a place.
    expect(pageReference("scan.pdf", hash, 4.7)).toBe("scan.pdf p. 4");
  });

  it("names a recording by its clock rather than by a page", () => {
    expect(timeReference("interview.mp4", hash, 724)).toBe("interview.mp4 12:04");
    expect(timeReference("interview.mp4", hash, 3907)).toBe("interview.mp4 1:05:07");
  });

  it("gives the same shape to all three kinds", () => {
    // D-46's symmetry constraint, as an assertion rather than a comment: the
    // unit differs because a tape has no pages, and nothing else may.
    expect(pageReference("scan.pdf", hash, 4).startsWith("scan.pdf ")).toBe(true);
    expect(timeReference("tape.mp4", hash, 724).startsWith("tape.mp4 ")).toBe(true);
  });

  it("never cites a moment after the words were said", () => {
    // A runtime is a length and is fairly rounded; a citation is a place to go
    // and listen. Rounding a line said at 15.6 seconds to 0:16 sends somebody
    // to a point where it has already been said.
    expect(timeReference("interview.mp3", hash, 15.6)).toBe("interview.mp3 0:15");
    expect(timeReference("interview.mp3", hash, 59.9)).toBe("interview.mp3 0:59");
  });

  it("cites an unmeasured recording by name alone", () => {
    expect(timeReference("interview.mp4", hash, null)).toBe("interview.mp4");
  });

  it("says the start of a recording rather than saying nothing", () => {
    // Zero is a measurement — the opening frame is a real place on a tape, and
    // the same distinction runtimeLabel already draws for a spine.
    expect(timeReference("interview.mp4", hash, 0)).toBe("interview.mp4 0:00");
  });
});
