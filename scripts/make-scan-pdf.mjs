/**
 * `public/spike/scan.pdf` — a one-page PDF that *is* a scan.
 *
 *     npm run spike:fetch     # if public/spike/ is empty
 *     npm run spike:scan
 *
 * One JPEG covering the whole MediaBox, as a `DCTDecode` XObject. That filter is
 * the point: `document.rs` passes a DCT stream through unmodified, so the bytes
 * the reading surface gets back are byte-identical to the JPEG that went in —
 * which makes this an *oracle* rather than a fixture. A run can hash both ends
 * and compare, where a re-encoded scan could only be eyeballed.
 *
 * A scan is also the one page the reading surface cannot be developed without.
 * D-46 section 4 is explicit that for this audience a scan is not an edge case,
 * it is a court filing, and `Q-199` settled that its image is lifted onto our
 * own paper — so a text file exercises none of the interesting half. Written
 * here rather than checked in because `public/spike/` is not in the repository
 * and 400 kB of PDF is not a diff anybody can read.
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
const content = Buffer.from(`q ${PAGE_W} 0 0 ${PAGE_H} 0 0 cm /Im0 Do Q\n`, "latin1");

const parts = [];
const offsets = [];
let at = 0;
const push = (buf) => {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf, "latin1");
  parts.push(b);
  at += b.length;
};
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

push("%PDF-1.5\n%\xe2\xe3\xcf\xd3\n");
obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
obj(
  3,
  `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
    `/Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`,
);
obj(
  4,
  `<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB ` +
    `/BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>`,
  jpeg,
);
obj(5, `<< /Length ${content.length} >>`, content);

const xrefAt = at;
let xref = `xref\n0 6\n0000000000 65535 f \n`;
for (let n = 1; n <= 5; n++) xref += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
push(xref);
push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);

const out = Buffer.concat(parts);
await writeFile(join(spike, "scan.pdf"), out);
console.log(JSON.stringify({ jpegBytes: jpeg.length, w, h, pdfBytes: out.length }));
