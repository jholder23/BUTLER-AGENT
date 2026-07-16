#!/usr/bin/env python3
"""
Download Wan 2.1 weights for Butler's bundled Comfy workflows
(knowledge/comfy_workflows/butler_txt2video.json, butler_img2video.json).

For sharper photoreal motion, upgrade to a Wan 2.2 image→video graph in Comfy (official templates + docs:
https://docs.comfy.org/tutorials/video/wan/wan2_2 ) and point Butler at your API export via
COMFY_IMG2VIDEO_WORKFLOW / comfy_config.json img2video_workflow — see knowledge/COMFY_VIDEO_SETUP.txt.
This script only fetches the Wan 2.1 repack used by the bundled JSON files.

Places files under <ComfyUI>/models/{vae,text_encoders,diffusion_models,clip_vision}/

Uses Hugging Face repo: Comfy-Org/Wan_2.1_ComfyUI_repackaged (public).

Examples:
  py -3 download_wan_models.py                    # text→video only (~9.5 GB)
  py -3 download_wan_models.py --image2video        # + image→video (adds ~33 GB bf16 i2v + ~1.2 GB vision)
  py -3 download_wan_models.py --image2video --i2v-fp8   # smaller i2v UNET (~16 GB) instead of bf16
  py -3 download_wan_models.py --dry-run
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

REPO = "Comfy-Org/Wan_2.1_ComfyUI_repackaged"
REV = "main"


def _comfy_root_from_env() -> Path:
    try:
        from config import SD_PROJECT_PATH  # noqa: WPS433

        root = (SD_PROJECT_PATH or "").strip()
    except ImportError:
        root = (os.environ.get("SD_PROJECT_PATH") or "").strip()
    if not root:
        root = str(Path(__file__).resolve().parent.parent / "sd")
    return Path(root) / "ComfyUI"


def _hf_url(relpath: str) -> str:
    return f"https://huggingface.co/{REPO}/resolve/{REV}/{relpath}"


def _download_requests(url: str, dest: Path, chunk: int = 8 * 1024 * 1024) -> None:
    try:
        import requests
    except ImportError as e:
        raise SystemExit("Install requests: pip install requests") from e

    dest.parent.mkdir(parents=True, exist_ok=True)
    partial = dest.with_suffix(dest.suffix + ".partial")
    headers = {}
    token = (os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN") or "").strip()
    if token:
        headers["Authorization"] = f"Bearer {token}"

    if partial.exists():
        partial.unlink()

    with requests.get(url, stream=True, timeout=60, headers=headers) as r:
        r.raise_for_status()
        total = int(r.headers.get("content-length") or 0)
        done = 0
        with open(partial, "wb") as f:
            for block in r.iter_content(chunk_size=chunk):
                if block:
                    f.write(block)
                    done += len(block)
                    if total and done % (chunk * 16) < chunk:
                        pct = 100 * done / total
                        print(f"\r  {dest.name}  {pct:.1f}%", end="", flush=True)
        print()
    partial.replace(dest)


def _try_hf_hub_download(repo_file: str, dest: Path) -> bool:
    try:
        from huggingface_hub import hf_hub_download
    except ImportError:
        return False
    token = (os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN") or "").strip()
    cache = hf_hub_download(
        repo_id=REPO,
        filename=repo_file,
        revision=REV,
        token=token or None,
    )
    import shutil

    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(cache, dest)
    return True


def _fetch(repo_subpath: str, dest: Path, dry_run: bool, prefer_hub: bool) -> None:
    if dest.exists() and dest.stat().st_size > 1024:
        print(f"OK skip (exists): {dest}")
        return
    if dry_run:
        print(f"DRY: {repo_subpath} -> {dest}")
        return
    print(f"GET {repo_subpath}")
    if prefer_hub and _try_hf_hub_download(repo_subpath, dest):
        print(f"OK {dest}")
        return
    _download_requests(_hf_url(repo_subpath), dest)
    print(f"OK {dest}")


def main() -> None:
    ap = argparse.ArgumentParser(description="Download Wan 2.1 models for Butler Comfy video workflows.")
    ap.add_argument("--comfy-root", type=Path, help="Path to ComfyUI folder (contains models/). Default: SD_PROJECT_PATH/ComfyUI or <Butler>/sd/ComfyUI")
    ap.add_argument("--image2video", action="store_true", help="Also download i2v UNET + CLIP-Vision (large).")
    ap.add_argument(
        "--i2v-fp8",
        action="store_true",
        help="Use fp8 i2v UNET (~16 GB) instead of bf16 (~33 GB). Butler remaps loaders via object_info.",
    )
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--prefer-huggingface-hub", action="store_true", help="Use huggingface_hub if installed (cache + resume).")
    args = ap.parse_args()

    comfy = args.comfy_root or _comfy_root_from_env()
    models = comfy / "models"
    if not args.dry_run:
        print(f"ComfyUI root: {comfy.resolve()}")
        print("Downloading from Hugging Face (public). Large files may take a long time.\n")

    # Text→video (matches butler_txt2video.json)
    jobs: list[tuple[str, Path]] = [
        ("split_files/vae/wan_2.1_vae.safetensors", models / "vae" / "wan_2.1_vae.safetensors"),
        (
            "split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors",
            models / "text_encoders" / "umt5_xxl_fp8_e4m3fn_scaled.safetensors",
        ),
        (
            "split_files/diffusion_models/wan2.1_t2v_1.3B_bf16.safetensors",
            models / "diffusion_models" / "wan2.1_t2v_1.3B_bf16.safetensors",
        ),
    ]

    if args.image2video:
        i2v_name = (
            "split_files/diffusion_models/wan2.1_i2v_480p_14B_fp8_e4m3fn.safetensors"
            if args.i2v_fp8
            else "split_files/diffusion_models/wan2.1_i2v_480p_14B_bf16.safetensors"
        )
        i2v_dest = models / "diffusion_models" / Path(i2v_name).name
        jobs.append((i2v_name, i2v_dest))
        jobs.append(
            ("split_files/clip_vision/clip_vision_h.safetensors", models / "clip_vision" / "clip_vision_h.safetensors")
        )

    # Some Comfy builds only scan models/unet; mirror diffusion UNETs there (same file, two paths).
    mirror_unet = not args.dry_run
    for repo_path, dest in list(jobs):
        _fetch(repo_path, dest, args.dry_run, args.prefer_huggingface_hub)
        if mirror_unet and "diffusion_models" in repo_path and dest.suffix == ".safetensors":
            alt = models / "unet" / dest.name
            if not alt.exists() or alt.stat().st_size != dest.stat().st_size:
                if args.dry_run:
                    print(f"DRY mirror -> {alt}")
                else:
                    alt.parent.mkdir(parents=True, exist_ok=True)
                    try:
                        if alt.exists():
                            alt.unlink()
                        os.link(dest, alt)
                        print(f"OK hardlink mirror: {alt}")
                    except OSError:
                        import shutil

                        shutil.copy2(dest, alt)
                        print(f"OK copy mirror: {alt}")

    if args.dry_run:
        return

    print("\nDone. Restart ComfyUI so /object_info lists the new files.")
    if not args.image2video:
        print("For image-to-video, re-run with: --image2video")


if __name__ == "__main__":
    main()
