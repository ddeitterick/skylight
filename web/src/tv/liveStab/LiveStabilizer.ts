// Live video stabilizer for the TV/stream page (WebGL2).
//
// One decoder: every new video frame (requestVideoFrameCallback) is copied
// into a GPU ring of textures. The plane is found in THAT frame (luma
// downsample + a 128×128 patch pair → readPixels → BlobDetector +
// phase correlation), and the record is keyed to the frame's media time. The
// canvas shows the frame `delay` behind the newest one, shifted onto the
// smooth path StabPlanner computes from ±delay of records — detection and
// display use the very same frame, so there's no alignment error (a 2-frame
// offset made the prototype worse than raw).
//
// The shader: deband flat sky, undo the lens vignette (the calibrated
// per-zoom flat-field; the radial profile learned live from sky frames when the
// zoom is unknown), shift (+ crop zoom), soft-fill any exposed edge from a
// blurred mip, re-apply `vignetteKeep` of the vignette, add a static dither.
// The deband/flat-field/dither part runs on every displayed frame, also while
// nothing is being stabilized (the rings show at every zoom). Horizon leveling
// (rotate + cover scale) is drawn by the shader too, not by CSS: the dither
// must sit on fixed SCREEN pixels, or the encoder sees it move whenever the
// roll changes and throws it away.

import { BlobDetector, PlaneFollower } from "./planeTrack.js";
import { PhaseCorrelator } from "./phaseCorr.js";
import { StabPlanner, type PlanOpts, type FrameRec } from "./stabPlan.js";
import { levelingTransform } from "@shared/index.js";
import { FF_DATA, FF_FADE_LO, FF_H, FF_LO, FF_STEP, FF_STOPS, FF_W } from "./flatfield.js";

/** Sky clean-up (tracker.liveStab.deband; research: claude.ai/artifact/5ZxgPf1ZuN5PfVtWucmTWu). */
export interface DebandOpts {
  enabled: boolean;
  thresholdLevels: number;
  radiusPx: number;
  ditherLevels: number;
  ditherCellPx: number;
  vignetteKeep: number;
}

export interface LiveStabOpts extends PlanOpts {
  /** Frame bottom must be above this elevation to fill (edge "auto"). */
  fillMinElDeg: number;
  deband: DebandOpts;
}

/** Flat-field lookup for a zoom: atlas rows a, b mixed by `mix`, faded by `amp` (null = none). */
export function flatFieldSel(zu: number | null | undefined): { a: number; b: number; mix: number; amp: number } | null {
  if (zu == null || !Number.isFinite(zu) || zu < FF_FADE_LO) return null;
  const st = FF_STOPS;
  if (zu <= st[0]) return { a: 0, b: 0, mix: 0, amp: (zu - FF_FADE_LO) / (st[0] - FF_FADE_LO) };
  if (zu >= st[st.length - 1]) return { a: st.length - 1, b: st.length - 1, mix: 0, amp: 1 };
  let i = 0;
  while (zu > st[i + 1]) i++;
  return { a: i, b: i + 1, mix: (zu - st[i]) / (st[i + 1] - st[i]), amp: 1 };
}

export interface StabContext {
  /** Tracker's (live, not delayed) vision detection. */
  det: { cx: number; cy: number; ageMs: number } | null;
  hfovDeg: number | null;
  /** Elevation of the frame's bottom edge, deg (null = unknown). */
  bottomElDeg: number | null;
  /** Lens zoom position, units (pose.zoomUnits; picks the flat-field). */
  zoomUnits?: number | null;
}

export interface StabFrameInfo {
  cx: number;
  cy: number;
  zoom: number;
  gain: number;
  /** Plane in the RAW displayed frame (fractions). */
  plane: { x: number; y: number; w: number; h: number } | null;
  /** Wall-clock age of the displayed frame since capture (estimate), ms. */
  lagMs: number;
}

interface Pending {
  seq: number;
  t: number;
  pbo: WebGLBuffer;
  fence: WebGLSync;
  org: [number, number] | null;
  ctx: StabContext;
  seg: number;
}

type RvfcMeta = { mediaTime: number; presentedFrames: number; width: number; height: number };
type RvfcVideo = HTMLVideoElement & {
  requestVideoFrameCallback(cb: (now: number, meta: RvfcMeta) => void): number;
  cancelVideoFrameCallback(id: number): void;
};

