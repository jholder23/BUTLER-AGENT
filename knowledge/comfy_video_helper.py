"""
ComfyUI text→video and image→video for Butler.

Expects API-format workflows (or UI JSON convertible the same way as img2img) under:
  <SD_PROJECT_PATH>/ComfyUI/workflows/

Default filenames: butler_txt2video.json, butler_img2video_nsfw.json (fallback butler_img2video.json)
Override with COMFY_TXT2VIDEO_WORKFLOW / COMFY_IMG2VIDEO_WORKFLOW or comfy_config.json keys.
"""
from __future__ import annotations

import base64
import json
import os
import time
from pathlib import Path

from sd_prompt_enhance import enhance_for_comfy

from comfy_helper import (
    _ensure_aux_model_loaders_from_comfy,
    _ensure_load_image_matches_comfy,
    _ensure_workflow_checkpoint_from_comfy,
    _ensure_workflow_ckpt_exists,
    _comfy_config_path,
    coerce_comfy_history_entry,
    _get_history,
    _get_image,
    _get_workflow_path,
    _is_api_format,
    _queue_prompt,
    _try_comfy_convert_api,
    _ui_to_api_format,
    _upload_image,
    invalidate_object_info_cache,
    wait_for_comfy_api_ready,
    _wire_sampler_prompts,
)


def _video_workflow_names(kind: str) -> tuple[str, ...]:
    """kind: 'txt' | 'img'."""
    env_key = "COMFY_TXT2VIDEO_WORKFLOW" if kind == "txt" else "COMFY_IMG2VIDEO_WORKFLOW"
    default = "butler_txt2video" if kind == "txt" else "butler_img2video_nsfw"
    env_v = (os.environ.get(env_key) or "").strip()
    if env_v:
        return (env_v.replace(".json", ""),)
    cfg_path = _comfy_config_path()
    if cfg_path.exists():
        try:
            with open(cfg_path, encoding="utf-8") as f:
                data = json.load(f)
            cfg_key = "txt2video_workflow" if kind == "txt" else "img2video_workflow"
            raw = data.get(cfg_key)
            if isinstance(raw, str) and raw.strip():
                return (raw.strip().replace(".json", ""),)
            if isinstance(raw, list) and raw:
                return tuple(str(x).replace(".json", "").strip() for x in raw if str(x).strip())
        except Exception:
            pass
    if kind == "img":
        return ("butler_img2video_nsfw", "butler_img2video")
    return (default,)


def _load_workflow(name: str) -> dict | None:
    wp = _get_workflow_path(name)
    if not wp or not wp.exists():
        return None
    try:
        with open(wp, encoding="utf-8") as f:
            raw = json.load(f)
    except Exception:
        return None
    if _is_api_format(raw):
        return raw
    return _try_comfy_convert_api(raw) or _ui_to_api_format(raw) or None


def _is_probably_video_magic(head: bytes) -> bool:
    if len(head) < 12:
        return False
    if head[4:8] == b"ftyp":
        return True
    if head[:4] == bytes([0x1A, 0x45, 0xDF, 0xA3]):
        return True
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return True
    if head[:6] in (b"GIF87a", b"GIF89a"):
        return True
    return False


def _video_extensions() -> tuple[str, ...]:
    return (".mp4", ".webm", ".gif", ".avi", ".mov", ".mkv", ".webp", ".m4v", ".ogv")


def _candidate_media_tuples(item: object) -> list[tuple[str, str, str]]:
    """Return list of (filename, subfolder, folder_type) to try with /view."""
    out: list[tuple[str, str, str]] = []
    if isinstance(item, str) and item.strip():
        out.append((item.strip(), "", "output"))
        return out
    if not isinstance(item, dict):
        return out
    sub = (item.get("subfolder") or "") or ""
    ft = (item.get("type") or "output") or "output"
    fn = (item.get("filename") or item.get("name") or "").strip()
    if not fn and item.get("fullpath"):
        try:
            fn = Path(str(item["fullpath"])).name
        except Exception:
            fn = ""
    if fn:
        out.append((fn, sub, ft))
    for alt in ("filepath", "path", "file"):
        v = item.get(alt)
        if isinstance(v, str) and v.strip() and not fn:
            try:
                out.append((Path(v.strip()).name, sub, ft))
            except Exception:
                pass
    return out


