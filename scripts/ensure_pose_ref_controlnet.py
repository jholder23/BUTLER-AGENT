#!/usr/bin/env python3
"""
Ensure OpenPose ControlNet assets for Butler pose-ref (Stage B).

Preferred (already used by Face+Pose, ~774MB, fits 12GB VRAM with Juggernaut + --lowvram):
  models/controlnet/control-lora-openposeXL2-rank256.safetensors

Optional full SDXL OpenPose (~5GB, xinsir SOTA by mAP; heavier VRAM):
  models/controlnet/OpenPoseXL2.safetensors
  python scripts/install_pose_controlnet.py

Stage A (text → skeleton) is Butler's pose_openpose_map.py — no extra Comfy custom node required.
Optional research Text-to-Pose (T2P) nodes can be installed separately if desired; Butler does not
depend on them for Pose ref.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

CONTROL_LORA = "control-lora-openposeXL2-rank256.safetensors"
CONTROL_LORA_MIN = 100_000_000
OPENPOSE_FULL = "OpenPoseXL2.safetensors"


def _comfy_root() -> Path:
    raw = (os.environ.get("SD_PROJECT_PATH") or "").strip()
    root = Path(__file__).resolve().parent.parent
    base = Path(raw) if raw else root / "sd"
    if not base.is_absolute():
        base = (root / base).resolve()
    return base / "ComfyUI"


def main() -> int:
    cn = _comfy_root() / "models" / "controlnet"
    cn.mkdir(parents=True, exist_ok=True)
    lora = cn / CONTROL_LORA
    if lora.is_file() and lora.stat().st_size >= CONTROL_LORA_MIN:
        print(f"OK (preferred for 12GB VRAM): {lora}")
        print(f"  size={lora.stat().st_size / 1e6:.0f} MB")
    else:
        print(f"MISSING: {lora}", file=sys.stderr)
        print(
            "Download from:\n"
            "  https://huggingface.co/thibaud/controlnet-openpose-sdxl-1.0/"
            "resolve/main/control-lora-openposeXL2-rank256.safetensors",
            file=sys.stderr,
        )
        return 1

    full = cn / OPENPOSE_FULL
    if full.is_file() and full.stat().st_size > 1_000_000_000:
        print(f"Also present (optional full ControlNet): {full}")
    else:
        print(f"Optional full OpenPoseXL2 not present (OK) — use: python scripts/install_pose_controlnet.py")

    print()
    print("Pose-ref workflow: knowledge/comfy_workflows/txt2img_pose_reference_controlnet.json")
    print("Stage A helper: knowledge/pose_openpose_map.py")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
