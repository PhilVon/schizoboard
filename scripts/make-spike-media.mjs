/**
 * Builds the video and audio the T-293 spike measures (D-48).
 *
 * The same argument `fetch-spike-photos.mjs` makes about photographs applies to
 * motion, and harder: a synthetic test pattern compresses to almost nothing, is
 * decoded almost for free, and would hand back a cheerful pass for a board that
 * chokes on a real film. So the film here is built out of the real photograph
 * corpus — a slow ken-burns push across one photograph after another, with a
 * little sensor noise on top so the encoder cannot cheat the flat areas.
 *
 * Needs ffmpeg on PATH and public/spike/ already populated:
 *
 *   node scripts/fetch-spike-photos.mjs
 *   node scripts/make-spike-media.mjs
 *
 * Output lands in public/spike/, which is gitignored — this is a test fixture,
 * not source. About 60 MB, most of it long1080.mp4.
 */

import { spawn } from "node:child_process";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const OUT = join(process.cwd(), "public", "spike");
/** Ten seconds at 30 fps. Long enough that a 2.6 s measuring block never sees
 *  the loop point, short enough to build in a couple of minutes. */
const FRAMES = 300;

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "inherit"] });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
  });
}

async function main() {
  await mkdir(OUT, { recursive: true });
  try {
    await access(join(OUT, "0000.jpg"));
  } catch {
    console.error("public/spike/0000.jpg is missing — run scripts/fetch-spike-photos.mjs first.");
    process.exit(1);
  }

  console.log("pan1080.mp4 — ken-burns across the photograph corpus, 1920x1080");
  await run([
    "-hide_banner", "-loglevel", "error", "-y",
    // Two seconds per photograph in, thirty frames a second out.
    "-framerate", "1/2", "-start_number", "0", "-i", join(OUT, "%04d.jpg"),
    "-frames:v", String(FRAMES),
    "-vf",
    "scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080," +
      "zoompan=z='min(zoom+0.0012,1.4)':d=60:s=1920x1080:fps=30," +
      "noise=alls=6:allf=t+u,format=yuv420p",
    "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-g", "60", "-an",
    join(OUT, "pan1080.mp4"),
  ]);

  for (const [w, h] of [[1280, 720], [640, 360]]) {
    console.log(`pan${h}.mp4 — the same film at ${w}x${h}`);
    await run([
      "-hide_banner", "-loglevel", "error", "-y",
      "-i", join(OUT, "pan1080.mp4"),
      "-vf", `scale=${w}:${h}`,
      "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-g", "60", "-an",
      join(OUT, `pan${h}.mp4`),
    ]);
  }

  // Six copies of the same four seconds, stream-copied through mpegts so the
  // timestamps restart cleanly. The point is the *size*: 48 MB is a dozen
  // times `protocol.rs`'s 4 MiB response cap, so playing it is a dozen ranges
  // rather than one, which is the only way to see the ladder at all (T-263).
  // The mp4 muxer leaves `moov` at the end by default and that is deliberate
  // here too — a media element cannot find it in the first 4 MiB, so it has to
  // read the short 206's `Content-Range` to work out where the tail is. If the
  // cap were mishandled the film would not load at all rather than stutter.
  console.log("long1080.mp4 — the same film six times over, 48 MB, moov at the end");
  const seg = join(OUT, "seg.ts");
  const list = join(OUT, "concat.txt");
  await run([
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", join(OUT, "pan1080.mp4"),
    "-c", "copy", "-bsf:v", "h264_mp4toannexb", "-f", "mpegts", seg,
  ]);
  await writeFile(list, `file '${seg.replace(/\\/g, "/")}'\n`.repeat(6));
  await run([
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "concat", "-safe", "0", "-i", list,
    "-c", "copy", "-fflags", "+genpts",
    join(OUT, "long1080.mp4"),
  ]);
  await Promise.all([rm(seg, { force: true }), rm(list, { force: true })]);

  // Band-limited to roughly a voice, because the cassette case (T-277) is an
  // interview and an mp3 of a sine wave is not one.
  console.log("tone.mp3 — sixty seconds of speech-band noise, 192 kbps stereo");
  await run([
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi",
    "-i", "anoisesrc=d=60:c=pink:r=44100:a=0.4,highpass=f=180,lowpass=f=3600,tremolo=f=3:d=0.7",
    "-ac", "2", "-c:a", "libmp3lame", "-b:a", "192k",
    join(OUT, "tone.mp3"),
  ]);

  console.log("done — public/spike/pan{360,720,1080}.mp4, long1080.mp4 and tone.mp3");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
