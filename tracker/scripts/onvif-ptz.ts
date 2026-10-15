// ONVIF PTZ discovery — camera-agnostic (any ONVIF Profile S PTZ camera).
// Reads what the camera says it can do: PTZ nodes, velocity spaces,
// configuration options. Read-only except `move` / `stop`.
//
//   pnpm exec tsx scripts/onvif-ptz.ts info
//   pnpm exec tsx scripts/onvif-ptz.ts status
//   pnpm exec tsx scripts/onvif-ptz.ts move <x> <y> <sec>   # MOVES THE CAMERA (tracker stopped)
//   pnpm exec tsx scripts/onvif-ptz.ts stop
import { clean, connectOnvif, continuousMove, NS, ptzStop, soap } from "./lib/onvif.js";

const o = await connectOnvif();
const cmd = process.argv[2];
if (cmd === "info") {
  console.log("services:", o);
  console.log("\n== GetNodes\n" + clean(await soap(o.ptz, `<GetNodes xmlns="${NS.ptz}"/>`)).slice(0, 4000));
  const cfgs = await soap(o.ptz, `<GetConfigurations xmlns="${NS.ptz}"/>`);
  console.log("\n== GetConfigurations\n" + clean(cfgs).slice(0, 3000));
  const ct = cfgs.match(/PTZConfiguration[^>]*token="([^"]+)"/)?.[1];
  if (ct) {
    console.log("\n== GetConfigurationOptions\n" + clean(await soap(o.ptz,
      `<GetConfigurationOptions xmlns="${NS.ptz}"><ConfigurationToken>${ct}</ConfigurationToken></GetConfigurationOptions>`)).slice(0, 4000));
  }
} else if (cmd === "status") {
  console.log(clean(await soap(o.ptz, `<GetStatus xmlns="${NS.ptz}"><ProfileToken>${o.profile}</ProfileToken></GetStatus>`)).slice(0, 1500));
} else if (cmd === "move") {
  const [x, y, sec] = process.argv.slice(3, 6).map(Number);
  const r = await continuousMove(o, x, y, sec > 0 ? sec : undefined);
  console.log(r.includes("Fault") ? clean(r).slice(0, 1200) : "ok");
} else if (cmd === "stop") {
  const r = await ptzStop(o);
  console.log(r.includes("Fault") ? clean(r).slice(0, 1200) : "stopped");
} else {
  console.log("usage: onvif-ptz.ts info|status|move <x> <y> <sec>|stop");
}
