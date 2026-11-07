/**
 * SRT in and out. Captions are ordinary text clips on the caption track, so a
 * subtitle file is just a batch of clip.insert commands — nothing special.
 */

export function parseSrt(text) {
  const clean = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const blocks = clean.split(/\n{2,}/);
  const out = [];
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    if (!lines.length) continue;
    let idx = 0;
    if (/^\d+$/.test(lines[0].trim())) idx = 1;
    const timeLine = lines[idx];
    if (!timeLine || !timeLine.includes('-->')) continue;
    const m = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/.exec(timeLine);
    if (!m) continue;
    const toSec = (h, mi, s, ms) => Number(h) * 3600 + Number(mi) * 60 + Number(s) + Number(ms.padEnd(3, '0')) / 1000;
    const start = toSec(m[1], m[2], m[3], m[4]);
    const end = toSec(m[5], m[6], m[7], m[8]);
    if (!(end > start)) continue;
    const body = lines.slice(idx + 1).join('\n').trim();
    if (!body) continue;
    out.push({ start: Math.round(start * 1000) / 1000, end: Math.round(end * 1000) / 1000, text: body });
  }
  return out;
}

function pad(n, len = 2) {
  return String(n).padStart(len, '0');
}

function stamp(sec) {
  const total = Math.max(0, sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const ms = Math.round((total - Math.floor(total)) * 1000);
  return pad(h) + ':' + pad(m) + ':' + pad(s) + ',' + pad(ms, 3);
}

export function toSrt(entries) {
  const list = (entries || [])
    .filter((e) => e && Number.isFinite(e.start) && Number.isFinite(e.end) && e.end > e.start && e.text)
    .sort((a, b) => a.start - b.start);
  return list
    .map((e, i) => `${i + 1}\n${stamp(e.start)} --> ${stamp(e.end)}\n${String(e.text).trim()}\n`)
    .join('\n');
}

/** 文字片段 → SRT 条目 */
export function clipsToSrt(clips) {
  return toSrt(
    (clips || [])
      .filter((c) => c.type === 'text')
      .map((c) => ({ start: c.start, end: c.start + c.duration, text: c.text || '' })),
  );
}
