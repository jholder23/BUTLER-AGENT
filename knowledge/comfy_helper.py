"""
ComfyUI integration for Butler.
Uses workflows from <SD_PROJECT_PATH>/ComfyUI/workflows (default: Butler repo's sd/ folder).
"""
from __future__ import annotations

import base64
import json
import os
import random
import re
import time
from pathlib import Path, PurePosixPath
from urllib.parse import unquote

_PROMPT_TAG_SPLIT = re.compile(r",(?![^()]*\))")


def _is_api_format(workflow: dict) -> bool:
    """Check if workflow is already in ComfyUI API format."""
    if not workflow or "nodes" in workflow:
        return False
    for k, v in list(workflow.items())[:3]:
        if isinstance(v, dict) and "class_type" in v and "inputs" in v:
            return True
        if not isinstance(k, str) or not isinstance(v, dict):
            return False
    return True


def _trace_clip_text_encode_node(workflow: dict, ref: object, depth: int = 0) -> str | None:
    """Follow conditioning from KSampler through WanImageToVideo (etc.) to CLIPTextEncode."""
    if depth > 16:
        return None
    if not isinstance(ref, list) or len(ref) < 1:
        return None
    nid = str(ref[0])
    node = workflow.get(nid)
    if not isinstance(node, dict):
        return None
    ct = node.get("class_type") or ""
    if ct == "CLIPTextEncode" or (isinstance(ct, str) and "CLIPTextEncode" in ct):
        return nid
    inp = node.get("inputs", {})
    if not isinstance(inp, dict):
        return None
    for key in ("positive", "negative"):
        sub = inp.get(key)
        found = _trace_clip_text_encode_node(workflow, sub, depth + 1)
        if found:
            return found
    return None


def _wire_sampler_prompts(workflow: dict, pos_text: str, neg_text: str) -> None:
    """Set CLIPTextEncode texts for every KSampler / KSamplerAdvanced chain (e.g. Wan 2.2 dual samplers)."""
    wired_pos: set[str] = set()
    wired_neg: set[str] = set()
    for _nid, node in workflow.items():
        if not isinstance(node, dict):
            continue
        if node.get("class_type") not in ("KSampler", "KSamplerAdvanced"):
            continue
        inp = node.get("inputs", {})
        pos_node = _trace_clip_text_encode_node(workflow, inp.get("positive"))
        neg_node = _trace_clip_text_encode_node(workflow, inp.get("negative"))
        if (
            pos_node
            and pos_node not in wired_pos
            and pos_node in workflow
            and isinstance(workflow[pos_node].get("inputs"), dict)
        ):
            cur = workflow[pos_node]["inputs"].get("text")
            # Leave linked CLIP text alone (e.g. ButlerEasyPrompt → CLIPTextEncode).
            if not isinstance(cur, list):
                workflow[pos_node]["inputs"]["text"] = pos_text
            wired_pos.add(pos_node)
        if (
            neg_node
            and neg_node not in wired_neg
            and neg_node in workflow
            and isinstance(workflow[neg_node].get("inputs"), dict)
        ):
            cur = workflow[neg_node]["inputs"].get("text")
            if not isinstance(cur, list):
                workflow[neg_node]["inputs"]["text"] = neg_text
            wired_neg.add(neg_node)


def _split_prompt_tags(text: str) -> list[str]:
    if not text or not str(text).strip():
        return []
    return [p.strip() for p in _PROMPT_TAG_SPLIT.split(str(text).strip()) if p.strip()]


def _merge_prompt_tags(*blocks: list[str]) -> str:
    seen: set[str] = set()
    out: list[str] = []
    for block in blocks:
        for tag in block:
            key = re.sub(r"\s+", " ", str(tag).strip().lower())
            if not key or key in seen:
                continue
            seen.add(key)
            out.append(str(tag).strip())
    return ", ".join(out)


def _prompt_implies_occluded_or_rear_face(prompt: str) -> bool:
    text = (prompt or "").lower()
    patterns = (
        r"forward fold|folded forward|bent over|touching toes|standing forward bend",
        r"back of (the )?legs|behind (the )?legs|underside of (the )?legs",
        r"rear view|back view|from behind|turned away|facing away",
        r"face (is )?(hidden|occluded|partially hidden|not visible)",
        r"camera on (the )?opposite side|opposite side of (the )?legs",
    )
    return any(re.search(p, text) for p in patterns)


def _compose_openpose_faceid_img2img_prompts(prompt: str, negative_prompt: str = "") -> tuple[str, str]:
    """
    Dual-reference img2img needs extra guardrails for extreme / occluded poses:
    pose image should own body geometry while face reference only supplies identity.
    """
    from sd_prompt_enhance import merge_prompts_with_user_sd_base

    pos_text, neg_text = merge_prompts_with_user_sd_base(prompt, negative_prompt)
    pos_parts = _split_prompt_tags(pos_text)
    neg_parts = _split_prompt_tags(neg_text)

    pos_add = [
        "(use the pose reference for full-body geometry and limb placement:1.45)",
        "(use the face reference for identity and facial structure only:1.25)",
        "single coherent person",
        "coherent anatomy",
        "natural skin texture",
        "correct shoulders hips knees ankles wrists and elbows",
    ]
    neg_add = [
        "mosaic skin",
        "tiled skin",
        "grid skin texture",
        "patchwork skin",
        "duplicate face",
        "pasted-on face",
        "wrong head angle",
        "broken anatomy",
        "impossible bend",
        "extra limbs",
    ]

    if _prompt_implies_occluded_or_rear_face(prompt):
        pos_add.append(
            "if the pose or camera angle naturally hides part of the face, preserve identity without forcing a frontal face or direct eye contact"
        )
        neg_add.extend(
            [
                "front-facing face when pose implies a hidden or turned-away face",
                "direct eye contact when the face should be obscured",
                "visible full face when the pose should hide it",
            ]
        )

    return _merge_prompt_tags(pos_parts, pos_add), _merge_prompt_tags(neg_parts, neg_add)


# Short API keys → ButlerEasyPrompt INPUT_TYPES labels (knowledge/butler_simple_ui).
_BUTLER_EASY_PROMPT_FIELD_ALIASES: dict[str, tuple[str, ...]] = {
    "details": ("DETAILS - looks (blue eyes...)", "details"),
    "avoid": ("AVOID - dont want", "avoid"),
    "action": ("ACTION - what they are doing", "action"),
    "pose": ("POSE - body position", "pose"),
    "outfit": ("OUTFIT - clothes", "outfit"),
    "scene": ("SCENE - place / lighting", "scene"),
    "mode": ("MODE", "mode"),
    "sweep_seed": ("SWEEP_SEED", "sweep_seed"),
    "sweep_run": ("SWEEP_RUN", "sweep_run"),
    "balance": ("BALANCE - LEFT=face  RIGHT=prompt", "balance_face_to_prompt", "balance"),
    "framing": ("framing",),
    "emphasize_action": ("emphasize_action",),
    "hands_in_frame": ("hands_in_frame",),
    "frontal_face": ("frontal_face",),
    "photoreal": ("photoreal",),
    "preset": ("PRESET", "preset"),
}


def _apply_ui_new_scene_prompt_boxes(raw_workflow: dict, fields: dict | None) -> bool:
    """
    Patch PrimitiveStringMultiline widgets on the new-scene UI graph by node title.
    Call before UI→API conversion so linked CLIP text stays driven by the boxes.
    """
    if not isinstance(fields, dict) or not fields or not isinstance(raw_workflow, dict):
        return False
    nodes = raw_workflow.get("nodes")
    if not isinstance(nodes, list):
        return False
    title_aliases: dict[str, tuple[str, ...]] = {
        "action": ("(ACTION)", "ACTION"),
        "pose": ("(POSE)", "POSE"),
        "outfit": ("(OUTFIT)", "OUTFIT"),
        "scene": ("(SCENE)", "SCENE"),
        "details": ("(FRAMING)", "FRAMING", "(DETAILS)", "DETAILS"),
        "likeness": ("(LIKENESS)", "LIKENESS"),
    }
    updated = False
    for node in nodes:
        if not isinstance(node, dict) or node.get("type") != "PrimitiveStringMultiline":
            continue
        title = str(node.get("title") or "").strip().upper()
        if not title:
            continue
        for field_key, aliases in title_aliases.items():
            if field_key not in fields:
                continue
            raw = fields.get(field_key)
            if raw is None:
                continue
            text = str(raw).strip()
            if not text:
                continue
            if not any(a.upper() in title for a in aliases):
                continue
            node["widgets_values"] = [text]
            updated = True
            break
    return updated


def _ensure_butler_easy_prompt_defaults(workflow: dict) -> bool:
    """
    Fill required ButlerEasyPrompt widgets that UI→API conversion / easy_prompt may omit.
    SWEEP_RUN is required by the node; single Easy runs never send it from the panel.
    """
    if not isinstance(workflow, dict):
        return False
    updated = False
    for _nid, node in workflow.items():
        if not isinstance(node, dict) or node.get("class_type") != "ButlerEasyPrompt":
            continue
        inputs = node.setdefault("inputs", {})
        if not isinstance(inputs, dict):
            continue
        if "SWEEP_RUN" not in inputs and "sweep_run" not in inputs:
            inputs["SWEEP_RUN"] = ""
            updated = True
        if "MODE" not in inputs and "mode" not in inputs:
            inputs["MODE"] = "single"
            updated = True
        if "SWEEP_SEED" not in inputs and "sweep_seed" not in inputs:
            inputs["SWEEP_SEED"] = 0
            updated = True
    return updated


def _apply_butler_easy_prompt_fields(workflow: dict, fields: dict | None) -> bool:
    """
    Set ButlerEasyPrompt node inputs from a flat dict (utility panel / API easy_prompt).
    Returns True if at least one ButlerEasyPrompt node was updated from fields.
    """
    if not isinstance(fields, dict) or not fields:
        return False
    updated = False
    for _nid, node in workflow.items():
        if not isinstance(node, dict) or node.get("class_type") != "ButlerEasyPrompt":
            continue
        inputs = node.setdefault("inputs", {})
        if not isinstance(inputs, dict):
            continue
        for api_key, aliases in _BUTLER_EASY_PROMPT_FIELD_ALIASES.items():
            if api_key not in fields and not any(a in fields for a in aliases):
                continue
            raw = fields.get(api_key)
            if raw is None:
                for a in aliases:
                    if a in fields:
                        raw = fields[a]
                        break
            if raw is None:
                continue
            target = None
            for a in aliases:
                if a in inputs or a == aliases[0]:
                    target = a
                    break
            if target is None:
                target = aliases[0]
            # Coerce types for known widgets
            if api_key == "balance":
                try:
                    raw = float(raw)
                except (TypeError, ValueError):
                    continue
            elif api_key == "sweep_seed":
                try:
                    raw = max(0, int(raw))
                except (TypeError, ValueError):
                    continue
            elif api_key in ("emphasize_action", "hands_in_frame", "frontal_face", "photoreal"):
                if isinstance(raw, str):
                    raw = raw.strip().lower() in ("1", "true", "yes", "on")
                else:
                    raw = bool(raw)
            elif api_key == "framing":
                raw = str(raw or "full_body").strip() or "full_body"
            else:
                raw = str(raw) if raw is not None else ""
            inputs[target] = raw
            updated = True
    return updated


def workflow_has_butler_easy_prompt(workflow: dict) -> bool:
    return any(
        isinstance(n, dict) and n.get("class_type") == "ButlerEasyPrompt" for n in (workflow or {}).values()
    )


# User wants new pose/outfit/location — VAEEncode from the same photo locks body/pose; use EmptyLatent + FaceID instead.
_SCENE_CHANGE_HINTS = re.compile(
    r"\b("
    r"pose|outfit|dress|bikini|lingerie|standing|sitting|lying|kneeling|squatting|leaning|"
    r"wearing|uniform|cosplay|naked|nude|topless|bottomless|jeans|pants|shirt|blouse|skirt|"
    r"heels|boots|sneakers|bra|panties|thong|stockings|latex|leather|swimsuit|"
    r"bedroom|beach|street|office|gym|pool|shower|bathroom|kitchen|forest|city|rooftop|"
    r"outdoor|indoor|background|location|scene|on a |in a |at the |different|new outfit|"
    r"change clothes|red dress|black dress|white dress|blue dress|gown|suit|jacket|coat"
    r")\b",
    re.IGNORECASE,
)

# FaceID graphs that should default to fresh-latent scene generation (not VAEEncode of the upload).
_FACEID_NEW_SCENE_WORKFLOW_STEMS = frozenset({
    "img2img_juggernaut_faceid_new_scene_nsfw",
    "img2img_juggernaut_faceid_easy_nsfw",
})

# Keep VAEEncode + OpenPose pose latent — do not promote to EmptyLatent.
_FACEID_KEEP_VAE_ENCODE_STEMS = frozenset({
    "img2img_juggernaut_faceid_openpose_action_nsfw",
})

# True pose/action refs only — NOT VAEEncode (that is classic img2img init, face-only).
_POSE_IMAGE_CONSUMERS = frozenset({
    "OpenposePreprocessor",
    "DWPreprocessor",
    "DensePosePreprocessor",
    "ControlNetApplyAdvanced",
    "ControlNetApply",
})
_FACE_IMAGE_CONSUMERS = frozenset({
    "IPAdapterFaceID",
    "IPAdapterFaceIDKolors",
    "ReActorFaceSwap",
    "ReActorFaceSwapOpt",
})
_IMAGE_PASSTHROUGH = frozenset({
    "ImageScale",
    "ImageScaleToTotalPixels",
    "ImageScaleBy",
    "ImageResize",
    "ImagePadForOutpaint",
})
# Face-only studio graphs — never require a separate pose upload.
_FACE_ONLY_IMG2IMG_STEMS = frozenset({
    "img2img_juggernaut_faceid_easy_nsfw",
    "img2img_juggernaut_faceid_new_scene_nsfw",
})


def _next_free_workflow_node_id(workflow: dict) -> str:
    nums = [int(k) for k in workflow if str(k).isdigit()]
    return str((max(nums) if nums else 9000) + 1)


def _workflow_has_faceid(workflow: dict) -> bool:
    return any(
        isinstance(n, dict) and n.get("class_type") == "IPAdapterFaceID"
        for n in workflow.values()
    )


def _promote_faceid_scene_mode(workflow: dict) -> bool:
    """
    Rewire VAEEncode+FaceID img2img graphs to EmptyLatent + denoise 1.0.

    The upload should drive FaceID only; encoding the same photo into the latent locks pose/outfit.
    Returns True when the graph was promoted.
    """
    if not _workflow_has_faceid(workflow):
        return False

    vae_encode_ids = {
        nid
        for nid, n in workflow.items()
        if isinstance(n, dict) and n.get("class_type") == "VAEEncode"
    }
    if not vae_encode_ids:
        return False

    sampler_ids: list[str] = []
    for nid, node in workflow.items():
        if not isinstance(node, dict) or node.get("class_type") != "KSampler":
            continue
        lat = node.get("inputs", {}).get("latent_image")
        if isinstance(lat, list) and len(lat) >= 1 and str(lat[0]) in vae_encode_ids:
            sampler_ids.append(str(nid))
    if not sampler_ids:
        return False

    empty_id = _next_free_workflow_node_id(workflow)
    workflow[empty_id] = {
        "class_type": "EmptyLatentImage",
        "inputs": {"width": 1024, "height": 1024, "batch_size": 1},
    }
    for sid in sampler_ids:
        sinp = workflow[sid]["inputs"]
        sinp["latent_image"] = [empty_id, 0]
        sinp["denoise"] = 1.0

    for node in workflow.values():
        if not isinstance(node, dict):
            continue
        ct = node.get("class_type", "")
        inp = node.get("inputs", {})
        if not isinstance(inp, dict):
            continue
        if ct == "IPAdapterFaceID":
            inp["weight"] = max(_as_float(inp.get("weight"), 0.78), 0.82)
            inp["weight_faceidv2"] = max(_as_float(inp.get("weight_faceidv2"), 1.2), 1.32)
            inp["end_at"] = max(_as_float(inp.get("end_at"), 0.62), 0.85)
        elif ct == "IPAdapterUnifiedLoaderFaceID":
            inp["lora_strength"] = max(_as_float(inp.get("lora_strength"), 0.55), 0.72)
    return True


