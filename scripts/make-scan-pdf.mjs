/**
 * The PDFs the reading surface is developed and driven against.
 *
 *     npm run spike:fetch     # if public/spike/ is empty
 *     npm run spike:scan
 *
 * Two files, and neither is checked in: `public/spike/` is not in the
 * repository, and 400 kB of PDF is not a diff anybody can read.
 *
 * **`scan.pdf`** — one page that *is* a scan. One JPEG covering the whole
 * MediaBox, as a `DCTDecode` XObject, and that filter is the point:
 * `document.rs` passes a DCT stream through unmodified, so the bytes the reading
 * surface gets back are byte-identical to the JPEG that went in. That makes it
 * an *oracle* rather than a fixture — a run can hash both ends and compare,
 * where a re-encoded scan could only be eyeballed.
 *
 * **`filing.pdf`** — four pages, one for each thing a page can turn out to be,
 * in one document. That shape is the fixture rather than a convenience: D-46
 * section 4 says the decision is per *page* and not per document, "because a
 * filing is routinely typed pages with scanned exhibits behind them", and four
 * separate files could not have shown it. The pages are
 *
 *   1  typed  — Courier text, which comes back as runs with their boxes
 *   2  a scan — the same JPEG, lifted
 *   3  empty  — a page with no `/Contents` at all
 *   4  unreadable — a JPEG 2000 image, which this build names and refuses
 *
 * so a single open exercises `PageContent`'s five arms bar one, and the fifth
 * (`Plain`) is what a `.txt` gives.
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const spike = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "spike");
const jpeg = await readFile(join(spike, "0000.jpg"));

/** Width and height off the first SOF marker. */
function size(buf) {
  let at = 2;
  while (at < buf.length) {
    if (buf[at] !== 0xff) {
      at++;
      continue;
    }
    const marker = buf[at + 1];
    const len = buf.readUInt16BE(at + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { h: buf.readUInt16BE(at + 5), w: buf.readUInt16BE(at + 7) };
    }
    at += 2 + len;
  }
  throw new Error("no SOF in the jpeg");
}

const { w, h } = size(jpeg);
const PAGE_W = 595;
const PAGE_H = 842;

/**
 * A PDF, written by hand.
 *
 * `pages` is a list of `{ resources, content }`, either of which may be absent —
 * a page with no content is page 3's whole point. Objects are numbered as they
 * are written and the cross-reference table is built from where they landed,
 * which is the only part of this that has to be exact.
 */
function pdf(pages) {
  const parts = [];
  const offsets = [];
  let at = 0;
  const push = (buf) => {
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf, "latin1");
    parts.push(b);
    at += b.length;
  };
  let next = 3; // 1 catalog, 2 pages
  const obj = (n, body, stream = null) => {
    offsets[n] = at;
    push(`${n} 0 obj\n${body}\n`);
    if (stream) {
      push("stream\n");
      push(stream);
      push("\nendstream\n");
    }
    push("endobj\n");
  };

  // Everything a page refers to is written before the page tree, so the ids are
  // known when the kids list is built.
  const later = [];
  const pageIds = [];
  for (const page of pages) {
    const extras = [];
    for (const [body, stream] of page.objects ?? []) {
      const id = next++;
      extras.push(id);
      later.push([id, typeof body === "function" ? body(extras) : body, stream]);
    }
    let contentId = null;
    if (page.content) {
      contentId = next++;
      later.push([contentId, `<< /Length ${page.content.length} >>`, page.content]);
    }
    const pageId = next++;
    pageIds.push(pageId);
    later.push([
      pageId,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
        (page.resources ? `/Resources ${page.resources(extras)} ` : "") +
        (contentId === null ? "" : `/Contents ${contentId} 0 R `) +
        ">>",
      null,
    ]);
  }

  push("%PDF-1.5\n%\xe2\xe3\xcf\xd3\n");
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(
    2,
    `<< /Type /Pages /Kids [${pageIds.map((n) => `${n} 0 R`).join(" ")}] /Count ${pageIds.length} >>`,
  );
  for (const [id, body, stream] of later) obj(id, body, stream);

  const count = next;
  const xrefAt = at;
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let n = 1; n < count; n++) xref += `${String(offsets[n] ?? 0).padStart(10, "0")} 00000 n \n`;
  push(xref);
  push(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);
  return Buffer.concat(parts);
}

const fullPageImage = Buffer.from(`q ${PAGE_W} 0 0 ${PAGE_H} 0 0 cm /Im0 Do Q\n`, "latin1");
const scanPage = {
  objects: [
    [
      `<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB ` +
        `/BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>`,
      jpeg,
    ],
  ],
  resources: (ids) => `<< /XObject << /Im0 ${ids[0]} 0 R >> >>`,
  content: fullPageImage,
};

const scan = pdf([scanPage]);
await writeFile(join(spike, "scan.pdf"), scan);

// --- filing.pdf: one document, four kinds of page ---------------------------

const typed = Buffer.from(
  [
    "BT /F1 12 Tf 72 760 Td (IN THE MATTER OF HARTLEY) Tj ET",
    "BT /F1 11 Tf 72 730 Td (and in the matter of an application under section 12) Tj ET",
    "BT /F1 11 Tf 72 706 Td (The witness states that on the evening in question he) Tj ET",
    "BT /F1 11 Tf 72 682 Td (observed the vehicle parked outside the premises.) Tj ET",
    "",
  ].join("\n"),
  "latin1",
);

/** A page whose only image is a JPEG 2000, which `document.rs` names and
 *  refuses rather than half-decoding — the reason `PageContent::Unsupported`
 *  carries a sentence instead of being a boolean. */
const jpxBytes = Buffer.from("\x00\x00\x00\x0cjP  \r\n\x87\n", "latin1");

const filing = pdf([
  {
    objects: [
      [`<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>`, null],
    ],
    resources: (ids) => `<< /Font << /F1 ${ids[0]} 0 R >> >>`,
    content: typed,
  },
  scanPage,
  // No `/Contents` and no resources: nothing on it at all.
  {},
  {
    objects: [
      [
        `<< /Type /XObject /Subtype /Image /Width 1200 /Height 1600 /ColorSpace /DeviceRGB ` +
          `/BitsPerComponent 8 /Filter /JPXDecode /Length ${jpxBytes.length} >>`,
        jpxBytes,
      ],
    ],
    resources: (ids) => `<< /XObject << /Im0 ${ids[0]} 0 R >> >>`,
    content: fullPageImage,
  },
]);
await writeFile(join(spike, "filing.pdf"), filing);

console.log(
  JSON.stringify({
    "scan.pdf": { bytes: scan.length, jpeg: jpeg.length, w, h },
    "filing.pdf": { bytes: filing.length, pages: 4 },
  }),
);
