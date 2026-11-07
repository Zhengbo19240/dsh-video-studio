/**
 * video_audio_mix：只读的「这条片子的音频到底有多响」报告。
 *
 * 目的只有一个：让 agent 能判断「配乐是不是盖住了口播」，而不是靠猜。
 * 它不改工程、不占写租约、不写任何文件。
 *
 * 峰值怎么来（两种来源，绝不给编造的数字）：
 *   1. WAV（PCM / float32）：纯 JS 解码，按片段源窗口 + 音量/淡入淡出包络取真实峰值
 *      （method = 'wav-pcm'，这是最准的一条路）。
 *   2. 其它格式：ffmpeg volumedetect 量整段素材峰值，再乘片段 volume
 *      （method = 'ffmpeg-volumedetect'；淡入淡出、ducking、响度归一都不在估算里）。
 *   3. 两条都拿不到：peak 为 null、status='unknown'，reason 写清为什么。
 *
 * 术语：effectivePeak 是「片段乘完音量后」的峰值估计，不是混音总线峰值。
 * 多条片段叠加、人声回避（ducking）与 RMS 归一都会改变总线，报告里明确标为估算。
 */

import { promises as fs } from 'node:fs';

import { resolveAssetPath } from './media.mjs';
import { decodeWavMono, effectiveClipPeak, gainToDb } from './audio-mix.mjs';
import { audioPropsOf } from './domain.mjs';
import { asrPaths } from './asr-deps.mjs';
import { runProcess } from './asr.mjs';
import { sanitizeJson } from './json-safe.mjs';

/** 单次 ffmpeg 探测的上限：素材再长也不该让一个只读报告卡住。 */
const PEAK_TIMEOUT_MS = 20 * 1000;
/** 同一素材只量一次；值放在进程内缓存里，键里带 size，换文件会重新量。 */
const peakCache = new Map();

const round3 = (v) => Math.round(v * 1000) / 1000;
const round1 = (v) => Math.round(v * 10) / 10;

/**
 * 生成音频混音报告。
 *
 * @param {object} opts
 * @param {import('./store.mjs').ProjectStore} opts.store
 * @param {string} opts.projectId
 * @param {string} opts.sessionId 省略时由调用方（工具层）解析好再传
 * @param {string} [opts.root] 工目录（测试可覆盖）
 * @param {Function} [opts.run] 进程实现（测试注入；默认 runProcess）
 * @param {string} [opts.ffmpegPath] ffmpeg 路径覆盖（测试用）
 */
