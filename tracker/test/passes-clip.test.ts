// PassClipWriter against a fake fMP4 box source: init + whole fragments
// only, from the next moof; restarts end the clip; the start-time estimate
// comes from tfdt/mdhd; the ffmpeg chain is stubbed.

import { mkdtemp, readFile, rm, writeFile, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PassClipWriter, parseTfdt, type ClipSource } from "../src/passes/clip.js";
import { extractTimescale, type Mp4Init, type Mp4Tap } from "../src/video/mse.js";

// --- tiny box builders ---
const box = (type: string, ...payload: Buffer[]): Buffer => {
  const body = Buffer.concat(payload);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, "ascii");
  return Buffer.concat([head, body]);
};
const u32 = (v: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(v, 0);
  return b;
};
const u64 = (v: number) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(v), 0);
  return b;
};
const fullbox = (type: string, version: number, ...payload: Buffer[]) =>
  box(type, Buffer.from([version, 0, 0, 0]), ...payload);

const TS = 90_000;
const FTYP = box("ftyp", Buffer.from("isom\0\0\0\0isomiso2avc1"));
const MDHD_V0 = fullbox("mdhd", 0, u32(0), u32(0), u32(TS), u32(0), u32(0));
const MOOV = box("moov", box("mvhd"), box("trak", box("mdia", MDHD_V0, box("hdlr"))));
const moof = (tfdt: number, v: 0 | 1 = 1) =>
  box("moof", box("mfhd"), box("traf", box("tfhd"), v === 1 ? fullbox("tfdt", 1, u64(tfdt)) : fullbox("tfdt", 0, u32(tfdt))));
const mdat = (fill: number) => box("mdat", Buffer.alloc(100, fill));

class FakeSource implements ClipSource {
  taps = new Set<Mp4Tap>();
  current: Mp4Init | null = null;
  gen = 1;
  tap(fn: Mp4Tap): () => void {
    this.taps.add(fn);
    return () => this.taps.delete(fn);
  }
  init(): Mp4Init | null {
    return this.current;
  }
  setInit(): void {
    this.current = { segment: Buffer.concat([FTYP, MOOV]), codec: "avc1.640028", timescale: TS, gen: this.gen };
  }
  push(type: string, b: Buffer): void {
    for (const fn of [...this.taps]) fn(type, b, this.gen);
  }
  restart(): void {
    this.gen++;
    this.current = null;
    this.push("ftyp", FTYP);
    this.setInit();
    this.push("moov", MOOV);
  }
}

/** ffmpeg/ffprobe stand-in: remux = copy, probe = fixed duration, poster = touch. */
function fakeExec(log: string[][], opts: { fail?: boolean } = {}) {
  return async (cmd: string, args: string[]): Promise<string> => {
    log.push([cmd, ...args]);
    if (opts.fail) throw new Error("boom");
    if (cmd === "ffprobe") return "3.000000\n";
    if (args.includes("-frames:v")) {
      await writeFile(args[args.length - 1], "jpeg");
      return "";
    }
    const i = args.indexOf("-i");
    await copyFile(args[i + 1], args[args.length - 1]);
    return "";
  };
}

