#!/usr/bin/env python3
"""
Clone ComfyUI custom nodes commonly used for photoreal / explicit local SDXL workflows
(FaceID identity lock, regional detailers, YOLO-guided FaceDetailer). There is no special
“NSFW-only” node pack — quality comes from uncensored checkpoints + IPAdapter + Impact detailers.

Installs under SD_PROJECT_PATH/ComfyUI/custom_nodes (default: <Butler>/sd/ComfyUI/custom_nodes):

  1. cubiq/ComfyUI_IPAdapter_plus     — IPAdapter / FaceID (see also scripts/install_faceid_stack.py for models)
  2. ltdrdata/ComfyUI-Impact-Pack     — FaceDetailer, SEGS, regional sampling, masks
  3. ltdrdata/ComfyUI-Impact-Subpack  — UltralyticsDetectorProvider + YOLO bbox models for detailers
  4. (optional) ltdrdata/ComfyUI-Manager — UI to install/update other nodes

After cloning, install Python deps with **ComfyUI’s** interpreter (portable Windows example):

  ..\\ComfyUI\\python_embeded\\python.exe -m pip install -r custom_nodes\\comfyui-impact-pack\\requirements.txt
  ..\\ComfyUI\\python_embeded\\python.exe -m pip install -r custom_nodes\\comfyui-impact-subpack\\requirements.txt

Then restart ComfyUI. YOLO weights (e.g. face_yolov8m.pt) are often pulled on first use or via Manager.

  python scripts/install_comfy_explicit_nodes.py
  python scripts/install_comfy_explicit_nodes.py --no-manager
  python scripts/install_comfy_explicit_nodes.py --install-reqs \"D:\\BUTLER\\sd\\ComfyUI\\python_embeded\\python.exe\"
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

# (git url, target folder name under custom_nodes/, marker file relative to that folder)
EXTENSIONS: tuple[tuple[str, str, str], ...] = (
    ("https://github.com/cubiq/ComfyUI_IPAdapter_plus.git", "ComfyUI_IPAdapter_plus", "IPAdapterPlus.py"),
    ("https://github.com/ltdrdata/ComfyUI-Impact-Pack.git", "comfyui-impact-pack", "__init__.py"),
    ("https://github.com/ltdrdata/ComfyUI-Impact-Subpack.git", "comfyui-impact-subpack", "__init__.py"),
    ("https://github.com/Fannovel16/comfyui_controlnet_aux.git", "comfyui_controlnet_aux", "node_wrappers/dwpose.py"),
)
MANAGER: tuple[str, str, str] = (
    "https://github.com/ltdrdata/ComfyUI-Manager.git",
    "ComfyUI-Manager",
    "__init__.py",
)


def _butler_root() -> Path:
    return Path(__file__).resolve().parent.parent


def _custom_nodes_dir() -> Path:
    raw = (os.environ.get("SD_PROJECT_PATH") or "").strip()
    if raw:
        base = Path(raw)
        if not base.is_absolute():
            base = (_butler_root() / raw).resolve()
    else:
        base = _butler_root() / "sd"
    return base / "ComfyUI" / "custom_nodes"


def _clone(url: str, dest: Path, marker: Path) -> bool:
    if marker.is_file():
        print(f"Already present: {dest}")
        return True
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() and not marker.is_file():
        print(f"Remove incomplete folder and retry: {dest}", file=sys.stderr)
        return False
    try:
        subprocess.run(
            ["git", "clone", "--depth", "1", url, str(dest)],
            check=True,
            cwd=str(dest.parent),
        )
        print(f"Cloned -> {dest}")
        return marker.is_file()
    except (OSError, subprocess.CalledProcessError) as e:
        print(f"git clone failed ({url}): {e}", file=sys.stderr)
        print('Install Git for Windows or clone manually into custom_nodes.', file=sys.stderr)
        return False


def _pip_reqs(python_exe: Path, req_file: Path) -> bool:
    if not req_file.is_file():
        return True
    r = subprocess.run([str(python_exe), "-m", "pip", "install", "-r", str(req_file)], check=False)
    return r.returncode == 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Clone ComfyUI custom nodes for FaceID + Impact detailer workflows.")
    ap.add_argument("--no-manager", action="store_true", help="Skip ComfyUI-Manager.")
    ap.add_argument(
        "--install-reqs",
        metavar="PYTHON",
        help="Path to ComfyUI's python.exe: run pip install -r requirements.txt for Impact Pack and Subpack.",
    )
    args = ap.parse_args()

    cn = _custom_nodes_dir()
    ok = True
    for url, folder, marker_name in EXTENSIONS:
        dest = cn / folder
        marker = dest / marker_name
        if not _clone(url, dest, marker):
            ok = False

    if not args.no_manager:
        u, folder, m = MANAGER
        dest = cn / folder
        marker = dest / m
        if not _clone(u, dest, marker):
            ok = False

    py: Path | None = None
    if args.install_reqs:
        py = Path(args.install_reqs)
        if not py.is_file():
            print(f"Python not found: {py}", file=sys.stderr)
            return 1
    else:
        # Suggest portable Comfy path next to custom_nodes
        guess = cn.parent / "python_embeded" / "python.exe"
        if guess.is_file():
            py = guess
            print(f"Found Comfy portable Python: {py}")

    if py and py.is_file():
        for folder in ("comfyui-impact-pack", "comfyui-impact-subpack", "comfyui_controlnet_aux"):
            req = cn / folder / "requirements.txt"
            print(f"pip install -r {req}")
            if not _pip_reqs(py, req):
                ok = False
        print("Restart ComfyUI after pip installs.")

    print()
    print("Models: run python scripts/install_faceid_stack.py for CLIP + FaceID portrait unnorm weights.")
    print("YOLO: FaceDetailer workflows may need bbox/*.pt under ComfyUI/models (see Impact Subpack / Manager).")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
