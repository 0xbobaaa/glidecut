import { Input, ALL_FORMATS, BlobSource } from '../vendor/mediabunny.min.mjs';
import { analyze, tidySegments } from './analyze.js';
import { buildCamera } from './camera.js';
import { drawFrame, stageToSource, OUTPUT_SIZES } from './render.js';
import { BACKGROUNDS, swatchCss } from './backgrounds.js';
import { exportMp4 } from './export.js';
import { Timeline } from './timeline.js';

const $ = id => document.getElementById(id);
const video = $('src'), stage = $('stage'), sctx = stage.getContext('2d', { alpha: false });

const S = {
  blob: null, input: null, vtrack: null, atrack: null, duration: 0, firstTs: 0,
  samples: [], segments: [], camera: null, last: null, selected: null, url: null,
  exporting: false, cancel: false,
  settings: { aspect: '16:9', background: 'violet', padding: 8, radius: 16, zoom: 2.0 },
};

function show(id) {
  for (const s of ['start', 'recording', 'editor']) $(s).hidden = s !== id;
}

// ---------- start screen ----------
$('btnRecord').onclick = record;
$('btnSample').onclick = () => fetch('media/sample.webm').then(r => r.blob()).then(load);
if (!navigator.mediaDevices?.getDisplayMedia || /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent)) { $('btnRecord').hidden = true; $('mobileNote').hidden = false; }
$('fileIn').onchange = e => e.target.files[0] && load(e.target.files[0]);
const drop = $('drop');
addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
addEventListener('dragleave', () => drop.classList.remove('over'));
addEventListener('drop', e => {
  e.preventDefault(); drop.classList.remove('over');
  const f = [...e.dataTransfer.files].find(f => f.type.startsWith('video/'));
  if (f) load(f);
});

function startError(msg) { const p = $('startErr'); p.textContent = msg; p.hidden = !msg; }

async function record() {
  startError('');
  if (!navigator.mediaDevices?.getDisplayMedia) return startError('Screen recording needs desktop Chrome, Edge, Firefox or Safari.');
  // made inside the click, otherwise Safari/Firefox start it suspended and the mixed audio is silent
  const actx = new AudioContext();
  let display, mic = null;
  try {
    display = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 60 }, width: { ideal: 2560 }, height: { ideal: 1440 } },
      audio: true, selfBrowserSurface: 'exclude', surfaceSwitching: 'include',
    });
  } catch (e) {
    actx.close();
    return startError(e.name === 'NotAllowedError' ? 'Recording was cancelled.' : `Could not start: ${e.message}`);
  }
  if ($('optMic').checked) {
    try { mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
    catch { /* no mic is fine */ }
  }
  const stopTracks = () => { [...display.getTracks(), ...(mic ? mic.getTracks() : [])].forEach(t => t.stop()); actx.close().catch(() => {}); };

  const vtrack = display.getVideoTracks()[0];
  let endedEarly = false;
  vtrack.onended = () => { endedEarly = true; };
  const tracks = [vtrack];
  const audioIns = [...display.getAudioTracks(), ...(mic ? mic.getAudioTracks() : [])];
  if (audioIns.length === 1) tracks.push(audioIns[0]);
  else if (audioIns.length > 1) {
    await actx.resume().catch(() => {});
    const dest = actx.createMediaStreamDestination();
    for (const t of audioIns) actx.createMediaStreamSource(new MediaStream([t])).connect(dest);
    tracks.push(dest.stream.getAudioTracks()[0]);
  }
  const stream = new MediaStream(tracks);

  show('recording');
  const count = $('count'), live = $('live');
  live.hidden = true; $('btnStop').hidden = true;
  for (const n of [3, 2, 1]) {
    count.textContent = n; await sleep(800);
    if (endedEarly) break;
  }
  count.textContent = '';
  if (endedEarly || vtrack.readyState === 'ended') { stopTracks(); show('start'); return startError('Sharing stopped before recording started.'); }
  live.hidden = false; $('btnStop').hidden = false;

  let rec;
  const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4']
    .find(m => MediaRecorder.isTypeSupported(m));
  try {
    rec = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), videoBitsPerSecond: 10e6 });
  } catch (e) {
    stopTracks(); show('start'); return startError(`This browser can't record video: ${e.message}`);
  }
  const chunks = [];
  rec.ondataavailable = e => e.data.size && chunks.push(e.data);
  const t0 = performance.now();
  const timer = setInterval(() => { $('recTime').textContent = mmss((performance.now() - t0) / 1000); }, 250);
  const stopAll = () => { if (rec.state !== 'inactive') rec.stop(); };
  vtrack.onended = stopAll;
  $('btnStop').onclick = stopAll;
  rec.onstop = () => {
    clearInterval(timer);
    stopTracks();
    const type = (rec.mimeType || mime || 'video/webm').split(';')[0];
    load(new Blob(chunks, { type }));
  };
  rec.start(1000);
}

// ---------- load + analyze ----------
let gen = 0; // bumps on every new video, so late results from an old one are dropped

