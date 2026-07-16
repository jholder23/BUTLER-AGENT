#!/usr/bin/env python3
"""
Sync Butler Comfy workflows into ComfyUI's API + UI folders.

Sources:
  - knowledge/comfy_workflows/*.json (bundled)
  - generated catalog entries from comfy_helper.registered_comfy_workflow_names()
  - ComfyUI_IPAdapter_plus/examples/*.json (FaceID / IPAdapter demos)

Targets:
  - <SD>/ComfyUI/workflows/
  - <SD>/ComfyUI/user/default/workflows/   ← ComfyUI sidebar browser
"""
from __future__ import annotations

import json
import os
import shutil
from copy import deepcopy
from pathlib import Path


def _butler_root() -> Path:
    return Path(__file__).resolve().parent.parent


def _sd_root() -> Path:
    raw = (os.environ.get("SD_PROJECT_PATH") or "").strip()
    if raw:
        p = Path(raw)
        return p if p.is_absolute() else (_butler_root() / raw).resolve()
    return _butler_root() / "sd"


def _bundled_dir() -> Path:
    return _butler_root() / "knowledge" / "comfy_workflows"


def _img2img_simple_api(
    name: str,
    *,
    ckpt: str = "juggernautXL_ragnarok.safetensors",
    denoise: float = 0.48,
    sampler: str = "euler_ancestral",
    steps: int = 42,
    cfg: float = 7.2,
) -> dict:
    return {
        "3": {
            "class_type": "KSampler",
            "inputs": {
                "seed": 0,
                "steps": steps,
                "cfg": cfg,
                "sampler_name": sampler,
                "scheduler": "karras",
                "denoise": denoise,
                "model": ["4", 0],
                "positive": ["6", 0],
                "negative": ["7", 0],
                "latent_image": ["8", 0],
            },
        },
        "4": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": ckpt}},
        "6": {
            "class_type": "CLIPTextEncode",
            "inputs": {
                "text": "YOUR SCENE HERE, photorealistic, RAW photo, sharp focus, natural skin texture",
                "clip": ["4", 1],
            },
        },
        "7": {
            "class_type": "CLIPTextEncode",
            "inputs": {
                "text": "cartoon, anime, 3d render, blurry, low quality, deformed, plastic skin",
                "clip": ["4", 1],
            },
        },
        "8": {"class_type": "VAEEncode", "inputs": {"pixels": ["10", 0], "vae": ["4", 2]}},
        "10": {"class_type": "LoadImage", "inputs": {"image": "example.png", "subfolder": ""}},
        "11": {"class_type": "VAEDecode", "inputs": {"samples": ["3", 0], "vae": ["4", 2]}},
        "12": {"class_type": "SaveImage", "inputs": {"filename_prefix": name, "images": ["11", 0]}},
    }