const LW = 480, LH = 270; // detection luma
const P = 128; // phase-correlation patch, px at 960×540
const PW = 960, PH = 540;
const FB_W = LW / 4 + 2 * (P / 4); // packed: 120 luma texels + two 32-texel patches
const FB_H = LH;
const VIG_BINS = 32;
const LOCK_HOLD_SEC = 3; // tracker detection counts as a lock this long
const EDGE_TEX_CROP = 3.0; // border residual (luma levels) above which edges are "structure"

const VS = `#version 300 es
in vec2 p; out vec2 uv;
void main(){ uv = p*.5+.5; uv.y = 1.-uv.y; gl_Position = vec4(p,0,1); }`;

// Packed luma: each RGBA texel holds 4 horizontally adjacent output pixels,
// each a 4-tap (bilinear) box average of the source.
const FS_LUMA = `#version 300 es
precision highp float; uniform sampler2D t; uniform vec2 org; uniform vec2 outSize; uniform vec2 srcOrg; uniform vec2 srcCell; uniform float taps; out vec4 o;
float L(vec2 q){ return dot(texture(t,q).rgb, vec3(.299,.587,.114)); }
void main(){
  vec2 f = floor(gl_FragCoord.xy - org);
  float iy = outSize.y - 1. - f.y;
  vec4 r;
  for (int k=0;k<4;k++){
    vec2 base = srcOrg + vec2(f.x*4.+float(k), iy) * srcCell;
    float v;
    if (taps > 1.5) v = .25*(L(base+srcCell*vec2(.25,.25))+L(base+srcCell*vec2(.75,.25))+L(base+srcCell*vec2(.25,.75))+L(base+srcCell*vec2(.75,.75)));
    else v = L(base + srcCell*.5);
    r[k] = v;
  }
  o = r;
}`;

const FF_N = FF_STOPS.length;
const FS_WARP = `#version 300 es
precision highp float; in vec2 uv; uniform sampler2D t; uniform sampler2D vig; uniform sampler2D nz; uniform sampler2D ffm;
uniform vec2 shift; uniform float zoom; uniform vec2 texel; uniform float lod;
uniform vec2 px; uniform float dbThr; uniform float dbRad; uniform float dbAmp; uniform float dbCell;
uniform vec2 ffRows; uniform float ffMix; uniform float ffAmp; uniform float ffOn; uniform float keep;
uniform float lvRot; uniform float lvScale;
out vec4 o;
float vn(vec2 p){ float r = clamp(length((p-.5)*vec2(16.,9.))/9.1788, 0., 1.); return max(.2, texture(vig, vec2(r*${(VIG_BINS - 1) / VIG_BINS}+${0.5 / VIG_BINS}, .5)).r); }
float ff(vec2 p){
  vec2 c = clamp(p, vec2(${0.5 / FF_W}, ${0.5 / FF_H}), vec2(${1 - 0.5 / FF_W}, ${1 - 0.5 / FF_H}));
  float a = texture(ffm, vec2(c.x, (ffRows.x + c.y) / ${FF_N}.)).r;
  float b = texture(ffm, vec2(c.x, (ffRows.y + c.y) / ${FF_N}.)).r;
  return 1. + (${FF_LO} + mix(a, b, ffMix) * ${255 * FF_STEP} - 1.) * ffAmp;
}
float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
// deband: 2 rounds of 4 taps on a randomly rotated cross (static per pixel);
// a round is taken only where every tap is within dbThr (flat sky), so the
// plane, wires and cloud edges are untouched
vec3 deband(vec2 q){
  vec3 c = textureLod(t, q, 0.).rgb;
  for (int i = 1; i <= 2; i++) {
    float a = 6.2831853 * h(gl_FragCoord.xy + float(i) * 17.);
    float r = dbRad * float(i) * .5 * (.5 + .5 * h(gl_FragCoord.yx + float(i) * 31.));
    vec2 d = vec2(cos(a), sin(a)) * r * px, e = vec2(-d.y * px.x / px.y, d.x * px.y / px.x);
    vec3 s1 = textureLod(t, q + d, 0.).rgb, s2 = textureLod(t, q - d, 0.).rgb, s3 = textureLod(t, q + e, 0.).rgb, s4 = textureLod(t, q - e, 0.).rgb;
    vec3 m = max(max(abs(s1 - c), abs(s2 - c)), max(abs(s3 - c), abs(s4 - c)));
    c = mix(c, (s1 + s2 + s3 + s4) * .25, step(max(m.r, max(m.g, m.b)), dbThr));
  }
  return c;
}
void main(){
  // screen -> picture through the leveling (CSS-equivalent rotate(lvRot) scale(lvScale))
  vec2 sp = (uv - .5) * vec2(16., 9.);
  float cr = cos(lvRot), sr = sin(lvRot);
  vec2 ul = vec2(cr * sp.x + sr * sp.y, -sr * sp.x + cr * sp.y) / lvScale / vec2(16., 9.) + .5;
  vec2 q = (ul-.5)/zoom + .5 - shift;
  vec2 qc = clamp(q, texel, 1.-texel);
  float d = length((q-qc)*vec2(16.,9.))/9.;
  vec3 c = dbThr > 0. ? deband(qc) : texture(t, qc).rgb;
  if (d > 0.) c = mix(c, textureLod(t, qc, lod).rgb, smoothstep(0., .04, d));
  if (ffOn > .5) c = c / ff(qc) * pow(ff(ul), keep);
  else c = c / vn(qc) * vn(ul);
  if (dbAmp > 0.) {
    // static triangular dither in dbCell px cells: the same pattern every
    // frame, so the stream encoder keeps it (per-frame grain gets discarded).
    // Grey (equal in R, G, B) = luma-only, like the archive: independent
    // per-channel noise would put a third of it into chroma.
    ivec2 k = ivec2(gl_FragCoord.xy / dbCell);
    float n = texelFetch(nz, k & 255, 0).r + texelFetch(nz, (k + ivec2(97, 61)) & 255, 0).r - 1.;
    c += n * dbAmp / 255.;
  }
  o = vec4(c, 1.);
}`;

