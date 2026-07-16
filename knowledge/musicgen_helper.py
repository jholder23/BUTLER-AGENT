"""
Free local text→audio for music / SFX-style samples (Meta MusicGen).
Uses Hugging Face Transformers + PyTorch (Python 3.13–friendly). Optional: see requirements-audio.txt.
Legacy: if `audiocraft` is installed with a matching torch, it can be used as a fallback.
"""
from __future__ import annotations

import base64
import io
import math
import os
import re
import wave
from typing import Any

from butlor_paths import ensure_butlor_config_dir

DEFAULT_SAMPLE_RATE = 32000

# MusicGen is music-biased; short clips + explicit “no drums / one layer” wording work better than long windows.
_ONE_SHOT_PROMPT_SUFFIX = (
    ", isolated pure sub-bass synthesizer only, no drums, no percussion, no hi-hats, no melody, no vocals"
)


def _parse_seconds_from_prompt(text: str) -> float | None:
    """Pick an explicit length from the user message (e.g. '2 seconds', '1.5s')."""
    if not (text or "").strip():
        return None
    t = text.lower()
    for pat in (
        r"\b(\d+(?:\.\d+)?)\s*(?:seconds?|secs?)\b",
        r"\b(\d+(?:\.\d+)?)\s*s\b(?=[\s,.\!\?]|$)",
    ):
        m = re.search(pat, t)
        if not m:
            continue
        try:
            v = float(m.group(1))
        except ValueError:
            continue
        if 0.25 <= v <= 30.0:
            return v
    return None


def _prompt_suggests_one_shot_or_sparse_mix(low: str) -> bool:
    """User wants a single hit / one layer (not a full arranged track)."""
    if not low:
        return False
    needles = (
        "no drums",
        "without drums",
        "no drum",
        "no percussion",
        "no layers",
        "no other",
        "other layers",
        "just bass",
        "just the bass",
        "bass only",
        "only bass",
        "only the bass",
        "single wub",
        "one wub",
        "one shot",
        "one-shot",
        "isolated bass",
        "bass sample",
        "sub sample",
        "pure bass",
        "solo bass",
        "only sub",
        "no hi-hat",
        "no hihat",
        "no melody",
        "no beat",
    )
    if any(n in low for n in needles):
        return True
    dub_wub = ("wub" in low) or ("dubstep" in low and "bass" in low)
    if dub_wub and any(
        x in low
        for x in (
            "no drum",
            "only",
            "just ",
            "sample",
            "single",
            "isolat",
            "pure ",
        )
    ):
        return True
    return False


def _maybe_enrich_one_shot_prompt(text: str) -> str:
    low = text.lower()
    if not _prompt_suggests_one_shot_or_sparse_mix(low):
        return text
    if "isolated pure sub-bass" in low:
        return text
    return (text.rstrip() + _ONE_SHOT_PROMPT_SUFFIX).strip()


def _resolve_duration_sec(text: str, api_duration: float | None) -> float:
    """
    Target clip length in seconds. Prefer API body, then digits in the message,
    then one-shot heuristics (short), else BUTLER_MUSICGEN_DURATION / 8.
    """
    if api_duration is not None:
        raw = float(api_duration)
    elif (parsed := _parse_seconds_from_prompt(text)) is not None:
        raw = parsed
    elif _prompt_suggests_one_shot_or_sparse_mix(text.lower()):
        raw = 2.0
    else:
        raw = float(os.environ.get("BUTLER_MUSICGEN_DURATION", "8") or "8")
    return max(0.5, min(30.0, raw))


def _slug(s: str, max_len: int = 48) -> str:
    t = re.sub(r"[^a-zA-Z0-9]+", "_", (s or "").strip().lower()).strip("_")
    return (t[:max_len] or "sample").rstrip("_")


def _wav_from_float_mono(samples: Any, sample_rate: int) -> bytes:
    import numpy as np

    x = np.asarray(samples, dtype=np.float64).flatten()
    x = np.clip(x, -1.0, 1.0)
    pcm = (x * 32767.0).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(int(sample_rate))
        wf.writeframes(pcm.tobytes())
    return buf.getvalue()


def _generate_transformers(
    text: str,
    mid: str,
    dur: float,
    device: str,
) -> tuple[Any, int, str]:
    import torch
    from transformers import AutoProcessor, MusicgenForConditionalGeneration

    processor = AutoProcessor.from_pretrained(mid)
    model = MusicgenForConditionalGeneration.from_pretrained(mid)
    model.to(device)
    model.eval()

    inputs = processor(text=[text], padding=True, return_tensors="pt")
    inputs = {k: v.to(device) for k, v in inputs.items()}

    # ~50 codec steps/sec for MusicGen; keep token budget tight for short clips (avoid full-song length).
    mnt = min(2048, max(48, int(dur * 52)))

    kwargs = {"do_sample": True, "max_new_tokens": mnt}
    try:
        audio_values = model.generate(**inputs, **kwargs, guidance_scale=3.0)
    except TypeError:
        audio_values = model.generate(**inputs, **kwargs)

    enc = getattr(model.config, "audio_encoder", None)
    sr = int(getattr(enc, "sampling_rate", None) or DEFAULT_SAMPLE_RATE) if enc else DEFAULT_SAMPLE_RATE

    # Typical shape: [batch, channels, samples]; HF examples use [0, 0] for mono waveform.
    av = audio_values
    if av.dim() >= 3:
        wav1d = av[0, 0].detach().cpu().float()
    elif av.dim() == 2:
        wav1d = av[0].detach().cpu().float()
    else:
        wav1d = av.detach().cpu().float()

    return wav1d.numpy(), sr, "transformers"