def _as_float(val: object, default: float) -> float:
    try:
        return float(val)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default


def _workflow_image_consumers(workflow: dict) -> dict[str, list[tuple[str, str, str]]]:
    """src_node_id -> [(consumer_id, input_name, class_type), ...]"""
    out: dict[str, list[tuple[str, str, str]]] = {}
    for nid, node in workflow.items():
        if not isinstance(node, dict):
            continue
        ct = str(node.get("class_type") or "")
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        for iname, ival in inputs.items():
            if isinstance(ival, list) and len(ival) >= 1:
                src = str(ival[0])
                out.setdefault(src, []).append((str(nid), str(iname), ct))
    return out


def _classify_load_image_roles(workflow: dict) -> dict[str, str]:
    """
    Map each LoadImage node id to 'face', 'pose', or 'unknown' from graph wiring.
    Face = IPAdapterFaceID / ReActor source.
    Pose = OpenPose / DWPose / DensePose / ControlNet image path only (not VAEEncode init).
    """
    consumers = _workflow_image_consumers(workflow)
    roles: dict[str, str] = {}
    for nid, node in workflow.items():
        if not isinstance(node, dict) or node.get("class_type") != "LoadImage":
            continue
        seen: set[str] = set()
        queue = [str(nid)]
        face = False
        pose = False
        while queue:
            cur = queue.pop(0)
            if cur in seen:
                continue
            seen.add(cur)
            for cid, iname, ct in consumers.get(cur, []):
                if ct in _FACE_IMAGE_CONSUMERS and iname in ("image", "source_image"):
                    face = True
                if ct in _POSE_IMAGE_CONSUMERS and iname in (
                    "image",
                    "pixels",
                    "input_image",
                ):
                    pose = True
                if ct in _IMAGE_PASSTHROUGH:
                    queue.append(cid)
        if face and not pose:
            roles[str(nid)] = "face"
        elif pose and not face:
            roles[str(nid)] = "pose"
        elif face and pose:
            roles[str(nid)] = "face"
        else:
            roles[str(nid)] = "unknown"
    return roles


def _workflow_needs_pose_image(workflow: dict, workflow_name: str | None = None) -> bool:
    """True only for dual-ref OpenPose/DWPose graphs — never for Easy / new-scene FaceID."""
    stem = (workflow_name or "").replace(".json", "").strip()
    if stem in _FACE_ONLY_IMG2IMG_STEMS:
        return False
    roles = _classify_load_image_roles(workflow)
    return any(r == "pose" for r in roles.values())


def _bind_load_images_for_img2img(
    workflow: dict,
    *,
    face_name: str,
    face_subfolder: str,
    pose_name: str | None = None,
    pose_subfolder: str = "",
    workflow_name: str | None = None,
) -> str | None:
    """
    Bind uploaded files onto LoadImage nodes.
    Dual-reference graphs (face + OpenPose/DWPose) keep separate uploads; single-ref graphs get face everywhere.
    Classic VAEEncode img2img init is not a pose ref and must not require pose_image.
    """
    load_nodes = [
        nid
        for nid, node in workflow.items()
        if isinstance(node, dict) and node.get("class_type") == "LoadImage"
    ]
    if not load_nodes:
        return "Workflow has no LoadImage node"
    roles = _classify_load_image_roles(workflow)
    needs_pose = _workflow_needs_pose_image(workflow, workflow_name)
    if needs_pose and not (pose_name or "").strip():
        return (
            "This workflow needs a separate pose_image (base64) for the pose/action reference, "
            "plus init_image for the face reference."
        )
    for load_node in load_nodes:
        role = roles.get(str(load_node), "unknown")
        if role == "pose" and pose_name:
            name, sub = pose_name, pose_subfolder or ""
        else:
            name, sub = face_name, face_subfolder or ""
        inputs = workflow[load_node].setdefault("inputs", {})
        if "subfolder" in inputs:
            inputs["subfolder"] = sub
        li_err = _ensure_load_image_matches_comfy(workflow, load_node, name, sub)
        if li_err:
            return li_err
    return None


def _apply_img2img_run_tweaks(workflow: dict, prompt: str, *, workflow_name: str = "") -> None:
    """Randomize seed each queue. Promote legacy VAEEncode FaceID graphs to EmptyLatent scene mode."""
    seed = random.randint(1, 2_147_483_646)
    stem = (workflow_name or "").replace(".json", "").strip()

    if stem not in _FACEID_KEEP_VAE_ENCODE_STEMS and (
        stem in _FACEID_NEW_SCENE_WORKFLOW_STEMS or _SCENE_CHANGE_HINTS.search(prompt or "")
    ):
        _promote_faceid_scene_mode(workflow)

    # FaceID Easy / SDXL paths: tiled decode lowers peak VRAM at VAEDecode (pairs with desktop --normalvram).
    if "faceid" in stem or stem.endswith("_sdxl_vae_simple") or "juggernaut" in stem:
        _prefer_tiled_vae_decode(workflow)

    for node in workflow.values():
        if not isinstance(node, dict):
            continue
        ct = node.get("class_type", "")
        inp = node.get("inputs", {})
        if not isinstance(inp, dict):
            continue
        if ct in ("KSampler", "KSamplerAdvanced", "FaceDetailer"):
            inp["seed"] = seed
            if "control_after_generate" in inp:
                inp["control_after_generate"] = "randomize"


def _apply_pose_control_settings(
    workflow: dict,
    strength: float | None,
    end_percent: float | None,
) -> None:
    """Apply optional UI/API pose adherence controls to every advanced ControlNet node."""
    if strength is None and end_percent is None:
        return
    for node in workflow.values():
        if not isinstance(node, dict) or node.get("class_type") != "ControlNetApplyAdvanced":
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        if strength is not None:
            inputs["strength"] = max(0.0, min(2.0, float(strength)))
        if end_percent is not None:
            inputs["end_percent"] = max(0.05, min(1.0, float(end_percent)))


# Optional sockets with link=null must not consume widgets_values during UI→API conversion.
_OPTIONAL_LINK_ONLY_INPUTS = frozenset({
    "ipadapter",
    "insightface",
    "clip_vision",
    "image_negative",
    "attn_mask",
    "sam_model_opt",
    "segm_detector_opt",
    "detailer_hook",
    "scheduler_func_opt",
})

# Widget index -> input name for nodes that have both linked inputs and widget-only params
_WIDGET_NAMES: dict[str, tuple[str, ...]] = {
    "KSampler": ("seed", "control_after_generate", "steps", "cfg", "sampler_name", "scheduler", "denoise"),
    "SaveImage": ("filename_prefix",),
    "CLIPTextEncode": ("text",),
    "IPAdapterUnifiedLoaderFaceID": ("preset", "lora_strength", "provider"),
    "IPAdapterFaceID": (
        "weight",
        "weight_faceidv2",
        "weight_type",
        "combine_embeds",
        "start_at",
        "end_at",
        "embeds_scaling",
    ),
    "FaceDetailer": (
        "guide_size",
        "guide_size_for",
        "max_size",
        "seed",
        "control_after_generate",
        "steps",
        "cfg",
        "sampler_name",
        "scheduler",
        "denoise",
        "feather",
        "noise_mask",
        "force_inpaint",
        "bbox_threshold",
        "bbox_dilation",
        "bbox_crop_factor",
        "sam_detection_hint",
        "sam_dilation",
        "sam_threshold",
        "sam_bbox_expansion",
        "sam_mask_hint_threshold",
        "sam_mask_hint_use_negative",
        "drop_size",
        "wildcard",
        "cycle",
        "tiled_encode",
        "tiled_decode",
    ),
    "IPAdapterInsightFaceLoader": ("provider", "model_name"),
}

# Nodes with only widgets (no linkable inputs)
_WIDGET_ONLY_NODES: dict[str, tuple[str, ...]] = {
    "CheckpointLoaderSimple": ("ckpt_name",),
    "LoadImage": ("image", "subfolder"),
    "EmptyLatentImage": ("width", "height", "batch_size"),
    # Wan / diffusion loaders (example workflows ship as UI JSON)
    "UNETLoader": ("unet_name", "weight_dtype"),
    "VAELoader": ("vae_name",),
    "CLIPLoader": ("clip_name", "type", "device"),
    "CLIPVisionLoader": ("clip_name",),
    "EmptyHunyuanLatentVideo": ("width", "height", "length", "batch_size"),
    "WanImageToVideo": ("width", "height", "length", "batch_size"),
    # knowledge/butler_simple_ui — widget order matches INPUT_TYPES (+ control_after_generate)
    "ButlerEasyPrompt": (
        "DETAILS - looks (blue eyes...)",
        "AVOID - dont want",
        "ACTION - what they are doing",
        "POSE - body position",
        "OUTFIT - clothes",
        "SCENE - place / lighting",
        "MODE",
        "SWEEP_SEED",
        "control_after_generate",
        "SWEEP_RUN",
        "BALANCE - LEFT=face  RIGHT=prompt",
        "framing",
        "emphasize_action",
        "hands_in_frame",
        "frontal_face",
        "photoreal",
        "PRESET",
    ),
}


def _downgrade_missing_butler_sweep_save(workflow: dict, *, force: bool = False) -> bool:
    """
    If ComfyUI has not loaded ButlerSweepSave yet, rewrite those nodes to SaveImage
    so easy img2img still queues (PreviewImage + SaveImage path).
    Returns True when any node was rewritten.
    """
    if not force:
        info = _fetch_object_info() or {}
        if "ButlerSweepSave" in info:
            return False
    changed = False
    for _nid, node in workflow.items():
        if not isinstance(node, dict) or node.get("class_type") != "ButlerSweepSave":
            continue
        inputs = node.get("inputs") if isinstance(node.get("inputs"), dict) else {}
        images = inputs.get("images")
        prefix = inputs.get("filename_prefix")
        if prefix is None or prefix == "":
            prefix = "easy_sweep/butler"
        node["class_type"] = "SaveImage"
        node["inputs"] = {
            "images": images,
            "filename_prefix": prefix,
        }
        changed = True
    return changed


def _ui_to_api_format(ui_workflow: dict) -> dict:
    """Convert ComfyUI UI workflow format to API format."""
    nodes = ui_workflow.get("nodes", [])
    links = ui_workflow.get("links", [])
    if not nodes:
        return {}

    # link_id -> (source_node_id, source_slot)
    link_sources = {}
    for link in links:
        if isinstance(link, (list, tuple)) and len(link) >= 5:
            link_id, src_node, src_slot = link[0], link[1], link[2]
            link_sources[link_id] = (src_node, src_slot)

    api_prompt = {}
    for node in nodes:
        nid = node.get("id")
        if nid is None:
            continue
        nid_str = str(nid)
        node_type = node.get("type", "")
        inputs = node.get("inputs", [])
        widgets_values = node.get("widgets_values", [])

        api_inputs = {}
        widget_idx = 0
        for inp in inputs:
            name = inp.get("name", "")
            link_val = inp.get("link")
            if link_val is not None and link_val in link_sources:
                src_node, src_slot = link_sources[link_val]
                # ComfyUI API expects [node_id, output_slot] with slot as int
                api_inputs[name] = [str(src_node), int(src_slot) if src_slot is not None else 0]
            elif link_val is None and name in _OPTIONAL_LINK_ONLY_INPUTS:
                pass
            elif widget_idx < len(widgets_values):
                api_inputs[name] = widgets_values[widget_idx]
                widget_idx += 1

        # Add remaining widget-only params (for nodes with both links and widgets)
        if node_type in _WIDGET_NAMES and widgets_values:
            names = _WIDGET_NAMES[node_type]
            for i, wname in enumerate(names):
                if wname not in api_inputs and (widget_idx + i) < len(widgets_values):
                    api_inputs[wname] = widgets_values[widget_idx + i]
        elif node_type in _WIDGET_ONLY_NODES and widgets_values:
            names = _WIDGET_ONLY_NODES[node_type]
            for i, wname in enumerate(names):
                if i < len(widgets_values):
                    api_inputs[wname] = widgets_values[i]
        elif widgets_values:
            # Try object_info for custom nodes (IPAdapterFaceID, FaceDetailer, etc.)
            full_order = _get_widget_order_from_object_info(node_type)
            if full_order:
                for wname in full_order:
                    if wname not in api_inputs and widget_idx < len(widgets_values):
                        api_inputs[wname] = widgets_values[widget_idx]
                        widget_idx += 1
        elif not inputs and widgets_values:
            # Unknown node with only widgets - try common patterns
            if node_type == "LoadImage" or "image" in node_type.lower():
                api_inputs["image"] = widgets_values[0] if widgets_values else ""
                if len(widgets_values) > 1:
                    api_inputs["subfolder"] = widgets_values[1]
            elif "Checkpoint" in node_type or "Loader" in node_type:
                api_inputs["ckpt_name"] = widgets_values[0] if widgets_values else ""

        api_prompt[nid_str] = {"class_type": node_type, "inputs": api_inputs}

    return api_prompt


def _try_comfy_convert_api(ui_workflow: dict) -> dict | None:
    """Use ComfyUI workflow-to-API converter extension (SethRobinson). Returns API prompt dict or None."""
    try:
        import requests
    except ImportError:
        return None
    url = f"{_comfy_url()}/workflow/convert"
    try:
        r = requests.post(url, json=ui_workflow, timeout=15)
        if r.status_code == 200:
            data = r.json()
            # Converter returns the prompt dict directly (or nested under prompt/api)
            if isinstance(data, dict) and "class_type" not in data:
                out = data.get("prompt") or data.get("api")
                if out and isinstance(out, dict):
                    return out
            # Response is the prompt dict itself (keys are node ids like "3", "12")
            if isinstance(data, dict) and data:
                return data
    except Exception:
        pass
    return None


def _comfy_url() -> str:
    # Prefer live env so desktop Electron (8198) wins over a stale config default (8188).
    live = (os.environ.get("COMFYUI_URL") or "").strip().rstrip("/")
    if live:
        return live
    try:
        from config import COMFYUI_URL

        return (COMFYUI_URL or "http://127.0.0.1:8188").rstrip("/")
    except ImportError:
        return "http://127.0.0.1:8188"


def _sd_project_path() -> str:
    try:
        from config import SD_PROJECT_PATH
        return (SD_PROJECT_PATH or "").strip() or str(Path(__file__).resolve().parent.parent / "sd")
    except ImportError:
        return (os.environ.get("SD_PROJECT_PATH") or "").strip() or str(Path(__file__).resolve().parent.parent / "sd")


def _workflows_dir() -> Path:
    base = _sd_project_path() or os.path.expanduser("~")
    return Path(base) / "ComfyUI" / "workflows"


def _easy_sweep_output_root() -> Path:
    base = _sd_project_path() or os.path.expanduser("~")
    return Path(base) / "ComfyUI" / "output"


