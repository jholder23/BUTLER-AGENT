"""
Butler Easy Prompt — plain English + Balance + MODE/PRESET sweeps + ButlerSweepSave.

Sweep modes generate sequential preset runs from SWEEP_SEED, with the helper incrementing the seed automatically.
Never raise EmptyLatentImage batch_size above 1 — FaceID + ReActor ONNX OOMs on
consumer GPUs (e.g. 12GB) with "bad allocation" when batch is 4–20.
"""
from __future__ import annotations

import base64
import csv
import io
import json
import os
import random
import uuid
from datetime import datetime, timezone

import folder_paths
import numpy as np
from aiohttp import web
from PIL import Image

# Simple XOR encoding for privacy (not cryptographic security, but prevents casual inspection)
_ENCRYPTION_KEY = 'butler-sweep-secure-key-2024'

def _encode_image_bytes(img_bytes: bytes) -> bytes:
    """Encode image bytes using XOR for privacy."""
    try:
        key = _ENCRYPTION_KEY
        encoded = bytearray()
        for i, byte in enumerate(img_bytes):
            encoded.append(byte ^ key[i % len(key)])
        return bytes(encoded)
    except Exception:
        return img_bytes

def _decode_image_bytes(encoded_bytes: bytes) -> bytes:
    """Decode image bytes using XOR."""
    try:
        key = _ENCRYPTION_KEY
        decoded = bytearray()
        for i, byte in enumerate(encoded_bytes):
            decoded.append(byte ^ key[i % len(key)])
        return bytes(decoded)
    except Exception:
        return encoded_bytes
from server import PromptServer


WEB_DIRECTORY = "./web"

_EASY_PRESET_WIDGET_NAMES = (
    "DETAILS - looks (blue eyes...)",
    "AVOID - dont want",
    "ACTION - what they are doing",
    "POSE - body position",
    "OUTFIT - clothes",
    "SCENE - place / lighting",
    "MODE",
    "SWEEP_SEED",
    "SWEEP_RUN",
    "BALANCE - LEFT=face  RIGHT=prompt",
    "framing",
    "emphasize_action",
    "hands_in_frame",
    "frontal_face",
    "photoreal",
    "PRESET",
)


def _easy_prompt_presets_path() -> str:
    root = os.path.join(folder_paths.get_user_directory(), "default")
    os.makedirs(root, exist_ok=True)
    return os.path.join(root, "butler_easy_prompt_presets.json")


def _read_easy_prompt_presets() -> dict:
    try:
        with open(_easy_prompt_presets_path(), encoding="utf-8") as f:
            data = json.load(f)
        presets = data.get("presets", []) if isinstance(data, dict) else []
        return {"version": 1, "presets": presets if isinstance(presets, list) else []}
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return {"version": 1, "presets": []}


