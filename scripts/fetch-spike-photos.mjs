/**
 * Fetches the fidelity-spike photo corpus (T-16).
 *
 * The spike exists to answer one question: does DOM under a CSS scale() stay
 * sharp across the 5%-400% zoom range, or do we have to escalate to WebGL
 * (DESIGN section 11.1, risk 1)? That question is only meaningful against real
 * photographs. Synthetic gradients compress to nothing, rasterise perfectly at
 * any scale and would return a cheerful false pass — it is the high-frequency
 * detail in a real photo that makes a stale bitmap obvious.
 *
 * Photos come from picsum.photos, which serves real photographs under a
 * permissive licence. They land in public/spike/, which is gitignored: this is
 * a few hundred megabytes of test fixture, not source.
 *
 *   node scripts/fetch-spike-photos.mjs [count]
 */

import { mkdir, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const COUNT = Number(process.argv[2] ?? 500);
const CONCURRENCY = 8;
const OUT = join(process.cwd(), "public", "spike");

/** A realistic spread of shapes, not 500 identical rectangles. */
const SHAPES = [
  [1600, 1200], // 4:3 landscape, the common case
  [1600, 1200],
  [1200, 1600], // portrait
  [1800, 1200], // 3:2
  [1200, 1800],
  [1500, 1500], // square
  [2000, 1125], // 16:9
];

async function fetchOne(index) {
  const shape = SHAPES[index % SHAPES.length];
  const name = `${String(index).padStart(4, "0")}.jpg`;
  const url = `https://picsum.photos/seed/schizo${index}/${shape[0]}/${shape[1]}`;

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const response = await fetch(url, { redirect: "follow" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length < 4096) throw new Error(`suspiciously small: ${bytes.length} B`);
      await writeFile(join(OUT, name), bytes);
      return bytes.length;
    } catch (error) {
      if (attempt === 3) {
        console.error(`  ${name} failed: ${String(error)}`);
        return 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 400 * 2 ** attempt));
    }
  }
  return 0;
}

async function main() {
  await mkdir(OUT, { recursive: true });

  const queue = Array.from({ length: COUNT }, (_, i) => i);
  let done = 0;
  let bytes = 0;

  const workers = Array.from({ length: CONCURRENCY }, async () => {
    for (;;) {
      const index = queue.shift();
      if (index === undefined) return;
      // Hoisted deliberately: `bytes += await ...` reads `bytes` before the
      // await and writes it after, so eight workers lose most of the total.
      const size = await fetchOne(index);
      bytes += size;
      done++;
      if (done % 25 === 0) {
        console.log(`  ${done}/${COUNT}  ${(bytes / 1024 / 1024).toFixed(0)} MB`);
      }
    }
  });

  await Promise.all(workers);

  const files = (await readdir(OUT)).filter((f) => f.endsWith(".jpg"));
  const manifest = files.sort();
  await writeFile(join(OUT, "manifest.json"), JSON.stringify(manifest));
  console.log(
    `\n${manifest.length} photos, ${(bytes / 1024 / 1024).toFixed(0)} MB, in public/spike/`,
  );
}

await main();
