/**
 * Timeline thumbnails: one small frame per media clip, captured from a hidden
 * video and cached by asset id + rounded source time.
 *
 * This is a view-only cache: nothing here is persisted, and a failure leaves
 * the clip without a thumbnail instead of breaking the timeline.
 */

const cache = new Map();
const pending = new Set();

export function thumbFor(assetId, sourceTime) {
  const key = assetId + '@' + Math.round(sourceTime * 2) / 2;
  return cache.get(key) || null;
}

export function prefetchThumb(assetId, url, sourceTime) {
  const key = assetId + '@' + Math.round(sourceTime * 2) / 2;
  if (cache.has(key) || pending.has(key)) return Promise.resolve(cache.get(key) || null);
  pending.add(key);
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'auto';
    video.crossOrigin = 'anonymous';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      pending.delete(key);
      if (value) cache.set(key, value);
      try {
        video.removeAttribute('src');
        video.load();
      } catch {
        /* ignore */
      }
      resolve(value || null);
    };
    const timer = setTimeout(() => finish(null), 6000);
    video.addEventListener('error', () => {
      clearTimeout(timer);
      finish(null);
    });
    video.addEventListener('loadeddata', () => {
      try {
        video.currentTime = Math.max(0, Math.min(sourceTime, (video.duration || 1) - 0.05));
      } catch {
        /* ignore */
      }
    });
    video.addEventListener('seeked', () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 36;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, 64, 36);
        clearTimeout(timer);
        finish(canvas.toDataURL('image/jpeg', 0.5));
      } catch {
        clearTimeout(timer);
        finish(null);
      }
    });
    video.src = url;
  });
}

export function clearThumbs() {
  cache.clear();
  pending.clear();
}