export async function audioMixReport({ store, projectId, sessionId, run, ffmpegPath } = {}) {
  if (!store) throw new Error('audioMixReport 需要 store');
  if (!projectId) throw new Error('audioMixReport 需要 projectId');
  const doc = store.get(projectId).doc;
  const root = doc.root;

  const tracks = Array.isArray(doc.tracks) ? doc.tracks : [];
  const audioTracks = tracks.filter((t) => t && t.kind === 'audio');
  const audioTrackIds = new Set(audioTracks.map((t) => t.id));
  const audioClips = (doc.clips || [])
    .filter((c) => c && audioTrackIds.has(c.trackId))
    .sort((a, b) => a.start - b.start || String(a.id).localeCompare(String(b.id)));

  const assets = new Map((doc.assets || []).map((a) => [a.id, a]));
  const warnings = [];
  const ffmpeg = ffmpegPath || process.env.DSH_FFMPEG_PATH || asrPaths().ffmpeg;

  const clips = [];
  for (const clip of audioClips) {
    const asset = assets.get(clip.assetId) || null;
    const props = audioPropsOf(clip);
    const relPath = asset && typeof asset.path === 'string' ? asset.path : null;

    let measured = { peak: null, method: null, reason: '没有关联素材文件' };
    if (asset && relPath) {
      measured = await measureAssetPeak({
        root,
        asset,
        relPath,
        ffmpeg,
        run,
        cacheKey: `${root}|${relPath}|${asset.size || 0}|${asset.hash || ''}`,
      });
    } else if (clip.assetId && !asset) {
      measured = { peak: null, method: null, reason: `工程里没有素材 ${clip.assetId}` };
    }

    let effectivePeak = null;
    let unknownReason = measured.reason || null;
    let method = measured.method;
    if (measured.peak != null) {
      if (measured.method === 'wav-pcm' && measured.samples) {
        // WAV 走真实样本 + 包络：淡入淡出、静音、sourceIn 全都算进去
        const eff = effectiveClipPeak(measured.samples, measured.sampleRate, clip);
        if (eff.peak != null) {
          effectivePeak = eff.peak;
          unknownReason = null;
        } else {
          unknownReason = eff.reason;
        }
        method = eff.method || measured.method;
      } else {
        // ffmpeg 只给「整段素材峰值」：乘 volume，muted 直接 0
        effectivePeak = props.muted ? 0 : measured.peak * props.volume;
        unknownReason = null;
      }
    }
    if (props.muted) {
      effectivePeak = 0;
      unknownReason = null;
    }

    clips.push({
      clipId: clip.id,
      trackId: clip.trackId,
      type: clip.type || null,
      assetId: clip.assetId || null,
      asset: relPath,
      assetName: asset && asset.name ? asset.name : null,
      start: round3(clip.start),
      duration: round3(clip.duration),
      sourceIn: round3(clip.sourceIn || 0),
      speed: round3(Number(clip.speed) > 0 ? Number(clip.speed) : 1),
      audioRole: clip.audioRole || 'sfx',
      volume: round3(props.volume),
      muted: props.muted,
      fadeIn: round3(props.fadeIn),
      fadeOut: round3(props.fadeOut),
      sourcePeak: measured.peak == null ? null : round3(measured.peak),
      effectivePeak: effectivePeak == null ? null : round3(effectivePeak),
      effectivePeakDb: effectivePeak == null || !(effectivePeak > 0) ? null : round1(gainToDb(effectivePeak)),
      peakStatus: effectivePeak == null ? 'unknown' : 'measured',
      peakMethod: measured.peak == null ? null : method,
      unknownReason: effectivePeak == null ? unknownReason || '未知原因' : null,
    });
  }

  const byId = new Map(clips.map((c) => [c.clipId, c]));
  const overlaps = [];
  for (const music of clips) {
    if (music.audioRole !== 'music') continue;
    for (const voice of clips) {
      if (voice.audioRole !== 'voice' || voice.muted) continue;
      const start = Math.max(music.start, voice.start);
      const end = Math.min(music.start + music.duration, voice.start + voice.duration);
      if (!(end > start)) continue;
      const marginDb =
        music.effectivePeak != null && voice.effectivePeak != null && music.effectivePeak > 0 && voice.effectivePeak > 0
          ? round1(gainToDb(music.effectivePeak) - gainToDb(voice.effectivePeak))
          : null;
      overlaps.push({
        musicClipId: music.clipId,
        voiceClipId: voice.clipId,
        start: round3(start),
        end: round3(end),
        duration: round3(end - start),
        approxMarginDb: marginDb,
      });
    }
  }

  const unknownCount = clips.filter((c) => c.peakStatus === 'unknown').length;
  if (unknownCount) {
    warnings.push({
      code: 'PEAK_UNKNOWN',
      message: `${unknownCount} 个音频片段的峰值无法估计；原因写在每个片段的 unknownReason 里（不编数字）。`,
    });
  }
  if (clips.some((c) => c.audioRole === 'music') && clips.some((c) => c.audioRole === 'voice')) {
    warnings.push({
      code: 'ESTIMATE_NOT_BUS',
      message:
        'effectivePeak 是「片段 × 音量」的估计，不含 ducking、RMS 归一与多片段叠加；approxMarginDb 只用来判断量级，不是总线实测。',
    });
  }

  return sanitizeJson({
    projectId: doc.projectId,
    root,
    revision: doc.revision,
    duration: round3(doc.duration),
    convention: {
      peakUnit: '线性 0..1（1 = 满幅）',
      curve: 'linear',
      effectivePeakNote: '片段窗口内 max(|sample| × 音量包络)；不含 ducking / 归一 / 其它片段',
      unknownRule: '拿不到样本就把 peak 置 null 并写 reason，不填猜的数字',
    },
    audioTracks: audioTracks.map((t) => ({
      trackId: t.id,
      name: t.name || t.id,
      muted: t.muted === true,
      clipCount: clips.filter((c) => c.trackId === t.id).length,
    })),
    clips,
    overlaps,
    warnings,
  });
}

