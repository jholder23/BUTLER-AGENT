"""
Stable Diffusion integration for Butler.
Supports Automatic1111 WebUI API (and compatible UIs like Thank You SD).
Configure SD_API_URL in .env (default http://127.0.0.1:7860).
For custom projects (e.g. Thank You SD), set the base URL where the API is served.
"""
from __future__ import annotations

import base64
import json
import os
import sys
import time
from pathlib import Path

from butlor_paths import get_generated_dir


def _api_url() -> str:
    try:
        from config import SD_API_URL
        return (SD_API_URL or "http://127.0.0.1:7860").rstrip("/")
    except ImportError:
        return os.environ.get("SD_API_URL", "http://127.0.0.1:7860").rstrip("/")


def _sd_project_path() -> str:
    """Path to SD root: <Butler root>/sd (ComfyUI, Forge as subdirs)."""
    try:
        from config import SD_PROJECT_PATH
        return (SD_PROJECT_PATH or "").strip() or str(Path(__file__).resolve().parent.parent / "sd")
    except ImportError:
        return (os.environ.get("SD_PROJECT_PATH") or "").strip() or str(Path(__file__).resolve().parent.parent / "sd")


def _request(method: str, path: str, json_body: dict | None = None, timeout: int = 300) -> dict:
    """Make API request to SD WebUI."""
    try:
        import requests
    except ImportError:
        return {"ok": False, "message": "Install requests: pip install requests"}
    url = f"{_api_url()}{path}"
    try:
        r = requests.post(url, json=json_body or {}, timeout=timeout) if method == "POST" else requests.get(url, timeout=timeout)
        r.raise_for_status()
        return {"ok": True, "data": r.json() if r.content else {}}
    except Exception as e:
        err = str(e)
        if "Connection refused" in err or "Max retries exceeded" in err or "10061" in err:
            root = _sd_project_path()
            return {
                "ok": False,
                "message": (
                    "Forge isn't running. For img2img use ComfyUI—Butler starts it at launch (2–3 min). "
                    f"Or run: cd {root}\\ComfyUI && python main.py. "
                    f"For txt2img run Forge: {root}\\stable-diffusion-webui-forge\\webui.bat --api"
                ),
            }
        return {"ok": False, "message": err}


def txt2img(
    prompt: str,
    negative_prompt: str = "",
    width: int = 512,
    height: int = 512,
    steps: int = 20,
    cfg_scale: float = 7,
    seed: int = -1,
    sampler: str = "Euler",
) -> dict:
    """
    Text-to-image generation.
    Returns dict with ok, message, images (list of base64), path (saved file if configured).
    """
    try:
        from sd_prompt_enhance import merge_prompts_with_user_sd_base

        fp, fn = merge_prompts_with_user_sd_base(prompt, negative_prompt)
    except Exception:
        fp, fn = prompt, negative_prompt
    payload = {
        "prompt": fp,
        "negative_prompt": fn or "ugly, blurry, low quality",
        "width": width,
        "height": height,
        "steps": steps,
        "cfg_scale": cfg_scale,
        "seed": seed,
        "sampler_name": sampler,
    }
    out = _request("POST", "/sdapi/v1/txt2img", json_body=payload)
    if not out.get("ok"):
        return {"ok": False, "message": out.get("message", "txt2img failed"), "images": []}
    data = out.get("data", {})
    images = data.get("images", [])
    if not images:
        return {"ok": False, "message": "No images returned", "images": []}
    path_saved = _save_image(images[0], "txt2img")
    return {
        "ok": True,
        "message": f"Generated image from: {prompt[:60]}...",
        "images": images,
        "path": path_saved,
        "info": data.get("info", ""),
    }


def img2img(
    prompt: str,
    init_image_b64: str,
    negative_prompt: str = "",
    denoising_strength: float = 0.7,
    width: int = 512,
    height: int = 512,
    steps: int = 20,
    cfg_scale: float = 7,
    seed: int = -1,
) -> dict:
    """
    Image-to-image generation. init_image_b64 is base64-encoded PNG/JPEG.
    """
    try:
        from sd_prompt_enhance import merge_prompts_with_user_sd_base

        fp, fn = merge_prompts_with_user_sd_base(prompt, negative_prompt)
    except Exception:
        fp, fn = prompt, negative_prompt
    payload = {
        "prompt": fp,
        "negative_prompt": fn or "ugly, blurry, low quality",
        "init_images": [init_image_b64],
        "denoising_strength": denoising_strength,
        "width": width,
        "height": height,
        "steps": steps,
        "cfg_scale": cfg_scale,
        "seed": seed,
    }
    out = _request("POST", "/sdapi/v1/img2img", json_body=payload)
    if not out.get("ok"):
        return {"ok": False, "message": out.get("message", "img2img failed"), "images": []}
    data = out.get("data", {})
    images = data.get("images", [])
    if not images:
        return {"ok": False, "message": "No images returned", "images": []}
    path_saved = _save_image(images[0], "img2img")
    return {
        "ok": True,
        "message": f"Generated image from your input. Prompt: {prompt[:60]}...",
        "images": images,
        "path": path_saved,
        "info": data.get("info", ""),
    }