def _harvest_video_bytes(hist: dict) -> bytes | None:
    outputs = hist.get("outputs") or {}
    for _nid, out in outputs.items():
        if not isinstance(out, dict):
            continue
        for _key, arr in out.items():
            if not isinstance(arr, list):
                continue
            for item in arr:
                for fn, subfolder, folder_type in _candidate_media_tuples(item):
                    if not fn:
                        continue
                    low = fn.lower()
                    ext_ok = low.endswith(_video_extensions())
                    raw = _get_image(fn, subfolder, folder_type)
                    if not raw or len(raw) < 80:
                        continue
                    if ext_ok or _is_probably_video_magic(raw[:32]):
                        return raw
    return None


def _poll_for_video_output(prompt_id: str, max_iterations: int = 10000, delay_sec: float = 3.0) -> dict:
    """Wait up to ~8 hours for a heavy video frame run."""
    for _ in range(max_iterations):
        time.sleep(delay_sec)
        hist_raw = _get_history(prompt_id)
        hist = coerce_comfy_history_entry(hist_raw) or (hist_raw if isinstance(hist_raw, dict) else None)
        if not hist:
            continue
        err_msgs = hist.get("status", {}).get("messages")
        if err_msgs and isinstance(err_msgs, list):
            # ComfyUI newer versions use 'messages' for execution_start, execution_success, etc.
            # Only treat as error if there is an explicit error message.
            has_error = any(
                isinstance(m, (list, tuple)) and len(m) > 0 and "error" in str(m[0]).lower()
                for m in err_msgs
            )
            if has_error:
                return {"ok": False, "message": str(err_msgs), "images": [], "video": ""}
        elif err_msgs and not isinstance(err_msgs, list):
            return {"ok": False, "message": str(err_msgs), "images": [], "video": ""}

        outs = hist.get("outputs") or {}
        if outs:
            raw = _harvest_video_bytes(hist)
            if raw:
                return {
                    "ok": True,
                    "message": "Video generated via ComfyUI",
                    "video": base64.b64encode(raw).decode("utf-8"),
                    "images": [],
                    "path": "",
                }
            st = hist.get("status") or {}
            done = st.get("completed") is True or st.get("status_str") == "success"
            if done:
                return {
                    "ok": False,
                    "message": (
                        "ComfyUI finished but Butler did not find a video file in outputs. "
                        "Use a node that saves WEBM/MP4/GIF (e.g. SaveWEBM, VHS Combine) and ensure the file appears under history outputs."
                    ),
                    "images": [],
                    "video": "",
                }
    return {
        "ok": False,
        "message": "ComfyUI video timed out (~8 hours). Reduce frames or use a lighter workflow.",
        "images": [],
        "video": "",
    }


def comfy_txt2video_workflow_exists() -> bool:
    for wn in _video_workflow_names("txt"):
        p = _get_workflow_path(wn)
        if p and p.exists():
            return True
    return False


def comfy_img2video_workflow_exists() -> bool:
    for wn in _video_workflow_names("img"):
        p = _get_workflow_path(wn)
        if p and p.exists():
            return True
    return False


