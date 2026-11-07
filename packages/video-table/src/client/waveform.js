/**
 * Waveform thumbnails for audio clips: decode once per asset, draw a small
 * PNG strip, cache the data URL.
 */

const cache = new Map();
const pending = new Set();
let audioCtx = null;

function ctx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

export function waveformFor(assetId) {
  return cache.get(assetId) || null;
}

function draw(peaks) {
  const w = 256;
  const h = 32;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d');
  g.fillStyle = 'rgba(255,255,255,0.06)';
  g.fillRect(0, 0, w, h);
  g.strokeStyle = 'rgba(160,230,200,0.85)';
  g.beginPath();
  const step = w / peaks.length;
  for (let i = 0; i < peaks.length; i += 1) {
    const v = Math.max(0.02, peaks[i]);
    const y = (h / 2) * (1 - v);
    g.moveTo(i * step, h / 2 - (h / 2 - y));
    g.lineTo(i * step, h / 2 + (h / 2 - y));
  }
  g.stroke();
  return canvas.toDataURL('image/png');
}

export function prefetchWaveform(assetId, url, buckets = 128) {
  if (cache.has(assetId)) return Promise.resolve(cache.get(assetId));
  if (pending.has(assetId)) return Promise.resolve(null);
  pending.add(assetId);
  return fetch(url)
    .then((r) => r.arrayBuffer())
    .then((buf) => ctx().decodeAudioData(buf))
    .then((audio) => {
      const data = audio.getChannelData(0);
      const size = Math.max(16, Math.floor(data.length / buckets));
      const peaks = new Float32Array(buckets);
      for (let b = 0; b < buckets; b += 1) {
        let max = 0;
        const start = b * size;
        const end = Math.min(data.length, start + size);
        for (let i = start; i < end; i += 1) {
          const v = Math.abs(data[i]);
          if (v > max) max = v;
        }
        peaks[b] = max;
      }
      const png = draw(peaks);
      cache.set(assetId, png);
      pending.delete(assetId);
      return png;
    })
    .catch(() => {
      pending.delete(assetId);
      return null;
    });
}

export function clearWaveforms() {
  cache.clear();
  pending.clear();
}
