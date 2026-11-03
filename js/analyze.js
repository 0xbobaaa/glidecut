// Finds where the action is without knowing where the mouse was.
// A browser tab can't log clicks in other windows, so we read the pixels instead:
// decode the recording at 12 fps, 320 px wide, diff each frame against the previous one.
// Small changing blobs = cursor, clicks, typing -> zoom in there.
// Huge changes = scroll, new page, window switch -> zoom back out.
import { CanvasSink } from '../vendor/mediabunny.min.mjs';

const STEP = 1 / 12;
const AW = 320;
const PIX_THRESHOLD = 20;

export async function analyze(track, duration, firstTs, onProgress, shouldStop = () => false) {
  const AH = Math.max(2, Math.round(AW * track.displayHeight / track.displayWidth));
  const sink = new CanvasSink(track, { width: AW, height: AH, fit: 'fill', poolSize: 2 });
  const work = document.createElement('canvas');
  work.width = AW; work.height = AH;
  const wctx = work.getContext('2d', { willReadFrequently: true });

  const times = [];
  for (let t = firstTs; t < firstTs + duration; t += STEP) times.push(t);

  const samples = [];
  let prev = null;
  let i = 0;
  for await (const wc of sink.canvasesAtTimestamps(times)) {
    const t = times[i++] - firstTs;
    if (shouldStop()) return null;
    if (!wc) continue;
    wctx.drawImage(wc.canvas, 0, 0, AW, AH);
    const px = wctx.getImageData(0, 0, AW, AH).data;
    const gray = new Uint8Array(AW * AH);
    for (let p = 0, q = 0; q < gray.length; p += 4, q++) {
      gray[q] = (px[p] * 77 + px[p + 1] * 150 + px[p + 2] * 29) >> 8;
    }
    if (prev) samples.push(diffSample(prev, gray, AW, AH, t));
    prev = gray;
    if (onProgress && i % 6 === 0) onProgress(i / times.length);
  }
  const aspect = AH / AW;
  return { samples, segments: buildSegments(samples, duration, aspect) };
}

function diffSample(a, b, w, h, t) {
  const mask = new Uint8Array(w * h);
  let n = 0;
  for (let i = 0; i < mask.length; i++) {
    const d = a[i] - b[i];
    if (d > PIX_THRESHOLD || d < -PIX_THRESHOLD) { mask[i] = 1; n++; }
  }
  const frac = n / (w * h);
  if (n < 2) return { t, kind: 'idle', a: frac };

  // connected blobs (8-neighbour). A mouse move = 1-3 cursor-sized blobs and nothing else.
  let sx = 0, sy = 0, x0 = w, y0 = h, x1 = -1, y1 = -1, blobs = 0, cursorish = true;
  const curW = Math.ceil(w * 0.03), curH = Math.ceil(h * 0.06);
  const stack = [];
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] !== 1) continue;
    mask[i] = 2; stack.push(i);
    let bx0 = w, by0 = h, bx1 = -1, by1 = -1;
    while (stack.length) {
      const j = stack.pop(), x = j % w, y = (j - x) / w;
      sx += x; sy += y;
      if (x < bx0) bx0 = x; if (x > bx1) bx1 = x;
      if (y < by0) by0 = y; if (y > by1) by1 = y;
      for (let yy = Math.max(0, y - 1); yy <= Math.min(h - 1, y + 1); yy++) {
        for (let xx = Math.max(0, x - 1); xx <= Math.min(w - 1, x + 1); xx++) {
          const k = yy * w + xx;
          if (mask[k] === 1) { mask[k] = 2; stack.push(k); }
        }
      }
    }
    blobs++;
    if (bx1 - bx0 + 1 > curW || by1 - by0 + 1 > curH) cursorish = false;
    if (bx0 < x0) x0 = bx0; if (bx1 > x1) x1 = bx1;
    if (by0 < y0) y0 = by0; if (by1 > y1) y1 = by1;
  }
  if (blobs > 3) cursorish = false;
  const bw = (x1 - x0 + 1) / w, bh = (y1 - y0 + 1) / h;
  const big = frac > 0.12 || (bw * bh > 0.45 && frac > 0.02);
  return {
    t, a: frac,
    kind: big ? 'big' : 'local',
    x: (sx / n + 0.5) / w,
    y: (sy / n + 0.5) / h,
    bw, bh, n, blobs, cursorish,
  };
}

