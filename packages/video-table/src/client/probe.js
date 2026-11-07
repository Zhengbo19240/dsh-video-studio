/**
 * Capability probe: what this browser can actually decode/encode.
 *
 * Surfaced in the workbench so a black frame or a silent export has a visible
 * cause instead of looking like a bug.
 */

export async function probe() {
  const out = {
    secureContext: typeof isSecureContext === 'boolean' ? isSecureContext : null,
    webgpu: !!navigator.gpu,
    videoDecoder: typeof VideoDecoder !== 'undefined',
    videoEncoder: typeof VideoEncoder !== 'undefined',
    audioEncoder: typeof AudioEncoder !== 'undefined',
    h264: null,
    hevc: null,
    vp9: null,
    av1: null,
    aac: null,
    opus: null,
  };

  async function tryVideo(codec, w = 1920, h = 1080) {
    if (typeof VideoEncoder === 'undefined') return false;
    try {
      const r = await VideoEncoder.isConfigSupported({ codec, width: w, height: h, bitrate: 8_000_000, framerate: 30 });
      return !!r.supported;
    } catch {
      return false;
    }
  }
  async function tryAudio(codec) {
    if (typeof AudioEncoder === 'undefined') return false;
    try {
      const r = await AudioEncoder.isConfigSupported({ codec, sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 });
      return !!r.supported;
    } catch {
      return false;
    }
  }

  out.h264 = await tryVideo('avc1.42001f');
  out.hevc = await tryVideo('hvc1.1.6.L93.B0');
  out.vp9 = await tryVideo('vp09.00.10.08');
  out.av1 = await tryVideo('av01.0.04M.08');
  out.aac = await tryAudio('mp4a.40.2');
  out.opus = await tryAudio('opus');

  try {
    if (navigator.gpu) {
      const adapter = await navigator.gpu.requestAdapter();
      out.gpuVendor = adapter && adapter.info ? adapter.info.vendor : null;
    }
  } catch {
    /* 探测失败就当没有 */
  }
  return out;
}
