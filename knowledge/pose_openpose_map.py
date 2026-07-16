"""
Synthesize OpenPose-style control maps from text for pose-reference generation.

Stage A of Butler's pose-ref pipeline: text → stick-figure map → SDXL OpenPose ControlNet.
Uses COCO-18 joint colors / limb order expected by OpenPose ControlNet (lllyasviel / xinsir).
"""
from __future__ import annotations

import base64
import io
import re
from typing import Sequence

from PIL import Image, ImageDraw

# COCO-18 joint order used by OpenPose ControlNet
# 0 Nose, 1 Neck, 2 RShoulder, 3 RElbow, 4 RWrist, 5 LShoulder, 6 LElbow, 7 LWrist,
# 8 RHip, 9 RKnee, 10 RAnkle, 11 LHip, 12 LKnee, 13 LAnkle, 14 REye, 15 LEye, 16 REar, 17 LEar

LIMB_SEQ = [
    (1, 2), (1, 5), (2, 3), (3, 4), (5, 6), (6, 7), (1, 8), (8, 9),
    (9, 10), (1, 11), (11, 12), (12, 13), (1, 0), (0, 14), (14, 16), (0, 15),
    (15, 17),
]

LIMB_COLORS = [
    (255, 0, 0), (255, 85, 0), (255, 170, 0), (255, 255, 0), (170, 255, 0),
    (85, 255, 0), (0, 255, 0), (0, 255, 85), (0, 255, 170), (0, 255, 255),
    (0, 170, 255), (0, 85, 255), (0, 0, 255), (85, 0, 255), (170, 0, 255),
    (255, 0, 255), (255, 0, 170),
]

JOINT_COLORS = [
    (255, 0, 0), (255, 85, 0), (255, 170, 0), (255, 255, 0), (170, 255, 0),
    (85, 255, 0), (0, 255, 0), (0, 255, 85), (0, 255, 170), (0, 255, 255),
    (0, 170, 255), (0, 85, 255), (0, 0, 255), (85, 0, 255), (170, 0, 255),
    (255, 0, 255), (255, 0, 170), (255, 0, 85),
]

# Normalized (x, y) keypoints in [0,1]. None = missing joint.
PosePts = list[tuple[float, float] | None]


def _standing_front() -> PosePts:
    return [
        (0.50, 0.12),  # nose
        (0.50, 0.18),  # neck
        (0.38, 0.22),  # R shoulder
        (0.30, 0.36),  # R elbow
        (0.28, 0.50),  # R wrist
        (0.62, 0.22),  # L shoulder
        (0.70, 0.36),  # L elbow
        (0.72, 0.50),  # L wrist
        (0.42, 0.48),  # R hip
        (0.40, 0.68),  # R knee
        (0.40, 0.88),  # R ankle
        (0.58, 0.48),  # L hip
        (0.60, 0.68),  # L knee
        (0.60, 0.88),  # L ankle
        (0.47, 0.10),  # R eye
        (0.53, 0.10),  # L eye
        (0.44, 0.12),  # R ear
        (0.56, 0.12),  # L ear
    ]


def _arms_raised() -> PosePts:
    p = _standing_front()
    p[3] = (0.28, 0.16)  # R elbow up
    p[4] = (0.24, 0.06)  # R wrist
    p[6] = (0.72, 0.16)
    p[7] = (0.76, 0.06)
    return p


def _sitting_front() -> PosePts:
    return [
        (0.50, 0.16),
        (0.50, 0.24),
        (0.36, 0.28),
        (0.28, 0.42),
        (0.30, 0.54),
        (0.64, 0.28),
        (0.72, 0.42),
        (0.70, 0.54),
        (0.40, 0.52),
        (0.34, 0.68),
        (0.32, 0.86),
        (0.60, 0.52),
        (0.66, 0.68),
        (0.68, 0.86),
        (0.47, 0.14),
        (0.53, 0.14),
        (0.44, 0.16),
        (0.56, 0.16),
    ]


def _knees_to_chest_supine() -> PosePts:
    """
    Happy-baby / knees-to-chest from eye-level / ground-level head-on.

    Face toward camera; torso foreshortened (hips mid-frame, not bottom);
    knees folded up; soles of feet up near the face — not bird's-eye / top-down.
    """
    return [
        (0.50, 0.18),  # nose — face toward camera
        (0.50, 0.28),  # neck
        (0.30, 0.34),  # R shoulder
        (0.12, 0.44),  # R elbow — flared out
        (0.28, 0.38),  # R wrist — holding shin
        (0.70, 0.34),  # L shoulder
        (0.88, 0.44),  # L elbow — flared out
        (0.72, 0.38),  # L wrist — holding shin
        (0.40, 0.56),  # R hip — foreshortened (body into depth)
        (0.22, 0.40),  # R knee — out + toward chest
        (0.38, 0.22),  # R ankle — sole up beside face
        (0.60, 0.56),  # L hip
        (0.78, 0.40),  # L knee — out + toward chest
        (0.62, 0.22),  # L ankle — sole up beside face
        (0.46, 0.16),  # R eye
        (0.54, 0.16),  # L eye
        (0.42, 0.18),  # R ear
        (0.58, 0.18),  # L ear
    ]


