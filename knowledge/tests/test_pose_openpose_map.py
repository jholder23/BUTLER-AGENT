"""Unit tests for OpenPose map synthesis (pose-ref Stage A)."""
from __future__ import annotations

import json

from pose_openpose_map import (
    compose_pose_controlnet_prompts,
    merge_pose_negatives,
    parse_camera_cues,
    reject_multi_person,
    render_openpose_map,
    select_pose_template,
    template_keypoints,
)
from comfy_helper import _bundled_workflows_dir, _is_api_format

KNEES_LEVEL_PROMPT = (
    "laying on back, holding knees up to chest, legs in the air, arms on the backside of legs, "
    "forearms behind the underside of the knees, bottoms of feet facing up, "
    "camera should be facing subject head on and level with the ground"
)


def test_knees_to_chest_selects_supine_template():
    assert select_pose_template(KNEES_LEVEL_PROMPT) == "knees_to_chest_supine"


def test_knees_high_angle_selects_high_angle_template():
    prompt = "knees to chest laying on back, bird's eye view from above"
    assert select_pose_template(prompt) == "knees_to_chest_high_angle"


def test_camera_cues_level_ground_head_on():
    cues = parse_camera_cues(KNEES_LEVEL_PROMPT)
    assert cues["eye_level"] is True
    assert cues["head_on"] is True
    assert cues["high_angle"] is False


def test_knees_eye_level_geometry_foreshortened():
    """Hips stay mid-frame (not bottom); ankles near face — eye-level, not top-down."""
    pts = template_keypoints("knees_to_chest_supine")
    r_hip_y = pts[8][1]
    l_hip_y = pts[11][1]
    r_ankle_y = pts[10][1]
    nose_y = pts[0][1]
    assert r_hip_y < 0.65 and l_hip_y < 0.65
    assert r_ankle_y < r_hip_y
    assert abs(r_ankle_y - nose_y) < 0.12


def test_standing_default():
    assert select_pose_template("facing camera, arms at sides") == "standing_front"


def test_reject_multi_person():
    assert reject_multi_person("two people dancing") is not None
    assert reject_multi_person("single person standing") is None


def test_compose_prompts_include_controlnet_lock():
    pos, neg = compose_pose_controlnet_prompts("knees up to chest, camera head on")
    assert "OpenPose body pose" in pos
    assert "living adult human" in pos
    assert "camera" in pos.lower() or "eye-level" in pos.lower()
    assert "t-shirt" in pos
    assert "photoreal" in pos.lower()
    assert "NOT anime" in pos or "not anime" in pos.lower()
    assert "skeleton" in neg
    assert "anime" in neg.lower()
    assert "flat on back with legs extended" in neg


def test_compose_level_ground_camera_lock():
    pos, neg = compose_pose_controlnet_prompts(KNEES_LEVEL_PROMPT)
    assert "eye-level" in pos.lower() or "level with the ground" in pos.lower()
    assert "head-on" in pos.lower() or "head on" in pos.lower()
    assert "bird" in pos.lower() or "top-down" in pos.lower() or "high angle" in pos.lower()
    assert "anime" in neg.lower()
    assert "manga" in neg.lower()


def test_merge_pose_negatives_keeps_anti_anime():
    _, composed = compose_pose_controlnet_prompts("standing")
    merged = merge_pose_negatives(composed, "extra custom avoid term")
    assert "anime" in merged.lower()
    assert "extra custom avoid term" in merged


def test_render_openpose_map_nonblack():
    img, name = render_openpose_map("knees to chest laying on back", width=384, height=576)
    assert name == "knees_to_chest_supine"
    assert img.size == (384, 576)
    # Stick figure must paint non-black pixels
    extrema = img.getextrema()
    assert any(ch[1] > 0 for ch in extrema)


def test_render_knees_level_ground_selects_eye_level():
    img, name = render_openpose_map(KNEES_LEVEL_PROMPT, width=384, height=576)
    assert name == "knees_to_chest_supine"
    assert img.size == (384, 576)


def test_bundled_pose_controlnet_workflow_api():
    p = _bundled_workflows_dir() / "txt2img_pose_reference_controlnet.json"
    assert p.is_file(), f"missing {p}"
    data = json.loads(p.read_text(encoding="utf-8"))
    assert _is_api_format(data)
    types = {v.get("class_type") for v in data.values() if isinstance(v, dict)}
    assert "ControlNetLoader" in types
    assert "ControlNetApplyAdvanced" in types
    assert "LoadImage" in types
    assert "EmptyLatentImage" in types
    cn = next(v for v in data.values() if v.get("class_type") == "ControlNetLoader")
    assert "openpose" in cn["inputs"]["control_net_name"].lower()
    pos = next(v for v in data.values() if v.get("class_type") == "CLIPTextEncode" and "photoreal" in v["inputs"]["text"].lower())
    assert "anime" in pos["inputs"]["text"].lower() or "NOT anime" in pos["inputs"]["text"]
    neg = next(
        v
        for v in data.values()
        if v.get("class_type") == "CLIPTextEncode" and "anime" in v["inputs"]["text"].lower() and "skeleton" in v["inputs"]["text"].lower()
    )
    assert "manga" in neg["inputs"]["text"].lower()
    apply = next(v for v in data.values() if v.get("class_type") == "ControlNetApplyAdvanced")
    assert float(apply["inputs"]["strength"]) >= 0.9
