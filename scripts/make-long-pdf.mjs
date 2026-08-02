/**
 * The two long fixtures the reading surface's *memory* is measured against.
 *
 *     npm run spike:fetch     # if public/spike/ is empty
 *     npm run spike:long
 *
 *   long.pdf        1000 typed pages, each carrying its own number
 *   deposition.pdf  200 pages that are all scans of the same JPEG
 *
 * Neither is checked in, for the reason `make-scan-pdf.mjs` gives about its own
 * two. What is different about these is the *length*: `filing.pdf` proves what a
 * page can turn out to be, and four pages is the right size for that. Nothing
 * about holding a thousand of them shows up until there are a thousand, and
 * T-279 was a measurement before it was a change — 199 pages and 77 MiB of
 * lifted JPEG held to draw one page of `deposition.pdf`, which no four-page
 * fixture could have shown.
 *
 * Both share **one image XObject across every page**, so a two-hundred-page scan
 * is 400 kB on disk rather than 80 MB. That is not a saving for its own sake: it
 * keeps the thing under test on the frontend's side of the boundary. A fixture
 * that was 80 MB would put the ingest, the store and the range handler into
 * every reading, and the number coming back would be theirs as much as the
 * reader's.
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "spike");
const jpeg = await readFile(join(root, "0000.jpg"));

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
 * `shared` is a list of [body, stream] written once before the pages; each page
 * is `{ resources(sharedIds), content }`.
 */
function pdf(shared, pages) {
  const parts = [];
  const offsets = [];
  let at = 0;
  const push = (buf) => {
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf, "latin1");
    parts.push(b);
    at += b.length;
  };
  let next = 3;
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

  const later = [];
  const sharedIds = [];
  for (const [body, stream] of shared) {
    const id = next++;
    sharedIds.push(id);
    later.push([id, body, stream]);
  }

  const pageIds = [];
  for (const page of pages) {
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
        (page.resources ? `/Resources ${page.resources(sharedIds)} ` : "") +
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

// --- long.pdf ---------------------------------------------------------------
// A page of a transcript: a heading with the page number, then twenty lines, so
// one page is about the 2 kB C-606 measured its typesetting against.
const LINES = [
  "Q. And you were present at the premises on that evening?",
  "A. I was, yes. I arrived shortly before seven and stayed until",
  "   the police attended, which I would put at around half past.",
  "Q. Did you at any point see the vehicle described in exhibit B?",
  "A. I saw a vehicle answering that description parked across the",
  "   entrance to the yard. I could not read the registration from",
  "   where I was standing and I did not go closer to it.",
  "Q. Was anybody in it?",
  "A. Not that I could see. The lights were off and the engine was",
  "   not running. It had been there some time, I should think.",
  "Q. You say it had been there some time. What makes you say so?",
  "A. There was frost on the windscreen and none on the others",
  "   further down, which had come and gone that same hour.",
  "Q. Did you mention that to the officer who attended?",
  "A. I did. He wrote it down. Whether it went any further than",
  "   his notebook I could not tell you.",
  "Q. I want to turn to the letter at tab fourteen.",
  "A. Yes.",
  "Q. Do you recognise the signature at the foot of it?",
  "A. I recognise the name. I have never seen him write it.",
];

const typedPage = (n) => {
  const rows = [`BT /F1 12 Tf 72 780 Td (TRANSCRIPT OF EVIDENCE - PAGE ${n}) Tj ET`];
  let y = 745;
  for (const line of LINES) {
    rows.push(`BT /F1 10 Tf 72 ${y} Td (${line.replace(/[()\\]/g, "")}) Tj ET`);
    y -= 16;
  }
  return Buffer.from(rows.join("\n") + "\n", "latin1");
};

const font = [`<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>`, null];
const long = pdf(
  [font],
  Array.from({ length: 1000 }, (_, i) => ({
    resources: (ids) => `<< /Font << /F1 ${ids[0]} 0 R >> >>`,
    content: typedPage(i + 1),
  })),
);
await writeFile(join(root, "long.pdf"), long);

// --- deposition.pdf ---------------------------------------------------------
const image = [
  `<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB ` +
    `/BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>`,
  jpeg,
];
const fullPageImage = Buffer.from(`q ${PAGE_W} 0 0 ${PAGE_H} 0 0 cm /Im0 Do Q\n`, "latin1");
const deposition = pdf(
  [image],
  Array.from({ length: 200 }, () => ({
    resources: (ids) => `<< /XObject << /Im0 ${ids[0]} 0 R >> >>`,
    content: fullPageImage,
  })),
);
await writeFile(join(root, "deposition.pdf"), deposition);

console.log(
  JSON.stringify({
    "long.pdf": { bytes: long.length, pages: 1000 },
    "deposition.pdf": { bytes: deposition.length, pages: 200, jpeg: jpeg.length },
  }),
);