def _knees_to_chest_high_angle() -> PosePts:
    """Explicit top-down / high-angle happy-baby (only when prompt asks for it)."""
    return [
        (0.50, 0.20),
        (0.50, 0.30),
        (0.28, 0.36),
        (0.10, 0.48),
        (0.30, 0.40),
        (0.72, 0.36),
        (0.90, 0.48),
        (0.70, 0.40),
        (0.38, 0.72),
        (0.22, 0.42),
        (0.40, 0.24),
        (0.62, 0.72),
        (0.78, 0.42),
        (0.60, 0.24),
        (0.46, 0.18),
        (0.54, 0.18),
        (0.42, 0.20),
        (0.58, 0.20),
    ]


def _lying_back_extended() -> PosePts:
    """Supine with legs extended — useful contrast template (avoid for knees-up prompts)."""
    return [
        (0.50, 0.12),
        (0.50, 0.18),
        (0.36, 0.22),
        (0.28, 0.30),
        (0.22, 0.38),
        (0.64, 0.22),
        (0.72, 0.30),
        (0.78, 0.38),
        (0.42, 0.40),
        (0.40, 0.62),
        (0.40, 0.88),
        (0.58, 0.40),
        (0.60, 0.62),
        (0.60, 0.88),
        (0.47, 0.10),
        (0.53, 0.10),
        (0.44, 0.12),
        (0.56, 0.12),
    ]


def _crouching() -> PosePts:
    return [
        (0.50, 0.22),
        (0.50, 0.30),
        (0.36, 0.34),
        (0.28, 0.48),
        (0.34, 0.58),
        (0.64, 0.34),
        (0.72, 0.48),
        (0.66, 0.58),
        (0.42, 0.55),
        (0.38, 0.70),
        (0.36, 0.90),
        (0.58, 0.55),
        (0.62, 0.70),
        (0.64, 0.90),
        (0.47, 0.20),
        (0.53, 0.20),
        (0.44, 0.22),
        (0.56, 0.22),
    ]


def _profile_left_walk() -> PosePts:
    return [
        (0.58, 0.14),
        (0.52, 0.20),
        (0.48, 0.24),
        (0.42, 0.38),
        (0.38, 0.50),
        (0.56, 0.24),
        (0.62, 0.36),
        (0.68, 0.48),
        (0.48, 0.48),
        (0.40, 0.66),
        (0.36, 0.88),
        (0.54, 0.48),
        (0.62, 0.66),
        (0.66, 0.88),
        (0.56, 0.12),
        (0.60, 0.12),
        (0.54, 0.14),
        (0.62, 0.14),
    ]


_TEMPLATES: dict[str, PosePts] = {
    "standing_front": _standing_front(),
    "arms_raised": _arms_raised(),
    "sitting_front": _sitting_front(),
    "knees_to_chest_supine": _knees_to_chest_supine(),
    "knees_to_chest_high_angle": _knees_to_chest_high_angle(),
    "lying_back_extended": _lying_back_extended(),
    "crouching": _crouching(),
    "profile_left_walk": _profile_left_walk(),
}


def parse_camera_cues(prompt: str) -> dict[str, bool]:
    """Extract camera / viewpoint cues from free-text pose prompts."""
    t = (prompt or "").lower()
    high_angle = bool(
        re.search(
            r"high[- ]?angle|from above|bird'?s?[- ]?eye|top[- ]?down|looking down|"
            r"overhead|above (the )?subject",
            t,
        )
    )
    eye_level = bool(
        re.search(
            r"level with (the )?ground|eye[- ]?level|ground[- ]?level|"
            r"camera (low|at (the )?floor|near (the )?floor)|from (the )?floor|"
            r"horizontal (camera|view)|camera height",
            t,
        )
    )
    head_on = bool(
        re.search(
            r"head[- ]?on|front view|frontal|straight[- ]?on|facing (the )?subject|"
            r"facing (the )?camera|looking (at|toward) (the )?subject|"
            r"camera should be facing|camera facing",
            t,
        )
    )
    low_angle = bool(re.search(r"low[- ]?angle|from below|looking up at", t))
    # Prefer eye-level when both conflict unless high-angle is explicit alone
    if high_angle and eye_level:
        high_angle = False
    return {
        "eye_level": bool(eye_level or (head_on and not high_angle)),
        "head_on": head_on,
        "high_angle": high_angle,
        "low_angle": bool(low_angle and not high_angle and not eye_level),
    }


