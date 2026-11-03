import { backgroundCanvas } from './backgrounds.js';

export const OUTPUT_SIZES = {
  '16:9': [1920, 1080],
  '9:16': [1080, 1920],
  '1:1': [1080, 1080],
  '4:5': [1080, 1350],
};

// Where the recording sits inside the output frame.
// fit:  the whole screen is visible (same-ish aspect, or a tall source in a wide frame)
// crop: a wide screen in a tall frame -> show a slice of it and let the camera follow the action
export function layout(outW, outH, srcW, srcH, padPct) {
  const pad = (padPct / 100) * Math.min(outW, outH);
  const aw = outW - 2 * pad, ah = outH - 2 * pad;
  const srcA = srcW / srcH, areaA = aw / ah;
  // a crop taller than 4:5 is mostly empty page, so cap it and let the background fill the rest
  const cropA = Math.max(areaA, 0.8);
  if (srcA > cropA * 1.15) {
    const h = Math.min(ah, aw / cropA);
    return { mode: 'crop', box: { x: pad, y: (outH - h) / 2, w: aw, h }, baseW: srcH * cropA, baseH: srcH };
  }
  let w = aw, h = aw / srcA;
  if (h > ah) { h = ah; w = ah * srcA; }
  return { mode: 'fit', box: { x: (outW - w) / 2, y: (outH - h) / 2, w, h }, baseW: srcW, baseH: srcH };
}

// The part of the source the camera sees, in source pixels.
export function viewport(L, srcW, srcH, cam) {
  // in a crop the slice is already close-up, so zoom in less
  const z = L.mode === 'crop' ? 1 + (cam.z - 1) * 0.55 : cam.z;
  const vw = L.baseW / z, vh = L.baseH / z;
  const cx = clamp(cam.x * srcW, vw / 2, srcW - vw / 2);
  const cy = clamp(cam.y * srcH, vh / 2, srcH - vh / 2);
  return { vx: cx - vw / 2, vy: cy - vh / 2, vw, vh };
}

export function drawFrame(ctx, src, srcW, srcH, cam, s) {
  const W = ctx.canvas.width, H = ctx.canvas.height;
  const L = layout(W, H, srcW, srcH, s.padding);
  ctx.drawImage(backgroundCanvas(s.background, W, H), 0, 0);
  const { x, y, w, h } = L.box;
  const unit = Math.min(W, H) / 1080;
  const r = Math.min(s.radius * unit, w / 2, h / 2);
  const framed = s.padding > 0;

  if (framed) {
    ctx.save();
    ctx.shadowColor = 'rgba(10, 8, 30, 0.38)';
    ctx.shadowBlur = 60 * unit;
    ctx.shadowOffsetY = 18 * unit;
    ctx.fillStyle = '#000';
    roundRect(ctx, x, y, w, h, r);
    ctx.fill();
    ctx.restore();
  }

  const v = viewport(L, srcW, srcH, cam);
  ctx.save();
  if (framed) { roundRect(ctx, x, y, w, h, r); ctx.clip(); }
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, v.vx, v.vy, v.vw, v.vh, x, y, w, h);
  ctx.restore();
  return { L, v };
}

// stage pixel -> normalized source point (used when the user clicks to aim a zoom)
export function stageToSource(px, py, last, srcW, srcH) {
  const { L, v } = last;
  const u = (px - L.box.x) / L.box.w, w = (py - L.box.y) / L.box.h;
  return {
    x: clamp((v.vx + u * v.vw) / srcW, 0, 1),
    y: clamp((v.vy + w * v.vh) / srcH, 0, 1),
  };
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const clamp = (v, a, b) => (a > b ? (a + b) / 2 : Math.max(a, Math.min(b, v)));
