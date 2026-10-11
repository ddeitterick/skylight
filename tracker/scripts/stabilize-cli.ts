// Offline run of the clip stabilizer (video/stabilize.ts — the same pass the
// clip recorder applies to finished recordings): writes a plane-centred
// version of a clip, using its .track.json sidecar when present.
//
// When: tuning the stabilizer, or re-rendering an old recording.
//   pnpm exec tsx scripts/stabilize-cli.ts <in.mp4> <out.mp4>
import { stabilizeClip } from "../src/video/stabilize.js";

const [, , src, out] = process.argv;
if (!src || !out) {
  console.error("usage: stabilize-cli <in.mp4> <out.mp4>");
  process.exit(1);
}
await stabilizeClip(src, out, {
  onProgress: (f) => console.log(`  ${(f * 100).toFixed(0)}%`),
});
console.log("wrote", out);
