#!/usr/bin/env python3
"""
Install assets + deps for Butler FaceID img2img (exact face, local uncensored prompting).

Fetches into SD_PROJECT_PATH or <Butler>/sd:
  - ComfyUI/models/clip_vision/CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors  (IPAdapter FaceID SDXL)
  - ComfyUI/models/ipadapter/portrait.sdxl.unnorm.bin  (FaceID portrait unnorm; Comfy naming)

Optional:
  - git clone ComfyUI_IPAdapter_plus into ComfyUI/custom_nodes/
  - pip install huggingface_hub insightface onnxruntime  (use ComfyUI's python.exe for best results)

Run (from Butler repo root):

  pip install huggingface_hub
  python scripts/install_faceid_stack.py

Use Comfy's embedded Python if you run portable Comfy:

  ..\\ComfyUI\\python_embeded\\python.exe -m pip install huggingface_hub insightface onnxruntime
  ..\\ComfyUI\\python_embeded\\python.exe scripts\\install_faceid_stack.py

For FaceDetailer / Impact workflows also run: python scripts/install_comfy_explicit_nodes.py
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

REPO_IPADAPTER = "h94/IP-Adapter"
REPO_FACEID = "h94/IP-Adapter-FaceID"
CLIP_REMOTE = "models/image_encoder/model.safetensors"
CLIP_LOCAL = "CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors"
FACEID_UNNORM_REMOTE = "ip-adapter-faceid-portrait_sdxl_unnorm.bin"
FACEID_UNNORM_LOCAL = "portrait.sdxl.unnorm.bin"
IPADAPTER_PLUS_GIT = "https://github.com/cubiq/ComfyUI_IPAdapter_plus.git"


def _butler_root() -> Path:
    return Path(__file__).resolve().parent.parent


def _comfy_root() -> Path:
    raw = (os.environ.get("SD_PROJECT_PATH") or "").strip()
    if raw:
        base = Path(raw)
        if not base.is_absolute():
            base = (_butler_root() / raw).resolve()
    else:
        base = _butler_root() / "sd"
    return base / "ComfyUI"


def _pip_install() -> bool:
    """
    Install Python deps into the *current* interpreter. FaceID needs insightface inside
    **ComfyUI's** Python (same one that runs Comfy). If this fails (e.g. Python 3.13, no MSVC),
    install manually: ComfyUI\\python_embeded\\python.exe -m pip install insightface onnxruntime
    """
    try:
        r = subprocess.run(
            [sys.executable, "-m", "pip", "install", "huggingface_hub", "insightface", "onnxruntime"],
            check=False,
        )
        return r.returncode == 0
    except OSError:
        return False


def _hf_download(repo: str, remote: str, dest_dir: Path, local_name: str, min_bytes: int = 1_000_000) -> Path | None:
    """Download one file from HF; move/rename into dest_dir/local_name (flat)."""
    dest_dir.mkdir(parents=True, exist_ok=True)
    out_path = dest_dir / local_name
    if out_path.is_file() and out_path.stat().st_size > min_bytes:
        print(f"Already present: {out_path}")
        return out_path
    try:
        from huggingface_hub import hf_hub_download
    except ImportError:
        print("Install: pip install huggingface_hub", file=sys.stderr)
        return None
    print(f"Downloading {repo}/{remote} …")
    tmp = hf_hub_download(repo_id=repo, filename=remote, local_dir=str(dest_dir))
    src = Path(tmp)
    dst = dest_dir / local_name
    if src.resolve() != dst.resolve():
        if dst.exists():
            dst.unlink()
        dst.parent.mkdir(parents=True, exist_ok=True)
        src.rename(dst)
        print(f"Placed: {dst}")
    else:
        print(f"Saved: {dst}")
    return dst


def _clone_ipadapter_plus(comfy_root: Path) -> None:
    dest = comfy_root / "custom_nodes" / "ComfyUI_IPAdapter_plus"
    marker = dest / "IPAdapterPlus.py"
    if marker.is_file():
        print(f"ComfyUI_IPAdapter_plus already at {dest}")
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        subprocess.run(
            ["git", "clone", "--depth", "1", IPADAPTER_PLUS_GIT, str(dest)],
            check=True,
            cwd=str(dest.parent),
        )
        print(f"Cloned {IPADAPTER_PLUS_GIT} → {dest}")
    except (OSError, subprocess.CalledProcessError) as e:
        print(
            "git clone failed; install ComfyUI_IPAdapter_plus manually:\n"
            f"  git clone {IPADAPTER_PLUS_GIT} \"{dest}\"",
            file=sys.stderr,
        )
        print(f"({e})", file=sys.stderr)


def main() -> int:
    ap = argparse.ArgumentParser(description="Download FaceID + CLIP Vision for IPAdapter (ComfyUI).")
    ap.add_argument("--skip-pip", action="store_true", help="Do not install insightface/onnxruntime.")
    ap.add_argument("--skip-git", action="store_true", help="Do not clone ComfyUI_IPAdapter_plus.")
    args = ap.parse_args()

    comfy = _comfy_root()
    models = comfy / "models"
    clip_dir = models / "clip_vision"
    ipa_dir = models / "ipadapter"

    pip_ok = True
    if not args.skip_pip:
        pip_ok = _pip_install()
        if not pip_ok:
            print(
                "\n*** pip install failed (common on Python 3.13 or without MSVC). "
                "Install deps with ComfyUI's Python, e.g.:\n"
                '  "D:\\...\\ComfyUI\\python_embeded\\python.exe" -m pip install insightface onnxruntime huggingface_hub\n',
                file=sys.stderr,
            )

    r = _hf_download(REPO_IPADAPTER, CLIP_REMOTE, clip_dir, CLIP_LOCAL)
    if r is None:
        return 1

    r2 = _hf_download(REPO_FACEID, FACEID_UNNORM_REMOTE, ipa_dir, FACEID_UNNORM_LOCAL)
    if r2 is None:
        return 1

    if not args.skip_git:
        _clone_ipadapter_plus(comfy)

    insight_root = models / "insightface"
    print()
    print("Done. Restart ComfyUI after first install.")
    print(f"InsightFace will download buffalo_l into: {insight_root} on first FaceID run (or pre-download).")
    print("No guardrails in Butler: leave base prompts empty; optional BUTLER_SKIP_SD_PROMPT_ENHANCE=1 for raw CLIP text.")
    print("FaceDetailer / YOLO: python scripts/install_comfy_explicit_nodes.py")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