/** Most the display may trail live beyond the look-ahead (MSE cushion etc.). */
const MAX_EXTRA_LAG_MS = 6000;

export class LiveStabilizer {
  onFrame: ((info: StabFrameInfo) => void) | null = null;
  onFail: ((why: string) => void) | null = null;
  readonly renderer: string;
  /** Rolling stats for the debug global / measurements. */
  stats = { frames: 0, shown: 0, detMs: [] as number[], submitMs: [] as number[], uploadMs: [] as number[], warpMs: [] as number[], found: 0, pcSteps: 0 };
  /** Recent per-frame rows for offline analysis (window.__liveStab.rows). */
  rows: number[][] = [];
  /** Recent per-frame detection records (replayable through StabPlanner). */
  recLog: FrameRec[] = [];

  private gl: WebGL2RenderingContext;
  private video: RvfcVideo;
  private canvas: HTMLCanvasElement;
  private opts: LiveStabOpts;
  private ctx: StabContext = { det: null, hfovDeg: null, bottomElDeg: null };
  private rvfc = 0;
  private alive = false;
  private failed = false;

  private progLuma!: WebGLProgram;
  private progWarp!: WebGLProgram;
  private vao!: WebGLVertexArrayObject;
  private fb!: WebGLFramebuffer;
  private fbTex!: WebGLTexture;
  private dispTex: WebGLTexture | null = null;
  private dispFb: WebGLFramebuffer | null = null;
  private readFb!: WebGLFramebuffer;
  private levelTarget: number | null = null;
  private levelRoll: number | null = null;
  private vigTex!: WebGLTexture;
  private noiseTex!: WebGLTexture;
  private ffTex!: WebGLTexture;
  private ring: WebGLTexture[] = [];
  private ringSeq: number[] = [];
  private vw = 0;
  private vh = 0;
  private delayFrames = 45;
  private mipLevels = 1;

  private px = new Uint8Array(FB_W * FB_H * 4);
  private luma = new Float32Array(LW * LH);
  private pa = new Float32Array(P * P);
  private pb = new Float32Array(P * P);
  private det = new BlobDetector(LW, LH);
  private pc = new PhaseCorrelator(P);
  private follow = new PlaneFollower();
  private planner = new StabPlanner(600);

  private seq = 0;
  private lastDone = -1;
  private procSeg = 0;
  private lastEdgeTex = NaN;
  private lockSeenT = -1e9;
  private pbos: WebGLBuffer[] = [];
  private pending: Pending[] = [];
  private seg = 0;
  private lastT = -1;
  private liveOff: number | null = null; // wall ms − media ms at the live edge (min)
  private vigSum = new Float64Array(VIG_BINS);
  private vigCnt = new Float64Array(VIG_BINS);
  private vigProf = new Float64Array(VIG_BINS);
  private vigFrames = 0;
  private vigHf: number | null = null;
  private vigUpload = new Float32Array(VIG_BINS);
  private rIdx = new Uint8Array(LW * LH); // radius bin per luma pixel

