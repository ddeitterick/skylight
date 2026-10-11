// Child-process entry for the q1 pass analysis (see quality.ts assessInChild):
//   nice -n 15 node --import tsx src/passes/quality-cli.ts <passDir>
// Reads <passDir>/pass.json, series.json and clip.mp4 (if present), writes the
// beauty frame over poster.jpg (via a temp file + rename, so a half-written
// poster is never uploaded) and quality.json. Exit 0 = quality.json written.

import { existsSync } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { setPriority } from "node:os";
import { join } from "node:path";
import { assessPass, CHILD_NICE, writePoster } from "./quality.js";

async function main(dir: string): Promise<void> {
  // Belt and braces when started without `nice`; ffmpeg children inherit it.
  try {
    setPriority(CHILD_NICE);
  } catch {
    /* already nicer, or not permitted */
  }
  const pass = JSON.parse(await readFile(join(dir, "pass.json"), "utf8"));
  const seriesPath = join(dir, "series.json");
  const series = existsSync(seriesPath) ? JSON.parse(await readFile(seriesPath, "utf8")) : null;
  const clipPath = existsSync(join(dir, "clip.mp4")) ? join(dir, "clip.mp4") : null;
  const t0 = Date.now();
  const { quality } = await assessPass({
    clipPath,
    clipDurationSec: clipPath ? pass.media?.clipDurationSec ?? null : null,
    pass,
    series,
  });
  if (clipPath && quality.bestFrameSec != null) {
    const tmp = join(dir, "poster.q1.jpg");
    try {
      await writePoster(clipPath, quality.bestFrameSec, tmp);
      await rename(tmp, join(dir, "poster.jpg"));
    } catch (err) {
      await rm(tmp, { force: true });
      process.stderr.write(`poster: ${String(err)}\n`);
    }
  }
  await writeFile(join(dir, "quality.json"), JSON.stringify({ ...quality, ms: Date.now() - t0 }));
}

const dir = process.argv[2];
if (!dir) {
  process.stderr.write("usage: quality-cli.ts <passDir>\n");
  process.exit(2);
}
main(dir).catch((err) => {
  process.stderr.write(`${String(err?.stack ?? err)}\n`);
  process.exit(1);
});