describe("PassClipWriter", () => {
  let dir: string;
  let clock: number;
  const now = () => clock;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "passclip-"));
    clock = 1_000_000;
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes init, then whole fragments from the next moof; estimates the start", async () => {
    const src = new FakeSource();
    src.setInit();
    const log: string[][] = [];
    const w = new PassClipWriter(dir, src, 350, fakeExec(log), now);
    w.start();
    src.push("mdat", mdat(9)); // orphan mdat before any moof: skipped
    const frags = [
      [0, mdat(1)],
      [TS, mdat(2)],
      [2 * TS, mdat(3)],
    ] as const;
    for (const [tfdt, data] of frags) {
      clock += 1000; // arrives one GOP after its first frame
      src.push("moof", moof(tfdt));
      src.push("mdat", data);
    }
    expect(w.fragmentCount).toBe(3);
    const res = await w.stop({ posterAt: ({ durationSec }) => durationSec / 2 });
    expect(res.error).toBeNull();
    expect(res.fragments).toBe(3);
    expect(res.durationSec).toBe(3);
    expect(res.codec).toBe("avc1.640028");
    expect(res.truncated).toBe(false);
    expect(res.restarted).toBe(false);
    expect(res.path).toBe(join(dir, "clip.mp4"));
    expect(res.posterPath).toBe(join(dir, "poster.jpg"));
    // Byte-exact: init + the three moof/mdat pairs, nothing else.
    const expected = Buffer.concat([
      FTYP, MOOV,
      moof(0), mdat(1), moof(TS), mdat(2), moof(2 * TS), mdat(3),
    ]);
    expect((await readFile(join(dir, "clip.mp4"))).equals(expected)).toBe(true);
    expect(res.bytes).toBe(expected.length);
    expect(existsSync(join(dir, "clip.fmp4"))).toBe(false);
    // Fragment k arrives when fragment k+1 starts: c = 1_001_000 − 1000 =
    // 1_000_000; first frame at tfdt 0 → c − pipeline lag.
    expect(res.startWallMs).toBe(1_000_000 - 350);
    // ffmpeg remux → ffprobe → poster, with the chosen poster time.
    expect(log.map((l) => l[0])).toEqual(["ffmpeg", "ffprobe", "ffmpeg"]);
    expect(log[0]).toContain("+faststart");
    expect(log[2][log[2].indexOf("-ss") + 1]).toBe("1.50");
  });

  it("waits for the init segment when the stream has none yet, and ends at a restart", async () => {
    const src = new FakeSource(); // no init yet
    const log: string[][] = [];
    const w = new PassClipWriter(dir, src, 350, fakeExec(log), now);
    w.start();
    src.push("moof", moof(0)); // fragments before init: dropped
    src.push("mdat", mdat(1));
    src.push("ftyp", FTYP);
    src.setInit();
    src.push("moov", MOOV);
    clock += 1000;
    src.push("moof", moof(TS));
    src.push("mdat", mdat(2));
    clock += 1000;
    src.push("moof", moof(2 * TS));
    src.push("mdat", mdat(3));
    expect(w.fragmentCount).toBe(2);
    src.restart(); // new ffmpeg epoch → new init: our clip stops here
    src.push("moof", moof(0));
    src.push("mdat", mdat(4));
    expect(w.fragmentCount).toBe(2);
    expect(src.taps.size).toBe(0); // detached
    const res = await w.stop();
    expect(res.restarted).toBe(true);
    expect(res.fragments).toBe(2);
    const expected = Buffer.concat([FTYP, MOOV, moof(TS), mdat(2), moof(2 * TS), mdat(3)]);
    expect((await readFile(join(dir, "clip.mp4"))).equals(expected)).toBe(true);
    // Default poster time is 1 s when no picker is given.
    expect(log[2][log[2].indexOf("-ss") + 1]).toBe("1.00");
  });

  it("discard removes the capture without running ffmpeg", async () => {
    const src = new FakeSource();
    src.setInit();
    const log: string[][] = [];
    const w = new PassClipWriter(dir, src, 350, fakeExec(log), now);
    w.start();
    src.push("moof", moof(0));
    src.push("mdat", mdat(1));
    const res = await w.stop({ discard: true });
    expect(res.path).toBeNull();
    expect(log).toEqual([]);
    expect(existsSync(join(dir, "clip.fmp4"))).toBe(false);
    expect(existsSync(join(dir, "clip.mp4"))).toBe(false);
    // Idempotent.
    expect(await w.stop()).toBe(res);
  });

  it("no fragments → no clip (sim driver / stream down), no ffmpeg", async () => {
    const src = new FakeSource();
    const log: string[][] = [];
    const w = new PassClipWriter(dir, src, 350, fakeExec(log), now);
    w.start();
    const res = await w.stop();
    expect(res.path).toBeNull();
    expect(res.fragments).toBe(0);
    expect(res.error).toBeNull();
    expect(log).toEqual([]);
  });

  it("records an ffmpeg failure instead of throwing", async () => {
    const src = new FakeSource();
    src.setInit();
    const w = new PassClipWriter(dir, src, 350, fakeExec([], { fail: true }), now);
    w.start();
    src.push("moof", moof(0));
    src.push("mdat", mdat(1));
    const res = await w.stop();
    expect(res.path).toBeNull();
    expect(res.error).toMatch(/remux: boom/);
    expect(existsSync(join(dir, "clip.fmp4"))).toBe(false);
  });

  it("falls back to arrival spacing when fragments carry no tfdt", async () => {
    const src = new FakeSource();
    src.setInit();
    const w = new PassClipWriter(dir, src, 350, fakeExec([]), now);
    w.start();
    const bare = box("moof", box("mfhd"));
    clock = 2_000_000;
    src.push("moof", bare);
    src.push("mdat", mdat(1));
    clock = 2_001_500;
    src.push("moof", bare);
    src.push("mdat", mdat(2));
    const res = await w.stop();
    // first GOP assumed as long as the next (1.5 s), minus the pipeline lag
    expect(res.startWallMs).toBe(2_000_000 - 1500 - 350);
  });
});

describe("box parsing", () => {
  it("parseTfdt handles version 0 and 1", () => {
    expect(parseTfdt(moof(123456, 1))).toBe(123456);
    expect(parseTfdt(moof(7890, 0))).toBe(7890);
    expect(parseTfdt(box("moof", box("mfhd")))).toBeNull();
  });
  it("extractTimescale reads mdhd v0 and v1", () => {
    expect(extractTimescale(MOOV)).toBe(TS);
    const mdhdV1 = fullbox("mdhd", 1, u64(0), u64(0), u32(1000), u64(0), u32(0));
    expect(extractTimescale(box("moov", box("trak", box("mdia", mdhdV1))))).toBe(1000);
    expect(extractTimescale(box("moov", box("mvhd")))).toBeNull();
  });
});