def _write_easy_prompt_presets(data: dict) -> None:
    target = _easy_prompt_presets_path()
    temp = target + ".tmp"
    with open(temp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.replace(temp, target)


@PromptServer.instance.routes.get("/butler/easy-presets")
async def butler_easy_presets_list(_request):
    return web.json_response({"ok": True, **_read_easy_prompt_presets()})


@PromptServer.instance.routes.post("/butler/easy-presets")
async def butler_easy_presets_save(request):
    try:
        body = await request.json()
        name = str(body.get("name") or "").strip()[:80]
        fields = body.get("fields")
        if not name:
            return web.json_response(
                {"ok": False, "message": "Preset name is required."}, status=400
            )
        if not isinstance(fields, dict) or any(
            key not in fields for key in _EASY_PRESET_WIDGET_NAMES
        ):
            return web.json_response(
                {
                    "ok": False,
                    "message": "Preset must contain every Butler Easy Prompt input.",
                },
                status=400,
            )
        clean_fields = {key: fields[key] for key in _EASY_PRESET_WIDGET_NAMES}
        payload_base64 = __import__("base64").b64encode(
            json.dumps(clean_fields, ensure_ascii=False).encode("utf-8")
        ).decode("ascii")
        store = _read_easy_prompt_presets()
        requested_id = str(body.get("id") or "").strip()
        existing = next(
            (
                item
                for item in store["presets"]
                if isinstance(item, dict)
                and (
                    (requested_id and str(item.get("id") or "") == requested_id)
                    or str(item.get("name") or "").casefold() == name.casefold()
                )
            ),
            None,
        )
        now = datetime.now(timezone.utc).isoformat()
        if existing is None:
            existing = {"id": str(uuid.uuid4())}
            store["presets"].append(existing)
        existing.update(
            {
                "name": name,
                "updated_at": now,
                "payload_base64": payload_base64,
            }
        )
        store["presets"].sort(
            key=lambda item: str(item.get("name") or "").casefold()
            if isinstance(item, dict)
            else ""
        )
        _write_easy_prompt_presets(store)
        return web.json_response(
            {
                "ok": True,
                "preset": existing,
                "message": f'Saved Base64 prompt preset "{name}".',
            }
        )
    except Exception as exc:
        return web.json_response(
            {"ok": False, "message": str(exc)}, status=500
        )


@PromptServer.instance.routes.delete("/butler/easy-presets/{preset_id}")
async def butler_easy_presets_delete(request):
    preset_id = str(request.match_info.get("preset_id") or "").strip()
    store = _read_easy_prompt_presets()
    before = len(store["presets"])
    store["presets"] = [
        item
        for item in store["presets"]
        if not isinstance(item, dict) or str(item.get("id") or "") != preset_id
    ]
    if len(store["presets"]) == before:
        return web.json_response(
            {"ok": False, "message": "Preset not found."}, status=404
        )
    _write_easy_prompt_presets(store)
    return web.json_response({"ok": True, "message": "Prompt preset deleted."})


def _clean(s: str) -> str:
    return " ".join((s or "").replace("\n", " ").split()).strip()


def _weighted(text: str, weight: float) -> str:
    t = _clean(text)
    if not t:
        return ""
    if t.startswith("(") and t.endswith(")") and ":" in t[1:-1]:
        return t
    return f"({t}:{weight:.2f})"


def _lerp(a: float, b: float, t: float) -> float:
    t = max(0.0, min(1.0, float(t)))
    return a + (b - a) * t


def _clamp(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, float(x)))


_BASE_NEGATIVE = [
    "different face",
    "wrong face",
    "another person",
    "mismatched identity",
    "cloned face",
    "generic face",
    "wrong pose",
    "wrong action",
    "ignored action",
    "ignored pose",
    "ignored prompt",
    "wrong outfit",
    "bad hands",
    "extra fingers",
    "missing fingers",
    "fused fingers",
    "extra limbs",
    "bad anatomy",
    "distorted body",
    "blurry",
    "low quality",
    "cartoon",
    "anime",
    "3d render",
    "cgi",
    "plastic skin",
    "oversaturated",
    "waxy skin",
    "uncanny valley",
]

_DEFAULT_ACTION = "standing casually looking at the camera with a natural expression"
_DEFAULT_POSE = "relaxed standing pose, weight on one hip, arms at a comfortable natural rest"
_DEFAULT_OUTFIT = "stylish fitted casual clothes, tasteful everyday outfit"
_DEFAULT_SCENE = "soft natural indoor light, clean simple background, shallow depth of field"

_FRAMING = {
    "full_body": {
        "pos": "(full body shot:1.5), head to toe, entire body visible, feet visible, legs visible, wide shot, camera pulled back",
        "neg": [
            "close-up",
            "extreme close-up",
            "headshot",
            "portrait crop",
            "bust shot",
            "upper body only",
            "cropped",
            "cut off at waist",
            "cut off legs",
            "missing feet",
        ],
        "size": (832, 1216),
    },
    "waist_up": {
        "pos": "(medium shot waist up:1.45), upper body visible, hands in frame, head to hips",
        "neg": ["extreme close-up", "headshot only", "full body", "missing hands"],
        "size": (896, 1152),
    },
    "medium": {
        "pos": "(medium shot:1.4), torso and head visible, natural framing",
        "neg": ["extreme close-up", "macro face"],
        "size": (896, 1152),
    },
    "portrait": {
        "pos": "(portrait shot:1.4), head and shoulders, face clearly visible",
        "neg": ["full body", "wide shot", "tiny face"],
        "size": (896, 1152),
    },
}

