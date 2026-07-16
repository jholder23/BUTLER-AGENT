#!/usr/bin/env python3
"""Install comfyui_controlnet_aux (DWPreprocessor) + optional OpenPose XL ControlNet."""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

AUX_GIT = "https://github.com/Fannovel16/comfyui_controlnet_aux.git"
OPENPOSE_REPO = "xinsir/controlnet-openpose-sdxl-1.0"
OPENPOSE_FILE = "OpenPoseXL2.safetensors"


def _comfy_root() -> Path:
    raw = (os.environ.get("SD_PROJECT_PATH") or "").strip()
    root = Path(__file__).resolve().parent.parent
    base = Path(raw) if raw else root / "sd"
    if not base.is_absolute():
        base = (root / base).resolve()
    return base / "ComfyUI"


def main() -> int:
    comfy = _comfy_root()
    aux = comfy / "custom_nodes" / "comfyui_controlnet_aux"
    python_exe = comfy / "venv" / "Scripts" / "python.exe"
    if not python_exe.is_file():
        python_exe = Path(sys.executable)

    if not (aux / "node_wrappers" / "dwpose.py").is_file():
        subprocess.run(
            ["git", "clone", "--depth", "1", AUX_GIT, str(aux)],
            check=True,
        )
        print(f"Cloned controlnet_aux → {aux}")

    req = aux / "requirements.txt"
    if req.is_file():
        print("Installing Python deps (stop ComfyUI first if pip reports Access denied)…")
        r = subprocess.run(
            [str(python_exe), "-m", "pip", "install", "-r", str(req)],
            check=False,
        )
        if r.returncode != 0:
            print("pip failed — close ComfyUI and rerun this script.", file=sys.stderr)
            return r.returncode

    # Quick import check
    r = subprocess.run(
        [
            str(python_exe),
            "-c",
            "import importlib; m=importlib.import_module('custom_nodes.comfyui_controlnet_aux.node_wrappers.dwpose'); "
            "assert 'DWPreprocessor' in m.NODE_CLASS_MAPPINGS; print('DWPreprocessor OK')",
        ],
        cwd=str(comfy),
        check=False,
    )
    if r.returncode != 0:
        return r.returncode

    cn_dir = comfy / "models" / "controlnet"
    cn_dir.mkdir(parents=True, exist_ok=True)
    openpose = cn_dir / OPENPOSE_FILE
    if not openpose.is_file() or openpose.stat().st_size < 1_000_000_000:
        try:
            from huggingface_hub import hf_hub_download

            print(f"Downloading {OPENPOSE_FILE} …")
            hf_hub_download(
                repo_id=OPENPOSE_REPO,
                filename=OPENPOSE_FILE,
                local_dir=str(cn_dir),
            )
        except Exception as e:
            print(f"OpenPose XL download skipped ({e}) — optional unless using pose ref ControlNet.")

    print()
    print("Restart ComfyUI. DWPreprocessor should load under ControlNet Preprocessors.")
    print(f"OpenPose model: {openpose}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