# Automatic1111 / Forge API paths Butler tries when ComfyUI video workflows are absent (order matters).
SD_FORGE_TXT2VIDEO_PATHS: tuple[str, ...] = (
    "/sdapi/v1/txt2video",
    "/sdapi/v1/text-to-video",
    "/sdapi/v1/video-txt",
    "/txt2video",
)
SD_FORGE_IMG2VIDEO_PATHS: tuple[str, ...] = (
    "/sdapi/v1/video",
    "/sdapi/v1/image-to-video",
    "/sdapi/v1/img2video",
    "/svd/img2vid",
    "/i2v/generate",
)


def _wants_video(message_lower: str) -> bool:
    """Heuristic: user asked for video / animation (used by generate_from_chat)."""
    keys = (
        "video",
        "animate",
        "animation",
        "motion",
        "movie",
        "mp4",
        "gif",
        "text-to-video",
        "text to video",
        "txt2vid",
        "txt2video",
        "image-to-video",
        "image to video",
        "img2vid",
        "img2video",
        "stable video",
        "svd",
        "i2v",
        "t2v",
    )
    return any(k in message_lower for k in keys)


def _script_python_argv() -> list[str]:
    """Interpreter for SD_*VIDEO_SCRIPT subprocesses (Windows: prefer py -3)."""
    exe = getattr(sys, "executable", "") or ""
    if exe and os.path.isfile(exe) and "python" in os.path.basename(exe).lower():
        return [exe]
    if os.name == "nt":
        py = os.path.join(os.environ.get("SystemRoot", "C:\\Windows"), "py.exe")
        if os.path.isfile(py):
            return [py, "-3"]
    return ["python3"]


def txt2video(
    prompt: str,
    frames: int = 14,
    fps: int = 6,
) -> dict:
    """
    Text-to-video: optional script, then ComfyUI workflow (if present), then Forge/A1111 API paths.
    """
    script = os.environ.get("SD_TXT2VIDEO_SCRIPT", "").strip()
    if script and Path(script).exists():
        return _run_txt2video_script(script, prompt, frames, fps)
    skip_comfy = os.environ.get("BUTLER_SKIP_COMFY_VIDEO", "").strip().lower() in ("1", "true", "yes")
    if not skip_comfy:
        try:
            from comfy_video_helper import comfy_txt2video_workflow_exists, txt2video_comfy

            if comfy_txt2video_workflow_exists():
                r = txt2video_comfy(prompt=prompt)
                return r
        except Exception as e:
            return {
                "ok": False,
                "message": f"ComfyUI txt2video error: {e}",
                "images": [],
                "video": "",
            }
    payload = {
        "prompt": prompt,
        "fps": fps,
        "frames": frames,
    }
    for path in SD_FORGE_TXT2VIDEO_PATHS:
        out = _request("POST", path, json_body=payload, timeout=600)
        if not out.get("ok"):
            continue
        data = out.get("data") or {}
        if not isinstance(data, dict):
            continue
        vid = data.get("video") or data.get("output") or data.get("mp4")
        if vid:
            path_saved = _save_video_b64_if_needed(vid, "txt2video")
            return {
                "ok": True,
                "message": f"Generated video from: {prompt[:60]}...",
                "video": vid,
                "images": [],
                "path": path_saved or data.get("path", ""),
            }
    return {
        "ok": False,
        "message": (
            "Text-to-video not available. Options: (1) Add ComfyUI/workflows/butler_txt2video.json (API export) "
            "or set COMFY_TXT2VIDEO_WORKFLOW — see knowledge/COMFY_VIDEO_SETUP.txt. "
            "(2) Forge/A1111 extension with /sdapi/v1/txt2video. "
            "(3) SD_TXT2VIDEO_SCRIPT pointing at a Python script that prints JSON {\"video\":\"<base64>\"}."
        ),
        "images": [],
        "video": "",
    }


