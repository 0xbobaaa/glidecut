// Wallpapers drawn on a canvas so preview and export look identical.
export const BACKGROUNDS = [
  { id: 'violet',   stops: ['#6d4aff', '#c06cff', '#ff8ad8'] },
  { id: 'ocean',    stops: ['#0ea5e9', '#4f46e5', '#7c3aed'] },
  { id: 'sunset',   stops: ['#ff9a3c', '#ff5f6d', '#c2185b'] },
  { id: 'mint',     stops: ['#5eead4', '#22c55e', '#0f766e'] },
  { id: 'peach',    stops: ['#ffe1c6', '#ffc2c2', '#f7a8d8'] },
  { id: 'sand',     stops: ['#f4ead7', '#e8d3b0', '#d9b98c'] },
  { id: 'sky',      stops: ['#e0f2fe', '#bae6fd', '#c7d2fe'] },
  { id: 'graphite', stops: ['#3a3a44', '#1d1d23', '#0d0d10'] },
  { id: 'night',    stops: ['#2a1f6e', '#14123a', '#07061a'] },
  { id: 'paper',    stops: ['#f6f5f2', '#f6f5f2', '#ece9e2'] },
];

export function swatchCss(bg) {
  return `linear-gradient(135deg, ${bg.stops.join(', ')})`;
}

const cache = new Map();

export function backgroundCanvas(id, w, h) {
  const key = `${id}:${w}x${h}`;
  if (cache.has(key)) return cache.get(key);
  const bg = BACKGROUNDS.find(b => b.id === id) || BACKGROUNDS[0];
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, w, h);
  bg.stops.forEach((s, i) => g.addColorStop(i / (bg.stops.length - 1), s));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  // two soft light blobs so the gradient doesn't look flat
  const m = Math.max(w, h);
  for (const [px, py, r, a] of [[0.18, 0.2, 0.55, 0.22], [0.85, 0.85, 0.6, 0.16]]) {
    const rg = ctx.createRadialGradient(px * w, py * h, 0, px * w, py * h, r * m);
    rg.addColorStop(0, `rgba(255,255,255,${a})`);
    rg.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = rg;
    ctx.fillRect(0, 0, w, h);
  }
  if (cache.size > 12) cache.clear();
  cache.set(key, c);
  return c;
}