/**
 * 量一个素材的峰值。WAV 先走纯 JS；失败再试 ffmpeg；都不行返回 reason。
 * 返回值里的 samples/sampleRate 只在 WAV 路径上出现，供 effectiveClipPeak 用。
 */
async function measureAssetPeak({ root, asset, relPath, ffmpeg, run, cacheKey }) {
  const cached = peakCache.get(cacheKey);
  if (cached) return cached;

  let result = null;
  const abs = await safeResolve(root, relPath);

  if (!abs) {
    result = { peak: null, method: null, reason: '素材路径不合法或不在工程目录内' };
  } else if (/\.wav$/i.test(relPath)) {
    try {
      const bytes = await fs.readFile(abs);
      const decoded = decodeWavMono(bytes);
      if (decoded) {
        result = {
          peak: maxAbs(decoded.samples),
          method: 'wav-pcm',
          reason: null,
          samples: decoded.samples,
          sampleRate: decoded.sampleRate,
        };
      } else {
        result = { peak: null, method: null, reason: 'WAV 不是可解析的 PCM / float32（可能是压缩格式），改试 ffmpeg' };
      }
    } catch (e) {
      result = { peak: null, method: null, reason: `读取 WAV 失败：${(e && e.message) || e}` };
    }
  }

  if (!result || result.peak == null) {
    const viaFfmpeg = await ffmpegPeak({ abs: abs || null, ffmpeg, run });
    if (viaFfmpeg.peak != null) {
      result = viaFfmpeg;
    } else if (!result || result.peak == null) {
      result = {
        peak: null,
        method: null,
        reason: [result && result.reason, viaFfmpeg.reason].filter(Boolean).join('；'),
      };
    }
  }

  // 成功的测量才缓存；失败的（缺 ffmpeg 等）不缓存，下次调用允许重试。
  if (result.peak != null) peakCache.set(cacheKey, result);
  return result;
}

async function safeResolve(root, relPath) {
  try {
    const abs = await resolveAssetPath(root, relPath);
    return abs || null;
  } catch {
    return null;
  }
}

async function ffmpegPeak({ abs, ffmpeg, run }) {
  if (!abs) return { peak: null, method: null, reason: '素材文件不存在' };
  try {
    await fs.access(abs);
  } catch {
    return { peak: null, method: null, reason: '素材文件不存在（可能被移动或删除）' };
  }
  if (!ffmpeg) return { peak: null, method: null, reason: '没有可用的 ffmpeg' };

  try {
    const out = await runProcess(
      ffmpeg,
      ['-hide_banner', '-nostdin', '-i', abs, '-map', '0:a:0?', '-af', 'volumedetect', '-f', 'null', '-'],
      { timeoutMs: PEAK_TIMEOUT_MS, run },
    );
    const text = `${out && out.stderr ? out.stderr : ''}\n${out && out.stdout ? out.stdout : ''}`;
    const peak = parseVolumedetect(text);
    if (peak == null) {
      return { peak: null, method: null, reason: 'ffmpeg volumedetect 没有给出 max_volume（可能没有音轨）' };
    }
    return { peak, method: 'ffmpeg-volumedetect', reason: null };
  } catch (e) {
    return { peak: null, method: null, reason: `ffmpeg 测量失败：${(e && e.message) || e}` };
  }
}

/** 从 volumedetect 的 stderr 里取 max_volume（dB）→ 线性峰值。 */
export function parseVolumedetect(text) {
  const m = /max_volume:\s*(-?(?:\d+(?:\.\d+)?|inf))\s*dB/i.exec(String(text || ''));
  if (!m) return null;
  if (/^-?inf$/i.test(m[1])) return 0;
  const db = Number(m[1]);
  if (!Number.isFinite(db)) return null;
  return Math.pow(10, db / 20);
}

function maxAbs(samples) {
  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const v = samples[i];
    if (!Number.isFinite(v)) continue;
    const a = Math.abs(v);
    if (a > peak) peak = a;
  }
  return peak;
}

/** 只给测试用：清空峰值缓存，避免跨用例互相污染。 */
export function clearPeakCache() {
  peakCache.clear();
}