def image2video(
    init_image_b64: str,
    prompt: str = "",
    frames: int = 14,
    fps: int = 6,
) -> dict:
    """
    Image-to-video: optional script, then ComfyUI workflow (if present), then Forge extension endpoints.
    """
    script = os.environ.get("SD_VIDEO_SCRIPT", "").strip()
    if script and Path(script).exists():
        return _run_video_script(script, init_image_b64, prompt, frames, fps)
    skip_comfy = os.environ.get("BUTLER_SKIP_COMFY_VIDEO", "").strip().lower() in ("1", "true", "yes")
    if not skip_comfy:
        try:
            from comfy_video_helper import comfy_img2video_workflow_exists, image2video_comfy

            if comfy_img2video_workflow_exists():
                r = image2video_comfy(init_image_b64, prompt=prompt or "smooth motion, cinematic")
                return r
        except Exception as e:
            return {
                "ok": False,
                "message": f"ComfyUI image2video error: {e}",
                "images": [],
                "video": "",
            }
    # Try SVD-style endpoint (some A1111 extensions add this)
    payload = {
        "image": init_image_b64,
        "prompt": prompt or "smooth motion, cinematic",
        "motion_bucket_id": 127,
        "noise_aug_strength": 0.02,
        "fps": fps,
    }
    for path in SD_FORGE_IMG2VIDEO_PATHS:
        out = _request("POST", path, json_body=payload, timeout=600)
        if not out.get("ok"):
            continue
        data = out.get("data") or {}
        if not isinstance(data, dict):
            continue
        vid = data.get("video") or data.get("output") or data.get("mp4") or data.get("frames")
        if vid:
            path_saved = _save_video_b64_if_needed(vid, "img2video")
            return {
                "ok": True,
                "message": "Video generated",
                "video": vid,
                "images": [],
                "path": path_saved or data.get("path", ""),
            }
    return {
        "ok": False,
        "message": (
            "Image-to-video not available. Options: (1) Add ComfyUI/workflows/butler_img2video.json (API export) "
            "or set COMFY_IMG2VIDEO_WORKFLOW — see knowledge/COMFY_VIDEO_SETUP.txt. "
            "(2) SD extension /sdapi/v1/video (or similar). (3) SD_VIDEO_SCRIPT Python script → JSON {\"video\":\"<base64>\"}."
        ),
        "images": [],
    }


def _run_txt2video_script(script: str, prompt: str, frames: int, fps: int) -> dict:
    import subprocess

    try:
        proc = subprocess.run(
            _script_python_argv()
            + [script, "--prompt", prompt, "--frames", str(frames), "--fps", str(fps)],
            capture_output=True,
            text=True,
            timeout=600,
            cwd=os.path.dirname(script),
        )
        if proc.returncode != 0:
            return {"ok": False, "message": proc.stderr or proc.stdout or "Script failed", "images": []}
        out = json.loads(proc.stdout) if proc.stdout.strip() else {}
        vid = out.get("video")
        if not vid:
            return {"ok": False, "message": "Script returned no video field", "images": []}
        path_saved = _save_video_b64_if_needed(vid, "txt2video_script")
        return {
            "ok": True,
            "message": "Video generated",
            "path": out.get("path", "") or path_saved or "",
            "video": vid,
            "images": [],
        }
    except Exception as e:
        return {"ok": False, "message": str(e), "images": []}


def _save_video_b64_if_needed(raw: str, prefix: str) -> str | None:
    """If raw is plausible base64 video bytes, save under Documents/Butlor/generated/."""
    if not raw or len(raw) < 120:
        return None
    s = raw.strip()
    if s.startswith("data:"):
        return None
    if s.endswith(".mp4") and len(s) < 400 and "\n" not in s:
        return None
    try:
        decoded = base64.b64decode(s, validate=False)
        if len(decoded) < 200:
            return None
        out_dir = str(get_generated_dir())
        name = f"{prefix}_{int(time.time())}.mp4"
        path = os.path.join(out_dir, name)
        with open(path, "wb") as f:
            f.write(decoded)
        return path
    except Exception:
        return None


def _run_video_script(script: str, image_b64: str, prompt: str, frames: int, fps: int) -> dict:
    """Run external script for video generation."""
    import subprocess
    try:
        proc = subprocess.run(
            _script_python_argv()
            + [script, "--image", image_b64, "--prompt", prompt, "--frames", str(frames), "--fps", str(fps)],
            capture_output=True,
            text=True,
            timeout=600,
            cwd=os.path.dirname(script),
        )
        if proc.returncode != 0:
            return {"ok": False, "message": proc.stderr or proc.stdout or "Script failed"}
        out = json.loads(proc.stdout) if proc.stdout.strip() else {}
        vid = out.get("video")
        path_saved = _save_video_b64_if_needed(vid, "img2video_script") if vid else None
        return {
            "ok": True,
            "message": "Video generated",
            "path": out.get("path", "") or path_saved or "",
            "video": vid,
            "images": [],
        }
    except Exception as e:
        return {"ok": False, "message": str(e)}


def _save_image(b64_data: str, prefix: str) -> str | None:
    """Save base64 image to Documents/Butlor/generated/."""
    try:
        out_dir = str(get_generated_dir())
        name = f"{prefix}_{int(time.time())}.png"
        path = os.path.join(out_dir, name)
        with open(path, "wb") as f:
            f.write(base64.b64decode(b64_data))
        return path
    except Exception:
        return None


def generate_from_chat(message: str, init_image_b64: str | None = None) -> dict:
    """
    Parse chat message and dispatch to txt2img, img2img, image2video, or txt2video.
    Examples:
      "draw a cat" -> txt2img
      "make it look like oil painting" + [image] -> img2img
      "turn this into a video" + [image] -> image2video
      "text to video: a cat walking" -> txt2video
    """
    raw = message.strip()
    msg_lower = raw.lower()
    wants_video = _wants_video(msg_lower)
    if init_image_b64:
        if wants_video:
            return image2video(init_image_b64, prompt=raw)
        return img2img(prompt=raw, init_image_b64=init_image_b64)
    if wants_video:
        return txt2video(prompt=raw)
    return txt2img(prompt=raw)