  constructor(video: HTMLVideoElement, canvas: HTMLCanvasElement, opts: LiveStabOpts) {
    this.video = video as RvfcVideo;
    this.canvas = canvas;
    this.opts = opts;
    const gl = canvas.getContext("webgl2", {
      alpha: false, antialias: false, depth: false, stencil: false,
      preserveDrawingBuffer: false, powerPreference: "high-performance",
    });
    if (!gl) throw new Error("WebGL2 unavailable");
    if (typeof (video as RvfcVideo).requestVideoFrameCallback !== "function") throw new Error("requestVideoFrameCallback unavailable");
    this.gl = gl;
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    this.renderer = String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    // The software rasterizer the stream used to run on lost its context
    // under this load — refuse it rather than flap.
    if (/swiftshader/i.test(this.renderer)) throw new Error(`software renderer (${this.renderer})`);
    canvas.addEventListener("webglcontextlost", this.onLost);
    this.initGl();
    for (let y = 0; y < LH; y++)
      for (let x = 0; x < LW; x++) {
        const r = Math.hypot(((x + 0.5) / LW - 0.5) * 16, ((y + 0.5) / LH - 0.5) * 9) / Math.hypot(8, 4.5);
        this.rIdx[y * LW + x] = Math.min(VIG_BINS - 1, Math.floor(r * VIG_BINS));
      }
    this.vigProf.fill(NaN);
  }

  private onLost = (e: Event) => {
    e.preventDefault();
    this.fail("WebGL context lost");
  };

  private fail(why: string): void {
    if (this.failed) return;
    this.failed = true;
    this.stop();
    console.warn(`[liveStab] off: ${why}`);
    this.onFail?.(why);
  }

