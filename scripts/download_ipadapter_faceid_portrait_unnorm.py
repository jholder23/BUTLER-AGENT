#!/usr/bin/env python3
"""
Optional: only needed if you use FaceID workflows (e.g. img2img_butler_faceid_explicit_ultimate_nsfw).
Butler’s default img2img is img2img_butler_sdxl_vae_simple (VAE+KSampler only — no IPAdapter files).

Comfy expects: portrait.sdxl.unnorm.(safetensors|bin)
Hugging Face ships: ip-adapter-faceid-portrait_sdxl_unnorm.bin — we rename to match Comfy’s pattern.

  pip install huggingface_hub
  python scripts/download_ipadapter_faceid_portrait_unnorm.py
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

REPO = "h94/IP-Adapter-FaceID"
REMOTE = "ip-adapter-faceid-portrait_sdxl_unnorm.bin"
# Must match ComfyUI_IPAdapter_plus/utils.py get_ipadapter_file() for "faceid portrait unnorm" + SDXL:
LOCAL = "portrait.sdxl.unnorm.bin"


def _butler_root() -> Path:
    return Path(__file__).resolve().parent.parent


def _ipadapter_dir() -> Path:
    raw = (os.environ.get("SD_PROJECT_PATH") or "").strip()
    if raw:
        base = Path(raw)
        if not base.is_absolute():
            base = (_butler_root() / raw).resolve()
    else:
        base = _butler_root() / "sd"
    return base / "ComfyUI" / "models" / "ipadapter"


def main() -> int:
    dest_dir = _ipadapter_dir()
    dest_dir.mkdir(parents=True, exist_ok=True)
    out_path = dest_dir / LOCAL

    if out_path.is_file() and out_path.stat().st_size > 1_000_000_000:
        print(f"Already present: {out_path}")
        return 0

    try:
        from huggingface_hub import hf_hub_download
    except ImportError:
        print("Install: pip install huggingface_hub", file=sys.stderr)
        return 1

    print(f"Downloading {REPO}/{REMOTE} …")
    tmp = hf_hub_download(repo_id=REPO, filename=REMOTE, local_dir=str(dest_dir))
    src = Path(tmp)
    dst = dest_dir / LOCAL
    if src.resolve() != dst.resolve():
        if dst.exists():
            dst.unlink()
        src.rename(dst)
        print(f"Renamed HF file → Comfy expected name: {dst}")
    else:
        print(f"Saved: {dst}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
