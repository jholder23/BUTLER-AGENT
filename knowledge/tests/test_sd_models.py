"""
Stable Diffusion / ComfyUI / Forge coverage for Butler.

- Default suite: no GPU, no Comfy — validates workflow catalog, bundled JSON, conversion helpers, and sd_helper constants.
- Live Comfy: `BUTLER_SD_LIVE_TEST=1` with ComfyUI on COMFYUI_URL (default http://127.0.0.1:8188) checks /object_info.
"""

from __future__ import annotations

import base64
import json
import os
from pathlib import Path

import pytest

from comfy_helper import (
    _bundled_workflows_dir,
    _get_workflow_path,
    _is_api_format,
    _pick_checkpoint_name,
    _ui_to_api_format,
    _workflows_dir,
    img2img_workflow_sweep_requested,
    registered_comfy_workflow_names,
    use_img2img_nsfw_compare_triple,
)
from sd_helper import SD_FORGE_IMG2VIDEO_PATHS, SD_FORGE_TXT2VIDEO_PATHS


def test_desktop_direct_handoff_stages_encoded_image_into_runtime_input_dir(monkeypatch, tmp_path):
    import comfy_helper as ch

    raw = base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6wAAAABJRU5ErkJggg=="
    )
    monkeypatch.setenv("BUTLER_COMFY_INPUT_DIR", str(tmp_path))
    monkeypatch.delenv("COMFYUI_INPUT_DIR", raising=False)

    out = ch._upload_image(base64.b64encode(raw).decode("ascii"), "face.png")

    assert out.get("ok") is True
    assert out.get("name") == "face.png"
    staged = Path(out["local_path"])
    assert staged == tmp_path / "face.png"
    assert staged.is_file()
    assert staged.read_bytes() == raw


def test_registered_workflow_catalog_unique_sorted_coverage():
    names = registered_comfy_workflow_names()
    assert len(names) == len(set(names)), f"duplicate entries in catalog: {names}"
    assert "txt2img_Juggernaut" in names
    assert "txt2img_pose_reference_simple" in names
    assert "txt2img_pose_reference_controlnet" in names
    assert "img2img_Juggernaut" in names
    assert "img2img_juggernaut_faceid_supreme_nsfw" in names
    assert "img2img_butler_photoreal_faceid_nsfw" in names
    assert "img2img_butler_faceid_explicit_ultimate_nsfw" in names
    assert "img2img_butler_sdxl_vae_simple" in names
    assert "butler_txt2video" in names
    assert "butler_img2video" in names
    assert "butler_img2video_nsfw" in names
    assert "butler_img2video_wan22" in names
    assert "img2img_nsfw_compare_lock" in names


def test_bundled_explicit_ultimate_faceid_workflow_is_api_graph():
    p = _bundled_workflows_dir() / "img2img_butler_faceid_explicit_ultimate_nsfw.json"
    assert p.is_file(), f"missing bundled workflow {p}"
    data = json.loads(p.read_text(encoding="utf-8"))
    assert isinstance(data, dict) and data
    assert _is_api_format(data), "explicit ultimate workflow must be API JSON for Butler"
    class_types = {v.get("class_type") for v in data.values() if isinstance(v, dict)}
    assert "IPAdapterUnifiedLoaderFaceID" in class_types
    assert "VAEEncode" in class_types
    assert "KSampler" in class_types


def test_bundled_sdxl_vae_simple_default_img2img_no_ipadapter():
    p = _bundled_workflows_dir() / "img2img_butler_sdxl_vae_simple.json"
    assert p.is_file(), f"missing bundled workflow {p}"
    data = json.loads(p.read_text(encoding="utf-8"))
    assert isinstance(data, dict) and data
    assert _is_api_format(data), "default img2img must be API JSON for Butler"
    class_types = {v.get("class_type") for v in data.values() if isinstance(v, dict)}
    assert "CheckpointLoaderSimple" in class_types
    assert "VAEEncode" in class_types
    assert "KSampler" in class_types
    assert "IPAdapterUnifiedLoaderFaceID" not in class_types


