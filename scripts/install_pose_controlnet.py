#!/usr/bin/env python3
"""Download OpenPoseXL2.safetensors for optional pose-reference ControlNet."""
from __future__ import annotations

import os
import sys
from pathlib import Path

REPO = "xinsir/controlnet-openpose-sdxl-1.0"
FILE = "OpenPoseXL2.safetensors"
MIN_BYTES = 4_500_000_000  # ~5GB


def _comfy_root() -> Path:
    raw = (os.environ.get("SD_PROJECT_PATH") or "").strip()
    root = Path(__file__).resolve().parent.parent
    base = Path(raw) if raw else root / "sd"
    if not base.is_absolute():
        base = (root / base).resolve()
    return base / "ComfyUI"


def main() -> int:
    cn_dir = _comfy_root() / "models" / "controlnet"
    cn_dir.mkdir(parents=True, exist_ok=True)
    dest = cn_dir / FILE
    if dest.is_file() and dest.stat().st_size >= MIN_BYTES:
        print(f"Already present: {dest}")
        return 0
    try:
        from huggingface_hub import hf_hub_download

        print(f"Downloading {FILE} (~5GB) to {cn_dir} …")
        print("This can take 10–30+ minutes depending on connection.")
        hf_hub_download(
            repo_id=REPO,
            filename=FILE,
            local_dir=str(cn_dir),
            resume_download=True,
        )
    except Exception as e:
        print(f"Download failed: {e}", file=sys.stderr)
        print("Manual: https://huggingface.co/xinsir/controlnet-openpose-sdxl-1.0", file=sys.stderr)
        return 1
    if dest.is_file() and dest.stat().st_size >= MIN_BYTES:
        print(f"OK: {dest}")
        return 0
    print(f"File missing or too small after download: {dest}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