# Named FaceID / CFG combos. balance drives prompt weights; knobs override sampler/FaceID.
# "custom" uses the Balance slider only (knobs derived from balance).
_PRESETS: dict[str, dict | None] = {
    "custom": None,
    "01_face_lock": {
        "balance": -0.75,
        "cfg": 5.2,
        "steps": 42,
        "faceid_weight": 0.9,
        "faceid_v2": 1.55,
        "faceid_end": 0.9,
        "faceid_lora": 0.72,
    },
    "02_soft_face": {
        "balance": -0.45,
        "cfg": 5.4,
        "steps": 40,
        "faceid_weight": 0.78,
        "faceid_v2": 1.35,
        "faceid_end": 0.78,
        "faceid_lora": 0.62,
    },
    "03_balanced": {
        "balance": 0.0,
        "cfg": 5.8,
        "steps": 44,
        "faceid_weight": 0.7,
        "faceid_v2": 1.25,
        "faceid_end": 0.66,
        "faceid_lora": 0.55,
    },
    "04_prompt_lean": {
        "balance": 0.35,
        "cfg": 6.0,
        "steps": 46,
        "faceid_weight": 0.58,
        "faceid_v2": 1.1,
        "faceid_end": 0.52,
        "faceid_lora": 0.48,
    },
    "05_action_first": {
        "balance": 0.55,
        "cfg": 6.2,
        "steps": 48,
        "faceid_weight": 0.52,
        "faceid_v2": 1.0,
        "faceid_end": 0.48,
        "faceid_lora": 0.45,
    },
    "06_strong_prompt": {
        "balance": 0.75,
        "cfg": 6.5,
        "steps": 50,
        "faceid_weight": 0.48,
        "faceid_v2": 0.95,
        "faceid_end": 0.42,
        "faceid_lora": 0.42,
    },
    "07_low_cfg_face": {
        "balance": -0.5,
        "cfg": 4.8,
        "steps": 40,
        "faceid_weight": 0.85,
        "faceid_v2": 1.45,
        "faceid_end": 0.85,
        "faceid_lora": 0.68,
    },
    "08_mid_cfg": {
        "balance": 0.1,
        "cfg": 5.5,
        "steps": 44,
        "faceid_weight": 0.68,
        "faceid_v2": 1.2,
        "faceid_end": 0.62,
        "faceid_lora": 0.55,
    },
    "09_high_cfg": {
        "balance": 0.25,
        "cfg": 7.0,
        "steps": 48,
        "faceid_weight": 0.6,
        "faceid_v2": 1.15,
        "faceid_end": 0.55,
        "faceid_lora": 0.5,
    },
    "10_short_end": {
        "balance": 0.4,
        "cfg": 6.0,
        "steps": 45,
        "faceid_weight": 0.62,
        "faceid_v2": 1.2,
        "faceid_end": 0.38,
        "faceid_lora": 0.5,
    },
    "11_long_end": {
        "balance": -0.35,
        "cfg": 5.6,
        "steps": 44,
        "faceid_weight": 0.8,
        "faceid_v2": 1.4,
        "faceid_end": 0.92,
        "faceid_lora": 0.65,
    },
    "12_soft_lora": {
        "balance": 0.15,
        "cfg": 5.8,
        "steps": 44,
        "faceid_weight": 0.7,
        "faceid_v2": 1.25,
        "faceid_end": 0.6,
        "faceid_lora": 0.35,
    },
    "13_mid_lora": {
        "balance": 0.0,
        "cfg": 5.8,
        "steps": 44,
        "faceid_weight": 0.7,
        "faceid_v2": 1.25,
        "faceid_end": 0.65,
        "faceid_lora": 0.55,
    },
    "14_high_lora": {
        "balance": -0.2,
        "cfg": 5.6,
        "steps": 46,
        "faceid_weight": 0.75,
        "faceid_v2": 1.35,
        "faceid_end": 0.7,
        "faceid_lora": 0.78,
    },
    "15_v2_soft": {
        "balance": 0.2,
        "cfg": 5.9,
        "steps": 45,
        "faceid_weight": 0.65,
        "faceid_v2": 0.9,
        "faceid_end": 0.55,
        "faceid_lora": 0.5,
    },
    "16_v2_strong": {
        "balance": -0.4,
        "cfg": 5.5,
        "steps": 46,
        "faceid_weight": 0.82,
        "faceid_v2": 1.65,
        "faceid_end": 0.82,
        "faceid_lora": 0.7,
    },
    "17_cfg60_mid": {
        "balance": 0.05,
        "cfg": 6.0,
        "steps": 45,
        "faceid_weight": 0.68,
        "faceid_v2": 1.22,
        "faceid_end": 0.6,
        "faceid_lora": 0.55,
    },
    "18_cfg65_mid": {
        "balance": 0.15,
        "cfg": 6.5,
        "steps": 48,
        "faceid_weight": 0.62,
        "faceid_v2": 1.18,
        "faceid_end": 0.55,
        "faceid_lora": 0.52,
    },
    "19_steps_high": {
        "balance": 0.1,
        "cfg": 6.0,
        "steps": 52,
        "faceid_weight": 0.66,
        "faceid_v2": 1.2,
        "faceid_end": 0.58,
        "faceid_lora": 0.55,
    },
    "20_high_lora_face": {
        "balance": -0.55,
        "cfg": 5.4,
        "steps": 46,
        "faceid_weight": 0.88,
        "faceid_v2": 1.5,
        "faceid_end": 0.86,
        "faceid_lora": 0.82,
    },
}