function resetExportUi() {
  S.cancel = true;
  $('prog').hidden = true; $('dl').hidden = true;
  if ($('dl').href) URL.revokeObjectURL($('dl').href);
  $('dl').removeAttribute('href');
}

async function load(blob) {
  const my = ++gen;
  resetExportUi();
  show('editor');
  hint('Opening…', true);
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
  let vtrack, atrack, firstTs, duration;
  try {
    vtrack = await input.getPrimaryVideoTrack();
    if (!vtrack) throw new Error('no video track in this file');
    if (!(await vtrack.canDecode())) throw new Error(`this browser can't decode ${vtrack.codec || 'this'} video. Try Chrome or Edge, or a .mp4/.webm file`);
    atrack = await input.getPrimaryAudioTrack();
    firstTs = await input.getFirstTimestamp([vtrack]);
    duration = (await input.computeDuration([vtrack])) - firstTs;
    if (!(duration > 0.2)) throw new Error('the video is too short');
  } catch (e) {
    if (my !== gen) return;
    show('start'); return startError(`Could not read that video: ${e.message}`);
  }
  if (my !== gen) return;
  // wait for any running export to notice the cancel before its input goes away
  while (S.exporting) await sleep(50);
  S.input?.dispose?.();
  Object.assign(S, { blob, input, vtrack, atrack, firstTs, duration, segments: [], samples: [], selected: null });
  if (S.url) URL.revokeObjectURL(S.url);
  S.url = URL.createObjectURL(blob);
  video.src = S.url;
  await new Promise(r => { video.onloadeddata = r; video.onerror = r; });
  if (my !== gen) return;
  rebuild(); redraw();
  await detect();
}

async function detect() {
  const my = gen;
  hint('Finding the action… 0%', true);
  $('btnExport').disabled = true; $('btnAuto').disabled = true;
  try {
    const res = await analyze(S.vtrack, S.duration, S.firstTs,
      p => { if (my === gen) hint(`Finding the action… ${Math.round(p * 100)}%`, true); },
      () => my !== gen);
    if (!res || my !== gen) return;
    S.samples = res.samples; S.segments = res.segments; S.selected = null;
    rebuild(true); redraw();
    const n = res.segments.length;
    hint(n ? `${n} zoom${n > 1 ? 's' : ''} added. Press space to watch.` : 'No clear action found — click the video to add a zoom.', true);
  } catch (e) {
    if (my !== gen) return;
    console.error(e);
    hint(`Couldn't scan this video (${e.message}). You can still add zooms by hand.`, true);
  } finally {
    if (my === gen) { $('btnExport').disabled = false; $('btnAuto').disabled = false; }
  }
  setTimeout(() => { if (my === gen && !S.selected) hint('', false); }, 4000);
}

let nextId = 1;
// auto=true: fresh detector output, apply the full cleanup.
// auto=false: the user edited something — only keep zooms inside the video and stop overlaps, never move their edits.
function rebuild(auto = false) {
  if (auto) S.segments = tidySegments(S.segments, S.duration);
  else {
    S.segments = S.segments
      .map(s => Object.assign(s, { start: Math.max(0, s.start), end: Math.min(S.duration, s.end) }))
      .filter(s => s.end - s.start > 0.2)
      .sort((a, b) => a.start - b.start);
    S.segments.forEach((s, i) => { const n = S.segments[i + 1]; if (n && s.end > n.start) s.end = Math.max(s.start + 0.2, n.start); });
  }
  for (const s of S.segments) { if (s.id == null || auto) s.id = nextId++; if (s.x == null) { s.x = 0.5; s.y = 0.5; } }
  if (S.selected && !S.segments.includes(S.selected)) S.selected = null;
  S.camera = buildCamera(S.segments, S.duration, S.settings.zoom);
  timeline.selected = S.selected;
  timeline.set(S.duration, S.segments, S.samples);
}

