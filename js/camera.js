// The virtual camera. Zoom segments say where to look; a critically damped spring
// turns that into smooth motion. Simulated once at 120 Hz, so preview and export match.
const HZ = 120;
const W_ZOOM = 5.5;  // spring stiffness for zoom (settles in ~0.8 s)
const W_PAN = 4.5;   // a bit softer for panning

export function buildCamera(segments, duration, zoomLevel) {
  const n = Math.ceil(duration * HZ) + 2;
  const z = new Float32Array(n), x = new Float32Array(n), y = new Float32Array(n);
  const segs = [...segments].sort((a, b) => a.start - b.start);
  let cz = 1, cx = 0.5, cy = 0.5, vz = 0, vx = 0, vy = 0;
  let tx = 0.5, ty = 0.5;
  // start already looking at the first spot, so a vertical crop doesn't open on a random slice
  if (segs[0]) { cx = tx = segs[0].x; cy = ty = segs[0].y; }
  let k = 0;
  const dt = 1 / HZ;
  for (let i = 0; i < n; i++) {
    const t = i * dt;
    while (k < segs.length && segs[k].end <= t) k++;
    const s = segs[k] && segs[k].start <= t ? segs[k] : null;
    let tz = 1;
    if (s) { tz = s.zoom || zoomLevel; tx = s.x; ty = s.y; }
    vz += (W_ZOOM * W_ZOOM * (tz - cz) - 2 * W_ZOOM * vz) * dt; cz += vz * dt;
    vx += (W_PAN * W_PAN * (tx - cx) - 2 * W_PAN * vx) * dt; cx += vx * dt;
    vy += (W_PAN * W_PAN * (ty - cy) - 2 * W_PAN * vy) * dt; cy += vy * dt;
    z[i] = cz; x[i] = cx; y[i] = cy;
  }
  return {
    at(t) {
      const f = Math.max(0, Math.min(n - 1.001, t * HZ));
      const i = f | 0, a = f - i;
      return {
        z: z[i] + (z[i + 1] - z[i]) * a,
        x: x[i] + (x[i + 1] - x[i]) * a,
        y: y[i] + (y[i + 1] - y[i]) * a,
      };
    },
  };
}