def test_bundled_video_workflows_exist_and_convert():
    """Shipped under knowledge/comfy_workflows/ — must always load and UI→API convert offline."""
    bdir = _bundled_workflows_dir()
    for base in ("butler_txt2video", "butler_img2video"):
        p = bdir / f"{base}.json"
        assert p.is_file(), f"missing bundled workflow {p}"
        data = json.loads(p.read_text(encoding="utf-8"))
        assert isinstance(data, dict) and data
        if _is_api_format(data):
            api = data
        else:
            api = _ui_to_api_format(data)
        assert api and isinstance(api, dict), f"{base}: UI→API conversion produced empty dict"
        class_types = {v.get("class_type") for v in api.values() if isinstance(v, dict)}
        assert class_types, f"{base}: no class_type entries"
        # Wan / video graphs use KSampler or KSamplerAdvanced; allow either
        assert class_types & {
            "KSampler",
            "KSamplerAdvanced",
        }, f"{base}: expected a sampler node, got {class_types!r}"


def test_catalog_workflows_resolve_bundled_and_validate_present_copies():
    """
    Bundled Butler video workflows must always resolve.

    Other names (Juggernaut, FaceID, compare trio) normally live under SD_PROJECT_PATH/ComfyUI/workflows
    (not committed). When present, they must be valid JSON and convert to a non-empty API graph.

    Set BUTLER_SD_WORKFLOW_STRICT=1 on a machine with a full sd/ tree to require every catalog name on disk.
    """
    missing: list[str] = []
    for name in registered_comfy_workflow_names():
        p = _get_workflow_path(name)
        if not p or not p.is_file():
            missing.append(name)
            continue
        data = json.loads(p.read_text(encoding="utf-8"))
        assert isinstance(data, dict) and data
        bundled_dir = _bundled_workflows_dir().resolve()
        is_bundled = p.resolve().parent == bundled_dir
        if not _is_api_format(data):
            # UI→API can call Comfy /object_info for custom nodes — only assert conversion for shipped bundles.
            if is_bundled:
                api = _ui_to_api_format(data)
                assert api, f"{name}: UI→API conversion empty — fix nodes/links or export API JSON from Comfy"

    for required in ("butler_txt2video", "butler_img2video"):
        assert required not in missing, f"Bundled workflow {required}.json must ship under {_bundled_workflows_dir()}"

    strict = os.environ.get("BUTLER_SD_WORKFLOW_STRICT", "").strip().lower() in ("1", "true", "yes", "on")
    if strict and missing:
        pytest.fail(
            "BUTLER_SD_WORKFLOW_STRICT: missing workflow files: "
            + ", ".join(missing)
            + f" — add under {_workflows_dir()}"
        )


def test_pick_checkpoint_prefers_comfy_list_and_juggernaut_heuristic():
    assert _pick_checkpoint_name("foo.safetensors", ["a.safetensors", "b.safetensors"], []) == "a.safetensors"
    assert _pick_checkpoint_name("a.safetensors", ["a.safetensors"], []) == "a.safetensors"
    combo = ["other.safetensors", "JuggernautXL_v9.safetensors"]
    assert _pick_checkpoint_name("juggernaut_xl_v9.safetensors", combo, []) == "JuggernautXL_v9.safetensors"


def test_img2img_test_prefix_requests_sweep_even_with_workflow_field():
    """`/test` forces sweep; an explicit workflow name in JSON must not disable it."""
    assert img2img_workflow_sweep_requested(
        {"prompt": "/test same pose", "workflow": "img2img_Juggernaut"},
    )


def test_img2img_test_prefix_requests_sweep_not_nsfw_triple():
    """`/test` / `/text` (start or end) runs full workflow sweep; compare_nsfw_triple is JSON-only."""
    sweep = {"prompt": "/test same pose", "workflow": ""}
    assert img2img_workflow_sweep_requested(sweep)
    assert not use_img2img_nsfw_compare_triple(sweep)
    assert img2img_workflow_sweep_requested({"prompt": "scene description /test", "workflow": ""})
    assert img2img_workflow_sweep_requested({"prompt": "/text warm", "workflow": ""})
    assert img2img_workflow_sweep_requested({"prompt": "foo bar /text", "workflow": ""})
    no_sweep = {"prompt": "warm light", "workflow": ""}
    assert not img2img_workflow_sweep_requested(no_sweep)
    triple = {"prompt": "warm light", "workflow": "", "compare_nsfw_triple": True}
    assert not img2img_workflow_sweep_requested(triple)


