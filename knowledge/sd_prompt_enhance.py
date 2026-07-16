"""
Local Stable Diffusion / ComfyUI prompt tuning (no OpenAI).

Tuned for Butler's bundled workflows under sd/ComfyUI/workflows/, which default to
**juggernautXL_ragnarok.safetensors** (Juggernaut XL / SDXL-class photoreal, NSFW-capable).

Goals: photorealism, face/body consistency with reference (img2img / FaceID graphs), and strong anatomy
negatives. Skips the photoreal *positive* stack when the user clearly wants non-photoreal styles.
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Iterable

# Split on commas but keep (weighted:1.2) chunks intact
_TAG_SPLIT = re.compile(r",(?![^()]*\))")


def _skip_enhance() -> bool:
    v = os.environ.get("BUTLER_SKIP_SD_PROMPT_ENHANCE", "").strip().lower()
    return v in ("1", "true", "yes", "on")


def _comfy_config_json_path() -> Path:
    from butlor_paths import get_butlor_config_dir

    return get_butlor_config_dir() / "comfy_config.json"


def _load_sd_base_prompts_from_comfy_config() -> tuple[str, str]:
    path = _comfy_config_json_path()
    if not path.is_file():
        return "", ""
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return "", ""
    if not isinstance(data, dict):
        return "", ""
    p = (data.get("base_positive_prompt") or data.get("base_positive") or "").strip()
    n = (data.get("base_negative_prompt") or data.get("base_negative") or "").strip()
    if isinstance(p, list):
        p = ", ".join(str(x) for x in p if str(x).strip())
    if isinstance(n, list):
        n = ", ".join(str(x) for x in n if str(x).strip())
    return str(p).strip(), str(n).strip()


def _load_sd_base_prompts_from_json_file(path: Path) -> tuple[str, str]:
    if not path.is_file():
        return "", ""
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return "", ""
    if not isinstance(data, dict):
        return "", ""
    p = (data.get("positive") or data.get("base_positive_prompt") or data.get("base_positive") or "").strip()
    n = (data.get("negative") or data.get("base_negative_prompt") or data.get("base_negative") or "").strip()
    return str(p).strip(), str(n).strip()


def _sd_project_path_for_prompts() -> Path:
    try:
        from config import SD_PROJECT_PATH

        return Path(SD_PROJECT_PATH)
    except Exception:
        raw = (os.environ.get("SD_PROJECT_PATH") or "").strip()
        if raw:
            p = Path(raw)
            return p if p.is_absolute() else (Path(__file__).resolve().parent.parent / p).resolve()
        return Path(__file__).resolve().parent.parent / "sd"


def _load_sd_base_prompts() -> tuple[str, str]:
    """
    User-defined base positive/negative merged into every Comfy (and Forge) run.
    Priority per field: BUTLER_SD_BASE_POSITIVE / BUTLER_SD_BASE_NEGATIVE env,
    then BUTLER_SD_BASE_PROMPTS_JSON if set,
    then <SD_PROJECT_PATH>/butler_sd_base_prompts.json,
    then comfy_config.json keys base_positive_prompt / base_negative_prompt.
    """
    ep = (os.environ.get("BUTLER_SD_BASE_POSITIVE") or "").strip()
    en = (os.environ.get("BUTLER_SD_BASE_NEGATIVE") or "").strip()
    jp, jn = "", ""
    jpath_raw = (os.environ.get("BUTLER_SD_BASE_PROMPTS_JSON") or "").strip()
    if jpath_raw:
        jp, jn = _load_sd_base_prompts_from_json_file(Path(jpath_raw))
    if not jp and not jn:
        jp, jn = _load_sd_base_prompts_from_json_file(_sd_project_path_for_prompts() / "butler_sd_base_prompts.json")
    cp, cn = _load_sd_base_prompts_from_comfy_config()
    return ep or jp or cp, en or jn or cn


def merge_prompts_with_user_sd_base(prompt: str, negative_prompt: str = "") -> tuple[str, str]:
    """
    Butler chat text first on the positive, then configured base; base negative first, then user negative.
    Does not add Butler photoreal auto-tags (use enhance_for_comfy for that).
    """
    base_pos, base_neg = _load_sd_base_prompts()
    user_pos = _split_tags((prompt or "").strip())
    user_neg = _split_tags((negative_prompt or "").strip())
    return (
        _merge_unique(user_pos, _split_tags(base_pos)),
        _merge_unique(_split_tags(base_neg), user_neg),
    )


def _split_tags(s: str) -> list[str]:
    if not s or not str(s).strip():
        return []
    parts = _TAG_SPLIT.split(str(s).strip())
    return [p.strip() for p in parts if p.strip()]


def _norm_key(tag: str) -> str:
    """Lowercase for dedupe; strip outer parens weight for comparison."""
    t = tag.strip().lower()
    m = re.match(r"^\((.+):[\d.]+\)$", t)
    if m:
        t = m.group(1).strip()
    return re.sub(r"\s+", " ", t)


def _merge_unique(user_first: Iterable[str], *extra_blocks: Iterable[str]) -> str:
    seen: set[str] = set()
    out: list[str] = []
    for block in (user_first, *extra_blocks):
        for t in block:
            if not t or not str(t).strip():
                continue
            key = _norm_key(t)
            if key in seen:
                continue
            seen.add(key)
            out.append(t.strip())
    return ", ".join(out)


_STYLE_NON_PHOTO = frozenset(
    """
    anime manga cartoon chibi illustration illustrated vector pixel art
    oil painting watercolor sketch drawing cel shaded low poly game asset
    comic lineart stylized 3d model clay render
    """.split()
)

_HUMAN_HINTS = frozenset(
    """
    person people woman man girl boy lady guy model face portrait headshot
    body torso full body upper body lower body nude naked breast chest
    butt ass hip waist thigh leg arm hand hands finger skin hair eyes lips
    couple intimate erotic nsfw explicit
    """.split()
)

_ADULT_HINTS = frozenset(
    """
    nsfw nude naked nudity explicit erotic sex sexual porn intimate genital genitals
    penis vagina vulva breast nipple nipples topless bottomless undressing lingerie
    blowjob oral cowgirl missionary doggy orgasm penetration thrust riding straddle
    cum creampie spread legs thighs hips curves cleavage areola labia scrotum
    nsfw art adult only 18+ uncensored unclothed bare skin fetish kink bdsm
    hentai rule34 r34 ecchi lewd nsfl
    """.split()
)


def _tokens_lower(prompt: str) -> set[str]:
    return set(re.findall(r"[a-z0-9']+", prompt.lower()))


def _wants_non_photoreal(prompt_lower: str, tokens: set[str]) -> bool:
    if any(w in prompt_lower for w in _STYLE_NON_PHOTO):
        return True
    if tokens & _STYLE_NON_PHOTO:
        return True
    return False


def _mentions_human(prompt_lower: str, tokens: set[str]) -> bool:
    if any(w in prompt_lower for w in _HUMAN_HINTS):
        return True
    return bool(tokens & _HUMAN_HINTS)


def _mentions_adult(prompt_lower: str, tokens: set[str]) -> bool:
    if any(w in prompt_lower for w in _ADULT_HINTS):
        return True
    if "rule 34" in prompt_lower or "rule34" in prompt_lower:
        return True
    return bool(tokens & _ADULT_HINTS)


# Juggernaut XL / SDXL photoreal — camera + skin cues that match community recipes for this family of models
_PHOTOREAL_ADD = [
    "RAW photo",
    "professional color photography",
    "DSLR",
    "photorealistic",
    "hyperdetailed",
    "natural skin texture",
    "visible skin pores",
    "soft subsurface scattering",
    "realistic diffuse and rim lighting",
    "catchlights in eyes",
    "sharp focus on subject",
    "shallow depth of field",
    "bokeh",
    "8k uhd",
    "subtle film grain",
]

# Img2img / FaceID: lock face only — do NOT anchor pose/outfit/body to the reference (that blocks scene edits).
_FACE_IDENTITY_ADD = [
    "same person as reference",
    "identical face to reference photo",
    "consistent facial features",
    "matching face",
]
_BODY_QUALITY_ADD = [
    "anatomically correct",
    "accurate hand anatomy",
    "five fingers per hand",
]

# Extra when the user is clearly after adult content — lighting and plausible anatomy (no censorship)
_NSFW_PHOTOREAL_ADD = [
    "intimate natural lighting",
    "soft realistic shadows on skin",
    "realistic skin with natural imperfections",
    "physically plausible pose",
    "coherent human anatomy",
    "detailed skin microtexture",
]

_VIDEO_MOTION_ADD = [
    "cinematic motion",
    "temporal consistency",
    "smooth natural movement",
    "photorealistic",
]

_DEFAULT_NEGATIVE = [
    "cartoon",
    "anime",
    "3d render",
    "cgi",
    "plastic skin",
    "wax figure",
    "airbrushed",
    "doll",
    "deformed",
    "mutation",
    "mutated anatomy",
    "bad anatomy",
    "bad proportions",
    "bad hands",
    "malformed hands",
    "extra fingers",
    "missing fingers",
    "fused fingers",
    "extra digits",
    "watermark",
    "text",
    "logo",
    "oversaturated",
    "blurry",
    "jpeg artifacts",
    "low quality",
    "duplicate limbs",
    "incorrect limb count",
    "disconnected limbs",
    "cloned face",
    "cloned body",
    "uncanny valley",
]

# Stronger anatomy / symmetry fixes when adult intent is detected (still uncensored — no “clothed” etc.)
_NEGATIVE_NSFW_EXTRA = [
    "cross-eyed",
    "wonky eyes",
    "asymmetrical eyes",
    "long neck",
    "giraffe neck",
    "malformed fingers",
    "bad teeth",
    "merged fingers",
    "mangled hands",
]


def enhance_for_comfy(
    prompt: str,
    negative_prompt: str = "",
    *,
    mode: str = "txt2img",
) -> tuple[str, str]:
    """
    Return (positive, negative) tuned for Butler Comfy workflows.

    If base prompts are configured (env, butler_sd_base_prompts.json, or comfy_config.json),
    Butler user text is merged first on the positive, then the base; negatives merge base first,
    then user additions, then Butler defaults (deduped).

    mode: txt2img | img2img | txt2video | img2video
    """
    base_pos, base_neg = _load_sd_base_prompts()
    bp = _split_tags(base_pos)
    bn = _split_tags(base_neg)

    p = (prompt or "").strip()
    n = (negative_prompt or "").strip()
    pl = p.lower()
    tokens = _tokens_lower(p)

    user_pos = _split_tags(p)
    user_neg = _split_tags(n)

    if _skip_enhance():
        pos_out = _merge_unique(user_pos, bp)
        neg_out = _merge_unique(bn, user_neg)
        return (pos_out, neg_out)

    if _wants_non_photoreal(pl, tokens):
        neg_merged = _merge_unique(bn, user_neg, _DEFAULT_NEGATIVE)
        return (_merge_unique(user_pos, bp), neg_merged)

    extra_pos: list[str] = []
    extra_pos.extend(_PHOTOREAL_ADD)
    if mode in ("txt2video", "img2video"):
        extra_pos.extend(_VIDEO_MOTION_ADD)
    if mode in ("img2img", "img2video") and _mentions_human(pl, tokens):
        extra_pos.extend(_FACE_IDENTITY_ADD)
        extra_pos.extend(_BODY_QUALITY_ADD)
    if _mentions_adult(pl, tokens):
        extra_pos.extend(_NSFW_PHOTOREAL_ADD)

    pos_out = _merge_unique(user_pos, bp, extra_pos)
    neg_parts: list[Iterable[str]] = [bn, user_neg, _DEFAULT_NEGATIVE]
    if _mentions_adult(pl, tokens):
        neg_parts.append(_NEGATIVE_NSFW_EXTRA)
    neg_out = _merge_unique(*neg_parts)
    return (pos_out, neg_out)
