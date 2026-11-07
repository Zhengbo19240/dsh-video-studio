#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""faster-whisper 转写 worker（随插件分发，由 src/asr.mjs 用 spawn 调用）。

约定 —— 改动前先读 src/asr.mjs 里的 transcribeWithFasterWhisper：

  stdout   一行 JSON：{"language": "zh", "duration": 87.5,
                       "segments": [{"start": 0.0, "end": 3.2, "text": "..."}]}
  stderr   PROGRESS <done>/<total>   按 30 秒窗口的进度（不阻塞，随时可读）
  stderr   ERROR <message>           致命错误，随后非零退出（1 参数 / 2 依赖 / 3 模型 / 4 转写）

为什么不用 multiprocessing / 队列：调用方只关心「进度」和「最后一次结果」，
stderr 逐行已经够用，也省得在 Windows 上处理 spawn 方式。

模型缓存：--models-dir 会同时设成 HF_HOME / HUGGINGFACE_HUB_CACHE 和
WhisperModel 的 download_root，保证权重落在 D:\\DSH插件\\Video依赖\\models 里，
不会散到用户目录。
"""

import argparse
import json
import os
import sys


def log(message):
    try:
        sys.stderr.write(str(message) + "\n")
        sys.stderr.flush()
    except Exception:
        pass


def fail(message, code=1):
    log("ERROR " + str(message))
    return code


def configure_stdio():
    # Windows 控制台默认 cp936，中文 JSON 会被写成乱码；调用方按 utf-8 解码
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def parse_args(argv):
    parser = argparse.ArgumentParser(description="faster-whisper worker")
    parser.add_argument("--audio", required=True, help="16k 单声道 wav")
    parser.add_argument("--model", default="small")
    parser.add_argument("--language", default="zh")
    parser.add_argument("--device", default="cpu", choices=["cpu", "cuda"])
    parser.add_argument("--compute-type", dest="compute_type", default="")
    parser.add_argument("--models-dir", dest="models_dir", default="")
    parser.add_argument("--initial-prompt", dest="initial_prompt", default="")
    parser.add_argument("--beam-size", dest="beam_size", type=int, default=5)
    return parser.parse_args(argv)


def pick_device(requested):
    """请求 cuda 但机器没有可用卡时降级到 cpu；不降级会直接崩在模型加载。"""
    device = "cuda" if requested == "cuda" else "cpu"
    compute = "float16" if device == "cuda" else "int8"
    try:
        import ctranslate2

        count = int(ctranslate2.get_cuda_device_count())
    except Exception as exc:  # 缺 cu12 运行库时 get_cuda_device_count 也可能抛
        count = 0
        if device == "cuda":
            log("WARN 检测 CUDA 设备失败（%s），改用 CPU" % exc)
    if device == "cuda" and count <= 0:
        log("WARN 没有可用的 CUDA 设备，改用 CPU（int8）")
        device = "cpu"
        compute = "int8"
    return device, compute, count



def _prepare_cuda_dlls():
    """把 pip 装的 nvidia-cublas / nvidia-cudnn 的 DLL 目录加进搜索路径。

    ctranslate2 在 Windows 上通过 LoadLibrary 找 cublas64_12.dll / cudnn64_9.dll，
    而 pip 把这些 DLL 放在 site-packages/nvidia/*/bin 下，不在 PATH 里。
    不加这一段，GPU 模式会报 "Library cublas64_12.dll is not found"。
    """
    try:
        import site
    except Exception:
        return
    roots = []
    for base in site.getsitepackages() + [site.getusersitepackages()]:
        roots.append(os.path.join(base, "nvidia"))
    added = []
    for root in roots:
        if not os.path.isdir(root):
            continue
        for name in ("cublas", "cudnn", "cuda_nvrtc"):
            bin_dir = os.path.join(root, name, "bin")
            if os.path.isdir(bin_dir):
                added.append(bin_dir)
                try:
                    if hasattr(os, "add_dll_directory"):
                        os.add_dll_directory(bin_dir)
                except Exception:
                    pass
    if added:
        os.environ["PATH"] = os.pathsep.join(added + [os.environ.get("PATH", "")])
        log("CUDA dll dirs: " + os.pathsep.join(added))


def main(argv):
    configure_stdio()
    args = parse_args(argv)

    if not os.path.isfile(args.audio):
        return fail("找不到音频文件：%s" % args.audio, 1)

    models_dir = args.models_dir or ""
    if models_dir:
        try:
            os.makedirs(models_dir, exist_ok=True)
        except Exception as exc:
            return fail("创建模型缓存目录失败：%s（%s）" % (models_dir, exc), 1)
        # faster-whisper 走 huggingface_hub；三个变量都设上，老版本也能命中同一个目录
        os.environ["HF_HOME"] = models_dir
        os.environ["HUGGINGFACE_HUB_CACHE"] = os.path.join(models_dir, "hub")
        os.environ["HF_HUB_CACHE"] = os.path.join(models_dir, "hub")

    try:
        _prepare_cuda_dlls()
        import faster_whisper  # noqa: F401
        from faster_whisper import WhisperModel
    except Exception as exc:
        return fail(
            "无法导入 faster-whisper（%s）。在当前 venv 里执行："
            "pip install faster-whisper nvidia-cublas-cu12 nvidia-cudnn-cu12" % exc,
            2,
        )

    device, compute, cuda_count = pick_device(args.device)
    compute = args.compute_type or compute

    try:
        model = WhisperModel(
            args.model,
            device=device,
            compute_type=compute,
            download_root=os.path.join(models_dir, "whisper") if models_dir else None,
        )
    except Exception as exc:
        return fail("模型加载失败（%s / %s / %s）：%s" % (args.model, device, compute, exc), 3)

    try:
        segments_iter, info = model.transcribe(
            args.audio,
            language=args.language or None,
            vad_filter=True,
            beam_size=max(1, int(args.beam_size)),
            initial_prompt=args.initial_prompt or None,
        )
    except Exception as exc:
        return fail("转写失败：%s" % exc, 4)

    duration = float(getattr(info, "duration", 0.0) or 0.0)
    language = getattr(info, "language", None) or args.language or "zh"
    total_windows = max(1, int(round(duration / 30.0))) if duration > 0 else 1

    out = []
    last_emit = -1
    log("PROGRESS 0/%d" % total_windows)
    try:
        for segment in segments_iter:
            text = (getattr(segment, "text", "") or "").strip()
            start = float(getattr(segment, "start", 0.0) or 0.0)
            end = float(getattr(segment, "end", 0.0) or 0.0)
            if text and end > start:
                out.append({"start": round(start, 3), "end": round(end, 3), "text": text})
            if duration > 0:
                done = int(end // 30) + 1
                done = max(1, min(total_windows, done))
                if done > last_emit:
                    last_emit = done
                    log("PROGRESS %d/%d" % (done, total_windows))
    except Exception as exc:
        return fail("转写中断：%s" % exc, 4)

    if duration <= 0 and out:
        duration = out[-1]["end"]

    payload = {
        "language": language,
        "duration": round(float(duration), 3),
        "segments": out,
        "device": device,
        "model": args.model,
        "cudaDevices": cuda_count,
    }
    try:
        sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
        sys.stdout.flush()
    except Exception as exc:
        return fail("写结果失败：%s" % exc, 5)

    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
