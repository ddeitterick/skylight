# Mount calibration tools (after moving the camera)

Nothing here holds site values — camera address, encoder units, gains, lens
table and the current mount all come from the tracker config
(`server/data/config.json` / `GET /api/config`).

1. Stop the tracker (one VISCA client only): `sudo systemctl stop skylight-tracker`.
2. On the Pi: `pnpm exec tsx scripts/survey-ring.ts <dir> -20,-5,10,25 30` —
   wide frames around the compass at known mechanical poses (also prints how
   far the head tilts below level).
3. `python3 scripts/calib/remount_fit.py --refs <landmarks*.json> --ring <dir>
   --config http://<pi>:3000/api/config [--apply]` — needs numpy, scipy,
   opencv (run on the dev box after copying the ring). The refs are the
   landmark store from before the move (move it aside first; its poses and
   model describe the OLD mount).
4. Move `tracker/data/autocal.json` and `landmarks.json` aside (they describe
   the old mount), start the tracker.
5. After a few passes: `python3 scripts/calib/pass_bias_fit.py --passes
   tracker/data/passes --since <first pass id after the change> --config …`
   (offsets; add `--lean` with passes all round the sky), `--apply`.

Tilt zero moved (head knocked while unpowered — it is backdrivable): the fit
shows a large `tiltOffsetDeg` and overhead becomes unreachable. Re-sync by
hand: `scripts/goto-pose.ts 0 90`, unplug, push the lens square to the base,
replug (the camera restores "90" from memory), re-run steps 2-3.