  private compile(fs: string): WebGLProgram {
    const gl = this.gl;
    const mk = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, mk(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, "p");
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "link");
    return p;
  }

  private tex(w: number, h: number, levels = 1, fmt?: number): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, levels, fmt ?? gl.RGBA8, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, levels > 1 ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  private initGl(): void {
    const gl = this.gl;
    this.progLuma = this.compile(FS_LUMA);
    this.progWarp = this.compile(FS_WARP);
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.fbTex = this.tex(FB_W, FB_H);
    this.fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fbTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.readFb = gl.createFramebuffer()!;
    for (let i = 0; i < 4; i++) {
      const b = gl.createBuffer()!;
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, b);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, FB_W * FB_H * 4, gl.STREAM_READ);
      this.pbos.push(b);
    }
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    this.vigTex = this.tex(VIG_BINS, 1, 1, gl.R16F);
    this.uploadVig(1);
    // static dither source: 256² random bytes (fixed seed), fetched per 2×2 cell
    this.noiseTex = this.tex(256, 256);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    const nz = new Uint8Array(256 * 256 * 4);
    let seed = 12345;
    for (let i = 0; i < nz.length; i++) { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; nz[i] = seed >>> 24; }
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 256, gl.RGBA, gl.UNSIGNED_BYTE, nz);
    // per-zoom flat-field atlas (R8, maps stacked vertically)
    const bin = atob(FF_DATA);
    const ff = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) ff[i] = bin.charCodeAt(i);
    this.ffTex = this.tex(FF_W, FF_H * FF_N, 1, gl.R8);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, FF_W, FF_H * FF_N, gl.RED, gl.UNSIGNED_BYTE, ff);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  }

  /** (Re)allocate the frame ring for the video size and delay. */
  private alloc(w: number, h: number): void {
    const gl = this.gl;
    for (const t of this.ring) gl.deleteTexture(t);
    if (this.dispTex) gl.deleteTexture(this.dispTex);
    this.vw = w; this.vh = h;
    this.delayFrames = Math.max(1, Math.round((this.opts.delaySec * 1000) / (1000 / 30)));
    const n = this.delayFrames + 6; // + readback pipeline depth
    this.ring = [];
    this.ringSeq = [];
    for (let i = 0; i < n; i++) {
      // mutable (texImage2D) textures: Chrome's GPU-side video copy fast path
      // applies to texImage2D; texSubImage2D into immutable storage measured
      // ~25 ms/frame on ANGLE/Vulkan
      const tx = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tx);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.ring.push(tx);
      this.ringSeq.push(-1);
    }
    this.mipLevels = Math.floor(Math.log2(Math.max(w, h))) + 1;
    this.dispTex = this.tex(w, h, this.mipLevels);
    if (!this.dispFb) this.dispFb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.dispFb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.dispTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.canvas.width = w;
    this.canvas.height = h;
  }

  setOpts(o: LiveStabOpts): void {
    const realloc = Math.round(o.delaySec * 30) !== Math.round(this.opts.delaySec * 30);
    this.opts = o;
    if (realloc && this.vw) this.alloc(this.vw, this.vh);
  }

  setContext(c: StabContext): void { this.ctx = c; }

  /** Picture roll to cancel for the DISPLAYED frame, deg (null = none). Eased per frame. */
  setLevel(rollDeg: number | null): void { this.levelTarget = rollDeg; }

  start(): void {
    if (this.alive || this.failed) return;
    this.alive = true;
    this.rvfc = this.video.requestVideoFrameCallback(this.onVideoFrame);
  }

  stop(): void {
    this.alive = false;
    try { this.video.cancelVideoFrameCallback(this.rvfc); } catch { /* gone */ }
  }

  destroy(): void {
    this.stop();
    this.canvas.removeEventListener("webglcontextlost", this.onLost);
    const gl = this.gl;
    for (const t of this.ring) gl.deleteTexture(t);
    this.ring = [];
    if (this.dispTex) gl.deleteTexture(this.dispTex);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }

  private draw(prog: WebGLProgram, tex: WebGLTexture, u: Record<string, number[]>): void {
    const gl = this.gl;
    gl.useProgram(prog);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(gl.getUniformLocation(prog, "t"), 0);
    for (const [k, v] of Object.entries(u)) {
      const loc = gl.getUniformLocation(prog, k);
      if (!loc) continue;
      if (v.length === 1) gl.uniform1f(loc, v[0]);
      else if (v.length === 2) gl.uniform2f(loc, v[0], v[1]);
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  private uploadVig(conf: number): void {
    const gl = this.gl;
    const prof = this.vigProf;
    // reference level: mean of the learned inner bins (the very centre is
    // often masked — the plane sits there)
    let s = 0, n = 0;
    for (let b = 0; b < 10; b++) if (Number.isFinite(prof[b])) { s += prof[b]; n++; }
    const ref = n ? s / n : NaN;
    let last = NaN;
    const first = prof.findIndex((v) => Number.isFinite(v));
    for (let i = 0; i < VIG_BINS; i++) {
      // unknown bins borrow the nearest known one (inward first)
      const pv = Number.isFinite(prof[i]) ? prof[i] : Number.isFinite(last) ? last : first >= 0 ? prof[first] : NaN;
      if (Number.isFinite(prof[i])) last = prof[i];
      const v = Number.isFinite(pv) && ref > 0 ? pv / ref : 1;
      this.vigUpload[i] = 1 + (Math.min(1.3, Math.max(0.3, v)) - 1) * conf;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.vigTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, VIG_BINS, 1, gl.RED, gl.FLOAT, this.vigUpload);
  }

  private onVideoFrame = (_now: number, meta: RvfcMeta): void => {
    if (!this.alive) return;
    try {
      this.frame(meta);
    } catch (e) {
      this.fail(String((e as Error)?.message ?? e));
      return;
    }
    if (this.alive) this.rvfc = this.video.requestVideoFrameCallback(this.onVideoFrame);
  };

  private frame(meta: RvfcMeta): void {
    const gl = this.gl;
    if (gl.isContextLost()) throw new Error("WebGL context lost");
    const v = this.video;
    const w = v.videoWidth, h = v.videoHeight;
    if (!w || !h) return;
    if (w !== this.vw || h !== this.vh) {
      this.alloc(w, h);
      this.planner.reset();
      this.follow.reset();
      for (const pd of this.pending) gl.deleteSync(pd.fence);
      this.pending = [];
      this.lastDone = -1;
    }
    const t0 = performance.now();
    const t = meta.mediaTime;
    if (this.lastT >= 0 && (t < this.lastT - 0.005 || t - this.lastT > 1)) {
      this.seg++;
      this.follow.reset();
      // A new media timeline (the MSE relay restarted — e.g. a tracker
      // restart): the old wall−media offset no longer applies. Keeping it
      // (min() only creeps up 1.5 ms/s) made overlays replay state from
      // minutes ago — "SCANNING" while a plane was tracked (2026-10-13).
      this.liveOff = null;
    }
    if (Math.abs(t - this.lastT) < 1e-4) return; // same frame re-presented
    this.lastT = t;

    // live-edge offset (for syncing overlays): min over time of wall − media
    if (v.buffered.length) {
      const sample = performance.now() - v.buffered.end(v.buffered.length - 1) * 1000;
      this.liveOff = this.liveOff == null ? sample : Math.min(sample, this.liveOff + 0.05);
    }

    // 1. upload into the ring
    const seq = this.seq++;
    const slot = seq % this.ring.length;
    const prevSlot = (seq - 1 + this.ring.length) % this.ring.length;
    gl.bindTexture(gl.TEXTURE_2D, this.ring[slot]);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v);
    this.ringSeq[slot] = seq;
    this.stats.uploadMs.push(performance.now() - t0);
    if (this.stats.uploadMs.length > 900) this.stats.uploadMs.shift();

    // 2. detection buffers: luma (full frame) + patch pair around the track,
    // read back ASYNCHRONOUSLY (pixel-pack buffer + fence): a synchronous
    // readPixels stalls on the whole GPU queue (~30 ms on ANGLE/Vulkan). The
    // display runs `delay` behind anyway, so a frame or two of detection
    // latency costs nothing.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb);
    gl.viewport(0, 0, LW / 4, LH);
    this.draw(this.progLuma, this.ring[slot], {
      org: [0, 0], outSize: [LW, LH], srcOrg: [0, 0], srcCell: [1 / LW, 1 / LH], taps: [2],
    });
    const prevOk = this.ringSeq[prevSlot] === seq - 1 && this.follow.x != null && this.follow.y != null;
    let org: [number, number] | null = null;
    if (prevOk) {
      org = [
        Math.min(PW - P, Math.max(0, Math.round(this.follow.x! * PW - P / 2))),
        Math.min(PH - P, Math.max(0, Math.round(this.follow.y! * PH - P / 2))),
      ];
      const u = (ox: number) => ({ org: [ox, 0], outSize: [P, P], srcOrg: [org![0] / PW, org![1] / PH], srcCell: [1 / PW, 1 / PH], taps: [1] });
      gl.viewport(LW / 4, 0, P / 4, P);
      this.draw(this.progLuma, this.ring[prevSlot], u(LW / 4));
      gl.viewport(LW / 4 + P / 4, 0, P / 4, P);
      this.draw(this.progLuma, this.ring[slot], u(LW / 4 + P / 4));
    }
    const pbo = this.pbos[seq % this.pbos.length];
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
    gl.readPixels(0, 0, FB_W, FB_H, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)!;
    gl.flush();
    this.pending.push({ seq, t, pbo, fence, org, ctx: this.ctx, seg: this.seg });
    const tSubmit = performance.now() - t0;

    // 3. harvest finished readbacks in order (wait only if too far behind)
    while (this.pending.length) {
      const pd = this.pending[0];
      const st = gl.clientWaitSync(pd.fence, 0, 0);
      if (st === gl.TIMEOUT_EXPIRED && this.pending.length < this.pbos.length - 1) break;
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pd.pbo);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.px);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      gl.deleteSync(pd.fence);
      this.pending.shift();
      this.process(pd);
    }
    const tDet = performance.now() - t0;
    this.stats.submitMs.push(tSubmit);
    if (this.stats.submitMs.length > 900) this.stats.submitMs.shift();

    // 4. display the frame `delay` behind
    if (this.lastDone < 0) { this.stat(tDet, null); return; }
    const ds = this.lastDone - this.delayFrames;
    const dslot = ((ds % this.ring.length) + this.ring.length) % this.ring.length;
    if (ds < 0 || this.ringSeq[dslot] !== ds) { this.stat(tDet, null); return; }
    const t1 = performance.now();
    const plan = this.planner.plan(ds, this.opts);
    // copy to the mipmapped display texture (blurred mips feed the edge fill)
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.readFb);
    gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.ring[dslot], 0);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.dispFb);
    gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    const edge = Math.abs(plan.cx) > 1e-4 || Math.abs(plan.cy) > 1e-4;
    gl.bindTexture(gl.TEXTURE_2D, this.dispTex);
    if (edge) gl.generateMipmap(gl.TEXTURE_2D);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.progWarp);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.vigTex);
    gl.uniform1i(gl.getUniformLocation(this.progWarp, "vig"), 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.noiseTex);
    gl.uniform1i(gl.getUniformLocation(this.progWarp, "nz"), 2);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.ffTex);
    gl.uniform1i(gl.getUniformLocation(this.progWarp, "ffm"), 3);
    const drec = this.planner.at(this.planner.indexOf(ds));
    const db = this.opts.deband;
    const on = db?.enabled === true;
    const sel = on ? flatFieldSel(drec?.zu) : null;
    // leveling: ease toward the pose's roll (pose updates arrive at a few Hz;
    // a step-wise rotation would read as a twitch)
    const lt = this.levelTarget;
    this.levelRoll = lt == null ? null : this.levelRoll == null ? lt : this.levelRoll + (lt - this.levelRoll) * 0.28;
    const lv = this.levelRoll == null ? { rotateDeg: 0, scale: 1 } : levelingTransform(this.levelRoll);
    this.draw(this.progWarp, this.dispTex!, {
      shift: [plan.cx, plan.cy], zoom: [plan.zoom], texel: [0.5 / w, 0.5 / h], lod: [Math.max(0, this.mipLevels - 6)],
      px: [1 / w, 1 / h],
      dbThr: [on ? Math.max(0, db.thresholdLevels) / 255 : 0],
      dbRad: [on ? db.radiusPx * (w / 1920) : 0],
      dbAmp: [on ? Math.max(0, db.ditherLevels) : 0],
      dbCell: [on ? Math.max(1, db.ditherCellPx) : 1],
      ffRows: [sel?.a ?? 0, sel?.b ?? 0], ffMix: [sel?.mix ?? 0], ffAmp: [sel?.amp ?? 0],
      ffOn: [sel ? 1 : 0], keep: [on ? Math.min(1, Math.max(0, db.vignetteKeep)) : 1],
      lvRot: [(lv.rotateDeg * Math.PI) / 180], lvScale: [lv.scale],
    });
    const rawLag = drec && this.liveOff != null ? performance.now() - (drec.t * 1000 + this.liveOff) : this.opts.delaySec * 1000;
    // Safety net: the display can't plausibly trail live by more than the
    // look-ahead plus a generous MSE cushion.
    const lagMs = Math.max(0, Math.min(rawLag, this.opts.delaySec * 1000 + MAX_EXTRA_LAG_MS));
    const info: StabFrameInfo = { cx: plan.cx, cy: plan.cy, zoom: plan.zoom, gain: plan.gain, plane: plan.plane, lagMs };
    this.stat(tDet, performance.now() - t1);
    this.rows.push([ds, drec?.t ?? 0, plan.plane?.x ?? NaN, plan.plane?.y ?? NaN, plan.cx, plan.cy, plan.zoom, plan.gain, lagMs, drec?.wantCrop ? 1 : 0, this.lastEdgeTex]);
    if (this.rows.length > 3000) this.rows.splice(0, 1000);
    this.onFrame?.(info);
  }

  /** CPU side of detection for one read-back frame (in frame order). */
  private process(pd: Pending): void {
    const px = this.px;
    for (let ry = 0; ry < LH; ry++) {
      const iy = LH - 1 - ry;
      for (let cx = 0; cx < LW / 4; cx++) {
        const s = (ry * FB_W + cx) * 4;
        const d = iy * LW + cx * 4;
        this.luma[d] = px[s]; this.luma[d + 1] = px[s + 1]; this.luma[d + 2] = px[s + 2]; this.luma[d + 3] = px[s + 3];
      }
    }
    const ctx = pd.ctx;
    const hf = ctx.hfovDeg;
    if (pd.seg !== this.procSeg) { this.procSeg = pd.seg; this.follow.reset(); }
    // the patch pair was cut where the track was when the frame was queued;
    // it's only valid if the follower still continues from the frame before
    const org = pd.org && this.lastDone === pd.seq - 1 && this.follow.x != null ? pd.org : null;

    // find the plane in this frame
    const det = ctx.det && ctx.det.ageMs < 1500 ? ctx.det : null;
    // "locked": the tracker has seen the plane recently. Its 10 Hz vision
    // drops out for a second at a time at tele while the plane is plainly
    // there — a per-frame requirement made the stabilizer flicker on/off.
    if (det) this.lockSeenT = pd.t;
    const locked = pd.t - this.lockSeenT < LOCK_HOLD_SEC && pd.t >= this.lockSeenT;
    let seed: { x: number; y: number } | null = null;
    let radius = 0.15;
    if (this.follow.x != null && this.follow.y != null) {
      seed = { x: this.follow.x, y: this.follow.y };
      radius = 0.1;
      // our track wandered off the tracker's plane (bird, cloud edge): reseed
      if (det && Math.hypot(det.cx - seed.x, ((det.cy - seed.y) * 9) / 16) > 0.25) { seed = { x: det.cx, y: det.cy }; radius = 0.15; this.follow.reset(); }
    } else if (det) seed = { x: det.cx, y: det.cy };
    const r = seed ? this.det.detect(this.luma, seed, radius) : null;
    let step: { dx: number; dy: number } | null = null;
    if (r?.blob && org && this.follow.x != null) {
      for (let y = 0; y < P; y++) {
        const ry = P - 1 - y;
        for (let k = 0; k < P / 4; k++) {
          const sa = (ry * FB_W + LW / 4 + k) * 4;
          const sb = (ry * FB_W + LW / 4 + P / 4 + k) * 4;
          for (let c = 0; c < 4; c++) { this.pa[y * P + k * 4 + c] = px[sa + c]; this.pb[y * P + k * 4 + c] = px[sb + c]; }
        }
      }
      const c = this.pc.correlate(this.pa, this.pb);
      if (c.response > 0.1 && Math.abs(c.dx) < P / 4 && Math.abs(c.dy) < P / 4) step = { dx: c.dx / PW, dy: c.dy / PH };
    }
    const pos = this.follow.update(r?.blob ? { x: r.blob.x, y: r.blob.y } : null, step);
    if (pos) this.stats.found++;
    if (step) this.stats.pcSteps++;

    // edge handling wanted for this frame
    const o = this.opts;
    let wantCrop = o.edge === "crop";
    if (o.edge === "auto") {
      if (ctx.bottomElDeg != null && ctx.bottomElDeg < o.fillMinElDeg) wantCrop = true;
      if (r && r.edgeTex > EDGE_TEX_CROP) wantCrop = true;
    }
    this.lastEdgeTex = r?.edgeTex ?? NaN;
    // learn the lens vignette from open-sky frames (radial profile, plane masked)
    if (r && !wantCrop) this.learnVignette(pos ?? seed, r.blob, hf);

    const rec = {
      seq: pd.seq, t: pd.t, x: pos?.x ?? null, y: pos?.y ?? null,
      bw: r?.blob?.w ?? 0, bh: r?.blob?.h ?? 0,
      hf, zu: ctx.zoomUnits ?? null, locked: locked && pos != null, wantCrop, seg: pd.seg,
    };
    this.planner.push(rec);
    this.recLog.push(rec);
    if (this.recLog.length > 3000) this.recLog.splice(0, 1000);
    this.lastDone = pd.seq;
  }

  private learnVignette(c: { x: number; y: number } | null, blob: { w: number; h: number } | null, hf: number | null): void {
    if (hf != null && (this.vigHf == null || Math.abs(hf - this.vigHf) > 0.05 * this.vigHf)) {
      this.vigHf = hf;
      this.vigFrames = 0;
      this.vigProf.fill(NaN);
    }
    const sum = this.vigSum, cnt = this.vigCnt;
    sum.fill(0); cnt.fill(0);
    const mx = c ? Math.max(0.08, (blob?.w ?? 0) * 0.75 + 0.04) * LW : -1;
    const my = c ? Math.max(0.08 * 16 / 9, (blob?.h ?? 0) * 0.75 + 0.04 * 16 / 9) * LH : -1;
    const cx = c ? c.x * LW : -1e9, cy = c ? c.y * LH : -1e9;
    for (let y = 0; y < LH; y += 2)
      for (let x = 0; x < LW; x += 2) {
        if (Math.abs(x - cx) < mx && Math.abs(y - cy) < my) continue;
        const i = y * LW + x;
        sum[this.rIdx[i]] += this.luma[i];
        cnt[this.rIdx[i]]++;
      }
    for (let b = 0; b < VIG_BINS; b++) {
      if (cnt[b] < 4) continue;
      const m = sum[b] / cnt[b];
      this.vigProf[b] = Number.isFinite(this.vigProf[b]) ? this.vigProf[b] + (m - this.vigProf[b]) / 60 : m;
    }
    this.vigFrames++;
    if (this.vigFrames % 5 === 0) this.uploadVig(Math.min(1, this.vigFrames / 45));
  }

  private stat(det: number, warp: number | null): void {
    const s = this.stats;
    s.frames++;
    s.detMs.push(det);
    if (s.detMs.length > 900) s.detMs.shift();
    if (warp != null) {
      s.shown++;
      s.warpMs.push(warp);
      if (s.warpMs.length > 900) s.warpMs.shift();
    }
  }
}
