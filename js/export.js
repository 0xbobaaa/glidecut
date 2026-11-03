// Renders every output frame on a canvas and encodes it with WebCodecs. No server, no upload.
import {
  Output, Mp4OutputFormat, BufferTarget, CanvasSource, AudioBufferSource, CanvasSink, AudioBufferSink,
  QUALITY_HIGH, getFirstEncodableVideoCodec, getFirstEncodableAudioCodec,
} from '../vendor/mediabunny.min.mjs';
import { drawFrame, OUTPUT_SIZES } from './render.js';

const FPS = 60;

export async function exportMp4({ videoTrack, audioTrack: audioTrack0, duration, firstTs, camera, settings, onProgress, isCancelled }) {
  let audioTrack = audioTrack0;
  const [W, H] = OUTPUT_SIZES[settings.aspect];
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d', { alpha: false });

  const vcodec = await getFirstEncodableVideoCodec(['avc', 'vp9', 'av1'], { width: W, height: H });
  if (!vcodec) throw new Error('This browser cannot encode video. Try Chrome or Edge.');

  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  const vsrc = new CanvasSource(canvas, { codec: vcodec, bitrate: QUALITY_HIGH, keyFrameInterval: 2 });
  output.addVideoTrack(vsrc, { frameRate: FPS });

  const notes = [];
  if (vcodec !== 'avc') notes.push(`saved as ${vcodec.toUpperCase()} — plays in Chrome, maybe not in QuickTime/iPhone`);
  let asrc = null;
  if (audioTrack && !(await audioTrack.canDecode())) { notes.push('this browser can\'t read the audio, exported without sound'); audioTrack = null; }
  if (audioTrack) {
    const acodec = await getFirstEncodableAudioCodec(['aac', 'opus'], {
      numberOfChannels: audioTrack.numberOfChannels, sampleRate: audioTrack.sampleRate,
    });
    if (acodec) {
      asrc = new AudioBufferSource({ codec: acodec, bitrate: 160e3 });
      output.addAudioTrack(asrc);
    } else notes.push('this browser can\'t encode audio, exported without sound');
  }
  await output.start();

  const total = Math.max(1, Math.floor(duration * FPS));
  const times = Array.from({ length: total }, (_, i) => firstTs + i / FPS);
  const sink = new CanvasSink(videoTrack, { poolSize: 2 });

  let i = 0;
  for await (const wc of sink.canvasesAtTimestamps(times)) {
    if (isCancelled()) { await output.cancel(); return null; }
    const t = i / FPS;
    if (wc) drawFrame(ctx, wc.canvas, wc.canvas.width, wc.canvas.height, camera.at(t), settings);
    await vsrc.add(t, 1 / FPS);
    i++;
    if (i % 10 === 0) onProgress(0.95 * i / total);
  }
  vsrc.close();

  if (asrc) await writeAudio(asrc, audioTrack, firstTs, duration);
  await output.finalize();
  onProgress(1);
  return { blob: new Blob([output.target.buffer], { type: 'video/mp4' }), notes };
}

// AudioBufferSource lays buffers end to end and ignores their timestamps, so we line them up
// ourselves: start exactly at the first video frame, fill gaps with silence, trim overlaps.
async function writeAudio(asrc, track, firstTs, duration) {
  const rate = track.sampleRate, ch = track.numberOfChannels;
  const total = Math.round(duration * rate);
  let cursor = 0;
  const silence = async frames => {
    while (frames > 0) {
      const n = Math.min(frames, rate);
      await asrc.add(new AudioBuffer({ length: n, numberOfChannels: ch, sampleRate: rate }));
      frames -= n; cursor += n;
    }
  };
  for await (const { buffer, timestamp } of new AudioBufferSink(track).buffers(firstTs, firstTs + duration)) {
    if (cursor >= total) break;
    const at = Math.round((timestamp - firstTs) * rate);
    if (at > cursor) await silence(Math.min(at, total) - cursor);
    const skip = Math.max(0, cursor - at);
    const n = Math.min(buffer.length - skip, total - cursor);
    if (n <= 0) continue;
    if (skip === 0 && n === buffer.length && buffer.numberOfChannels === ch) await asrc.add(buffer);
    else {
      const out = new AudioBuffer({ length: n, numberOfChannels: ch, sampleRate: rate });
      for (let c = 0; c < ch; c++) out.copyToChannel(buffer.getChannelData(Math.min(c, buffer.numberOfChannels - 1)).subarray(skip, skip + n), c);
      await asrc.add(out);
    }
    cursor += n;
  }
  if (cursor < total) await silence(total - cursor);
  asrc.close();
}
