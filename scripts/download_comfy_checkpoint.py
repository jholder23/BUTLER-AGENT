#!/usr/bin/env python3
"""
Download a Stable Diffusion checkpoint into ComfyUI/models/checkpoints for Butler's SD tree.

  pip install huggingface_hub
  python scripts/download_comfy_checkpoint.py --preset pony-xl
  python scripts/download_comfy_checkpoint.py --repo stabilityai/stable-diffusion-xl-base-1.0 --file sd_xl_base_1.0.safetensors

Default output: <Butler repo>/sd/ComfyUI/models/checkpoints (override with SD_PROJECT_PATH in .env).
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

_PRESETS: dict[str, tuple[str, str]] = {
    # ~6.9 GB — SDXL, widely used for flexible local generation (incl. NSFW); needs GPU VRAM for Comfy.
    "pony-xl": (
        "LyliaEngine/Pony_Diffusion_V6_XL",
        "ponyDiffusionV6XL_v6StartWithThisOne.safetensors",
    ),
    # Official SDXL base (~6.5 GB) — neutral baseline; good if you want stock Stability weights.
    "sdxl-base": (
        "stabilityai/stable-diffusion-xl-base-1.0",
        "sd_xl_base_1.0.safetensors",
    ),
}


def _butler_root() -> Path:
    return Path(__file__).resolve().parent.parent


def _checkpoints_dir() -> Path:
    raw = (os.environ.get("SD_PROJECT_PATH") or "").strip()
    if raw:
        base = Path(raw)
        if not base.is_absolute():
            base = (_butler_root() / raw).resolve()
    else:
        base = _butler_root() / "sd"
    return base / "ComfyUI" / "models" / "checkpoints"


def main() -> int:
    ap = argparse.ArgumentParser(description="Download a .safetensors checkpoint into ComfyUI checkpoints.")
    ap.add_argument(
        "--preset",
        choices=sorted(_PRESETS.keys()),
        help="Known Hugging Face checkpoints (pony-xl = Pony Diffusion V6 XL; sdxl-base = Stability SDXL base).",
    )
    ap.add_argument("--repo", help="Hugging Face repo id, e.g. stabilityai/stable-diffusion-xl-base-1.0")
    ap.add_argument("--file", help="Filename inside the repo, e.g. sd_xl_base_1.0.safetensors")
    ap.add_argument(
        "--output-dir",
        type=Path,
        help="Override checkpoints folder (default: SD_PROJECT_PATH/ComfyUI/models/checkpoints or Butler/sd/...).",
    )
    args = ap.parse_args()

    if args.preset:
        repo, filename = _PRESETS[args.preset]
    elif args.repo and args.file:
        repo, filename = args.repo, args.file
    else:
        ap.error("Pass --preset pony-xl|sdxl-base or both --repo and --file")

    out = args.output_dir or _checkpoints_dir()
    out.mkdir(parents=True, exist_ok=True)

    try:
        from huggingface_hub import hf_hub_download
    except ImportError:
        print("Install: pip install huggingface_hub", file=sys.stderr)
        return 1

    print(f"Repo: {repo}")
    print(f"File: {filename}")
    print(f"Destination: {out}")
    print("Downloading (large file — can take a while)…")
    path = hf_hub_download(
        repo_id=repo,
        filename=filename,
        local_dir=str(out),
    )
    print(f"Done: {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
