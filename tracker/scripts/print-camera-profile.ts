// Print a built-in camera profile preset as a tracker config patch, ready to
// POST to /api/config:  pnpm exec tsx scripts/print-camera-profile.ts > p.json
//   curl -X POST -H 'content-type: application/json' --data @p.json http://<pi>:3000/api/config
import { TONGVEO_PROFILE } from "../../shared/src/camera-profile.js";

const presets: Record<string, unknown> = { tongveo: TONGVEO_PROFILE };
const name = process.argv[2] ?? "tongveo";
if (!presets[name]) throw new Error(`unknown preset ${name} (have: ${Object.keys(presets).join(", ")})`);
console.log(JSON.stringify({ tracker: { camera: presets[name] } }));
