// What a media container's title tag actually says, on a real disk.
//
// Two jobs, and they are the same run. It writes `corpus.tsv` — one
// `path<TAB>title` line per file — which is what `media.rs`'s ignored test
// reads to check our five parsers against ffprobe's, because hand-built
// fixtures agree with the parser that was written beside them and real files do
// not. And it prints the shape of what is out there, which is D-52: how often a
// title is present at all, per container, and what it says when it is.
//
// ffprobe is the second opinion rather than the oracle. It reads the same
// header fields we do — it is not estimating anything, the way it estimates a
// duration (T-300) — so where it and we disagree, one of us has a bug and the
// file is named so it can be looked at.
//
//   node scripts/sweep-media-titles.mjs D:/ C:/Users/you
//   SCHIZO_MEDIA_CORPUS=<out>/corpus.tsv cargo test --lib -- --ignored --nocapture
//
// The output goes beside this script's `--out` (default: the system temp dir),
// never into the repository: it is a list of somebody's private files.

import { mkdirSync, writeFileSync, appendFileSync, readdirSync } from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";

const EXTENSIONS = new Set([
  ".mp3", ".m4a", ".m4b", ".aac",
  ".mp4", ".m4v", ".mov",
  ".mkv", ".webm",
  ".ogg", ".oga", ".opus",
  ".flac", ".wav", ".avi",
]);

/** How many ffprobes are in flight. It is I/O bound; this is not a core count. */
const CONCURRENCY = 12;

const roots = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const outFlag = process.argv.find((a) => a.startsWith("--out="));
const out = outFlag ? outFlag.slice("--out=".length) : join(tmpdir(), "schizo-media-sweep");

if (roots.length === 0) {
  console.error("usage: node scripts/sweep-media-titles.mjs <root> [root...] [--out=DIR]");
  process.exit(2);
}
mkdirSync(out, { recursive: true });

/** Every media file under a root, depth first, refusing nothing quietly. */
function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // A directory this account cannot open is not a finding.
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(path);
    } else if (entry.isFile() && EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      yield path;
    }
  }
}

const files = [];
for (const root of roots) {
  for (const path of walk(root)) files.push(path);
}
console.log(`${files.length} files under ${roots.join(", ")}`);

function probe(path) {
  return new Promise((resolve) => {
    execFile(
      "ffprobe",
      ["-v", "quiet", "-show_format", "-show_streams", "-of", "json", path],
      { maxBuffer: 32 * 1024 * 1024, timeout: 30_000 },
      (err, stdout) => {
        if (err) return resolve(null);
        try {
          resolve(JSON.parse(stdout));
        } catch {
          resolve(null);
        }
      },
    );
  });
}

/** The container's own title, whatever case the muxer wrote the key in. */
function pickTitle(tags) {
  for (const [key, value] of Object.entries(tags ?? {})) {
    if (key.toLowerCase() === "title" && String(value).trim()) return String(value);
  }
  return null;
}

/**
 * The title ffprobe read, from wherever ffprobe decided to put it.
 *
 * For Ogg and FLAC it hangs the Vorbis comment off the *stream* rather than the
 * format, because in those containers the comment belongs to a logical stream —
 * so a file whose only title is `TITLE=Cobalt` shows nothing at the format level
 * and the two readers appear to disagree when they do not.
 *
 * Matroska is deliberately excluded from that fallback: a stream's title there
 * is a *track name*, which says "English" or "Commentary". That is a fact about
 * one stream and never the name of the film.
 */
function titleOf(info) {
  const format = pickTitle(info?.format?.tags);
  if (format) return format;
  const name = info?.format?.format_name ?? "";
  if (!/^ogg|flac/.test(name)) return null;
  for (const stream of info?.streams ?? []) {
    const title = pickTitle(stream.tags);
    if (title) return title;
  }
  return null;
}

/** What ffprobe calls the container, mapped onto the parser that answers it. */
function family(info) {
  const name = info?.format?.format_name ?? "";
  if (/mov|mp4|m4a|3gp/.test(name)) return "mp4 udta";
  if (/matroska|webm/.test(name)) return "matroska";
  if (/^ogg/.test(name)) return "vorbis (ogg)";
  if (/flac/.test(name)) return "vorbis (flac)";
  if (/mp3/.test(name)) return "id3v2";
  if (/wav|avi/.test(name)) return "riff INFO";
  return name || "unreadable";
}

const stem = (path) => {
  const base = path.slice(Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/")) + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
};

const tsv = join(out, "corpus.tsv");
writeFileSync(tsv, "");

const stats = new Map();
const titles = new Map();
let unreadable = 0;
let done = 0;
let cursor = 0;

async function worker() {
  for (;;) {
    const i = cursor++;
    if (i >= files.length) return;
    const path = files[i];
    const info = await probe(path);
    const title = titleOf(info);

    // Tabs and newlines in a title would break the line the test reads, and
    // `tidy` collapses whitespace on both sides of the comparison anyway.
    const flat = (title ?? "").replace(/[\t\r\n]+/g, " ");
    appendFileSync(tsv, `${path}\t${flat}\n`);

    if (!info) {
      unreadable++;
    } else {
      const key = family(info);
      const stat = stats.get(key) ?? { n: 0, titled: 0, sameAsName: 0 };
      stat.n++;
      if (title) {
        stat.titled++;
        if (title.trim().toLowerCase() === stem(path).toLowerCase()) stat.sameAsName++;
        titles.set(title, (titles.get(title) ?? 0) + 1);
      }
      stats.set(key, stat);
    }
    if (++done % 500 === 0) console.log(`  ${done}/${files.length}`);
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));

console.log(`\ncorpus written: ${tsv}\n`);
console.log("container         files   titled   = filename");
for (const [key, s] of [...stats].sort((a, b) => b[1].n - a[1].n)) {
  const pct = ((100 * s.titled) / s.n).toFixed(0).padStart(3);
  console.log(
    `${key.padEnd(16)} ${String(s.n).padStart(6)} ${String(s.titled).padStart(8)} (${pct}%) ${String(s.sameAsName).padStart(11)}`,
  );
}
console.log(`\nffprobe could not read ${unreadable} of ${files.length}`);

// The producer-template shape D-47 found in PDFs: one string under many files,
// which nothing inside any one of them says is not a title.
const repeated = [...titles].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]);
if (repeated.length) {
  console.log("\na title that is on more than one file:");
  for (const [title, n] of repeated.slice(0, 20)) {
    console.log(`  ${String(n).padStart(4)} x ${JSON.stringify(title)}`);
  }
}