const GAP = 1.2;        // seconds of calm that end a zoom
const NEAR = 0.18;      // how far (in screen widths) action can drift and stay in one zoom
const LEAD_IN = 0.45;   // start zooming a bit before the action
const HOLD = 0.9;       // stay zoomed a bit after it

export function buildSegments(samples, duration, aspect) {
  const raw = [];
  let cur = null;
  const close = () => {
    if (cur && cur.pts.length >= 4) {
      const xs = cur.pts.map(p => p.x).sort((m, n) => m - n);
      const ys = cur.pts.map(p => p.y).sort((m, n) => m - n);
      raw.push({
        start: cur.first - LEAD_IN,
        end: cur.last + HOLD,
        x: xs[xs.length >> 1],
        y: ys[ys.length >> 1],
      });
    }
    cur = null;
  };
  // recent cursor-sized changes, to tell "mouse travelling" from "something happening in one spot"
  let recent = [];
  for (const s of samples) {
    if (s.kind === 'big') { close(); recent = []; continue; }
    if (s.kind === 'idle') { if (cur && s.t - cur.last > GAP) close(); continue; }
    if (s.cursorish) {
      recent = recent.filter(r => s.t - r.t <= 0.5);
      const last = recent[recent.length - 1], oldest = recent[0];
      recent.push(s);
      const step = last && s.t - last.t < 0.2 ? dist(s, last, aspect) : 0;
      const sweep = oldest && s.t - oldest.t >= 0.25 ? dist(s, oldest, aspect) : 0;
      if (step > 0.02 || sweep > 0.06) {
        // it was travel all along: take the points we already counted back out
        if (cur) {
          cur.pts = cur.pts.filter(p => !recent.includes(p));
          if (!cur.pts.length) cur = null;
          else {
            cur.last = cur.pts[cur.pts.length - 1].t;
            cur.cx = cur.pts.reduce((m, p) => m + p.x, 0) / cur.pts.length;
            cur.cy = cur.pts.reduce((m, p) => m + p.y, 0) / cur.pts.length;
          }
        }
        if (cur && s.t - cur.last > GAP) close();
        continue;
      }
    } else recent = [];
    if (cur) {
      const dx = s.x - cur.cx, dy = (s.y - cur.cy) * aspect;
      if (Math.hypot(dx, dy) < NEAR && s.t - cur.last < GAP) {
        cur.pts.push(s); cur.last = s.t;
        const k = 1 / cur.pts.length;
        cur.cx += (s.x - cur.cx) * k; cur.cy += (s.y - cur.cy) * k;
        continue;
      }
      close();
    }
    cur = { first: s.t, last: s.t, cx: s.x, cy: s.y, pts: [s] };
  }
  close();
  return tidySegments(raw, duration);
}

const dist = (a, b, aspect) => Math.hypot(a.x - b.x, (a.y - b.y) * aspect);

export function tidySegments(list, duration) {
  const segs = list
    .map(s => ({ ...s, start: Math.max(0, s.start), end: Math.min(duration, s.end) }))
    .filter(s => s.end - s.start > 0.3)
    .sort((a, b) => a.start - b.start);
  const out = [];
  for (const s of segs) {
    const p = out[out.length - 1];
    if (p && s.start < p.end + 0.7) {
      const close = Math.hypot(s.x - p.x, s.y - p.y) < 0.1;
      if (close) { p.end = Math.max(p.end, s.end); continue; }
      // different spot right after: pan across instead of zooming out and back in
      const mid = Math.max(p.start + 0.5, Math.min(p.end, s.start));
      p.end = mid; s.start = mid;
    }
    out.push(s);
  }
  // a zoom that lasts under 1.6 s right next to another one feels like the camera twitching: fold it in
  for (let i = 0; i < out.length; i++) {
    const s = out[i], len = s.end - s.start;
    if (len >= 1.6) continue;
    const p = out[i - 1], n = out[i + 1];
    if (p && Math.abs(p.end - s.start) < 0.05) { p.end = s.end; out.splice(i--, 1); }
    else if (n && Math.abs(n.start - s.end) < 0.05) { n.start = s.start; out.splice(i--, 1); }
  }
  out.forEach((s, i) => {
    const limit = out[i + 1] ? out[i + 1].start : duration;
    if (s.end - s.start < 1.2) s.end = Math.min(limit, s.start + 1.2);
  });
  return out.map((s, i) => ({ ...s, id: i + 1 }));
}
