import { readFileSync, writeFileSync } from 'node:fs';

function patch(file, pairs) {
  let s = readFileSync(file, 'utf8');
  for (const [a, b] of pairs) {
    if (!s.includes(a)) throw new Error(`[${file}] anchor missing: ${a.slice(0, 60)}`);
    s = s.replace(a, b);
  }
  writeFileSync(file, s);
  console.log('patched', file);
}

// 1) 默认工程加一条画中画视频轨
patch('src/domain.mjs', [
  [
    "      { id: 'v1', kind: 'video', name: '主轨', clips: [], muted: false, locked: false },",
    "      { id: 'v1', kind: 'video', name: '主轨', clips: [], muted: false, locked: false },\n      { id: 'v2', kind: 'video', name: '画中画', clips: [], muted: false, locked: false },",
  ],
]);

// 2) 播放器：按轨道顺序合成（主轨在下，画中画在上）+ 脏帧跳过重绘
patch('src/client/player.js', [
  [
    "function activeClips(clips, t) {",
    "function trackOrder(doc) {\n  const m = new Map();\n  (doc && doc.tracks ? doc.tracks : []).forEach((tr, i) => m.set(tr.id, i));\n  return m;\n}\n\nfunction activeClips(clips, t) {",
  ],
]);