def _txt2img_juggernaut_api(name: str = "txt2img_Juggernaut") -> dict:
    if name == "txt2img_pose_reference_simple":
        return {
            "4": {
                "class_type": "CheckpointLoaderSimple",
                "inputs": {"ckpt_name": "juggernautXL_ragnarok.safetensors"},
            },
            "5": {
                "class_type": "EmptyLatentImage",
                "inputs": {"width": 768, "height": 1152, "batch_size": 1},
            },
            "6": {
                "class_type": "CLIPTextEncode",
                "inputs": {
                    "text": (
                        "(follow the described pose exactly:1.55), single adult person, "
                        "clear human proportions, visible arms legs hands feet, "
                        "full body head to toe in frame, distinct limb separation, "
                        "simple clean clothing, mannequin-like reference figure, "
                        "plain light background"
                    ),
                    "clip": ["4", 1],
                },
            },
            "7": {
                "class_type": "CLIPTextEncode",
                "inputs": {
                    "text": (
                        "silhouette, black silhouette, abstract shape, stick figure, blob, "
                        "featureless body, shadow figure, wrong pose, ignored pose, different pose, "
                        "arms in wrong position, hands in wrong position, legs in wrong position, "
                        "multiple people, crowd, busy background, scenery, furniture, props, clutter, "
                        "cropped body, out of frame, cut off head, cut off feet, hidden hands, "
                        "hidden feet, missing limbs, extra limbs, fused limbs, overlapping limbs, "
                        "text, watermark, logo, nude, nsfw"
                    ),
                    "clip": ["4", 1],
                },
            },
            "3": {
                "class_type": "KSampler",
                "inputs": {
                    "seed": 0,
                    "steps": 32,
                    "cfg": 8.0,
                    "sampler_name": "dpmpp_2m_sde",
                    "scheduler": "karras",
                    "denoise": 1.0,
                    "model": ["4", 0],
                    "positive": ["6", 0],
                    "negative": ["7", 0],
                    "latent_image": ["5", 0],
                },
            },
            "8": {"class_type": "VAEDecode", "inputs": {"samples": ["3", 0], "vae": ["4", 2]}},
            "9": {"class_type": "SaveImage", "inputs": {"filename_prefix": name, "images": ["8", 0]}},
        }
    return {
        "4": {
            "class_type": "CheckpointLoaderSimple",
            "inputs": {"ckpt_name": "juggernautXL_ragnarok.safetensors"},
        },
        "5": {
            "class_type": "EmptyLatentImage",
            "inputs": {"width": 1024, "height": 1024, "batch_size": 1},
        },
        "6": {
            "class_type": "CLIPTextEncode",
            "inputs": {
                "text": "YOUR PROMPT HERE, photorealistic, RAW photo, sharp focus",
                "clip": ["4", 1],
            },
        },
        "7": {
            "class_type": "CLIPTextEncode",
            "inputs": {
                "text": "cartoon, anime, blurry, low quality, deformed",
                "clip": ["4", 1],
            },
        },
        "3": {
            "class_type": "KSampler",
            "inputs": {
                "seed": 0,
                "steps": 34,
                "cfg": 6.5,
                "sampler_name": "dpmpp_2m_sde",
                "scheduler": "karras",
                "denoise": 1.0,
                "model": ["4", 0],
                "positive": ["6", 0],
                "negative": ["7", 0],
                "latent_image": ["5", 0],
            },
        },
        "8": {"class_type": "VAEDecode", "inputs": {"samples": ["3", 0], "vae": ["4", 2]}},
        "9": {"class_type": "SaveImage", "inputs": {"filename_prefix": name, "images": ["8", 0]}},
    }


def _patch_supreme_ui(
    data: dict,
    *,
    weight: float,
    weight_v2: float,
    end_at: float,
    denoise: float,
    preset: str | None = None,
    lora_strength: float | None = None,
) -> dict:
    out = deepcopy(data)
    for node in out.get("nodes", []):
        t = node.get("type")
        if t == "IPAdapterFaceID" and node.get("widgets_values"):
            w = list(node["widgets_values"])
            if len(w) >= 6:
                w[0], w[1], w[5] = weight, weight_v2, end_at
                node["widgets_values"] = w
        elif t == "KSampler" and node.get("widgets_values"):
            w = list(node["widgets_values"])
            if len(w) >= 7:
                w[6] = denoise
                node["widgets_values"] = w
        elif t == "IPAdapterUnifiedLoaderFaceID" and node.get("widgets_values"):
            w = list(node["widgets_values"])
            if preset and len(w) >= 1:
                w[0] = preset
            if lora_strength is not None and len(w) >= 2:
                w[1] = lora_strength
            node["widgets_values"] = w
    return out