def test_img2img_sweep_includes_all_eligible_json(monkeypatch, tmp_path):
    import comfy_helper as ch

    wf = tmp_path / "workflows"
    wf.mkdir()
    (wf / "txt2img_x.json").write_text("{}")
    (wf / "butler_txt2video.json").write_text("{}")
    (wf / "img2img_b.json").write_text("{}")
    (wf / "img2img_a.json").write_text("{}")
    (wf / "custom_edit.json").write_text("{}")

    monkeypatch.setattr(ch, "_workflows_dir", lambda: wf)
    monkeypatch.setattr(ch, "_img2img_workflow_order_list", lambda: ["img2img_b", "nope"])

    names = ch._img2img_sweep_workflow_basenames()
    assert names == ["img2img_b", "custom_edit", "img2img_a"]
    assert "txt2img_x" not in names
    assert "butler_txt2video" not in names


def test_img2img_sweep_nested_json_under_test(monkeypatch, tmp_path):
    import comfy_helper as ch

    wf = tmp_path / "workflows"
    wf.mkdir()
    td = wf / "test"
    td.mkdir()
    nested = td / "nsfw_batch"
    nested.mkdir()
    (nested / "one.json").write_text("{}")
    (td / "root.json").write_text("{}")

    monkeypatch.setattr(ch, "_workflows_dir", lambda: wf)
    monkeypatch.setattr(ch, "_img2img_workflow_order_list", lambda: [])

    names = ch._img2img_sweep_workflow_basenames()
    assert "root" in names
    assert "nsfw_batch/one" in names
    p = ch._get_workflow_path("nsfw_batch/one")
    assert p and p.is_file()


def test_img2img_sweep_prefers_workflows_test_and_includes_txt2img(monkeypatch, tmp_path):
    import comfy_helper as ch

    wf = tmp_path / "workflows"
    wf.mkdir()
    td = wf / "test"
    td.mkdir()
    (td / "txt2img_a.json").write_text("{}")
    (td / "img2img_b.json").write_text("{}")
    (wf / "root_only.json").write_text("{}")

    monkeypatch.setattr(ch, "_workflows_dir", lambda: wf)
    monkeypatch.setattr(ch, "_img2img_workflow_order_list", lambda: ["img2img_b", "txt2img_a"])

    names = ch._img2img_sweep_workflow_basenames()
    assert names == ["img2img_b", "txt2img_a"]
    assert "root_only" not in names
    assert "txt2img_a" in names


def test_img2img_sweep_empty_test_subdir_falls_back_to_main_folder(monkeypatch, tmp_path):
    import comfy_helper as ch

    wf = tmp_path / "workflows"
    wf.mkdir()
    (wf / "test").mkdir()
    (wf / "img2img_x.json").write_text("{}")
    (wf / "txt2img_y.json").write_text("{}")

    monkeypatch.setattr(ch, "_workflows_dir", lambda: wf)
    monkeypatch.setattr(ch, "_img2img_workflow_order_list", lambda: [])

    names = ch._img2img_sweep_workflow_basenames()
    assert names == ["img2img_x"]
    assert "txt2img_y" not in names


def test_easy_faceid_does_not_require_pose_image(monkeypatch):
    """Easy FaceID is face-only; OpenPose dual-ref still requires pose_image."""
    import comfy_helper as ch

    monkeypatch.setattr(
        ch,
        "_ensure_load_image_matches_comfy",
        lambda workflow, load_node_id, filename, subfolder: (
            workflow[load_node_id].setdefault("inputs", {}).__setitem__("image", filename) or None
        ),
    )

    for stem, want_pose in (
        ("img2img_juggernaut_faceid_easy_nsfw", False),
        ("img2img_juggernaut_faceid_new_scene_nsfw", False),
        ("img2img_juggernaut_faceid_openpose_action_nsfw", True),
        ("img2img_Juggernaut", False),  # VAEEncode init must not count as pose
        ("img2img_butler_sdxl_vae_simple", False),
    ):
        wp = ch._get_workflow_path(stem) or (ch._bundled_workflows_dir() / f"{stem}.json")
        assert wp and wp.is_file(), stem
        raw = json.loads(wp.read_text(encoding="utf-8"))
        api = raw if ch._is_api_format(raw) else ch._ui_to_api_format(raw)
        assert ch._workflow_needs_pose_image(api, stem) is want_pose, stem
        err = ch._bind_load_images_for_img2img(
            api,
            face_name="face.png",
            face_subfolder="",
            workflow_name=stem,
        )
        if want_pose:
            assert err and "pose_image" in err, stem
        else:
            assert err is None, f"{stem}: {err}"