def _easy_sweep_winners_path() -> Path:
    return _easy_sweep_output_root() / "butler_easy_sweep_winners.json"


def _winner_presets() -> list[str]:
    try:
        with open(_easy_sweep_winners_path(), encoding="utf-8") as f:
            data = json.load(f)
        presets = data.get("presets")
        if isinstance(presets, list):
            return [str(item) for item in presets if item is not None]
    except Exception:
        pass
    return []


def _bundled_workflows_dir() -> Path:
    """Shipped Wan 2.1 example graphs (UI JSON); used when SD project has no copy."""
    return Path(__file__).resolve().parent / "comfy_workflows"


def _checkpoints_dir() -> Path:
    base = _sd_project_path() or os.path.expanduser("~")
    return Path(base) / "ComfyUI" / "models" / "checkpoints"


def _preferred_checkpoint_wanted(workflow_name: str | None = None) -> str | None:
    """
    Default checkpoint basename for Butler→Comfy runs (txt2img, img2img, compare, sweeps).
    Matches `scripts/download_comfy_checkpoint.py --preset pony-xl` (Pony Diffusion V6 XL, SDXL)
    unless the workflow name itself asks for Juggernaut.

    BUTLER_COMFY_CHECKPOINT=my.safetensors — use another file under ComfyUI/models/checkpoints.
    BUTLER_COMFY_CHECKPOINT=workflow (or 0/false/off) — do not override; use each workflow JSON's ckpt_name.
    """
    v = (os.environ.get("BUTLER_COMFY_CHECKPOINT") or "").strip()
    if v.lower() in ("0", "false", "no", "off", "workflow", "embedded"):
        return None
    if v:
        return v
    try:
        cfg_path = _comfy_config_path()
        if cfg_path.is_file():
            with open(cfg_path, encoding="utf-8") as f:
                configured = json.load(f).get("selected_checkpoint")
            if isinstance(configured, str) and configured.strip():
                return configured.strip().replace("\\", "/")
    except Exception:
        pass
    wn = (workflow_name or "").replace(".json", "").strip().lower()
    if "juggernaut" in wn:
        return "juggernautXL_ragnarok.safetensors"
    return "ponyDiffusionV6XL_v6StartWithThisOne.safetensors"


def _list_available_checkpoints() -> list[str]:
    """Scan ComfyUI checkpoints under SD_PROJECT_PATH (top-level files only; legacy)."""
    cp_dir = _checkpoints_dir()
    if not cp_dir.exists():
        return []
    out = []
    for f in cp_dir.iterdir():
        if f.is_file() and f.suffix.lower() in (".safetensors", ".ckpt"):
            out.append(f.name)
    return sorted(out)


def _list_checkpoint_rel_paths() -> list[str]:
    """Recursive .safetensors / .ckpt under models/checkpoints, posix paths for Comfy."""
    cp_dir = _checkpoints_dir()
    if not cp_dir.is_dir():
        return []
    out: list[str] = []
    for f in cp_dir.rglob("*"):
        if f.is_file() and f.suffix.lower() in (".safetensors", ".ckpt"):
            out.append(f.relative_to(cp_dir).as_posix())
    return sorted(out)


def get_comfy_checkpoint_settings() -> dict:
    """Return checkpoints visible to Butler and the persisted global selection."""
    comfy_options = _combo_choices("CheckpointLoaderSimple", "ckpt_name") or []
    disk_names = _list_checkpoint_rel_paths()
    available = sorted(set(comfy_options) | set(disk_names), key=str.lower)
    selected = ""
    try:
        cfg_path = _comfy_config_path()
        if cfg_path.is_file():
            with open(cfg_path, encoding="utf-8") as f:
                selected = str(json.load(f).get("selected_checkpoint") or "").strip().replace("\\", "/")
    except Exception:
        selected = ""
    effective = _preferred_checkpoint_wanted()
    return {
        "ok": True,
        "checkpoints": available,
        "selected_checkpoint": selected,
        "effective_checkpoint": effective or "",
        "config_path": str(_comfy_config_path()),
    }