def _score_template(prompt: str) -> tuple[str, int]:
    t = (prompt or "").lower()
    scores: dict[str, int] = {k: 0 for k in _TEMPLATES}

    # Knees-to-chest / happy baby — highest priority for the user's failure mode
    knees_up = any(
        k in t
        for k in (
            "knees up",
            "knees to chest",
            "knees to the chest",
            "holding knees",
            "happy baby",
            "legs in the air",
            "feet facing up",
            "bottoms of feet",
            "soles facing",
            "forearms behind",
            "underside of the knees",
            "underside of knees",
        )
    )
    lying = any(k in t for k in ("laying", "lying", "on back", "on their back", "supine", "reclining"))
    if knees_up or (lying and ("knee" in t or "legs in the air" in t or "feet" in t and "up" in t)):
        scores["knees_to_chest_supine"] += 100
    if lying and not knees_up:
        scores["lying_back_extended"] += 40

    if any(k in t for k in ("arms raised", "arms above", "hands above", "hands up", "arms up")):
        scores["arms_raised"] += 50
    if any(k in t for k in ("sitting", "seated", "sit down", "cross-legged", "cross legged")):
        scores["sitting_front"] += 50
    if any(k in t for k in ("crouch", "squat", "kneeling")):
        scores["crouching"] += 50
    if any(k in t for k in ("walking", "running", "side view", "profile", "from the side")):
        scores["profile_left_walk"] += 40
    if any(k in t for k in ("standing", "stand upright", "facing camera", "facing the camera")):
        scores["standing_front"] += 20

    best = max(scores.items(), key=lambda kv: kv[1])
    if best[1] <= 0:
        return "standing_front", 0
    return best[0], best[1]


def select_pose_template(prompt: str) -> str:
    name, _ = _score_template(prompt)
    cues = parse_camera_cues(prompt)
    if name == "knees_to_chest_supine" and cues["high_angle"]:
        return "knees_to_chest_high_angle"
    return name


def template_keypoints(name: str) -> PosePts:
    """Return a copy of template keypoints (for tests / debugging)."""
    if name not in _TEMPLATES:
        name = "standing_front"
    return _clone(_TEMPLATES[name])


def reject_multi_person(prompt: str) -> str | None:
    """Return a short error if the prompt clearly asks for multiple people."""
    t = (prompt or "").lower()
    if re.search(r"\b(two|three|four|five|2|3|4|5)\s+(people|persons|men|women|figures)\b", t):
        return "Pose reference supports a single person only — remove multi-person wording."
    if re.search(r"\b(couple|group|crowd|duo|trio)\b", t):
        return "Pose reference supports a single person only — remove group wording."
    return None


_ANTI_ANIME_NEGATIVE = (
    "anime, manga, cartoon, comic, chibi, illustration, illustrated, 2d animation, "
    "cel shading, anime style, drawn, sketch, painting, stylized art, waifu, pixiv, "
    "lineart, comic book, cartoonish, toon"
)

_REALISTIC_POSITIVE = (
    "(photorealistic:1.4), (realistic photograph:1.3), (realistic skin:1.2), "
    "clean realistic reference photo of a simple clothed adult person, "
    "natural human proportions, mannequin-neutral plain clothing, "
    "NOT anime, NOT manga, NOT illustration, NOT cartoon"
)


def _camera_lock_phrase(user_pose: str) -> str:
    cues = parse_camera_cues(user_pose)
    parts: list[str] = []
    if cues["eye_level"] or cues["head_on"]:
        parts.append(
            "(eye-level camera:1.45), (camera level with the ground:1.4), "
            "(head-on frontal view:1.35), looking straight at the subject, "
            "horizontal viewpoint, not high angle, not bird's eye, not top-down, "
            "not looking down from above"
        )
    elif cues["high_angle"]:
        parts.append("(high-angle view:1.2), looking down at the subject")
    elif cues["low_angle"]:
        parts.append("(low-angle view:1.2), looking up at the subject")
    elif re.search(r"camera|facing|front view|looking (at|toward)", user_pose or "", re.I):
        parts.append("keep the described camera angle and framing")
    return (", ".join(parts) + ", ") if parts else ""