_PRESET_NAMES = list(_PRESETS.keys())
_WINNERS = ["01_face_lock", "09_high_cfg", "18_cfg65_mid", "20_high_lora_face"]
_SWEEP_20 = [n for n in _PRESET_NAMES if n != "custom"]

_L_DETAILS = "DETAILS - looks (blue eyes...)"
_L_AVOID = "AVOID - dont want"
_L_ACTION = "ACTION - what they are doing"
_L_POSE = "POSE - body position"
_L_OUTFIT = "OUTFIT - clothes"
_L_SCENE = "SCENE - place / lighting"
_L_MODE = "MODE"
_L_SEED = "SWEEP_SEED"
_L_SWEEP_RUN = "SWEEP_RUN"
_L_BALANCE = "BALANCE - LEFT=face  RIGHT=prompt"
_L_FRAMING = "framing"
_L_EMPH = "emphasize_action"
_L_HANDS = "hands_in_frame"
_L_FRONT = "frontal_face"
_L_PHOTO = "photoreal"
_L_PRESET = "PRESET"


def _or_default(value: str, fallback: str) -> str:
    return _clean(value) or fallback


def _split_phrases(raw: str) -> list[str]:
    parts: list[str] = []
    buf = (raw or "").replace("\n", ",").replace(";", ",")
    for part in buf.split(","):
        t = _clean(part)
        if t:
            parts.append(t)
    return parts


def _avoid_phrases(raw: str) -> list[str]:
    out: list[str] = []
    prefixes = ("no ", "not ", "without ", "don't ", "dont ", "avoid ", "never ")
    for t in _split_phrases(raw):
        low = t.lower()
        for p in prefixes:
            if low.startswith(p):
                t = t[len(p) :].strip()
                break
        if t:
            out.append(t)
    return out


def _pick(kwargs: dict, *names, default=""):
    for n in names:
        if n in kwargs and kwargs[n] is not None:
            return kwargs[n]
    return default


def _winner_presets() -> list[str]:
    """Read utility-panel selections only. Do not fallback to bundled winners."""
    try:
        manifest = os.path.join(
            folder_paths.get_output_directory(), "butler_easy_sweep_winners.json"
        )
        with open(manifest, encoding="utf-8") as f:
            data = json.load(f)
        selected = []
        for raw in data.get("presets", []):
            name = str(raw)
            if name in _PRESETS and name != "custom" and name not in selected:
                selected.append(name)
        return selected
    except (OSError, TypeError, ValueError, json.JSONDecodeError):
        pass
    return []


def _resolve_preset(mode: str, preset_name: str, sweep_seed: int) -> tuple[str, dict | None]:
    mode = (mode or "single").strip().lower()
    seed = int(sweep_seed) if sweep_seed is not None else 0
    if mode == "sweep_winners":
        winners = _winner_presets()
        if not winners:
            return "custom", None
        name = winners[seed % len(winners)]
        return name, _PRESETS[name]
    if mode == "sweep_20":
        rng = random.Random(seed)
        name = rng.choice(_SWEEP_20)
        return name, _PRESETS[name]
    name = (preset_name or "custom").strip()
    if name not in _PRESETS:
        name = "custom"
    return name, _PRESETS[name]