def save_comfy_checkpoint_selection(checkpoint: str) -> dict:
    """Persist the checkpoint used by Butler image workflows in comfy_config.json."""
    wanted = (checkpoint or "").strip().replace("\\", "/")
    available = get_comfy_checkpoint_settings()["checkpoints"]
    if wanted not in available:
        return {
            "ok": False,
            "message": "Checkpoint is not available in ComfyUI. Refresh after adding or rescanning models.",
        }
    _ensure_comfy_config()
    cfg_path = _comfy_config_path()
    data: dict = {}
    try:
        if cfg_path.is_file():
            with open(cfg_path, encoding="utf-8") as f:
                loaded = json.load(f)
            if isinstance(loaded, dict):
                data = loaded
    except Exception:
        data = {}
    data["selected_checkpoint"] = wanted
    cfg_path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = cfg_path.with_suffix(".json.tmp")
    with open(temp_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    temp_path.replace(cfg_path)
    return {
        "ok": True,
        "message": f'Butler image model set to "{wanted}".',
        "selected_checkpoint": wanted,
        "effective_checkpoint": wanted,
        "checkpoints": available,
    }


def invalidate_object_info_cache() -> None:
    """Call after /upload/image so LoadImage combo includes the new file."""
    global _object_info_cache
    _object_info_cache = None


def _combo_choices(node_type: str, input_key: str) -> list[str] | None:
    """Combo dropdown values from /object_info (first element of [list, meta])."""
    info = _fetch_object_info()
    if not info or node_type not in info:
        return None
    inp = info[node_type].get("input") or {}
    for section in ("required", "optional"):
        spec = inp.get(section, {}).get(input_key)
        if isinstance(spec, (list, tuple)) and len(spec) > 0:
            first = spec[0]
            if isinstance(first, list):
                return [str(x) for x in first]
    return None


def _pick_checkpoint_name(wanted: str, comfy_options: list[str] | None, disk_names: list[str]) -> str | None:
    """Pick ckpt_name that Comfy's CheckpointLoader combo will accept."""
    wanted = (wanted or "").strip().replace("\\", "/")
    if comfy_options:
        if wanted in comfy_options:
            return wanted
        wl = wanted.lower()
        for o in comfy_options:
            ol = o.lower()
            if ol == wl or ol.endswith("/" + wl) or wl in ol:
                return o
        if "juggernaut" in wl:
            for o in comfy_options:
                if "juggernaut" in o.lower():
                    return o
        return comfy_options[0] if comfy_options else None
    if not disk_names:
        return None
    cp_dir = _checkpoints_dir()
    wn = wanted.replace("\\", "/")
    if wn and (cp_dir / wn).is_file():
        return wn
    for d in disk_names:
        if wn and (wn.lower() in d.lower() or d.lower().endswith(wn.lower())):
            return d
    return disk_names[0]


def _pick_combo_value(wanted: str, combo: list[str]) -> str:
    """Pick a Comfy combo entry matching wanted filename, else first option."""
    wanted = (wanted or "").strip()
    if wanted in combo:
        return wanted
    wl = wanted.lower()
    bn = wanted.replace("\\", "/").split("/")[-1].lower()
    for o in combo:
        if o.lower() == wl:
            return o
    for o in combo:
        if bn and bn in o.lower():
            return o
    for o in combo:
        ol = o.lower()
        if wl and (wl in ol or ol in wl):
            return o
    return combo[0]


def _ensure_aux_model_loaders_from_comfy(workflow: dict) -> str | None:
    """
    Align UNETLoader / VAELoader / CLIPLoader / CLIPVisionLoader combos with /object_info.
    Used for bundled Wan text→video / image→video workflows (no CheckpointLoaderSimple).
    """
    for _nid, node in workflow.items():
        if not isinstance(node, dict):
            continue
        ct = node.get("class_type")
        inp = node.get("inputs", {})
        if not isinstance(inp, dict):
            continue

        if ct == "UNETLoader":
            for key in ("unet_name", "model_name"):
                if key not in inp:
                    continue
                v = inp.get(key)
                if isinstance(v, list):
                    break
                combo = _combo_choices(ct, key)
                if combo is None:
                    continue
                if len(combo) == 0:
                    return (
                        "No UNET models in ComfyUI (install Wan .safetensors under ComfyUI/models/unet, then restart Comfy)."
                    )
                inp[key] = _pick_combo_value(str(v or ""), combo)
                break
            wd_key = "weight_dtype"
            if wd_key in inp:
                wv = inp[wd_key]
                wcombo = _combo_choices(ct, wd_key)
                if wcombo and isinstance(wv, str) and wv not in wcombo:
                    inp[wd_key] = wcombo[0]

        elif ct == "VAELoader":
            key = "vae_name"
            if key not in inp:
                continue
            v = inp.get(key)
            if isinstance(v, list):
                continue
            combo = _combo_choices(ct, key)
            if combo is None:
                continue
            if len(combo) == 0:
                return "No VAE models in ComfyUI (install Wan VAE under ComfyUI/models/vae)."
            inp[key] = _pick_combo_value(str(v or ""), combo)

        elif ct == "CLIPLoader":
            cn = inp.get("clip_name")
            if not isinstance(cn, list):
                combo = _combo_choices(ct, "clip_name")
                if combo is not None:
                    if len(combo) == 0:
                        return "No CLIP text models in ComfyUI (install Wan UMT5 CLIP under models/text_encoders or as per Wan docs)."
                    inp["clip_name"] = _pick_combo_value(str(cn or ""), combo)
            for ek in ("type", "device"):
                ev = inp.get(ek)
                ec = _combo_choices(ct, ek)
                if not ec or not isinstance(ev, str) or ev in ec:
                    continue
                if ek == "type":
                    inp[ek] = next((x for x in ec if str(x).lower() == "wan"), ec[0])
                else:
                    inp[ek] = ec[0]

        elif ct == "CLIPVisionLoader":
            key = "clip_name" if "clip_name" in inp else ("model_name" if "model_name" in inp else None)
            if not key:
                continue
            v = inp.get(key)
            if isinstance(v, list):
                continue
            combo = _combo_choices(ct, key)
            if combo is None:
                continue
            if len(combo) == 0:
                return "No CLIP vision models in ComfyUI (install CLIP-Vision for Wan i2v under models/clip_vision)."
            inp[key] = _pick_combo_value(str(v or ""), combo)

    return None


def _ensure_workflow_checkpoint_from_comfy(
    workflow: dict, workflow_name: str | None = None
) -> str | None:
    """
    Set CheckpointLoaderSimple ckpt_name to a value that exists in Comfy's model list.
    Returns an error string if no checkpoint is available.
    """
    has_loader = any(isinstance(n, dict) and n.get("class_type") == "CheckpointLoaderSimple" for n in workflow.values())
    if not has_loader:
        return None

    combo = _combo_choices("CheckpointLoaderSimple", "ckpt_name")
    disk = _list_checkpoint_rel_paths()
    if not combo and not disk:
        return (
            "No checkpoints found under ComfyUI/models/checkpoints. "
            "Add a .safetensors or .ckpt file there (any subfolder is OK), then restart ComfyUI if the list does not update."
        )
    for _nid, node in workflow.items():
        if not isinstance(node, dict) or node.get("class_type") != "CheckpointLoaderSimple":
            continue
        inp = node.get("inputs", {})
        cur = inp.get("ckpt_name")
        if isinstance(cur, list):
            continue
        pref = _preferred_checkpoint_wanted(workflow_name)
        wanted = pref if pref is not None else str(cur or "").strip()
        chosen = _pick_checkpoint_name(wanted, combo, disk)
        if not chosen:
            return "Could not pick a checkpoint that exists on disk and in Comfy's list."
        inp["ckpt_name"] = chosen
    return None


def _ensure_workflow_ckpt_exists(workflow: dict, workflow_name: str | None = None) -> None:
    """Legacy: filesystem-only substitution when object_info is unavailable."""
    if _combo_choices("CheckpointLoaderSimple", "ckpt_name") is not None:
        return
    available = _list_checkpoint_rel_paths() or _list_available_checkpoints()
    if not available:
        return
    cp_dir = _checkpoints_dir()
    for _nid, node in workflow.items():
        if not isinstance(node, dict) or node.get("class_type") != "CheckpointLoaderSimple":
            continue
        inp = node.get("inputs", {})
        ckpt = inp.get("ckpt_name")
        if not ckpt or isinstance(ckpt, list):
            continue
        ckpt = str(ckpt).strip().replace("\\", "/")
        if not ckpt:
            continue
        if (cp_dir / ckpt).is_file():
            continue
        pref = _preferred_checkpoint_wanted(workflow_name)
        if pref:
            for d in available:
                pl = pref.lower()
                dl = d.lower()
                if dl == pl or dl.endswith("/" + pl) or pl in dl:
                    inp["ckpt_name"] = d
                    break
            else:
                inp["ckpt_name"] = available[0]
        else:
            inp["ckpt_name"] = available[0]


def _comfy_free_vram(*, wait_s: float = 1.5) -> None:
    """Interrupt/clear queue, unload models, and clear CUDA cache before a heavy SDXL load."""
    try:
        import requests

        base = _comfy_url()
        # Leftover running/pending jobs hold VRAM; clear them before unload.
        try:
            requests.post(f"{base}/interrupt", timeout=15)
        except Exception:
            pass
        try:
            requests.post(f"{base}/queue", json={"clear": True}, timeout=15)
        except Exception:
            pass
        requests.post(
            f"{base}/free",
            json={"unload_models": True, "free_memory": True},
            timeout=60,
        )
        if wait_s and wait_s > 0:
            time.sleep(float(wait_s))
    except Exception:
        pass


def _iter_comfy_status_messages(messages: object):
    """Yield (event_key, payload_dict) from Comfy history status.messages."""
    if not isinstance(messages, list):
        return
    for item in messages:
        if not isinstance(item, (list, tuple)) or len(item) < 2:
            continue
        payload = item[1] if isinstance(item[1], dict) else {}
        yield str(item[0]), payload


def _history_is_oom(messages: object) -> bool:
    """True for CUDA OOM and bare MemoryError (ReActor ONNX load often has empty message)."""
    text = _format_comfy_execution_error(messages).lower()
    if (
        "out of memory" in text
        or "allocation on device" in text
        or "memoryerror" in text
        or "cuda out of memory" in text
    ):
        return True
    for _key, payload in _iter_comfy_status_messages(messages):
        et = str(payload.get("exception_type") or "").strip().lower()
        em = str(payload.get("exception_message") or "").strip().lower()
        if et == "memoryerror" or "out of memory" in em or "cuda out of memory" in em:
            return True
    return False


def _history_job_finished(hist: dict) -> bool:
    """True when Comfy marked the prompt complete (success or error)."""
    st = hist.get("status") if isinstance(hist.get("status"), dict) else {}
    if st.get("completed") is True:
        return True
    status_str = str(st.get("status_str") or "").strip().lower()
    if status_str in ("success", "error", "interrupted"):
        return True
    msgs = st.get("messages")
    if isinstance(msgs, list):
        for m in msgs:
            if not isinstance(m, (list, tuple)) or not m:
                continue
            key = str(m[0]).lower()
            if key in ("execution_success", "execution_error", "execution_interrupted"):
                return True
    return False


def _harvest_history_images(hist: dict) -> tuple[list[str], int]:
    """
    Collect base64 images from a Comfy history entry.
    Returns (images_b64, refs_seen) so callers can distinguish 'no refs' vs 'refs but unreadable'.
    """
    images: list[str] = []
    refs_seen = 0
    outs = hist.get("outputs")
    if not isinstance(outs, dict):
        return images, refs_seen
    for _nid, out in outs.items():
        if not isinstance(out, dict):
            continue
        for img in out.get("images") or []:
            if not isinstance(img, dict):
                continue
            fn = img.get("filename")
            if not fn:
                continue
            refs_seen += 1
            raw = _get_image(
                str(fn),
                str(img.get("subfolder") or ""),
                str(img.get("type") or "output"),
            )
            if raw and len(raw) >= 32:
                images.append(base64.b64encode(raw).decode("utf-8"))
    return images, refs_seen


def _poll_comfy_images(prompt_id: str, *, label: str = "") -> dict:
    """Wait for a queued prompt; return {ok, message, images}."""
    if not prompt_id:
        return {"ok": False, "message": "ComfyUI queue returned no prompt_id.", "images": []}
    dead_streak = 0
    empty_fetch_streak = 0
    for _ in range(360):
        time.sleep(1)
        if _comfy_process_dead():
            dead_streak += 1
            # Hard crash (VAE Decode AV) leaves no history — detect after a few refused probes.
            if dead_streak >= 3:
                msg = (
                    _vae_decode_crash_message()
                    if _sniff_comfy_spawn_log_vae_crash()
                    else _comfy_down_message()
                )
                return {"ok": False, "message": msg, "images": [], "comfy_crashed": True}
            continue
        dead_streak = 0
        hist_raw = _get_history(prompt_id)
        hist = coerce_comfy_history_entry(hist_raw) or (hist_raw if isinstance(hist_raw, dict) else None)
        if not hist:
            continue
        images, refs_seen = _harvest_history_images(hist)
        if images:
            msg = f"Generated with ComfyUI: {(label or 'image')[:50]}..."
            return {"ok": True, "message": msg, "images": images}

        err_msgs = hist.get("status", {}).get("messages") if isinstance(hist.get("status"), dict) else None
        if err_msgs and isinstance(err_msgs, list):
            has_error = any(
                isinstance(m, (list, tuple)) and len(m) > 0 and "error" in str(m[0]).lower()
                for m in err_msgs
            )
            if has_error:
                return {
                    "ok": False,
                    "message": _format_comfy_execution_error(err_msgs),
                    "images": [],
                    "oom": _history_is_oom(err_msgs),
                }
        elif err_msgs and not isinstance(err_msgs, list):
            return {"ok": False, "message": str(err_msgs), "images": []}

        # Comfy finished (preview visible in UI) but Butler could not fetch bytes — do not spin 6 min.
        if _history_job_finished(hist) and ("outputs" in hist or refs_seen > 0):
            empty_fetch_streak += 1
            if empty_fetch_streak >= 3:
                if refs_seen > 0:
                    return {
                        "ok": False,
                        "message": (
                            "ComfyUI finished, but Butler could not download the result image "
                            f"({refs_seen} output ref(s) in history). Check Comfy output/temp folders "
                            f"on {_comfy_url()} or restart ComfyUI, then retry."
                        ),
                        "images": [],
                    }
                return {
                    "ok": False,
                    "message": (
                        "ComfyUI finished with no image outputs in history. "
                        "Ensure the workflow has PreviewImage or SaveImage (or ButlerSweepSave), then retry."
                    ),
                    "images": [],
                }
        else:
            empty_fetch_streak = 0
    if _comfy_process_dead() and _sniff_comfy_spawn_log_vae_crash():
        return {"ok": False, "message": _vae_decode_crash_message(), "images": [], "comfy_crashed": True}
    return {
        "ok": False,
        "message": "ComfyUI timed out (6 min). FaceID workflows can be slow—try again or reduce steps.",
        "images": [],
    }


def _format_comfy_execution_error(messages: object) -> str:
    """Turn Comfy history status.messages into a short UI-facing error."""
    if not isinstance(messages, list):
        return str(messages)[:500]
    for key, payload in _iter_comfy_status_messages(messages):
        if "error" not in key.lower():
            continue
        em = str(payload.get("exception_message") or "").strip()
        et = str(payload.get("exception_type") or "").strip()
        nt = str(payload.get("node_type") or "").strip()
        first = em.split("\n", 1)[0].strip() if em else ""
        who = f" on {nt}" if nt else ""
        low = f"{em} {et} {nt}".lower()
        tip = ""
        if et.lower() == "memoryerror" or "out of memory" in low or "allocation on device" in low:
            if "reactor" in low:
                tip = (
                    " ReActor ran out of memory loading the face-swap ONNX after SDXL/FaceID. "
                    "Butler clears Comfy's model cache and retries once on MemoryError/OOM."
                )
            else:
                tip = (
                    " Hit fragmented VRAM/RAM (Butler UI/Knowledge are CPU-only). "
                    "Retry — Butler clears Comfy's model cache once on OOM."
                )
        if not first:
            kind = et or "error"
            return f"ComfyUI{who} — {kind}.{tip}"
        kind = f"{et}: " if et else ""
        return f"ComfyUI{who} — {kind}{first}{tip}"
    return str(messages)[:500]


def _comfy_input_dir() -> Path:
    override = (
        os.environ.get("BUTLER_COMFY_INPUT_DIR")
        or os.environ.get("COMFYUI_INPUT_DIR")
        or ""
    ).strip()
    if override:
        return Path(override)
    return Path(_sd_project_path()) / "ComfyUI" / "input"


def _is_path_under_dir(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def _local_uploaded_input_file(filename: str, subfolder: str) -> Path | None:
    """
    Absolute path to the file Comfy wrote after /upload/image, when Butler shares SD_PROJECT_PATH with that Comfy.
    """
    root = _comfy_input_dir()
    if not root.is_dir():
        return None
    fn = (filename or "").strip()
    if not fn or ".." in fn.replace("\\", "/"):
        return None
    sub = (subfolder or "").strip().replace("\\", "/").strip("/")
    candidates: list[Path] = []
    if sub:
        candidates.append(root / sub / fn)
    candidates.append(root / fn)
    for p in candidates:
        try:
            rp = p.resolve()
            if rp.is_file() and _is_path_under_dir(rp, root):
                return rp
        except OSError:
            continue
    return None


def _rel_path_for_load_image(abs_file: Path) -> str:
    """Posix path relative to ComfyUI/input for LoadImage / exists_annotated_filepath."""
    inp = _comfy_input_dir().resolve()
    return abs_file.resolve().relative_to(inp).as_posix()


def _comfy_load_image_ref(filename: str, subfolder: str) -> str:
    """Path string for LoadImage: subfolder/filename when upload used a subfolder."""
    fn = _normalize_uploaded_image_name(filename)
    sub = _normalize_uploaded_subfolder(subfolder)
    if sub:
        return f"{sub}/{fn}"
    return fn


def _normalize_uploaded_subfolder(subfolder: str | None) -> str:
    raw = unquote((subfolder or "").strip()).replace("\\", "/").strip("/")
    if not raw:
        return ""
    parts = [p.strip() for p in raw.split("/") if p.strip() not in ("", ".", "..")]
    return "/".join(parts)


def _normalize_uploaded_image_name(filename: str | None, fallback_ext: str = "png") -> str:
    raw = unquote((filename or "").strip()).replace("\\", "/")
    raw = raw.split("/")[-1].split("?")[0].split("#")[0].strip().strip(". ")
    raw = re.sub(r"[\x00-\x1f]+", "", raw)
    raw = re.sub(r"[^A-Za-z0-9._()\- ]+", "_", raw)
    raw = re.sub(r"\s+", " ", raw).strip()
    if not raw:
        raw = f"butler_input.{fallback_ext}"
    elif "." not in raw:
        raw = f"{raw}.{fallback_ext}"
    return raw[:180]


def _materialize_uploaded_input_file(raw: bytes, filename: str, subfolder: str) -> Path | None:
    """
    Mirror the uploaded bytes into Comfy's effective input dir so desktop/runtime-specific input
    directories work even when object-info combo choices lag behind the actual upload.
    """
    root = _comfy_input_dir()
    try:
        root.mkdir(parents=True, exist_ok=True)
    except OSError:
        return None
    safe_name = _normalize_uploaded_image_name(filename, _sniff_image_ext(raw))
    safe_sub = _normalize_uploaded_subfolder(subfolder)
    target = root / safe_name if not safe_sub else root.joinpath(*safe_sub.split("/"), safe_name)
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        resolved = target.resolve()
        if not _is_path_under_dir(resolved, root):
            return None
        target.write_bytes(raw)
        return resolved
    except OSError:
        return None



def _should_prefer_direct_comfy_handoff() -> bool:
    """
    Desktop Butler launches Comfy with a dedicated runtime input dir.
    In that mode, write the decoded bytes directly into Comfy's live input folder
    instead of depending on /upload/image to refresh object_info immediately.
    """
    for key in ("BUTLER_COMFY_INPUT_DIR", "COMFYUI_INPUT_DIR"):
        if (os.environ.get(key) or "").strip():
            return True
    return False


def _stage_b64_into_comfy_input(image_b64: str, filename: str | None = None) -> dict:
    """Late-decode a base64 image directly into Comfy's effective input dir."""
    try:
        raw = base64.b64decode(image_b64)
    except Exception as e:
        return {"ok": False, "message": f"Invalid image base64: {e}"}
    ext = _sniff_image_ext(raw)
    safe_name = _normalize_uploaded_image_name(filename, ext)
    local_file = _materialize_uploaded_input_file(raw, safe_name, "")
    if local_file is None:
        return {
            "ok": False,
            "message": f"Could not write image into Comfy input dir: {_comfy_input_dir()}",
        }
    return {
        "ok": True,
        "name": local_file.name,
        "subfolder": "",
        "type": "input",
        "local_path": str(local_file),
    }


def _pick_load_image_combo_value(desired: str, choices: list[str] | None) -> str | None:
    """Return an entry from choices that should resolve to the same file as desired, or None."""
    if not choices:
        return None
    d = (desired or "").strip().replace("\\", "/")
    if not d:
        return None
    base = d.split("/")[-1]
    if d in choices:
        return d
    for cand in (f"{d} [input]", f"{base} [input]"):
        if cand in choices:
            return cand
    if base in choices:
        return base
    for c in choices:
        cnorm = str(c).replace("\\", "/").rstrip("/")
        if cnorm == d or cnorm.endswith("/" + base):
            return c
    return None


def _strip_load_image_annotation(name: str) -> str:
    s = (name or "").strip()
    if s.endswith("[input]"):
        return s[:-8].strip()
    if s.endswith("[output]"):
        return s[:-9].strip()
    if s.endswith("[temp]"):
        return s[:-7].strip()
    return s


def _input_file_exists_for_load_image_value(image_field: str) -> bool:
    """True if path resolves to a file under ComfyUI/input (same idea as Comfy exists_annotated_filepath for input)."""
    root = _comfy_input_dir()
    if not root.is_dir():
        return False
    rel = _strip_load_image_annotation(image_field).replace("\\", "/")
    if not rel or ".." in rel:
        return False
    try:
        p = (root / rel).resolve()
        return p.is_file() and _is_path_under_dir(p, root)
    except OSError:
        return False


def _ensure_txt2img_face_reference_images(workflow: dict) -> str | None:
    """
    Face-ID txt2img workflows often ship with placeholder LoadImage names (e.g. rosario_4.jpg).
    If those files are missing, swap to the first real file in Comfy's input list (or on disk under input).
    """
    load_ids = [
        nid for nid, n in workflow.items() if isinstance(n, dict) and n.get("class_type") == "LoadImage"
    ]
    if not load_ids:
        return None
    invalidate_object_info_cache()
    combo = _combo_choices("LoadImage", "image") or []
    root = _comfy_input_dir()
    disk_first: str | None = None
    if root.is_dir():
        exts = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"}
        for f in sorted(root.rglob("*")):
            if f.is_file() and f.suffix.lower() in exts:
                try:
                    disk_first = f.resolve().relative_to(root.resolve()).as_posix()
                    break
                except ValueError:
                    continue
    pick: str | None = combo[0] if combo else disk_first
    if not pick:
        return (
            "This txt2img workflow needs a reference image in ComfyUI/input (FaceID), but the folder is empty. "
            "Add any JPG/PNG, or use workflow txt2img_Juggernaut for text-only generation."
        )
    for nid in load_ids:
        inp = workflow[nid].setdefault("inputs", {})
        cur = inp.get("image")
        cur_s = cur.strip() if isinstance(cur, str) else ""
        on_disk = bool(cur_s) and _input_file_exists_for_load_image_value(cur_s)
        in_combo = True
        if combo and cur_s:
            in_combo = cur_s in combo or _pick_load_image_combo_value(cur_s, combo) is not None
        if not on_disk or not in_combo:
            chosen = _pick_load_image_combo_value(pick, combo) if combo else pick
            if combo and chosen is None:
                chosen = combo[0]
            inp["image"] = chosen if chosen is not None else pick
    return None


def _ensure_load_image_matches_comfy(workflow: dict, load_node_id: str, filename: str, subfolder: str) -> str | None:
    """
    Set LoadImage 'image' to a value Comfy's validator accepts (exists under input; combo when available).
    Returns error message if we cannot resolve.
    """
    path_ref = _comfy_load_image_ref(filename, subfolder)
    inputs = workflow[load_node_id]["inputs"]
    local_file = _local_uploaded_input_file(filename, subfolder)
    if local_file is not None:
        path_ref = _rel_path_for_load_image(local_file)

    choices = _combo_choices("LoadImage", "image")
    picked = _pick_load_image_combo_value(path_ref, choices)
    if picked is not None:
        inputs["image"] = picked
        return None

    if choices:
        invalidate_object_info_cache()
        choices2 = _combo_choices("LoadImage", "image") or []
        picked2 = _pick_load_image_combo_value(path_ref, choices2)
        if picked2 is not None:
            inputs["image"] = picked2
            return None
        if local_file is not None:
            inputs["image"] = path_ref
            return None
        return (
            f"Uploaded image '{filename}' is not in Comfy's input list (got {len(choices)} files before refresh, "
            f"{len(choices2)} after). Save the image into ComfyUI/input or restart ComfyUI, then try again."
        )

    inputs["image"] = path_ref
    return None


def _get_workflow_path(name: str) -> Path | None:
    """Find workflow: SD project's ComfyUI/workflows, workflows/test/ (flat or nested), then bundled."""
    base = (name or "").replace(".json", "").strip()
    if not base:
        return None
    norm = base.replace("\\", "/")
    if ".." in norm.split("/"):
        return None
    wf_root = _workflows_dir()
    if "/" not in norm:
        fname = f"{base}.json"
        for dir_ in (wf_root, wf_root / "test", _bundled_workflows_dir()):
            p = dir_ / fname
            if p.is_file():
                return p
    else:
        td = wf_root / "test"
        parts = PurePosixPath(norm.strip("/")).parts
        if ".." in parts or not parts:
            return None
        try:
            cand = td.joinpath(*parts).with_suffix(".json").resolve()
            cand.relative_to(td.resolve())
        except (ValueError, OSError):
            return None
        if cand.is_file():
            return cand
    return None


def _is_connection_error(err: str) -> bool:
    return any(
        x in err
        for x in (
            "Connection refused",
            "Max retries exceeded",
            "10061",
            "10060",
            "ConnectionResetError",
            "10054",
            "RemoteDisconnected",
            "Connection aborted",
            "Failed to establish a new connection",
        )
    )


def _comfy_process_dead(timeout: float = 1.5) -> bool:
    """
    True only when Comfy is clearly gone (refused/reset), not when the API is just busy.
    Timeouts during VAEDecode must not be treated as a crash.
    """
    try:
        import requests
        from requests.exceptions import ConnectionError as ReqConnectionError
        from requests.exceptions import Timeout as ReqTimeout

        try:
            r = requests.get(f"{_comfy_url()}/system_stats", timeout=timeout)
            return False
        except ReqTimeout:
            return False
        except ReqConnectionError as e:
            return _is_connection_error(str(e))
        except Exception as e:
            return _is_connection_error(str(e))
    except Exception:
        return False


def _vae_decode_crash_message() -> str:
    port = _comfy_listen_port()
    return (
        f"ComfyUI crashed during VAE Decode (Windows access violation while unloading the UNet "
        f"to load the VAE). This is a hard process crash, not a Python exception. "
        f"Use Status → Restart ComfyUI (port {port}), close other GPU apps if VRAM is tight, "
        f"then retry. Desktop Butler now starts Comfy with --normalvram --fp16-vae to avoid this."
    )


def _sniff_comfy_spawn_log_vae_crash() -> bool:
    """True if the spawn log shows the known Windows AV at AutoencoderKL / VAEDecode."""
    candidates = []
    try:
        import tempfile

        candidates.append(os.path.join(tempfile.gettempdir(), "butler-comfyui-spawn.log"))
        candidates.append(os.path.join(tempfile.gettempdir(), "butler-comfyui-desktop", "comfy-console.log"))
    except Exception:
        pass
    for path in candidates:
        try:
            if not os.path.isfile(path):
                continue
            # Tail only — log can grow large across restarts.
            with open(path, "rb") as f:
                f.seek(0, os.SEEK_END)
                size = f.tell()
                f.seek(max(0, size - 24_000), os.SEEK_SET)
                tail = f.read().decode("utf-8", errors="ignore").lower()
            if "access violation" in tail and (
                "autoencoderkl" in tail or "vaedecode" in tail or "unpatch_model" in tail
            ):
                return True
        except Exception:
            continue
    return False


def _prefer_tiled_vae_decode(workflow: dict) -> None:
    """
    Rewrite VAEDecode → VAEDecodeTiled (lower peak VRAM during decode).
    Does not fix the Windows unload AV by itself; pairs with normalvram launch flags.
    """
    if not isinstance(workflow, dict):
        return
    for node in workflow.values():
        if not isinstance(node, dict) or node.get("class_type") != "VAEDecode":
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        node["class_type"] = "VAEDecodeTiled"
        inputs.setdefault("tile_size", 512)
        inputs.setdefault("overlap", 64)
        inputs.setdefault("temporal_size", 64)
        inputs.setdefault("temporal_overlap", 8)


def _comfy_listen_port() -> int:
    base = _comfy_url()
    try:
        from urllib.parse import urlparse

        u = urlparse(base if "://" in base else f"http://{base}")
        if u.port:
            return int(u.port)
        return 443 if (u.scheme or "").lower() == "https" else 80
    except Exception:
        return 8188


def _comfy_down_message() -> str:
    root = _sd_project_path()
    comfy = os.path.join(root, "ComfyUI")
    port = _comfy_listen_port()
    if os.name == "nt":
        venv_py = os.path.join(comfy, "venv", "Scripts", "python.exe")
        if os.path.isfile(venv_py):
            manual = f'cd /d "{comfy}" && "{venv_py}" main.py --port {port}'
        else:
            manual = f'cd /d "{comfy}" && py -3 main.py --port {port}'
        hint = (
            f"Nothing is listening on {port}. In desktop Butler use Status → Restart ComfyUI "
            f"(expects port {port}). Or run manually:\n{manual}"
        )
    else:
        venv_py = os.path.join(comfy, "venv", "bin", "python")
        manual = (
            f'cd "{comfy}" && "{venv_py}" main.py --port {port}'
            if os.path.isfile(venv_py)
            else f'cd "{comfy}" && python3 main.py --port {port}'
        )
        hint = f"ComfyUI is not running on port {port}. Start it from a terminal:\n{manual}"
    return hint


def _sniff_image_ext(raw: bytes) -> str:
    if len(raw) >= 8 and raw[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if len(raw) >= 3 and raw[:3] == b"\xff\xd8\xff":
        return "jpg"
    if len(raw) >= 12 and raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return "webp"
    if len(raw) >= 6 and raw[:6] in (b"GIF87a", b"GIF89a"):
        return "gif"
    return "png"


def _mime_for_image_filename(fname: str) -> str:
    ext = (fname.rsplit(".", 1)[-1] if "." in fname else "").lower()
    return {
        "png": "image/png",
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "webp": "image/webp",
        "gif": "image/gif",
    }.get(ext, "application/octet-stream")


def _upload_image(image_b64: str, filename: str | None = None) -> dict:
    """Upload base64 image to ComfyUI. Returns {name, subfolder, type} or error."""
    if _should_prefer_direct_comfy_handoff():
        staged = _stage_b64_into_comfy_input(image_b64, filename)
        if staged.get("ok"):
            invalidate_object_info_cache()
            return staged
    try:
        import requests
    except ImportError:
        return {"ok": False, "message": "Install requests: pip install requests"}
    url = f"{_comfy_url()}/upload/image"
    raw = base64.b64decode(image_b64)
    ext = _sniff_image_ext(raw)
    fname = _normalize_uploaded_image_name(filename, ext)
    mime = _mime_for_image_filename(fname)
    try:
        r = requests.post(
            url,
            files={"image": (fname, raw, mime)},
            data={"type": "input"},
            timeout=60,
        )
        r.raise_for_status()
        data = r.json()
        actual_name = _normalize_uploaded_image_name(data.get("name", fname), ext)
        actual_subfolder = _normalize_uploaded_subfolder(data.get("subfolder", ""))
        local_file = _materialize_uploaded_input_file(raw, actual_name, actual_subfolder)
        return {
            "ok": True,
            "name": actual_name,
            "subfolder": actual_subfolder,
            "type": data.get("type", "input"),
            "local_path": str(local_file) if local_file is not None else "",
        }
    except Exception as e:
        err = str(e)
        return {"ok": False, "message": _comfy_down_message() if _is_connection_error(err) else err}


def _queue_prompt(prompt: dict) -> dict:
    """Queue workflow. Returns {prompt_id} or error."""
    try:
        import requests
    except ImportError:
        return {"ok": False, "message": "Install requests"}
    url = f"{_comfy_url()}/prompt"
    try:
        r = requests.post(url, json={"prompt": prompt}, timeout=30)
        r.raise_for_status()
        data = r.json()
        return {"ok": True, "prompt_id": data.get("prompt_id")}
    except requests.exceptions.HTTPError as e:
        # Capture ComfyUI's validation error (400) for debugging
        body = ""
        if e.response is not None:
            try:
                j = e.response.json()
                # ComfyUI can return node_errors with per-node failure details
                node_errors = j.get("node_errors", {})
                if node_errors:
                    parts = []
                    for nid, nd in list(node_errors.items())[:5]:
                        errs = nd.get("errors", []) if isinstance(nd, dict) else []
                        for err in errs[:2]:
                            if isinstance(err, dict):
                                msg = (err.get("message") or "").strip()
                                det = (err.get("details") or "").strip()
                                typ = (err.get("type") or "").strip()
                                chunk = f"{nid}: {msg}" if msg else f"{nid}: ({typ or 'error'})"
                                if det:
                                    chunk += f" — {det}"
                                if typ and typ not in chunk:
                                    chunk += f" [{typ}]"
                                parts.append(chunk)
                            elif err:
                                parts.append(f"{nid}: {err}")
                    if parts:
                        body = "; ".join(parts)
                if not body:
                    body = j.get("detail") or (j.get("error", {}) or {}).get("message") if isinstance(j.get("error"), dict) else None
                if not body:
                    body = str(j)[:400]
            except Exception:
                body = (e.response.text or "")[:500]
        err = body or str(e)
        el = err.lower()
        if "invalid image file" in el:
            hint = (
                " Tip: LoadImage must point at a file under ComfyUI/input (use the exact path Comfy shows in the Load Image "
                "dropdown, including any subfolder). Butler updates every LoadImage node after upload—if SD_PROJECT_PATH "
                "does not point at this Comfy install, paths will not match."
            )
        else:
            hint = (
                " Tip: put at least one .safetensors in ComfyUI/models/checkpoints; after upload Butler refreshes Comfy's file list. "
                "If this persists, open ComfyUI → Load Image and confirm your file appears in the dropdown."
            )
        return {"ok": False, "message": f"ComfyUI rejected workflow: {err}{hint}"}
    except Exception as e:
        err = str(e)
        return {"ok": False, "message": _comfy_down_message() if _is_connection_error(err) else err}


def _get_history(prompt_id: str) -> dict | None:
    try:
        import requests
    except ImportError:
        return None
    url = f"{_comfy_url()}/history/{prompt_id}"
    try:
        r = requests.get(url, timeout=10)
        r.raise_for_status()
        data = r.json()
        if not isinstance(data, dict):
            return None
        if prompt_id in data:
            return data.get(prompt_id)
        # Some proxies/forks return the entry unwrapped (or empty {} while still running).
        if "outputs" in data or "status" in data or "prompt" in data:
            return data
        return None
    except Exception:
        return None


def coerce_comfy_history_entry(hist: object) -> dict | None:
    """
    ComfyUI normally stores each job as a dict with prompt, outputs, status.
    Some forks/API wrappers may return a list/tuple; pick the dict that carries outputs/status.
    """
    if hist is None:
        return None
    if isinstance(hist, dict):
        return hist
    if isinstance(hist, (list, tuple)):
        for el in reversed(hist):
            if isinstance(el, dict) and ("outputs" in el or "status" in el):
                return el
        for el in reversed(hist):
            if isinstance(el, dict):
                return el
    return None


_object_info_cache: dict | None = None


def _probe_object_info_uncached(timeout: float = 15.0) -> tuple[bool, str]:
    """
    Lightweight readiness probe: GET /object_info/CheckpointLoaderSimple (not the full schema).
    Full /object_info is large and can MemoryError under Windows commit pressure; Butler fetches
    the full map lazily via _fetch_object_info when needed.
    """
    try:
        import requests
    except ImportError:
        return False, "requests not installed"
    url = f"{_comfy_url()}/object_info/CheckpointLoaderSimple"
    try:
        r = requests.get(url, timeout=timeout)
        r.raise_for_status()
        data = r.json()
        if isinstance(data, dict) and "CheckpointLoaderSimple" in data:
            return True, ""
        if isinstance(data, dict) and len(data) > 0:
            return True, ""
        return False, "object_info empty"
    except Exception as e:
        err = str(e)
        return False, (_comfy_down_message() if _is_connection_error(err) else err)[:220]


def wait_for_comfy_api_ready(max_wait_sec: float = 120.0, poll_sec: float = 2.5) -> tuple[bool, str]:
    """
    Poll until ComfyUI serves a node schema (GET /object_info/CheckpointLoaderSimple).
    Use after Comfy starts listening so queue/prompt does not fail while still booting.
    Clears queue on first successful connection to prevent stale sweep runs from persisting across restarts.
    """
    import time

    deadline = time.monotonic() + max_wait_sec
    last = ""
    first_ready = False
    while time.monotonic() < deadline:
        global _object_info_cache
        _object_info_cache = None
        ok, last = _probe_object_info_uncached()
        if ok:
            if not first_ready:
                first_ready = True
                # Clear queue on first ready to prevent stale sweep runs from persisting
                try:
                    import requests
                    requests.post(f"{_comfy_url()}/interrupt", timeout=5)
                except Exception:
                    pass
                try:
                    import requests
                    requests.post(f"{_comfy_url()}/queue", json={"clear": True}, timeout=5)
                except Exception:
                    pass
            return True, ""
        time.sleep(poll_sec)
    return False, (
        f"ComfyUI did not finish loading within {int(max_wait_sec)}s (last: {last}). "
        "Wait until the Status tab shows Comfy ready, then retry."
    )


def _fetch_object_info() -> dict | None:
    """Fetch ComfyUI object_info for widget name mapping. Cached for session."""
    global _object_info_cache
    if _object_info_cache is not None:
        return _object_info_cache
    if os.environ.get("BUTLER_OFFLINE_TESTS", "").strip().lower() in ("1", "true", "yes", "on"):
        return None
    try:
        import requests
    except ImportError:
        return None
    url = f"{_comfy_url()}/object_info"
    try:
        r = requests.get(url, timeout=5)
        r.raise_for_status()
        _object_info_cache = r.json()
        return _object_info_cache
    except Exception:
        return None


def _get_widget_order_from_object_info(node_type: str) -> list[str] | None:
    """Get ordered widget input names for a node type from ComfyUI object_info."""
    info = _fetch_object_info()
    if not info or node_type not in info:
        return None
    node_info = info[node_type]
    input_order = node_info.get("input_order", {})
    if not input_order:
        return None
    order = list(input_order.get("required", [])) + list(input_order.get("optional", []))
    return order if order else None


_SWEEP_ENC_KEY = "butler-sweep-secure-key-2024"


def _split_comfy_image_ref(filename: str, subfolder: str = "") -> tuple[str, str]:
    """
    Normalize Comfy image refs for /view and disk reads.
    ButlerSweepSave historically put a relative path in `filename` with empty `subfolder`;
    Comfy's /view does basename(filename), which drops the subfolder and 404s.
    """
    fn = (filename or "").replace("\\", "/").strip()
    sub = (subfolder or "").replace("\\", "/").strip().strip("/")
    while "//" in fn:
        fn = fn.replace("//", "/")
    while "//" in sub:
        sub = sub.replace("//", "/")
    fn = fn.strip("/")
    if not fn:
        return "", sub
    if "/" in fn:
        head, tail = fn.rsplit("/", 1)
        fn = tail
        head = head.strip("/")
        sub = f"{sub}/{head}".strip("/") if sub else head
    return fn, sub


def _maybe_decode_sweep_enc(raw: bytes, filename: str = "") -> bytes:
    """Decode ButlerSweepSave .enc XOR payloads (privacy-at-rest); pass through normal images."""
    if not raw:
        return raw
    if raw[:8] == b"\x89PNG\r\n\x1a\n" or raw[:2] == b"\xff\xd8":
        return raw
    if len(raw) >= 12 and raw[:4] == b"RIFF":
        return raw
    low = (filename or "").lower()
    if low.endswith((".png", ".jpg", ".jpeg", ".webp", ".gif")) and not low.endswith(".enc"):
        return raw
    try:
        key = _SWEEP_ENC_KEY
        decoded = bytes(b ^ key[i % len(key)] for i, b in enumerate(raw))
        if decoded[:8] == b"\x89PNG\r\n\x1a\n" or decoded[:2] == b"\xff\xd8":
            return decoded
    except Exception:
        pass
    return raw


def _comfy_folder_dir(folder_type: str) -> Path | None:
    """Resolve Comfy output/temp/input dirs (honors desktop BUTLER_COMFY_* overrides)."""
    t = (folder_type or "output").strip().lower() or "output"
    if t == "input":
        return _comfy_input_dir()
    if t == "temp":
        override = (
            os.environ.get("BUTLER_COMFY_TEMP_DIR")
            or os.environ.get("COMFYUI_TEMP_DIR")
            or ""
        ).strip()
        if override:
            return Path(override)
        root = (os.environ.get("BUTLER_COMFY_TEMP_ROOT") or "").strip()
        if root:
            return Path(root) / "temp"
        return Path(_sd_project_path()) / "ComfyUI" / "temp"
    # output
    override = (
        os.environ.get("BUTLER_COMFY_OUTPUT_DIR")
        or os.environ.get("COMFYUI_OUTPUT_DIR")
        or ""
    ).strip()
    if override:
        return Path(override)
    root = (os.environ.get("BUTLER_COMFY_TEMP_ROOT") or "").strip()
    if root:
        return Path(root) / "output"
    return Path(_sd_project_path()) / "ComfyUI" / "output"


def _read_image_from_disk(filename: str, subfolder: str = "", folder_type: str = "output") -> bytes | None:
    fn, sub = _split_comfy_image_ref(filename, subfolder)
    if not fn:
        return None
    root = _comfy_folder_dir(folder_type)
    if root is None:
        return None
    try:
        path = root.joinpath(*sub.split("/"), fn) if sub else root / fn
        if not path.is_file():
            return None
        raw = path.read_bytes()
        return _maybe_decode_sweep_enc(raw, fn)
    except Exception:
        return None


def _get_image(filename: str, subfolder: str = "", folder_type: str = "output") -> bytes | None:
    fn, sub = _split_comfy_image_ref(filename, subfolder)
    if not fn:
        return None
    # Prefer HTTP /view (works across machines); fall back to local disk for desktop path bugs.
    try:
        import requests
        from urllib.parse import urlencode
    except ImportError:
        return _read_image_from_disk(fn, sub, folder_type)
    params = urlencode({"filename": fn, "subfolder": sub, "type": folder_type or "output"})
    url = f"{_comfy_url()}/view?{params}"
    try:
        r = requests.get(url, timeout=30)
        r.raise_for_status()
        raw = r.content
        if raw and len(raw) >= 32:
            return _maybe_decode_sweep_enc(raw, fn)
    except Exception:
        pass
    return _read_image_from_disk(fn, sub, folder_type)


def _config_dir() -> Path:
    from butlor_paths import get_butlor_config_dir

    return get_butlor_config_dir()


def _comfy_config_path() -> Path:
    return _config_dir() / "comfy_config.json"


# Default img2img: FaceID portrait unnorm when ComfyUI_IPAdapter_plus + models are installed (scripts/install_faceid_stack.py).
# Fallback order: simple VAE img2img → Juggernaut if queue validation fails.
# Prompts: enhance_for_comfy (identity + adult cues); BUTLER_SKIP_SD_PROMPT_ENHANCE=1 for raw user text (no Butler tags).
_PREFERRED_DEFAULT_IMG2IMG = "img2img_juggernaut_faceid_easy_nsfw"
_VERBATIM_PROMPT_IMG2IMG_WORKFLOWS: frozenset[str] = frozenset({
    "img2img_juggernaut_faceid_openpose_action_nsfw",
})
_DEFAULT_IMG2IMG_ORDER = (
    "img2img_juggernaut_faceid_easy_nsfw",  # ButlerEasyPrompt boxes + FaceID + ReActor (utility panel)
    "img2img_juggernaut_faceid_openpose_action_nsfw",  # separate face + pose refs; one positive/negative
    "img2img_juggernaut_faceid_new_scene_nsfw",  # EmptyLatent + FaceID — same face, new pose/outfit/scene
    "img2img_butler_faceid_explicit_ultimate_nsfw",  # FaceID unnorm API graph (Butler promotes to EmptyLatent when needed)
    "img2img_butler_sdxl_vae_simple",  # SDXL VAE only — works without IPAdapter files
    "img2img_juggernaut_faceid_supreme_nsfw",  # VAEEncode img2img — subtle edits on same photo
    "img2img_butler_photoreal_faceid_nsfw",  # FaceID Plus V2 + FaceDetailer
    "img2img_faceid_FULL_SETUP",  # FaceID 0.98 / 1.78 + FaceDetailer — max face lock, NSFW photoreal checkpoint note
    "img2img_faceid_NSFW_ultra",  # 0.98 / 1.72 + FaceDetailer
    "img2img_faceid_NSFW_adherent",
    "img2img_faceid_NSFW_face_tight",
    "img2img_faceid_NSFW_natural",
    "img2img_faceid_Juggernaut_working",
    "img2img_faceid_Juggernaut",
    "img2img_faceid_optimized",
    "txt2img_faceid_Juggernaut_facefocus",  # EmptyLatent path — fallback if classical img2img graphs fail validation
    "img2img_Juggernaut",  # no FaceID — last resort
    # Plain SDXL VAEEncode img2img presets for workflows/test/ sweeps (denoise tuned like ComfyUI wiki img2img examples).
    "img2img_nsfw_sweep_soft_relight_sdxl",
    "img2img_nsfw_sweep_hard_restyle_sdxl",
)

# Text-only first — Face-ID graphs embed example filenames (e.g. rosario_4.jpg) that fail if missing from input.
_DEFAULT_TXT2IMG_ORDER = (
    "txt2img_pose_reference_controlnet",  # OpenPose map + ControlNet (pose tab)
    "txt2img_pose_reference_simple",  # legacy text-only Juggernaut (weak on complex poses)
    "txt2img_Juggernaut",
    "txt2img_faceid_NSFW_ultra",
    "txt2img_faceid_Juggernaut_facemax",
    "txt2img_faceid_Juggernaut",
)

# Pose-reference txt2img: keep user pose prompt verbatim (no NSFW/photoreal/scene auto-tags).
_VERBATIM_PROMPT_TXT2IMG_WORKFLOWS: frozenset[str] = frozenset({
    "txt2img_pose_reference_simple",
    "txt2img_pose_reference_controlnet",
})
_POSE_REFERENCE_TXT2IMG_WORKFLOWS = _VERBATIM_PROMPT_TXT2IMG_WORKFLOWS  # alias

# ControlNet OpenPose pose-ref: Stage A map is synthesized + uploaded before queue.
_POSE_REFERENCE_CONTROLNET_WORKFLOWS: frozenset[str] = frozenset({
    "txt2img_pose_reference_controlnet",
})

_POSE_REFERENCE_FALLBACK_POSITIVE = (
    "(follow the described pose exactly:1.55), (photorealistic:1.35), single adult person, "
    "clear human proportions, visible arms legs hands feet, full body head to toe in frame, "
    "distinct limb separation, simple clean clothing, realistic reference figure, "
    "NOT anime, NOT illustration, plain light background"
)
_POSE_REFERENCE_FALLBACK_NEGATIVE = (
    "anime, manga, cartoon, comic, chibi, illustration, illustrated, stylized art, "
    "silhouette, black silhouette, abstract shape, stick figure, blob, featureless body, shadow figure, "
    "wrong pose, ignored pose, different pose, arms in wrong position, hands in wrong position, "
    "legs in wrong position, multiple people, crowd, busy background, scenery, furniture, props, clutter, "
    "cropped body, out of frame, cut off head, cut off feet, hidden hands, hidden feet, missing limbs, "
    "extra limbs, fused limbs, overlapping limbs, text, watermark, logo, nude, nsfw"
)

# Three Juggernaut XL VAE img2img strengths for A/B/C picks (no FaceID — fast compare). See img2img_comfy_nsfw_compare_triple.
_IMG2IMG_NSFW_COMPARE_TRIO: tuple[tuple[str, str], ...] = (
    ("img2img_nsfw_compare_lock", "Lock — close to your photo (DPM++ 2M, low denoise)"),
    ("img2img_nsfw_compare_balanced", "Balanced — middle redraw (Euler a)"),
    ("img2img_nsfw_compare_bold", "Bold — strongest change (Euler a, high denoise)"),
)


def registered_comfy_workflow_names() -> tuple[str, ...]:
    """
    Every Comfy workflow basename Butler may load (img2img order, txt2img order, NSFW compare trio, bundled video names).
    Use for tests, installers, and docs. Files may live under SD_PROJECT_PATH/ComfyUI/workflows or knowledge/comfy_workflows/.
    """
    seen: list[str] = []

    def add(name: str) -> None:
        base = (name or "").replace(".json", "").strip()
        if base and base not in seen:
            seen.append(base)

    for n in _DEFAULT_IMG2IMG_ORDER:
        add(n)
    for n in _DEFAULT_TXT2IMG_ORDER:
        add(n)
    for n, _lbl in _IMG2IMG_NSFW_COMPARE_TRIO:
        add(n)
    for n in ("butler_txt2video", "butler_img2video", "butler_img2video_nsfw", "butler_img2video_wan22"):
        add(n)
    return tuple(seen)


def nsfw_compare_workflows_ready() -> bool:
    d = _workflows_dir()
    return all((d / f"{name}.json").exists() for name, _ in _IMG2IMG_NSFW_COMPARE_TRIO)


# Trailing token: "... scene /test" or "... /text" (word boundary so "foo/test" does not match).
_IMG2IMG_SWEEP_TOKEN_END = re.compile(r"(?:^|\s)/(?:test|text)\s*$", re.IGNORECASE)

# Stems excluded from sweep — not img2img graphs (txt2img + bundled video API workflows).
_IMG2IMG_SWEEP_DENY_STEMS = frozenset(
    {"butler_txt2video", "butler_img2video", "butler_img2video_nsfw", "butler_img2video_wan22"}
)


def img2img_triple_test_prefix_requested(prompt: str) -> bool:
    """
    True when the img2img prompt should run the workflow sweep: `/test` or `/text` at the
    start (optionally followed by a space) or as a final token after whitespace.
    """
    s = (prompt or "").strip()
    if not s:
        return False
    low = s.lower()
    if low in ("/test", "/text"):
        return True
    if low.startswith("/test ") or low.startswith("/text "):
        return True
    return bool(_IMG2IMG_SWEEP_TOKEN_END.search(s))


def strip_img2img_triple_test_prefix(prompt: str) -> str:
    """Legacy no-op: Butler passes img2img prompts to Comfy verbatim (sweep tokens are not stripped)."""
    return (prompt or "").strip()


def img2img_workflow_sweep_requested(data: dict) -> bool:
    """
    When True, /sd/img2img runs a sweep over workflow JSON files, triggered by `/test` or `/text` at
    start or end of prompt. If ComfyUI/workflows/test/ contains at least one .json, only those files
    are swept (including txt2img_*); otherwise the main workflows folder is swept (img2img_* only).
    Each output image is labeled with the workflow filename.

    `/test` / `/text` wins over an explicit ``workflow`` field in the JSON body (user intent is to run
    every graph in the sweep folder, not a single named file).
    """
    if os.environ.get("BUTLER_IMG2IMG_SINGLE", "").strip().lower() in ("1", "true", "yes", "on"):
        return False
    return img2img_triple_test_prefix_requested(data.get("prompt") or "")


def use_img2img_nsfw_compare_triple(data: dict) -> bool:
    """
    When True, /sd/img2img runs three lock/balanced/bold compare workflows (JSON compare_nsfw_triple only).
    Prompt `/test` or `/text` (sweep) is handled by img2img_workflow_sweep_requested, not this trio.
    Opt in: compare_nsfw_triple: true (trio JSON files must exist).
    Opt out: set workflow name, BUTLER_IMG2IMG_SINGLE=1, compare_nsfw_triple: false, or use `/test`/`/text` (sweep).
    """
    if img2img_triple_test_prefix_requested(data.get("prompt") or ""):
        return False
    wf = (data.get("workflow") or "").strip()
    if wf:
        return False
    if os.environ.get("BUTLER_IMG2IMG_SINGLE", "").strip().lower() in ("1", "true", "yes", "on"):
        return False
    raw = data.get("compare_nsfw_triple")
    if raw is not None:
        if raw is False:
            return False
        s = str(raw).strip().lower()
        if s in ("0", "false", "no", "off", ""):
            return False
        if s in ("1", "true", "yes", "on") or raw is True:
            return nsfw_compare_workflows_ready()
        return False
    return False


def _ensure_comfy_config() -> None:
    """Create Documents/Butlor/comfy_config.json with defaults if missing."""
    cfg_path = _comfy_config_path()
    if cfg_path.exists():
        return
    cfg_path.parent.mkdir(parents=True, exist_ok=True)
    wf_dir = _workflows_dir()
    default = {
        "img2img_workflow_order": list(_DEFAULT_IMG2IMG_ORDER),
        "txt2img_workflow_order": list(_DEFAULT_TXT2IMG_ORDER),
        "selected_checkpoint": "",
        "txt2video_workflow": "butler_txt2video",
        "img2video_workflow": "butler_img2video_nsfw",
        "base_positive_prompt": "",
        "base_negative_prompt": "",
        "_comment": (
            f"img2img: first existing JSON in img2img_workflow_order wins for normal runs; "
            f"default graph is {_PREFERRED_DEFAULT_IMG2IMG}.json. "
            f"Prompt /test or /text (start or end): if ComfyUI/workflows/test/ has any .json, sweeps that folder only (includes txt2img_*); else sweeps the main workflows folder (excludes txt2img_* and video bundles). "
            f"Optional base_positive_prompt / base_negative_prompt: merged into every SD run (Butler chat text first on positive). Or use SD_PROJECT_PATH/butler_sd_base_prompts.json or BUTLER_SD_BASE_* env — see .env.example. "
            f"Video: default img2video is butler_img2video_nsfw (Wan 2.1 I2V fp8). Override img2video_workflow or see knowledge/COMFY_VIDEO_SETUP.txt."
        ),
    }
    try:
        with open(cfg_path, "w", encoding="utf-8") as f:
            json.dump(default, f, indent=2)
    except Exception:
        pass


def _img2img_workflow_order_list() -> list[str]:
    """Resolved img2img try order; preferred default workflow is forced to the front when listed."""
    _ensure_comfy_config()
    order: list[str] = []
    cfg_path = _comfy_config_path()
    if cfg_path.exists():
        try:
            with open(cfg_path, encoding="utf-8") as f:
                data = json.load(f)
            raw = data.get("img2img_workflow_order") or data.get("img2img_order")
            if isinstance(raw, list):
                order = [str(x).replace(".json", "").strip() for x in raw if str(x).strip()]
            elif isinstance(raw, str) and raw.strip():
                order = [raw.replace(".json", "").strip()]
        except Exception:
            pass
    if not order:
        order = list(_DEFAULT_IMG2IMG_ORDER)
    pref = _PREFERRED_DEFAULT_IMG2IMG
    if pref in order:
        order = [pref] + [x for x in order if x != pref]
    else:
        order = [pref] + order
    seen: set[str] = set()
    deduped: list[str] = []
    for x in order:
        if x not in seen:
            seen.add(x)
            deduped.append(x)
    return deduped


def _existing_img2img_workflows() -> list[str]:
    """Basenames (no .json) in configured order: Comfy workflows folder or bundled knowledge/comfy_workflows/."""
    out: list[str] = []
    for name in _img2img_workflow_order_list():
        base = (name or "").replace(".json", "").strip()
        if not base:
            continue
        p = _get_workflow_path(base)
        if p and p.is_file():
            out.append(base)
    return out


def _test_workflows_dir_has_json(td: Path) -> bool:
    """True if workflows/test exists and contains at least one .json (any depth)."""
    if not td.is_dir():
        return False
    return any(p.is_file() for p in td.rglob("*.json"))


def _img2img_sweep_workflows_root() -> tuple[Path, bool]:
    """
    Directory whose *.json files a /test sweep uses, and whether txt2img_* stems are included.
    Prefer ComfyUI/workflows/test/ when it exists and has at least one .json file (including subfolders).
    """
    root = _workflows_dir()
    td = root / "test"
    if _test_workflows_dir_has_json(td):
        return td, True
    return root, False


def _img2img_sweep_candidate_stems(dir_: Path, *, allow_txt2img: bool) -> list[str]:
    """
    Workflow JSON paths for sweep as load stems (flat basename, or subdir/name for nested under test/).
    Main workflows folder: only top-level *.json. workflows/test/: all *.json recursively.
    """
    if not dir_.exists():
        return []
    stems: list[str] = []
    if allow_txt2img:
        for p in sorted(dir_.rglob("*.json"), key=lambda x: str(x).lower()):
            if not p.is_file():
                continue
            try:
                rel = p.relative_to(dir_)
            except ValueError:
                continue
            stem = rel.with_suffix("").as_posix()
            if rel.stem in _IMG2IMG_SWEEP_DENY_STEMS:
                continue
            stems.append(stem)
    else:
        for p in sorted(dir_.glob("*.json"), key=lambda x: x.name.lower()):
            if not p.is_file():
                continue
            stem = p.stem
            if stem in _IMG2IMG_SWEEP_DENY_STEMS:
                continue
            if stem.startswith("txt2img_"):
                continue
            stems.append(stem)
    seen: set[str] = set()
    out: list[str] = []
    for s in stems:
        if s not in seen:
            seen.add(s)
            out.append(s)
    return out


def _img2img_sweep_ordered_basenames(dir_: Path, allow_txt2img: bool) -> list[str]:
    """
    Ordered basenames for a /test sweep within dir_. Same ordering rules as the public sweep helper.
    """
    candidates = _img2img_sweep_candidate_stems(dir_, allow_txt2img=allow_txt2img)
    if not candidates:
        return []
    cand_set = set(candidates)
    seen: set[str] = set()
    out: list[str] = []
    for name in _img2img_workflow_order_list():
        base = (name or "").replace(".json", "").strip()
        if base in cand_set and base not in seen:
            seen.add(base)
            out.append(base)
    for stem in candidates:
        if stem not in seen:
            seen.add(stem)
            out.append(stem)
    return out


def _img2img_sweep_workflow_basenames() -> list[str]:
    """
    Sweep order: comfy_config img2img_workflow_order (hits in the sweep folder first), then remaining
    eligible *.json alphabetically. If using workflows/test/, txt2img_* graphs are included; otherwise excluded.
    """
    dir_, allow_txt2img = _img2img_sweep_workflows_root()
    return _img2img_sweep_ordered_basenames(dir_, allow_txt2img)


def _default_img2img_workflow() -> str:
    """Preferred img2img workflow: FaceID explicit ultimate when present (bundled or SD tree), else first existing in order."""
    ex = _existing_img2img_workflows()
    if ex:
        return ex[0]
    return "img2img_Juggernaut"


def _easy_prompt_mode(easy_prompt: dict | None) -> str | None:
    if not isinstance(easy_prompt, dict):
        return None
    mode = str(easy_prompt.get("mode") or easy_prompt.get("MODE") or "").strip().lower()
    return mode if mode in ("single", "sweep_winners", "sweep_20") else None


def _img2img_comfy_once(
    prompt: str,
    init_image_b64: str,
    negative_prompt: str = "",
    workflow_name: str | None = None,
    upload_filename: str | None = None,
    easy_prompt: dict | None = None,
    pose_image_b64: str | None = None,
    pose_upload_filename: str | None = None,
    pose_strength: float | None = None,
    pose_end_percent: float | None = None,
) -> dict:
    workflow_name = workflow_name or _default_img2img_workflow()
    wp = _get_workflow_path(workflow_name)
    if not wp or not wp.exists():
        return {
            "ok": False,
            "message": f"Workflow not found: {workflow_name}. Check SD_PROJECT_PATH and workflows folder.",
            "images": [],
        }
    try:
        with open(wp, encoding="utf-8") as f:
            raw_workflow = json.load(f)
    except Exception as e:
        return {"ok": False, "message": f"Invalid workflow JSON: {e}", "images": []}

    easy_fields_early = easy_prompt if isinstance(easy_prompt, dict) else None
    wfn_early = (workflow_name or "").replace(".json", "").strip()
    used_scene_boxes = False
    if wfn_early == "img2img_juggernaut_faceid_new_scene_nsfw" and easy_fields_early:
        used_scene_boxes = _apply_ui_new_scene_prompt_boxes(raw_workflow, easy_fields_early)

    # Convert UI format to API format if needed
    if _is_api_format(raw_workflow):
        workflow = raw_workflow
    else:
        workflow = _try_comfy_convert_api(raw_workflow) or _ui_to_api_format(raw_workflow)
        if not workflow:
            return {
                "ok": False,
                "message": "Failed to convert workflow. Restart ComfyUI after installing workflow-to-api-converter (ComfyUI Manager: search 'Workflow to API Converter').",
                "images": [],
            }

    up = _upload_image(init_image_b64, upload_filename)
    if not up.get("ok"):
        return {"ok": False, "message": up.get("message", "Upload failed"), "images": []}
    filename = up["name"]
    subfolder = up.get("subfolder", "")
    pose_name = None
    pose_sub = ""
    pose_b64 = (pose_image_b64 or "").strip()
    if pose_b64:
        up_pose = _upload_image(pose_b64, pose_upload_filename or "pose_reference.png")
        if not up_pose.get("ok"):
            return {"ok": False, "message": up_pose.get("message", "Pose upload failed"), "images": []}
        pose_name = up_pose["name"]
        pose_sub = up_pose.get("subfolder", "")
    invalidate_object_info_cache()

    bind_err = _bind_load_images_for_img2img(
        workflow,
        face_name=filename,
        face_subfolder=subfolder,
        pose_name=pose_name,
        pose_subfolder=pose_sub,
        workflow_name=workflow_name,
    )
    if bind_err:
        return {"ok": False, "message": bind_err, "images": []}
    _apply_pose_control_settings(workflow, pose_strength, pose_end_percent)

    easy_fields = easy_prompt if isinstance(easy_prompt, dict) else None
    if not easy_fields and workflow_has_butler_easy_prompt(workflow) and (prompt or "").strip():
        # Single free-text prompt → ACTION box on Easy graphs.
        easy_fields = {"action": (prompt or "").strip()}
        if (negative_prompt or "").strip():
            easy_fields["avoid"] = (negative_prompt or "").strip()

    used_easy = _apply_butler_easy_prompt_fields(workflow, easy_fields)
    if workflow_has_butler_easy_prompt(workflow):
        _ensure_butler_easy_prompt_defaults(workflow)

    pos_text = prompt or "high quality, detailed"
    neg_text = negative_prompt or ""
    wfn = (workflow_name or "").replace(".json", "").strip()
    if used_scene_boxes:
        # Positive CLIP is linked from PrimitiveString boxes; only refresh negative + seed.
        avoid = (neg_text or "").strip()
        if not avoid and easy_fields:
            avoid = str(easy_fields.get("avoid") or "").strip()
        if avoid:
            _wire_sampler_prompts(workflow, "keep-linked-positive", avoid)
        _apply_img2img_run_tweaks(workflow, "", workflow_name=wfn)
    elif not used_easy:
        try:
            if wfn == "img2img_juggernaut_faceid_openpose_action_nsfw":
                pos_text, neg_text = _compose_openpose_faceid_img2img_prompts(pos_text, neg_text)
            elif wfn in _VERBATIM_PROMPT_IMG2IMG_WORKFLOWS:
                from sd_prompt_enhance import merge_prompts_with_user_sd_base

                pos_text, neg_text = merge_prompts_with_user_sd_base(pos_text, neg_text)
            else:
                from sd_prompt_enhance import enhance_for_comfy

                pos_text, neg_text = enhance_for_comfy(pos_text, neg_text, mode="img2img")
        except Exception:
            pass
        _wire_sampler_prompts(workflow, pos_text, neg_text or "ugly, blurry, low quality")
        _apply_img2img_run_tweaks(workflow, pos_text, workflow_name=wfn)
    else:
        # Easy node builds CLIP text at runtime; only tweak non-prompt knobs if needed.
        _apply_img2img_run_tweaks(workflow, "", workflow_name=wfn)

    ck_err = _ensure_workflow_checkpoint_from_comfy(workflow, workflow_name=wfn)
    if ck_err:
        return {"ok": False, "message": ck_err, "images": []}
    _ensure_workflow_ckpt_exists(workflow, workflow_name=wfn)
    _downgrade_missing_butler_sweep_save(workflow)
    # Do NOT /free before every run — that forces a cold SDXL reload and OOMs on Windows
    # fragmentation. Comfy UI works because models stay warm; match that. Free only on OOM retry.
    q = _queue_prompt(workflow)
    if not q.get("ok"):
        msg_low = (q.get("message") or "").lower()
        # Stale Comfy without ButlerSweepSave — force SaveImage rewrite and retry once
        if "butlersweepsave" in msg_low or (
            "missing_node_type" in msg_low and "sweep" in msg_low
        ):
            _downgrade_missing_butler_sweep_save(workflow, force=True)
            q = _queue_prompt(workflow)
        if not q.get("ok"):
            msg_low = (q.get("message") or "").lower()
            # Fallback: FaceID → plain VAE img2img → Juggernaut when custom nodes / models missing
            if workflow_name != "img2img_Juggernaut" and (
                "validation" in msg_low
                or "value_not_in_list" in msg_low
                or "invalid image" in msg_low
                or "missing_node_type" in msg_low
            ):
                fallback = "img2img_Juggernaut"
                if workflow_name in (
                    "img2img_butler_faceid_explicit_ultimate_nsfw",
                    "img2img_juggernaut_faceid_easy_nsfw",
                ):
                    fb = _get_workflow_path("img2img_butler_sdxl_vae_simple")
                    if fb and fb.is_file():
                        fallback = "img2img_butler_sdxl_vae_simple"
                return img2img_comfy(
                    prompt=prompt,
                    init_image_b64=init_image_b64,
                    negative_prompt=negative_prompt,
                    workflow_name=fallback,
                    upload_filename=upload_filename,
                    easy_prompt=None,
                    pose_image_b64=pose_image_b64,
                    pose_upload_filename=pose_upload_filename,
                    pose_strength=pose_strength,
                    pose_end_percent=pose_end_percent,
                )
            return {"ok": False, "message": q.get("message", "Queue failed"), "images": []}
    result = _poll_comfy_images(q["prompt_id"], label=(prompt or "easy prompt"))
    if result.get("ok"):
        return result
    # One automatic recovery: free CUDA cache / unload models and re-queue the same graph
    if result.get("oom"):
        _comfy_free_vram(wait_s=2.5)
        q2 = _queue_prompt(workflow)
        if q2.get("ok"):
            retry = _poll_comfy_images(q2["prompt_id"], label=(prompt or "easy prompt"))
            if retry.get("ok"):
                retry["message"] = (retry.get("message") or "Done") + " (after VRAM clear retry)"
                return retry
            return {
                "ok": False,
                "message": retry.get("message")
                or result.get("message")
                or "ComfyUI OOM after VRAM clear retry",
                "images": [],
            }
    return {"ok": False, "message": result.get("message") or "ComfyUI failed", "images": []}


def _img2img_comfy_easy_prompt_sweep(
    prompt: str,
    init_image_b64: str,
    negative_prompt: str,
    workflow_name: str | None,
    upload_filename: str | None,
    easy_prompt: dict,
) -> dict:
    mode = _easy_prompt_mode(easy_prompt)
    if mode not in ("sweep_20", "sweep_winners"):
        return _img2img_comfy_once(
            prompt,
            init_image_b64,
            negative_prompt,
            workflow_name,
            upload_filename,
            easy_prompt,
        )

    try:
        base_seed = int(easy_prompt.get("sweep_seed") or 0)
    except (TypeError, ValueError):
        base_seed = 0
    if base_seed <= 0:
        base_seed = random.randint(1, 2_147_483_646)

    count = 20 if mode == "sweep_20" else len(_winner_presets())
    if mode == "sweep_winners" and count == 0:
        return {
            "ok": False,
            "message": "No saved sweep winners. Pick winning images from the latest sweep before using sweep_winners.",
            "images": [],
            "variant_labels": [],
        }

    sweep_run = f"{base_seed}_{int(time.time() * 1000)}"
    images: list[str] = []
    labels: list[str] = []
    errors: list[str] = []

    for idx in range(count):
        current_seed = base_seed + idx
        easy_run = {
            **easy_prompt,
            "sweep_seed": current_seed,
            "sweep_run": sweep_run,
        }
        result = _img2img_comfy_once(
            prompt,
            init_image_b64,
            negative_prompt,
            workflow_name,
            upload_filename,
            easy_run,
        )
        if result.get("ok") and isinstance(result.get("images"), list):
            batch_images = [str(img) for img in result.get("images", [])]
            if isinstance(result.get("variant_labels"), list) and len(result["variant_labels"]) == len(batch_images):
                labels.extend([str(v) for v in result["variant_labels"]])
            else:
                labels.extend([f"{mode} run {idx + 1}/{count}"] * len(batch_images))
            images.extend(batch_images)
        else:
            errors.append(f"{mode} run {idx + 1}: {result.get('message', 'failed')}")

    if not images:
        return {
            "ok": False,
            "message": "; ".join(errors) if errors else "All sweep runs failed.",
            "images": [],
            "variant_labels": [],
        }

    message = f"Generated {len(images)} of {count} sequential {mode.replace('_', ' ')} results."
    if errors:
        message += " Partial failures: " + " | ".join(errors)
    return {"ok": True, "message": message, "images": images, "variant_labels": labels}


def img2img_comfy(
    prompt: str,
    init_image_b64: str,
    negative_prompt: str = "",
    workflow_name: str | None = None,
    upload_filename: str | None = None,
    easy_prompt: dict | None = None,
    pose_image_b64: str | None = None,
    pose_upload_filename: str | None = None,
    pose_strength: float | None = None,
    pose_end_percent: float | None = None,
) -> dict:
    """
    Run ComfyUI img2img using a workflow from the project folder.
    Supports both API format and UI format (converted automatically).
    We find LoadImage node (set image filename), CLIPTextEncode nodes (positive/negative prompts).
    Optional easy_prompt: fields for ButlerEasyPrompt (utility panel / easy NSFW workflow).
    Optional pose_image_b64: second reference for OpenPose/DWPose dual-LoadImage graphs.
    """
    if easy_prompt and _easy_prompt_mode(easy_prompt) in ("sweep_20", "sweep_winners"):
        return _img2img_comfy_easy_prompt_sweep(
            prompt,
            init_image_b64,
            negative_prompt,
            workflow_name,
            upload_filename,
            easy_prompt,
        )
    return _img2img_comfy_once(
        prompt,
        init_image_b64,
        negative_prompt,
        workflow_name,
        upload_filename,
        easy_prompt,
        pose_image_b64=pose_image_b64,
        pose_upload_filename=pose_upload_filename,
        pose_strength=pose_strength,
        pose_end_percent=pose_end_percent,
    )


def merge_nsfw_triple_compare_images(b64_list: list[str]) -> str | None:
    """
    Blend lock + balanced + bold: center of frame favors image 0 (face / identity),
    edges blend toward the average of images 1–2 (context / scene from stronger redraws).
    Set BUTLER_COMPARE_TRIPLE_MERGE=0 to skip. Tune BUTLER_COMPARE_MERGE_FACE_WEIGHT (default 0.88).
    """
    if os.environ.get("BUTLER_COMPARE_TRIPLE_MERGE", "1").strip().lower() in ("0", "false", "no", "off"):
        return None
    if len(b64_list) < 3:
        return None
    try:
        from io import BytesIO

        import numpy as np
        from PIL import Image
    except ImportError:
        return None
    try:
        imgs: list[Image.Image] = []
        for b in b64_list[:3]:
            raw = base64.b64decode(b)
            im = Image.open(BytesIO(raw)).convert("RGB")
            imgs.append(im)
        w0, h0 = imgs[0].size
        if w0 < 8 or h0 < 8:
            return None
        a = np.asarray(imgs[0], dtype=np.float32)
        b = np.asarray(imgs[1].resize((w0, h0), Image.Resampling.LANCZOS), dtype=np.float32)
        c = np.asarray(imgs[2].resize((w0, h0), Image.Resampling.LANCZOS), dtype=np.float32)
        h, w = h0, w0
        yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
        cy = (h - 1) / 2.0
        cx = (w - 1) / 2.0
        dx = (xx - cx) / max(w / 2.0, 1.0)
        dy = (yy - cy) / max(h / 2.0, 1.0)
        dist = np.sqrt(dx * dx + dy * dy)
        dist = np.clip(dist, 0.0, 1.0)
        t = np.clip(1.0 - dist, 0.0, 1.0)
        center_strength = float(os.environ.get("BUTLER_COMPARE_MERGE_FACE_WEIGHT", "0.88").strip() or "0.88")
        center_strength = max(0.25, min(center_strength, 0.98))
        exp = float(os.environ.get("BUTLER_COMPARE_MERGE_EDGE_FALLOFF", "1.75").strip() or "1.75")
        exp = max(0.5, min(exp, 4.0))
        w_face = (t**exp) * center_strength
        w_face = w_face[..., np.newaxis]
        context = (b + c) * 0.5
        merged = a * w_face + context * (1.0 - w_face)
        merged_u8 = np.clip(merged, 0, 255).astype(np.uint8)
        out = Image.fromarray(merged_u8)
        buf = BytesIO()
        out.save(buf, format="PNG", compress_level=6)
        return base64.b64encode(buf.getvalue()).decode("ascii")
    except Exception:
        return None


def img2img_comfy_workflow_sweep(
    prompt: str,
    init_image_b64: str,
    negative_prompt: str = "",
    upload_filename: str | None = None,
) -> dict:
    """
    Run every eligible workflow JSON for a /test sweep (see _img2img_sweep_workflows_root).
    Order: img2img_workflow_order hits first, then remaining files alphabetically.
    variant_labels are filenames (e.g. img2img_juggernaut_faceid_supreme_nsfw.json).
    """
    sweep_dir, allow_txt2img = _img2img_sweep_workflows_root()
    names = _img2img_sweep_ordered_basenames(sweep_dir, allow_txt2img)
    if not names:
        scope = (
            f"{sweep_dir} (includes txt2img_*; still excludes bundled video JSON names)"
            if allow_txt2img
            else f"{sweep_dir} (excludes txt2img_* and bundled video graphs)"
        )
        return {
            "ok": False,
            "message": f"No sweep-eligible workflow .json files under {scope}.",
            "images": [],
            "variant_labels": [],
        }
    images: list[str] = []
    labels: list[str] = []
    errors: list[str] = []
    for wf_name in names:
        r = img2img_comfy(
            prompt,
            init_image_b64,
            negative_prompt,
            workflow_name=wf_name,
            upload_filename=upload_filename,
        )
        fn = f"{wf_name}.json"
        if r.get("ok") and r.get("images"):
            images.append(r["images"][0])
            labels.append(fn)
        else:
            errors.append(f"{fn}: {r.get('message', 'failed')}")
    if not images:
        return {
            "ok": False,
            "message": "; ".join(errors) if errors else "All workflow runs failed.",
            "images": [],
            "variant_labels": [],
            "compare_workflow_sweep": True,
        }
    if allow_txt2img:
        folder_note = (
            f"Sweep used ComfyUI/workflows/test/ only ({len(names)} file(s), including txt2img_* when present). "
        )
    else:
        folder_note = (
            f"Sweep used the main workflows folder ({len(names)} file(s); txt2img_* excluded — add JSON under workflows/test/ to compare those). "
        )
    msg = (
        f"Ran {len(images)} of {len(names)} workflow JSON(s); each image is labeled with its filename. "
        f"{folder_note}"
        f"Order: comfy_config img2img_workflow_order first, then other *.json in that folder. "
        f"Preferred default for single runs remains {_PREFERRED_DEFAULT_IMG2IMG}.json when present."
    )
    if errors:
        msg += " Partial failures: " + " | ".join(errors)
    return {
        "ok": True,
        "message": msg,
        "images": images,
        "variant_labels": labels,
        "variant_errors": errors,
        "compare_workflow_sweep": True,
    }


def img2img_comfy_nsfw_compare_triple(
    prompt: str,
    init_image_b64: str,
    negative_prompt: str = "",
    upload_filename: str | None = None,
) -> dict:
    """
    Run three NSFW-tuned VAE img2img workflows (same prompt/upload) so the user can pick the best look.
    """
    if not nsfw_compare_workflows_ready():
        return {
            "ok": False,
            "message": (
                "NSFW compare workflows missing. Add img2img_nsfw_compare_lock.json, "
                "img2img_nsfw_compare_balanced.json, img2img_nsfw_compare_bold.json under ComfyUI/workflows."
            ),
            "images": [],
            "variant_labels": [],
        }
    images: list[str] = []
    labels: list[str] = []
    errors: list[str] = []
    for wf_name, label in _IMG2IMG_NSFW_COMPARE_TRIO:
        r = img2img_comfy(
            prompt,
            init_image_b64,
            negative_prompt,
            workflow_name=wf_name,
            upload_filename=upload_filename,
        )
        if r.get("ok") and r.get("images"):
            images.append(r["images"][0])
            labels.append(label)
        else:
            errors.append(f"{wf_name}: {r.get('message', 'failed')}")
    if not images:
        return {
            "ok": False,
            "message": "; ".join(errors) if errors else "All compare runs failed.",
            "images": [],
            "variant_labels": [],
        }
    merged_b64 = merge_nsfw_triple_compare_images(images)
    if merged_b64:
        images = [merged_b64] + images
        labels = ["Merged — face from lock (center) + context from balanced & bold (edges)"] + labels
    if merged_b64:
        msg = (
            "Four images: (1) merged blend — center favors lock (face), edges blend balanced+bold (context). "
            "(2–4) lock, balanced, bold. Set BUTLER_COMPARE_TRIPLE_MERGE=0 to get only the three originals."
        )
    else:
        msg = (
            f"Three NSFW img2img variants ({len(images)}/3). Left to right: lock → balanced → bold. "
            "Lock stays closest to your upload; bold changes composition the most."
        )
    if errors:
        msg += " Partial: " + " | ".join(errors)
    return {
        "ok": True,
        "message": msg,
        "images": images,
        "variant_labels": labels,
        "variant_errors": errors,
        "compare_nsfw_triple": True,
        "compare_merged": bool(merged_b64),
    }


def txt2img_comfy(
    prompt: str,
    negative_prompt: str = "",
    workflow_name: str | None = None,
    width: int = 1024,
    height: int = 768,
    steps: int | None = None,
    cfg: float | None = None,
) -> dict:
    """
    Run ComfyUI txt2img (no user upload). Prefers OpenPose ControlNet pose-ref, then Juggernaut.
    Pose ControlNet workflows synthesize an OpenPose map, upload it, then lock generation to it.
    Face-ID workflows get placeholder LoadImage paths fixed to any file present in ComfyUI/input.
    """
    cfg_path = _comfy_config_path()
    order = list(_DEFAULT_TXT2IMG_ORDER)
    if cfg_path.exists():
        try:
            with open(cfg_path, encoding="utf-8") as f:
                data = json.load(f)
            raw = data.get("txt2img_workflow_order") or data.get("txt2img_order")
            if isinstance(raw, list):
                order = raw
            elif isinstance(raw, str):
                order = [raw]
        except Exception:
            pass
    dir_ = _workflows_dir()
    if not dir_.exists():
        return {"ok": False, "message": "No workflows folder", "images": []}
    wname = workflow_name
    if not wname:
        for n in order:
            if (dir_ / f"{n}.json").exists() or (_bundled_workflows_dir() / f"{n}.json").is_file():
                wname = n
                break
        wname = wname or "txt2img_Juggernaut"
    wp = _get_workflow_path(wname or "txt2img_Juggernaut")
    if not wp or not wp.exists():
        for fallback in (
            "txt2img_pose_reference_controlnet",
            "txt2img_pose_reference_simple",
            "txt2img_Juggernaut",
        ):
            if (wname or "") == fallback or not wname:
                bp = _bundled_workflows_dir() / f"{fallback}.json"
                if bp.is_file():
                    wp = bp
                    wname = fallback
                    break
        if not wp or not wp.exists():
            return {"ok": False, "message": f"txt2img workflow not found: {wname}", "images": []}
    try:
        with open(wp, encoding="utf-8") as f:
            raw_workflow = json.load(f)
    except Exception as e:
        return {"ok": False, "message": f"Invalid workflow: {e}", "images": []}

    if _is_api_format(raw_workflow):
        workflow = raw_workflow
    else:
        workflow = _try_comfy_convert_api(raw_workflow) or _ui_to_api_format(raw_workflow)
        if not workflow:
            return {"ok": False, "message": "Failed to convert workflow", "images": []}

    wfn = (wname or "").replace(".json", "").strip()
    pose_controlnet = wfn in _POSE_REFERENCE_CONTROLNET_WORKFLOWS
    pose_map_template = ""

    if pose_controlnet:
        try:
            from pose_openpose_map import (
                compose_pose_controlnet_prompts,
                merge_pose_negatives,
                reject_multi_person,
                render_openpose_map_b64,
            )
        except Exception as e:
            return {"ok": False, "message": f"Pose OpenPose map helper unavailable: {e}", "images": []}
        multi_err = reject_multi_person(prompt or "")
        if multi_err:
            return {"ok": False, "message": multi_err, "images": []}
        map_b64, pose_map_template = render_openpose_map_b64(prompt or "", width=width, height=height)
        up_map = _upload_image(map_b64, "butler_pose_openpose_map.png")
        if not up_map.get("ok"):
            return {"ok": False, "message": up_map.get("message", "Pose map upload failed"), "images": []}
        invalidate_object_info_cache()
        load_ids = [
            nid
            for nid, n in workflow.items()
            if isinstance(n, dict) and n.get("class_type") == "LoadImage"
        ]
        if not load_ids:
            return {"ok": False, "message": "Pose ControlNet workflow has no LoadImage node", "images": []}
        bind_err = _ensure_load_image_matches_comfy(
            workflow, load_ids[0], up_map["name"], up_map.get("subfolder", "") or ""
        )
        if bind_err:
            return {"ok": False, "message": bind_err, "images": []}
        _apply_pose_control_settings(workflow, strength=0.95, end_percent=0.92)
    else:
        li_fix = _ensure_txt2img_face_reference_images(workflow)
        if li_fix:
            return {"ok": False, "message": li_fix, "images": []}

    pos_node = None
    neg_node = None
    latent_node = None
    sampler_nodes: list[str] = []
    for nid, node in workflow.items():
        if not isinstance(node, dict):
            continue
        ct = node.get("class_type")
        if ct == "EmptyLatentImage":
            latent_node = nid
        elif ct == "KSampler":
            sampler_nodes.append(nid)

    if pose_controlnet:
        for nid, node in workflow.items():
            if not isinstance(node, dict) or node.get("class_type") != "ControlNetApplyAdvanced":
                continue
            inp = node.get("inputs", {})
            pref = inp.get("positive")
            nref = inp.get("negative")
            if isinstance(pref, list) and pref:
                pos_node = str(pref[0])
            if isinstance(nref, list) and nref:
                neg_node = str(nref[0])
    else:
        for sn in sampler_nodes:
            inp = workflow[sn].get("inputs", {})
            ref = inp.get("positive")
            if isinstance(ref, list) and ref:
                pos_node = str(ref[0])
            ref = inp.get("negative")
            if isinstance(ref, list) and ref:
                neg_node = str(ref[0])

    if latent_node and latent_node in workflow:
        workflow[latent_node]["inputs"]["width"] = width
        workflow[latent_node]["inputs"]["height"] = height
    if steps is not None or cfg is not None:
        for sn in sampler_nodes:
            inp = workflow[sn].setdefault("inputs", {})
            if not isinstance(inp, dict):
                continue
            if steps is not None:
                inp["steps"] = max(8, min(80, int(steps)))
            if cfg is not None:
                inp["cfg"] = max(1.0, min(20.0, float(cfg)))

    pose_verbatim = wfn in _VERBATIM_PROMPT_TXT2IMG_WORKFLOWS
    if pose_controlnet:
        pos_text, composed_neg = compose_pose_controlnet_prompts(prompt or "")
        # Always keep compose anti-anime / camera locks; UI Avoid box only adds extras
        neg_text = merge_pose_negatives(composed_neg, negative_prompt)
    elif prompt:
        pos_text = prompt
        neg_text = negative_prompt or ""
    elif pose_verbatim:
        pos_text = _POSE_REFERENCE_FALLBACK_POSITIVE
        neg_text = negative_prompt or ""
    else:
        pos_text = "high quality, detailed"
        neg_text = negative_prompt or ""
    try:
        if pose_verbatim:
            pass
        else:
            from sd_prompt_enhance import enhance_for_comfy

            pos_text, neg_text = enhance_for_comfy(pos_text, neg_text, mode="txt2img")
    except Exception:
        pass
    if pos_node and pos_node in workflow:
        workflow[pos_node]["inputs"]["text"] = pos_text
    if neg_node and neg_node in workflow:
        if not neg_text:
            neg_text = (
                _POSE_REFERENCE_FALLBACK_NEGATIVE
                if pose_verbatim
                else "ugly, blurry, low quality"
            )
        workflow[neg_node]["inputs"]["text"] = neg_text

    ck_err = _ensure_workflow_checkpoint_from_comfy(workflow, workflow_name=wname)
    if ck_err:
        return {"ok": False, "message": ck_err, "images": []}
    _ensure_workflow_ckpt_exists(workflow, workflow_name=wname)
    q = _queue_prompt(workflow)
    if not q.get("ok"):
        msg_low = (q.get("message") or "").lower()
        if pose_controlnet and (
            "validation" in msg_low
            or "value_not_in_list" in msg_low
            or "controlnet" in msg_low
            or "invalid image" in msg_low
        ):
            return txt2img_comfy(
                prompt=prompt,
                negative_prompt=negative_prompt,
                workflow_name="txt2img_pose_reference_simple",
                width=width,
                height=height,
                steps=steps,
                cfg=cfg,
            )
        if (wname or "") not in (
            "txt2img_Juggernaut",
            "txt2img_pose_reference_simple",
            "txt2img_pose_reference_controlnet",
        ) and (
            "invalid image file" in msg_low or "validation" in msg_low or "value_not_in_list" in msg_low
        ):
            return txt2img_comfy(
                prompt=prompt,
                negative_prompt=negative_prompt,
                workflow_name="txt2img_pose_reference_controlnet",
                width=width,
                height=height,
                steps=steps,
                cfg=cfg,
            )
        return {"ok": False, "message": q.get("message", "Queue failed"), "images": []}
    prompt_id = q["prompt_id"]
    result = _poll_comfy_images(prompt_id, label=(prompt or "txt2img"))
    if result.get("ok") and result.get("images"):
        if pose_controlnet and pose_map_template:
            result = {
                **result,
                "message": f"Pose ControlNet ({pose_map_template}): {(prompt or '')[:40]}...",
            }
        return result
    return {
        "ok": False,
        "message": result.get("message") or "ComfyUI timed out (6 min)",
        "images": [],
    }


def list_workflows() -> list[str]:
    """List available workflow names (without .json)."""
    dir_ = _workflows_dir()
    if not dir_.exists():
        return []
    return [f.stem for f in dir_.glob("*.json")]