def compose_pose_controlnet_prompts(user_pose: str) -> tuple[str, str]:
    """
    Structure user pose text for ControlNet + prompt synergy.
    ControlNet drives geometry; prompt insists on a clothed living photoreal person (not anime).
    """
    raw = (user_pose or "").strip()
    raw = re.sub(
        r"^\(follow the described pose exactly:[^)]+\),\s*",
        "",
        raw,
        flags=re.I,
    ).strip()
    raw = re.sub(
        r"^\(match the OpenPose skeleton exactly:[^)]+\),\s*",
        "",
        raw,
        flags=re.I,
    ).strip()
    camera = _camera_lock_phrase(raw)
    positive = (
        f"(one living adult human person:1.55), (match the OpenPose body pose exactly:1.55), "
        f"{_REALISTIC_POSITIVE}, {camera}{raw}, "
        "clear face, natural skin, wearing a plain t-shirt and pants, shoes optional, "
        "clear human proportions, visible arms legs hands feet, full body head to toe in frame, "
        "distinct separated limbs, plain solid light gray studio background, even soft lighting, no props"
    )
    negative = (
        f"{_ANTI_ANIME_NEGATIVE}, "
        "skeleton, bones, skull, ribcage, anatomical chart, x-ray, stick figure, wireframe, "
        "OpenPose overlay, neon bones, silhouette, black silhouette, abstract shape, blob, "
        "featureless body, shadow figure, statue, mannequin, doll, robot, jewelry, ornament, "
        "wrong pose, ignored pose, different pose, flat on back with legs extended, "
        "straight legs when knees should be bent, melted feet, fused feet, arms in wrong position, "
        "hands in wrong position, legs in wrong position, multiple people, crowd, busy background, "
        "scenery, furniture, props, clutter, cropped body, out of frame, cut off head, cut off feet, "
        "hidden hands, hidden feet, missing limbs, extra limbs, fused limbs, overlapping limbs, "
        "text, watermark, logo, nude, nsfw, photoreal fashion, glamorous, magazine cover, "
        "high angle when eye-level requested, bird's eye, top-down when not requested"
    )
    return positive, negative


def merge_pose_negatives(composed_neg: str, user_neg: str | None) -> str:
    """Always keep compose anti-anime / pose locks; append unique user Avoid terms."""
    composed = (composed_neg or "").strip()
    user = (user_neg or "").strip()
    if not user:
        return composed
    if not composed:
        return user

    def _parts(s: str) -> list[str]:
        return [p.strip() for p in s.split(",") if p.strip()]

    seen: set[str] = set()
    out: list[str] = []
    for part in _parts(composed) + _parts(user):
        key = re.sub(r"\s+", " ", part.lower())
        if key in seen:
            continue
        seen.add(key)
        out.append(part)
    return ", ".join(out)


def _clone(pts: PosePts) -> PosePts:
    return [None if p is None else (float(p[0]), float(p[1])) for p in pts]


def _draw_openpose(width: int, height: int, pts: PosePts) -> Image.Image:
    img = Image.new("RGB", (width, height), (0, 0, 0))
    draw = ImageDraw.Draw(img)
    stick = max(6, int(round(min(width, height) / 96)))

    def xy(i: int) -> tuple[int, int] | None:
        p = pts[i]
        if p is None:
            return None
        return int(p[0] * width), int(p[1] * height)

    for (a, b), color in zip(LIMB_SEQ, LIMB_COLORS):
        pa, pb = xy(a), xy(b)
        if pa is None or pb is None:
            continue
        c = tuple(int(v * 0.6) for v in color)
        draw.line([pa, pb], fill=c, width=stick)

    r = max(5, int(stick * 0.85))
    for i, color in enumerate(JOINT_COLORS):
        p = xy(i)
        if p is None:
            continue
        draw.ellipse((p[0] - r, p[1] - r, p[0] + r, p[1] + r), fill=color)
    return img


def render_openpose_map(
    prompt: str,
    width: int = 768,
    height: int = 1152,
    template: str | None = None,
) -> tuple[Image.Image, str]:
    """Return (RGB OpenPose map, template_name)."""
    name = template or select_pose_template(prompt)
    if name not in _TEMPLATES:
        name = "standing_front"
    pts = _clone(_TEMPLATES[name])
    w = max(256, min(2048, int(width)))
    h = max(256, min(2048, int(height)))
    return _draw_openpose(w, h, pts), name


def render_openpose_map_png_bytes(
    prompt: str,
    width: int = 768,
    height: int = 1152,
    template: str | None = None,
) -> tuple[bytes, str]:
    img, name = render_openpose_map(prompt, width=width, height=height, template=template)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue(), name


def render_openpose_map_b64(
    prompt: str,
    width: int = 768,
    height: int = 1152,
    template: str | None = None,
) -> tuple[str, str]:
    raw, name = render_openpose_map_png_bytes(prompt, width=width, height=height, template=template)
    return base64.b64encode(raw).decode("ascii"), name


def available_templates() -> Sequence[str]:
    return tuple(_TEMPLATES.keys())
