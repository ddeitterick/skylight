# Pass analysis scripts

Run ON THE PI against the local pass archive (`~/skylight/tracker/data/passes/<id>/{pass,series}.json`):

    scp tracker/scripts/passes/*.py pi@ceiling.local:/tmp/
    ssh pi@ceiling.local 'python3 /tmp/passstats.py $(ls ~/skylight/tracker/data/passes | sort | tail -10)'

- `passstats.py <ids…>` — per pass: lock %, min HFOV, centring (all / at tele <6°),
  1-s camera hops, detection jitter at tele, median vision bias (corrAz/corrEl ≈ mount-model
  error; fold with off −= corr), quality score/flags.
- `focussum.py <ids…>` — focus at tele (<6° HFOV): share of sharp (edge ≤3 px) / soft (>4 px)
  measurements, median edge width (`fe`), seconds from reaching tele to first sharp frame.
- `focusline.py <ids…>` — 1 Hz timeline of zoom, lens focus position (`fpos`), edge width, lock.
- `elband.py <ids…>` — lock rate per 10° elevation band + max |corrEl| (roof-lock check).
- `tilthops.py <ids…>` — tilt hops >0.2° at tele, mean size and reversals (up-down wobble).