def test_openpose_faceid_workflow_defaults_bias_pose_over_pose_face_conflicts():
    import comfy_helper as ch

    wp = ch._get_workflow_path("img2img_juggernaut_faceid_openpose_action_nsfw")
    assert wp and wp.is_file()
    raw = json.loads(wp.read_text(encoding="utf-8"))

    dw = next(n for n in raw["nodes"] if n["type"] == "DWPreprocessor")
    cnet = next(n for n in raw["nodes"] if n["type"] == "ControlNetApplyAdvanced")
    face_loader = next(n for n in raw["nodes"] if n["type"] == "IPAdapterUnifiedLoaderFaceID")
    faceid = next(n for n in raw["nodes"] if n["type"] == "IPAdapterFaceID")

    assert dw["widgets_values"][:3] == ["enable", "enable", "disable"]
    assert cnet["widgets_values"] == [1.0, 0.0, 0.9]
    assert face_loader["widgets_values"][1] == 0.35
    assert faceid["widgets_values"][0] == 0.55
    assert faceid["widgets_values"][1] == 1.0
    assert faceid["widgets_values"][5] == 0.45


def test_openpose_faceid_prompt_guardrails_for_occluded_rear_face_pose():
    import comfy_helper as ch

    pos, neg = ch._compose_openpose_faceid_img2img_prompts(
        "same adult person as the face reference, follow the pose reference body geometry, camera on opposite side facing back of the legs, forward fold",
        "",
    )

    pos_low = pos.lower()
    neg_low = neg.lower()
    assert "pose reference for full-body geometry" in pos_low
    assert "face reference for identity" in pos_low
    assert "without forcing a frontal face" in pos_low
    assert "mosaic skin" in neg_low
    assert "front-facing face when pose implies a hidden or turned-away face" in neg_low


def test_forge_video_probe_paths_non_empty():
    assert len(SD_FORGE_TXT2VIDEO_PATHS) >= 2
    assert all(p.startswith("/") for p in SD_FORGE_TXT2VIDEO_PATHS)
    assert len(SD_FORGE_IMG2VIDEO_PATHS) >= 2
    assert all(p.startswith("/") for p in SD_FORGE_IMG2VIDEO_PATHS)


@pytest.mark.integration
def test_live_comfy_object_info_when_enabled():
    """
    Requires ComfyUI listening. Enable with BUTLER_SD_LIVE_TEST=1 (optional in CI).
    Validates core node schema used by checkpoint wiring exists.
    """
    if os.environ.get("BUTLER_SD_LIVE_TEST", "").strip().lower() not in ("1", "true", "yes", "on"):
        pytest.skip("Set BUTLER_SD_LIVE_TEST=1 to probe a running ComfyUI")

    try:
        import requests
    except ImportError:
        pytest.skip("requests not installed")

    from comfy_helper import _comfy_url, invalidate_object_info_cache

    invalidate_object_info_cache()
    url = f"{_comfy_url()}/object_info"
    try:
        r = requests.get(url, timeout=20)
    except OSError as e:
        pytest.fail(f"Could not reach ComfyUI at {url}: {e}")
    assert r.status_code == 200, f"object_info HTTP {r.status_code}: {r.text[:500]}"
    data = r.json()
    assert isinstance(data, dict) and data
    assert "CheckpointLoaderSimple" in data, "ComfyUI schema missing CheckpointLoaderSimple — wrong server or very old Comfy?"
    # Video / Wan stacks use these when present
    for optional in ("UNETLoader", "VAELoader", "CLIPLoader", "CLIPVisionLoader"):
        if optional in data:
            assert isinstance(data[optional], dict)