def _knobs_from_balance(prompt_t: float) -> dict:
    return {
        "cfg": round(_lerp(5.0, 6.8, prompt_t), 2),
        "steps": int(round(_lerp(38, 52, prompt_t))),
        "faceid_weight": round(_lerp(0.9, 0.48, prompt_t), 3),
        "faceid_v2": round(_lerp(1.55, 0.95, prompt_t), 3),
        "faceid_end": round(_lerp(0.9, 0.42, prompt_t), 3),
        "faceid_lora": round(_lerp(0.72, 0.42, prompt_t), 3),
    }


class ButlerEasyPrompt:
    """One Balance slider + MODE/PRESET. Sweeps are sequential (seed), never latent batch."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                _L_DETAILS: (
                    "STRING",
                    {
                        "multiline": True,
                        "default": "",
                        "placeholder": "blue eyes, freckles, long hair…",
                    },
                ),
                _L_AVOID: (
                    "STRING",
                    {
                        "multiline": True,
                        "default": "",
                        "placeholder": "holes in shirt, blurry face…",
                    },
                ),
                _L_ACTION: (
                    "STRING",
                    {
                        "multiline": True,
                        "default": "",
                        "placeholder": "empty = standing looking at camera",
                    },
                ),
                _L_POSE: (
                    "STRING",
                    {
                        "multiline": True,
                        "default": "",
                        "placeholder": "empty = relaxed standing pose",
                    },
                ),
                _L_OUTFIT: (
                    "STRING",
                    {
                        "multiline": True,
                        "default": "",
                        "placeholder": "empty = stylish casual clothes",
                    },
                ),
                _L_SCENE: (
                    "STRING",
                    {
                        "multiline": True,
                        "default": "",
                        "placeholder": "empty = soft indoor light",
                    },
                ),
                _L_MODE: (
                    ["single", "sweep_winners", "sweep_20"],
                    {
                        "default": "single",
                        "tooltip": "sweep_* = generate sequential preset runs automatically; no manual batch count needed.",
                    },
                ),
                _L_SEED: (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 0xFFFFFFFFFFFFFFFF,
                        "control_after_generate": True,
                        "tooltip": "For sweeps: the helper increments SWEEP_SEED automatically, so this is optional.",
                    },
                ),
                _L_SWEEP_RUN: (
                    "STRING",
                    {
                        "default": "",
                        "tooltip": "Internal run ID for grouping sweep results together.",
                    },
                ),
                _L_BALANCE: (
                    "FLOAT",
                    {
                        "default": 0.35,
                        "min": -1.0,
                        "max": 1.0,
                        "step": 0.05,
                        "display": "slider",
                        "tooltip": "Used when PRESET=custom (or as prompt bias). LEFT=face, RIGHT=prompt.",
                    },
                ),
                _L_FRAMING: (
                    ["full_body", "waist_up", "medium", "portrait"],
                    {"default": "full_body"},
                ),
                _L_EMPH: (
                    "BOOLEAN",
                    {"default": True, "label_on": "yes", "label_off": "no"},
                ),
                _L_HANDS: (
                    "BOOLEAN",
                    {"default": True, "label_on": "yes", "label_off": "no"},
                ),
                _L_FRONT: (
                    "BOOLEAN",
                    {"default": True, "label_on": "yes", "label_off": "no"},
                ),
                _L_PHOTO: (
                    "BOOLEAN",
                    {"default": True, "label_on": "yes", "label_off": "no"},
                ),
                _L_PRESET: (
                    _PRESET_NAMES,
                    {
                        "default": "20_high_lora_face",
                        "tooltip": "Used in MODE=single. sweep modes ignore this and cycle winners/20.",
                    },
                ),
            }
        }

    RETURN_TYPES = (
        "STRING",
        "STRING",
        "FLOAT",
        "INT",
        "FLOAT",
        "FLOAT",
        "FLOAT",
        "FLOAT",
        "INT",
        "INT",
        "STRING",
        "STRING",
    )
    RETURN_NAMES = (
        "positive",
        "negative",
        "cfg",
        "steps",
        "faceid_weight",
        "faceid_weight_v2",
        "faceid_end_at",
        "faceid_lora",
        "width",
        "height",
        "settings_note",
        "filename_prefix",
    )
    FUNCTION = "build"
    CATEGORY = "Butler/Easy"
    DESCRIPTION = (
        "MODE=single uses PRESET. MODE=sweep_winners/sweep_20 generates sequential preset runs automatically. "
        "Keep EmptyLatent batch_size=1 — this avoids ONNX batch OOMs on consumer GPUs."
    )

    def build(self, **kwargs):
        details = _pick(kwargs, _L_DETAILS, "details", default="")
        avoid = _pick(kwargs, _L_AVOID, "avoid", default="")
        action = _pick(kwargs, _L_ACTION, "action", default="")
        pose = _pick(kwargs, _L_POSE, "pose", default="")
        outfit = _pick(kwargs, _L_OUTFIT, "outfit", default="")
        scene = _pick(kwargs, _L_SCENE, "scene", default="")
        mode = str(_pick(kwargs, _L_MODE, "MODE", "mode", default="single"))
        sweep_seed = int(_pick(kwargs, _L_SEED, "SWEEP_SEED", "sweep_seed", default=0) or 0)
        sweep_run = str(_pick(kwargs, _L_SWEEP_RUN, "SWEEP_RUN", "sweep_run", default="")).strip()
        balance_face_to_prompt = float(
            _pick(
                kwargs,
                _L_BALANCE,
                "balance_face_to_prompt",
                "balance",
                default=0.35,
            )
        )
        framing = str(_pick(kwargs, _L_FRAMING, "framing", default="full_body"))
        emphasize_action = bool(_pick(kwargs, _L_EMPH, "emphasize_action", default=True))
        hands_in_frame = bool(_pick(kwargs, _L_HANDS, "hands_in_frame", default=True))
        frontal_face = bool(_pick(kwargs, _L_FRONT, "frontal_face", default=True))
        photoreal = bool(_pick(kwargs, _L_PHOTO, "photoreal", default=True))
        preset_in = str(_pick(kwargs, _L_PRESET, "PRESET", "preset", default="custom"))

        mode_l = mode.strip().lower()
        preset_name, preset = _resolve_preset(mode_l, preset_in, sweep_seed)
        if preset and "balance" in preset:
            balance_face_to_prompt = float(preset["balance"])

        if mode_l == "sweep_20":
            rng = random.Random(sweep_seed)
            framing = rng.choice(list(_FRAMING.keys()))
            emphasize_action = rng.random() < 0.75
            hands_in_frame = rng.random() < 0.75
            frontal_face = rng.random() < 0.9
            photoreal = rng.random() < 0.9
            balance_face_to_prompt = float(rng.uniform(-0.8, 0.8))

        action = _or_default(action, _DEFAULT_ACTION)
        pose = _or_default(pose, _DEFAULT_POSE)
        outfit = _or_default(outfit, _DEFAULT_OUTFIT)
        scene = _or_default(scene, _DEFAULT_SCENE)
        details_raw = _clean(details)
        avoid_items = _avoid_phrases(avoid)

        b = _clamp(balance_face_to_prompt, -1.0, 1.0)
        prompt_t = _clamp((b + 1.0) / 2.0, 0.08, 0.92)
        likeness_t = 1.0 - prompt_t

        if b < -0.33:
            bal_hint = "FACE (likeness)"
        elif b > 0.33:
            bal_hint = "PROMPT (action/pose)"
        else:
            bal_hint = "CENTER"

        w_action = _lerp(1.25, 1.95, prompt_t)
        w_pose = _lerp(1.2, 1.75, prompt_t)
        w_outfit = _lerp(1.15, 1.55, prompt_t)
        w_scene = _lerp(1.1, 1.35, prompt_t)
        w_details = _lerp(1.2, 1.45, prompt_t)
        w_like = _lerp(1.55, 1.2, prompt_t)
        if emphasize_action:
            w_action = min(2.0, w_action + 0.1)

        frame = _FRAMING.get(framing) or _FRAMING["full_body"]
        width, height = frame["size"]

        parts: list[str] = []
        favor_prompt = prompt_t >= 0.45

        def add_framing():
            parts.append(frame["pos"])
            if hands_in_frame and framing in ("full_body", "waist_up", "medium"):
                parts.append("(hands visible in frame:1.3)")
            if frontal_face:
                parts.append("(facing camera:1.25), face visible to camera")

        def add_action_pose():
            a = _weighted(action, w_action)
            if a:
                parts.append(a)
                if emphasize_action or prompt_t >= 0.5:
                    echo = _clean(action)
                    if echo:
                        parts.append(_weighted(f"the subject is {echo}", min(1.85, w_action)))
                        if prompt_t >= 0.65:
                            parts.append(f"must show: {echo}")
            p = _weighted(pose, w_pose)
            if p:
                parts.append(p)
                if prompt_t >= 0.55:
                    pe = _clean(pose)
                    if pe:
                        parts.append(_weighted(f"body pose: {pe}", min(1.7, w_pose)))

        def add_outfit_scene():
            raw_outfit = _clean(outfit)
            if raw_outfit:
                if not raw_outfit.lower().startswith("wearing"):
                    raw_outfit = f"wearing {raw_outfit}"
                o = _weighted(raw_outfit, w_outfit)
                if o:
                    parts.append(o)
            s = _weighted(scene, w_scene)
            if s:
                parts.append(s)

        def add_details():
            if not details_raw:
                return
            for phrase in _split_phrases(details_raw):
                d = _weighted(phrase, w_details)
                if d:
                    parts.append(d)

        def add_likeness_text():
            if likeness_t < 0.12:
                return
            parts.append(
                f"(same person as face reference photo:{w_like:.2f}), "
                f"(identical face to reference:{w_like:.2f})"
            )
            if likeness_t >= 0.45:
                parts.append("matching facial features, same eyes nose mouth jawline")

        if favor_prompt:
            add_action_pose()
            add_framing()
            add_outfit_scene()
            add_details()
            add_likeness_text()
        else:
            add_framing()
            add_likeness_text()
            add_details()
            add_action_pose()
            add_outfit_scene()

        if photoreal:
            parts.append(
                "photorealistic, RAW photo, natural skin texture, sharp focus, true-to-life colors"
            )
            if prompt_t >= 0.7:
                parts.append(
                    "physically plausible pose, believable action, natural body language, "
                    "not plastic, not CGI"
                )

        positive = ", ".join(parts)

        neg = list(_BASE_NEGATIVE)
        neg.extend(frame["neg"])
        neg.extend(avoid_items)
        if _clean(action):
            neg.extend(
                [
                    "hands at sides",
                    "arms down",
                    "idle standing",
                    "not performing the action",
                    "different action",
                    "static pose ignoring action",
                ]
            )
        if _clean(pose):
            neg.extend(["wrong stance", "incorrect body pose", "different pose"])
        if prompt_t >= 0.55:
            neg.extend(
                [
                    "prompt ignored",
                    "generic pose",
                    "default standing",
                    "unrelated gesture",
                ]
            )
        if likeness_t >= 0.55:
            neg.extend(["unrelated face", "identity drift", "another person"])
        if frontal_face:
            neg.extend(["looking away", "back to camera", "face obscured"])
        if hands_in_frame:
            neg.extend(["hands out of frame", "hidden hands"])

        seen: set[str] = set()
        neg_out: list[str] = []
        for t in neg:
            key = t.lower()
            if key not in seen:
                seen.add(key)
                neg_out.append(t)
        negative = ", ".join(neg_out)

        knobs = _knobs_from_balance(prompt_t)
        if preset:
            for k in (
                "cfg",
                "steps",
                "faceid_weight",
                "faceid_v2",
                "faceid_end",
                "faceid_lora",
            ):
                if k in preset:
                    knobs[k] = preset[k]

        cfg = float(knobs["cfg"])
        steps = int(knobs["steps"])
        faceid_weight = float(knobs["faceid_weight"])
        faceid_v2 = float(knobs["faceid_v2"])
        faceid_end = float(knobs["faceid_end"])
        faceid_lora = float(knobs["faceid_lora"])

        mode_l = mode.strip().lower()
        if mode_l == "sweep_20":
            how = (
                f"sweep_20 idx={sweep_seed % len(_SWEEP_20)}/{len(_SWEEP_20)} "
                f"→ {preset_name}. Generates 20 sequential preset results with an incrementing seed. "
                "Keep EmptyLatent batch_size=1 (avoids ONNX batch OOMs on 12GB)."
            )
        elif mode_l == "sweep_winners":
            winners = _winner_presets()
            how = (
                f"sweep_winners idx={sweep_seed % len(winners)}/{len(winners)} "
                f"→ {preset_name}. Uses saved winner presets only, with an incrementing seed. "
                "Keep EmptyLatent batch_size=1."
            )
        else:
            how = f"single preset={preset_name} balance={bal_hint}"

        settings_note = (
            f"{how} | cfg={cfg} steps={steps} "
            f"fid={faceid_weight}/{faceid_v2} end={faceid_end} lora={faceid_lora} "
            f"| {width}x{height} {framing}"
        )
        safe_preset = "".join(c if c.isalnum() or c in "-_" else "_" for c in preset_name)
        # Each sweep run gets its own subfolder so the UI can group all 20 results together.
        # Single-mode runs also get a per-invocation folder when sweep_run is provided.
        run_folder = sweep_run if sweep_run else f"single_{safe_preset}_s{sweep_seed}"
        filename_prefix = f"easy_sweep/{run_folder}/{safe_preset}_{mode_l}_s{sweep_seed}"

        return (
            positive,
            negative,
            cfg,
            steps,
            faceid_weight,
            faceid_v2,
            faceid_end,
            faceid_lora,
            int(width),
            int(height),
            settings_note,
            filename_prefix,
        )


class ButlerSweepSave:
    """Save sweep images under output/easy_sweep/ and append butler_easy_sweep_log.csv."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "settings_note": ("STRING", {"forceInput": True}),
                "filename_prefix": ("STRING", {"forceInput": True}),
            }
        }

    RETURN_TYPES = ()
    FUNCTION = "save"
    OUTPUT_NODE = True
    CATEGORY = "Butler/Easy"
    DESCRIPTION = "Writes PNGs + CSV log for easy FaceID sweeps."

    def save(self, images, settings_note, filename_prefix):
        out_root = folder_paths.get_output_directory()
        prefix = _clean(str(filename_prefix or "easy_sweep/run")) or "easy_sweep/run"
        # Allow subfolder in prefix
        full_prefix = os.path.join(out_root, prefix.replace("/", os.sep).replace("\\", os.sep))
        out_dir = os.path.dirname(full_prefix)
        os.makedirs(out_dir, exist_ok=True)
        base_name = os.path.basename(full_prefix) or "run"

        log_path = os.path.join(out_root, "butler_easy_sweep_log.csv")
        write_header = not os.path.isfile(log_path)
        ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        note = str(settings_note or "")

        results = []
        for i, tensor in enumerate(images):
            arr = 255.0 * tensor.cpu().numpy()
            img = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))
            
            # Encode image bytes before saving
            img_bytes = io.BytesIO()
            img.save(img_bytes, format='PNG', compress_level=4)
            encoded_bytes = _encode_image_bytes(img_bytes.getvalue())
            
            fname = f"{base_name}_{i:03d}.enc"
            path = os.path.join(out_dir, fname)
            # Avoid clobber if re-queued
            n = 0
            while os.path.exists(path):
                n += 1
                fname = f"{base_name}_{i:03d}_{n}.enc"
                path = os.path.join(out_dir, fname)
            
            # Save encoded bytes
            with open(path, 'wb') as f:
                f.write(encoded_bytes)
            
            rel = os.path.relpath(path, out_root).replace("\\", "/")
            if "/" in rel:
                subfolder, file_only = rel.rsplit("/", 1)
            else:
                subfolder, file_only = "", rel
            results.append({"filename": file_only, "subfolder": subfolder, "note": note})

        with open(log_path, "a", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            if write_header:
                w.writerow(["utc", "filename", "settings_note"])
            for row in results:
                rel_name = f"{row['subfolder']}/{row['filename']}" if row["subfolder"] else row["filename"]
                w.writerow([ts, rel_name, row["note"]])

        return {
            "ui": {
                "images": [
                    {
                        "filename": r["filename"],
                        "subfolder": r["subfolder"],
                        "type": "output",
                    }
                    for r in results
                ]
            }
        }


NODE_CLASS_MAPPINGS = {
    "ButlerEasyPrompt": ButlerEasyPrompt,
    "ButlerSweepSave": ButlerSweepSave,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ButlerEasyPrompt": "Butler Easy Prompt — details + avoid",
    "ButlerSweepSave": "Butler Sweep Save + CSV log",
}