def _generate_audiocraft(text: str, mid: str, dur: float, device: str) -> tuple[Any, int, str]:
    import torch
    from audiocraft.models import MusicGen

    model = MusicGen.get_pretrained(mid, device=device)
    ac_dur = max(1, min(30, int(math.ceil(float(dur)))))
    model.set_generation_params(duration=ac_dur, temperature=1.0, top_k=250)
    with torch.inference_mode():
        wav = model.generate([text], progress=False)
    tensor = wav[0].detach().cpu().float()
    if tensor.dim() == 1:
        arr = tensor.unsqueeze(0).numpy()
    else:
        arr = tensor.numpy()
    if arr.ndim == 1:
        arr = arr.reshape(1, -1)
    ch = int(arr.shape[0])
    sr = int(getattr(model, "sample_rate", None) or DEFAULT_SAMPLE_RATE)
    # Mono mix if stereo
    import numpy as np

    mono = np.mean(arr, axis=0) if ch > 1 else arr[0]
    return mono, sr, "audiocraft"


def generate_musicgen_sample(
    prompt: str,
    *,
    duration_sec: float | None = None,
    model_id: str | None = None,
) -> dict[str, Any]:
    """
    Returns dict: ok, message, path (optional), audio_b64 (WAV), sample_rate, engine.
    """
    text = (prompt or "").strip()
    if not text:
        return {"ok": False, "message": "Prompt is required.", "engine": "musicgen"}
    try:
        import torch
    except ImportError:
        return {
            "ok": False,
            "message": "PyTorch is not installed. Run: pip install -r knowledge/requirements-audio.txt",
            "engine": "musicgen",
        }

    dur = _resolve_duration_sec(text, duration_sec)
    text = _maybe_enrich_one_shot_prompt(text)
    if len(text) > 800:
        text = text[:800]

    mid = (model_id or os.environ.get("BUTLER_MUSICGEN_MODEL") or "facebook/musicgen-small").strip()

    device = "cuda" if torch.cuda.is_available() else "cpu"
    out_dir = ensure_butlor_config_dir() / "audio_samples"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"musicgen_{_slug(text)}_{int(dur)}s.wav"

    engine_backend = os.environ.get("BUTLER_MUSICGEN_BACKEND", "").strip().lower()
    wav_np = None
    sr = DEFAULT_SAMPLE_RATE
    backend = ""

    try:
        if engine_backend == "audiocraft":
            wav_np, sr, backend = _generate_audiocraft(text, mid, dur, device)
        elif engine_backend == "transformers":
            wav_np, sr, backend = _generate_transformers(text, mid, dur, device)
        else:
            try:
                wav_np, sr, backend = _generate_transformers(text, mid, dur, device)
            except ImportError:
                wav_np, sr, backend = _generate_audiocraft(text, mid, dur, device)
    except ImportError as e:
        return {
            "ok": False,
            "message": (
                "MusicGen deps missing. Run: pip install -r knowledge/requirements-audio.txt "
                f"(torch + transformers). ({e})"
            ),
            "engine": "musicgen",
        }
    except Exception as e:
        return {
            "ok": False,
            "message": f"MusicGen failed: {str(e)[:500]}",
            "engine": "musicgen",
        }

    import numpy as np

    w = np.asarray(wav_np, dtype=np.float64).flatten()
    target_samples = max(1, int(float(sr) * float(dur)))
    if w.size > target_samples:
        w = w[:target_samples]
    mx = float(np.abs(w).max()) if w.size else 0.0
    if mx > 1.0:
        w = w / (mx + 1e-8)

    try:
        raw_wav = _wav_from_float_mono(w, sr)
        out_path.write_bytes(raw_wav)
        b64 = base64.b64encode(raw_wav).decode("ascii")
    except Exception as e:
        return {
            "ok": False,
            "message": f"Could not encode WAV: {str(e)[:320]}",
            "engine": "musicgen",
        }

    actual_sec = float(w.size) / float(sr) if sr else float(dur)
    return {
        "ok": True,
        "message": (
            f"Generated ~{actual_sec:.1f}s clip ({mid}, {device}, {backend}). "
            "MusicGen tends to add layers; use a short duration plus phrases like 'no drums' / 'bass only' for simpler results. "
            "Saved beside your Butler data."
        ),
        "path": str(out_path),
        "audio_b64": b64,
        "sample_rate": sr,
        "engine": f"musicgen:{mid}:{backend}",
    }