// ---------- preview ----------
function sizeStage() {
  const [w, h] = OUTPUT_SIZES[S.settings.aspect];
  if (stage.width !== w || stage.height !== h) { stage.width = w; stage.height = h; }
}
function redraw() {
  if (!S.camera || video.readyState < 2) return;
  sizeStage();
  const t = Math.min(S.duration, Math.max(0, video.currentTime));
  S.last = drawFrame(sctx, video, video.videoWidth, video.videoHeight, S.camera.at(t), S.settings);
  timeline.setTime(t);
  $('tc').textContent = mmss(t, true);
}
function loop() {
  if (!video.paused) redraw();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
video.addEventListener('seeked', redraw);
video.addEventListener('ended', () => { $('btnPlay').textContent = '▶'; });
video.addEventListener('pause', () => { $('btnPlay').textContent = '▶'; });
video.addEventListener('play', () => { $('btnPlay').textContent = '❚❚'; });

function togglePlay() {
  if (video.paused) { if (video.currentTime >= S.duration - 0.05) video.currentTime = 0; video.play(); }
  else video.pause();
}
$('btnPlay').onclick = togglePlay;

const timeline = new Timeline($('timeline'), {
  onSeek: t => { video.currentTime = t; timeline.setTime(t); },
  onChange: () => { rebuild(); redraw(); },
  onSelect: s => {
    S.selected = s;
    if (s) hint('Click the video to choose where this zoom looks', true);
    else hint('', false);
  },
});

stage.addEventListener('click', e => {
  if (!S.last) return;
  const r = stage.getBoundingClientRect();
  const px = (e.clientX - r.left) * (stage.width / r.width), py = (e.clientY - r.top) * (stage.height / r.height);
  const p = stageToSource(px, py, S.last, video.videoWidth, video.videoHeight);
  let s = S.selected;
  if (!s) {
    // clicking the video with nothing selected adds a zoom right here, right now
    const t = video.currentTime;
    if (S.segments.some(o => t >= o.start && t < o.end)) {
      s = S.segments.find(o => t >= o.start && t < o.end);
    } else {
      s = { id: Date.now(), start: Math.max(0, t - 0.3), end: Math.min(S.duration, t + 2) };
      S.segments.push(s);
    }
  }
  s.x = p.x; s.y = p.y;
  S.selected = s;
  rebuild(); redraw();
});

addEventListener('keydown', e => {
  if ($('editor').hidden || e.target.tagName === 'INPUT') return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  if ((e.key === 'Delete' || e.key === 'Backspace') && timeline.removeSelected()) { S.selected = null; e.preventDefault(); }
});

// ---------- controls ----------
for (const b of $('segAspect').children) {
  b.onclick = () => {
    for (const o of $('segAspect').children) o.classList.toggle('on', o === b);
    S.settings.aspect = b.dataset.v; redraw();
  };
}
const sw = $('swatches');
for (const bg of BACKGROUNDS) {
  const b = document.createElement('button');
  b.style.background = swatchCss(bg); b.title = bg.id;
  b.classList.toggle('on', bg.id === S.settings.background);
  b.onclick = () => {
    for (const o of sw.children) o.classList.toggle('on', o === b);
    S.settings.background = bg.id; redraw();
  };
  sw.appendChild(b);
}
const range = (id, out, key, fmt, f = v => v) => {
  const el = $(id);
  const upd = () => { S.settings[key] = f(+el.value); $(out).textContent = fmt(S.settings[key]); };
  el.oninput = () => { upd(); if (key === 'zoom') rebuild(); redraw(); };
  upd();
};
range('rPad', 'vPad', 'padding', v => `${v}%`);
range('rRad', 'vRad', 'radius', v => `${v}px`);
range('rZoom', 'vZoom', 'zoom', v => `${v.toFixed(1)}×`, v => v / 10);

$('btnAuto').onclick = () => detect();
$('btnClear').onclick = () => { S.segments = []; S.selected = null; rebuild(); redraw(); };
$('btnNew').onclick = () => { video.pause(); gen++; resetExportUi(); $('fileIn').value = ''; show('start'); };

$('btnExport').onclick = async () => {
  if (S.exporting) { S.cancel = true; return; }
  video.pause();
  S.exporting = true; S.cancel = false;
  const btn = $('btnExport'), prog = $('prog'), dl = $('dl');
  btn.textContent = 'Cancel'; prog.hidden = false; dl.hidden = true;
  const t0 = performance.now();
  try {
    const out = await exportMp4({
      videoTrack: S.vtrack, audioTrack: S.atrack, duration: S.duration, firstTs: S.firstTs,
      camera: S.camera, settings: { ...S.settings },
      isCancelled: () => S.cancel,
      onProgress: p => { $('progBar').style.width = `${p * 100}%`; $('progTxt').textContent = `${Math.round(p * 100)}%`; },
    });
    if (out) {
      const { blob, notes } = out;
      dl.href = URL.createObjectURL(blob);
      dl.download = `glidecut-${S.settings.aspect.replace(':', 'x')}-${Date.now()}.mp4`;
      dl.textContent = `Download MP4 · ${(blob.size / 1e6).toFixed(1)} MB · ${((performance.now() - t0) / 1000).toFixed(0)}s`;
      dl.hidden = false;
      window.__lastExport = blob;
      $('progTxt').textContent = notes.length ? notes.join(' · ') : 'done';
    }
  } catch (e) {
    $('progTxt').textContent = `Export failed: ${e.message}`;
    console.error(e);
  }
  S.exporting = false; btn.textContent = 'Export MP4';
};

// ---------- utils ----------
function hint(text, on) { const h = $('stageHint'); h.textContent = text; h.classList.toggle('show', !!on && !!text); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function mmss(s, tenths) {
  const m = Math.floor(s / 60), r = s - m * 60;
  return tenths ? `${m}:${r.toFixed(1).padStart(4, '0')}` : `${String(m).padStart(2, '0')}:${String(Math.floor(r)).padStart(2, '0')}`;
}

// test hook: ?demo=<url> loads a video straight into the editor
const demo = new URLSearchParams(location.search).get('demo');
if (demo) fetch(demo).then(r => r.blob()).then(load);
window.__zr = S;
