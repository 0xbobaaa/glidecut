// Timeline: activity graph, zoom blocks you can drag/resize/delete, playhead.
const EDGE = 8;

export class Timeline {
  constructor(canvas, { onSeek, onChange, onSelect }) {
    this.c = canvas;
    this.ctx = canvas.getContext('2d');
    this.onSeek = onSeek; this.onChange = onChange; this.onSelect = onSelect;
    this.duration = 1; this.segments = []; this.samples = []; this.time = 0;
    this.selected = null; this.drag = null;
    canvas.addEventListener('pointerdown', e => this.down(e));
    canvas.addEventListener('pointermove', e => this.move(e));
    canvas.addEventListener('pointerup', e => this.up(e));
    canvas.addEventListener('pointercancel', e => this.up(e));
    canvas.addEventListener('lostpointercapture', e => this.up(e));
    canvas.addEventListener('dblclick', e => this.dbl(e));
    new ResizeObserver(() => this.resize()).observe(canvas);
  }
  set(duration, segments, samples) {
    this.duration = Math.max(0.1, duration); this.segments = segments; this.samples = samples || this.samples;
    this.draw();
  }
  resize() {
    const r = this.c.getBoundingClientRect(), d = devicePixelRatio || 1;
    this.c.width = Math.round(r.width * d); this.c.height = Math.round(r.height * d);
    this.scale = d; this.draw();
  }
  tx(t) { return (t / this.duration) * this.c.width; }
  xt(x) { return Math.max(0, Math.min(this.duration, (x / this.c.width) * this.duration)); }
  px(e) { const r = this.c.getBoundingClientRect(); return (e.clientX - r.left) * this.scale; }

  hit(x) {
    // edges first, nearest wins: where two zooms touch, both edges stay grabbable
    const e = EDGE * this.scale;
    let best = null;
    for (const s of this.segments) {
      for (const part of ['start', 'end']) {
        const d = Math.abs(x - this.tx(s[part]));
        if (d < e && (!best || d < best.d)) best = { s, part, d };
      }
    }
    if (best) {
      // touching pair: left of the seam grabs the end of the left zoom, right of it the start of the next
      const twin = this.segments.find(o => o !== best.s && Math.abs(this.tx(best.part === 'end' ? o.start : o.end) - this.tx(best.s[best.part])) < 1);
      if (twin) {
        const seam = this.tx(best.s[best.part]);
        const left = best.part === 'end' ? best.s : twin, right = best.part === 'end' ? twin : best.s;
        return x < seam ? { s: left, part: 'end' } : { s: right, part: 'start' };
      }
      return { s: best.s, part: best.part };
    }
    for (const s of this.segments) if (x > this.tx(s.start) && x < this.tx(s.end)) return { s, part: 'body' };
    return null;
  }
  down(e) {
    const x = this.px(e), h = this.hit(x);
    this.c.setPointerCapture(e.pointerId);
    if (h) {
      this.selected = h.s; this.onSelect(h.s);
      this.drag = { ...h, x0: x, start: h.s.start, end: h.s.end, moved: false };
    } else {
      this.selected = null; this.onSelect(null);
      this.drag = { part: 'seek' }; this.onSeek(this.xt(x));
    }
    this.draw();
  }
  move(e) {
    const x = this.px(e);
    if (!this.drag) {
      const h = this.hit(x);
      this.c.style.cursor = h ? (h.part === 'body' ? 'grab' : 'ew-resize') : 'pointer';
      return;
    }
    if (this.drag.part === 'seek') { this.onSeek(this.xt(x)); return; }
    const { s, part } = this.drag, dt = this.xt(x) - this.xt(this.drag.x0);
    const others = this.segments.filter(o => o !== s);
    const lo = Math.max(0, ...others.filter(o => o.end <= this.drag.start + 1e-6).map(o => o.end));
    const hi = Math.min(this.duration, ...others.filter(o => o.start >= this.drag.end - 1e-6).map(o => o.start));
    if (part === 'body') {
      const len = this.drag.end - this.drag.start;
      s.start = Math.max(lo, Math.min(hi - len, this.drag.start + dt)); s.end = s.start + len;
    } else if (part === 'start') {
      s.start = Math.max(lo, Math.min(s.end - 0.5, this.drag.start + dt));
    } else {
      s.end = Math.min(hi, Math.max(s.start + 0.5, this.drag.end + dt));
    }
    this.drag.moved = true;
    this.draw();
  }
  up() {
    if (this.drag && this.drag.moved) this.onChange();
    this.drag = null;
  }
  dbl(e) {
    const t = this.xt(this.px(e));
    if (this.hit(this.px(e))) return;
    const next = this.segments.filter(s => s.start > t).sort((a, b) => a.start - b.start)[0];
    const end = Math.min(t + 2, next ? next.start : this.duration);
    if (end - t < 0.5) return;
    const s = { id: Date.now(), start: t, end, x: 0.5, y: 0.5 };
    this.segments.push(s);
    this.selected = s; this.onSelect(s); this.onChange(); this.draw();
  }
  removeSelected() {
    if (!this.selected) return false;
    this.segments.splice(this.segments.indexOf(this.selected), 1);
    this.selected = null; this.onSelect(null); this.onChange(); this.draw();
    return true;
  }
  setTime(t) { this.time = t; this.draw(); }

  draw() {
    const { ctx, c } = this, W = c.width, H = c.height, d = this.scale || 1;
    ctx.clearRect(0, 0, W, H);
    // activity graph
    if (this.samples.length) {
      ctx.fillStyle = '#e8e5de';
      for (const s of this.samples) {
        const h = (s.a > 0 ? Math.max(0, Math.min(1, Math.log10(s.a * 1e5) / 4.5)) : 0) * (H - 10 * d);
        ctx.fillRect(this.tx(s.t), H - 5 * d - h, Math.max(1, W / this.samples.length), h);
      }
    }
    // zoom blocks
    ctx.font = `${600} ${11 * d}px ui-sans-serif, system-ui, sans-serif`;
    for (const s of this.segments) {
      const a = this.tx(s.start), b = this.tx(s.end), sel = s === this.selected;
      ctx.fillStyle = sel ? '#6d4aff' : 'rgba(109,74,255,.78)';
      rr(ctx, a + d, 12 * d, b - a - 2 * d, H - 24 * d, 7 * d); ctx.fill();
      if (sel) { ctx.strokeStyle = '#16151a'; ctx.lineWidth = 2 * d; ctx.stroke(); }
      if (b - a > 34 * d) { ctx.fillStyle = '#fff'; ctx.fillText('zoom', a + 9 * d, H / 2 + 4 * d); }
    }
    // playhead
    const p = this.tx(this.time);
    ctx.fillStyle = '#16151a';
    ctx.fillRect(p - d, 0, 2 * d, H);
  }
}

function rr(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath(); ctx.roundRect(x, y, Math.max(0, w), h, r);
}