def txt2video_comfy(
    prompt: str,
    negative_prompt: str = "",
    workflow_name: str | None = None,
) -> dict:
    names = (workflow_name.replace(".json", ""),) if workflow_name else _video_workflow_names("txt")
    tried = False
    for wn in names:
        workflow = _load_workflow(wn)
        if not workflow:
            continue
        tried = True
        ready_ok, ready_msg = wait_for_comfy_api_ready()
        if not ready_ok:
            return {"ok": False, "message": ready_msg, "images": [], "video": ""}
        ep, en = enhance_for_comfy(prompt, negative_prompt, mode="txt2video")
        _wire_sampler_prompts(workflow, ep or "high quality, cinematic motion", en or "blurry, static, jpeg artifacts, low quality, ugly")
        ck_err = _ensure_workflow_checkpoint_from_comfy(workflow)
        if ck_err:
            return {"ok": False, "message": ck_err, "images": [], "video": ""}
        aux_err = _ensure_aux_model_loaders_from_comfy(workflow)
        if aux_err:
            return {"ok": False, "message": aux_err, "images": [], "video": ""}
        _ensure_workflow_ckpt_exists(workflow)
        q = _queue_prompt(workflow)
        if not q.get("ok"):
            return {"ok": False, "message": q.get("message", "Queue failed"), "images": [], "video": ""}
        return _poll_for_video_output(q["prompt_id"])
    if not tried:
        return {
            "ok": False,
            "message": (
                f"No ComfyUI txt2video workflow file. Add {names[0]}.json under ComfyUI/workflows "
                "(export API JSON from Comfy — see knowledge/COMFY_VIDEO_SETUP.txt)."
            ),
            "images": [],
            "video": "",
        }
    return {"ok": False, "message": "Txt2video workflow load failed.", "images": [], "video": ""}


def image2video_comfy(
    init_image_b64: str,
    prompt: str,
    negative_prompt: str = "",
    workflow_name: str | None = None,
    upload_filename: str | None = None,
) -> dict:
    names = (workflow_name.replace(".json", ""),) if workflow_name else _video_workflow_names("img")
    for wn in names:
        workflow = _load_workflow(wn)
        if not workflow:
            continue
        load_nodes = [
            nid
            for nid, node in workflow.items()
            if isinstance(node, dict) and node.get("class_type") == "LoadImage"
        ]
        if not load_nodes:
            return {
                "ok": False,
                "message": "Img2video workflow has no LoadImage node (required for your still).",
                "images": [],
                "video": "",
            }
        ready_ok, ready_msg = wait_for_comfy_api_ready()
        if not ready_ok:
            return {"ok": False, "message": ready_msg, "images": [], "video": ""}
        up = _upload_image(init_image_b64, upload_filename)
        if not up.get("ok"):
            return {"ok": False, "message": up.get("message", "Upload failed"), "images": [], "video": ""}
        filename = up["name"]
        subfolder = up.get("subfolder", "")
        invalidate_object_info_cache()
        for load_node in load_nodes:
            if "subfolder" in workflow[load_node]["inputs"]:
                workflow[load_node]["inputs"]["subfolder"] = subfolder
            li_err = _ensure_load_image_matches_comfy(workflow, load_node, filename, subfolder)
            if li_err:
                return {"ok": False, "message": li_err, "images": [], "video": ""}
        vp = prompt or "smooth motion, cinematic"
        ep, en = enhance_for_comfy(vp, negative_prompt, mode="img2video")
        _wire_sampler_prompts(workflow, ep, en or "blurry, static, jpeg artifacts, low quality, ugly")
        ck_err = _ensure_workflow_checkpoint_from_comfy(workflow)
        if ck_err:
            return {"ok": False, "message": ck_err, "images": [], "video": ""}
        aux_err = _ensure_aux_model_loaders_from_comfy(workflow)
        if aux_err:
            return {"ok": False, "message": aux_err, "images": [], "video": ""}
        _ensure_workflow_ckpt_exists(workflow)
        q = _queue_prompt(workflow)
        if not q.get("ok"):
            return {"ok": False, "message": q.get("message", "Queue failed"), "images": [], "video": ""}
        return _poll_for_video_output(q["prompt_id"])
    return {
        "ok": False,
        "message": (
            f"No ComfyUI img2video workflow file. Add {names[0]}.json under ComfyUI/workflows "
            "(see knowledge/COMFY_VIDEO_SETUP.txt)."
        ),
        "images": [],
        "video": "",
    }
