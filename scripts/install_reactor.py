#!/usr/bin/env python3
"""Install ComfyUI-ReActor + inswapper_128.onnx for pixel-accurate face swap."""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

REACTOR_GIT = "https://github.com/Gourieff/ComfyUI-ReActor.git"
INSWAPPER_URL = "https://huggingface.co/datasets/Gourieff/ReActor/resolve/main/models/inswapper_128.onnx"
BUFFALO_FILES = (
    "det_10g.onnx",
    "w600k_r50.onnx",
    "1k3d68.onnx",
    "2d106det.onnx",
    "genderage.onnx",
)
BUFFALO_REPO = "Gourieff/ReActor"


def _comfy_root() -> Path:
    raw = (os.environ.get("SD_PROJECT_PATH") or "").strip()
    root = Path(__file__).resolve().parent.parent
    base = Path(raw) if raw else root / "sd"
    if not base.is_absolute():
        base = (root / base).resolve()
    return base / "ComfyUI"


def _patch_reactor_nsfw_filter(reactor: Path) -> None:
    """Disable ReActor NSFW block — otherwise NSFW generations return black 512x512."""
    sfw = reactor / "scripts" / "reactor_sfw.py"
    if not sfw.is_file():
        return
    text = sfw.read_text(encoding="utf-8")
    marker = "_DISABLE_NSFW_BLOCK"
    if marker in text:
        print("ReActor NSFW filter already patched.")
        return
    needle = "SCORE = 0.979\n\nlogging.getLogger"
    insert = (
        "SCORE = 0.979\n\n"
        "# Butler NSFW workflows: do not block face swap on generated adult content (default ReActor returns black 512x512).\n"
        '_DISABLE_NSFW_BLOCK = os.environ.get("REACTOR_DISABLE_NSFW_FILTER", "1").strip().lower() not in ("0", "false", "no", "off")\n\n'
        "logging.getLogger"
    )
    if needle not in text:
        print("ReActor reactor_sfw.py layout changed — skip NSFW patch.")
        return
    text = text.replace(needle, insert, 1)
    fn_needle = "def nsfw_image(img_data, model_path: str):\n"
    fn_insert = (
        "def nsfw_image(img_data, model_path: str):\n"
        "    if _DISABLE_NSFW_BLOCK:\n"
        "        return False\n"
    )
    if fn_needle not in text:
        print("ReActor nsfw_image() not found — skip NSFW patch.")
        return
    text = text.replace(fn_needle, fn_insert, 1)
    sfw.write_text(text, encoding="utf-8")
    print("Patched ReActor NSFW filter (disabled by default).")


def main() -> int:
    comfy = _comfy_root()
    reactor = comfy / "custom_nodes" / "ComfyUI-ReActor"
    if not (reactor / "nodes.py").is_file():
        subprocess.run(
            ["git", "clone", "--depth", "1", REACTOR_GIT, str(reactor)],
            check=True,
        )
        print(f"Cloned ReActor → {reactor}")

    python_exe = comfy / "venv" / "Scripts" / "python.exe"
    if not python_exe.is_file():
        python_exe = Path(sys.executable)

    inswap = comfy / "models" / "insightface" / "inswapper_128.onnx"
    if not inswap.is_file() or inswap.stat().st_size < 100_000_000:
        try:
            from huggingface_hub import hf_hub_download

            hf_hub_download(
                repo_id="Gourieff/ReActor",
                filename="models/inswapper_128.onnx",
                local_dir=str(comfy / "models" / "insightface"),
            )
            src = comfy / "models" / "insightface" / "models" / "inswapper_128.onnx"
            if src.is_file() and not inswap.is_file():
                src.rename(inswap)
        except Exception:
            import urllib.request

            inswap.parent.mkdir(parents=True, exist_ok=True)
            print("Downloading inswapper_128.onnx …")
            urllib.request.urlretrieve(INSWAPPER_URL, inswap)

    buffalo_dir = comfy / "models" / "insightface" / "models" / "buffalo_l"
    buffalo_dir.mkdir(parents=True, exist_ok=True)
    try:
        from huggingface_hub import hf_hub_download

        for name in BUFFALO_FILES:
            dest = buffalo_dir / name
            if dest.is_file() and dest.stat().st_size > 1000:
                continue
            hf_hub_download(
                repo_id=BUFFALO_REPO,
                filename=f"models/buffalo_l/{name}",
                local_dir=str(buffalo_dir.parent.parent),
            )
            print(f"buffalo_l: {name}")
    except Exception as e:
        print(f"buffalo_l download skipped ({e})")

    try:
        subprocess.run([str(python_exe), str(reactor / "install.py")], check=False)
    except Exception as e:
        print(f"ReActor install.py: {e}")

    _patch_reactor_nsfw_filter(reactor)

    print()
    print("Restart ComfyUI (required after first ReActor install).")
    print(f"inswapper: {inswap}")
    print(f"buffalo_l: {buffalo_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