def _generate_missing(bundled: Path) -> list[Path]:
    created: list[Path] = []
    supreme_src = bundled / "img2img_juggernaut_faceid_supreme_nsfw.json"
    supreme = json.loads(supreme_src.read_text(encoding="utf-8")) if supreme_src.is_file() else None

    simple_specs = {
        "img2img_Juggernaut": _img2img_simple_api("img2img_Juggernaut"),
        "img2img_nsfw_compare_lock": _img2img_simple_api(
            "img2img_nsfw_compare_lock", denoise=0.32, sampler="dpmpp_2m", steps=36, cfg=6.0
        ),
        "img2img_nsfw_compare_balanced": _img2img_simple_api(
            "img2img_nsfw_compare_balanced", denoise=0.48, sampler="euler_ancestral"
        ),
        "img2img_nsfw_compare_bold": _img2img_simple_api(
            "img2img_nsfw_compare_bold", denoise=0.72, sampler="euler_ancestral", steps=44
        ),
        "txt2img_Juggernaut": _txt2img_juggernaut_api(),
        "txt2img_pose_reference_simple": _txt2img_juggernaut_api("txt2img_pose_reference_simple"),
        "txt2img_pose_reference_controlnet": None,  # shipped as dedicated API JSON; do not regenerate
        "txt2img_faceid_Juggernaut": _txt2img_juggernaut_api("txt2img_faceid_Juggernaut"),
        "txt2img_faceid_Juggernaut_facemax": _txt2img_juggernaut_api("txt2img_faceid_Juggernaut_facemax"),
        "txt2img_faceid_NSFW_ultra": _txt2img_juggernaut_api("txt2img_faceid_NSFW_ultra"),
        "txt2img_faceid_Juggernaut_facefocus": _txt2img_juggernaut_api("txt2img_faceid_Juggernaut_facefocus"),
    }
    for name, body in simple_specs.items():
        if body is None:
            continue
        p = bundled / f"{name}.json"
        if not p.exists():
            p.write_text(json.dumps(body, indent=2), encoding="utf-8")
            created.append(p)

    if supreme:
        supreme_variants = {
            "img2img_faceid_FULL_SETUP": dict(weight=0.98, weight_v2=1.78, end_at=0.88, denoise=0.5),
            "img2img_faceid_NSFW_ultra": dict(weight=0.98, weight_v2=1.72, end_at=0.86, denoise=0.52),
            "img2img_faceid_NSFW_adherent": dict(weight=0.94, weight_v2=1.65, end_at=0.82, denoise=0.5),
            "img2img_faceid_NSFW_face_tight": dict(weight=0.99, weight_v2=1.85, end_at=0.9, denoise=0.46),
            "img2img_faceid_NSFW_natural": dict(weight=0.72, weight_v2=1.15, end_at=0.62, denoise=0.62),
            "img2img_faceid_Juggernaut_working": dict(weight=0.82, weight_v2=1.35, end_at=0.72, denoise=0.55),
            "img2img_faceid_Juggernaut": dict(weight=0.86, weight_v2=1.45, end_at=0.75, denoise=0.52),
            "img2img_faceid_optimized": dict(weight=0.78, weight_v2=1.22, end_at=0.65, denoise=0.58),
            "img2img_butler_photoreal_faceid_nsfw": dict(
                weight=0.8,
                weight_v2=1.3,
                end_at=0.68,
                denoise=0.56,
                preset="FACEID PLUS V2",
                lora_strength=0.65,
            ),
        }
        for name, kw in supreme_variants.items():
            p = bundled / f"{name}.json"
            if not p.exists():
                body = _patch_supreme_ui(supreme, **kw)
                p.write_text(json.dumps(body, indent=2), encoding="utf-8")
                created.append(p)

    wan22 = bundled / "butler_img2video_wan22.json"
    img2v = bundled / "butler_img2video.json"
    if not wan22.exists() and img2v.is_file():
        shutil.copy2(img2v, wan22)
        created.append(wan22)

    return created


def _copy_ipadapter_examples(bundled: Path, comfy: Path) -> list[Path]:
    examples = comfy / "custom_nodes" / "ComfyUI_IPAdapter_plus" / "examples"
    if not examples.is_dir():
        return []
    copied: list[Path] = []
    for src in sorted(examples.glob("*.json")):
        dest_name = f"example_ipadapter_{src.name}"
        dest = bundled / dest_name
        if not dest.exists():
            shutil.copy2(src, dest)
            copied.append(dest)
    return copied


def _sync_all() -> tuple[list[str], list[str]]:
    bundled = _bundled_dir()
    sd = _sd_root()
    api_target = sd / "ComfyUI" / "workflows"
    ui_target = sd / "ComfyUI" / "user" / "default" / "workflows"
    api_target.mkdir(parents=True, exist_ok=True)
    ui_target.mkdir(parents=True, exist_ok=True)

    _generate_missing(bundled)
    _copy_ipadapter_examples(bundled, sd / "ComfyUI")

    names: list[str] = []
    for src in sorted(bundled.glob("*.json")):
        shutil.copy2(src, api_target / src.name)
        shutil.copy2(src, ui_target / src.name)
        names.append(src.name)
    return names, [str(api_target), str(ui_target)]


def main() -> int:
    names, targets = _sync_all()
    print(f"Synced {len(names)} workflow(s) to:")
    for t in targets:
        print(f"  {t}")
    print("Files:")
    for n in names:
        print(f"  {n}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
