"""
GPU / VRAM snapshot for Butler Settings.

Probes nvidia-smi, ComfyUI /system_stats, and Ollama /api/ps.
Free actions unload Comfy models and stop Ollama-resident models.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import urllib.error
import urllib.request
from typing import Any


def _comfy_base() -> str:
    return (os.environ.get("COMFYUI_URL") or "http://127.0.0.1:8188").rstrip("/")


def _ollama_base() -> str:
    return (os.environ.get("OLLAMA_HOST") or "http://127.0.0.1:11434").rstrip("/")


def _http_json(url: str, *, method: str = "GET", body: dict | None = None, timeout: float = 8.0) -> Any:
    data = None
    headers = {"Accept": "application/json"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read().decode("utf-8", errors="replace")
        return json.loads(raw) if raw.strip() else {}


def probe_nvidia_smi() -> dict:
    """Return GPU memory + per-process usage via nvidia-smi."""
    exe = shutil.which("nvidia-smi")
    if not exe:
        return {"ok": False, "error": "nvidia-smi not found on PATH", "gpus": [], "processes": []}
    try:
        gpu_raw = subprocess.check_output(
            [
                exe,
                "--query-gpu=index,name,memory.used,memory.total,memory.free,utilization.gpu",
                "--format=csv,noheader,nounits",
            ],
            stderr=subprocess.STDOUT,
            text=True,
            timeout=8,
        )
        gpus = []
        for line in gpu_raw.strip().splitlines():
            parts = [p.strip() for p in line.split(",")]
            if len(parts) < 6:
                continue
            gpus.append(
                {
                    "index": int(parts[0]) if parts[0].isdigit() else parts[0],
                    "name": parts[1],
                    "memory_used_mb": _num(parts[2]),
                    "memory_total_mb": _num(parts[3]),
                    "memory_free_mb": _num(parts[4]),
                    "utilization_pct": _num(parts[5]),
                }
            )
    except Exception as e:
        return {"ok": False, "error": f"nvidia-smi gpu query failed: {e}", "gpus": [], "processes": []}

    processes: list[dict] = []
    try:
        proc_raw = subprocess.check_output(
            [
                exe,
                "--query-compute-apps=pid,process_name,used_gpu_memory",
                "--format=csv,noheader,nounits",
            ],
            stderr=subprocess.STDOUT,
            text=True,
            timeout=8,
        )
        for line in proc_raw.strip().splitlines():
            parts = [p.strip() for p in line.split(",")]
            if len(parts) < 3:
                continue
            mem = parts[2]
            # Skip Windows desktop noise that reports [N/A]
            if mem.upper() in ("[N/A]", "N/A", ""):
                continue
            processes.append(
                {
                    "pid": int(parts[0]) if parts[0].isdigit() else parts[0],
                    "name": parts[1],
                    "memory_mb": _num(mem),
                    "kind": _classify_process(parts[1]),
                }
            )
    except Exception:
        pass

    processes.sort(key=lambda p: float(p.get("memory_mb") or 0), reverse=True)
    return {"ok": True, "gpus": gpus, "processes": processes}


def _num(v: str) -> float | None:
    try:
        return float(str(v).strip().replace(" MiB", "").replace("MB", ""))
    except Exception:
        return None


def _classify_process(name: str) -> str:
    n = (name or "").lower().replace("\\", "/")
    if "ollama" in n:
        return "ollama"
    if "comfy" in n or ("python" in n and "comfyui" in n):
        return "comfy"
    if "butler" in n:
        return "butler"
    if "python" in n:
        return "python"
    if "cursor" in n or "code.exe" in n:
        return "editor"
    return "other"


def probe_comfy() -> dict:
    base = _comfy_base()
    try:
        data = _http_json(f"{base}/system_stats", timeout=5.0)
        devices = data.get("devices") if isinstance(data, dict) else None
        out_devices = []
        if isinstance(devices, list):
            for d in devices:
                if not isinstance(d, dict):
                    continue
                out_devices.append(
                    {
                        "name": d.get("name"),
                        "vram_total": d.get("vram_total"),
                        "vram_free": d.get("vram_free"),
                        "torch_vram_total": d.get("torch_vram_total"),
                        "torch_vram_free": d.get("torch_vram_free"),
                    }
                )
        return {"ok": True, "url": base, "devices": out_devices, "system": data.get("system") if isinstance(data, dict) else None}
    except Exception as e:
        return {"ok": False, "url": base, "error": str(e), "devices": []}


def probe_ollama() -> dict:
    base = _ollama_base()
    try:
        data = _http_json(f"{base}/api/ps", timeout=5.0)
        models = data.get("models") if isinstance(data, dict) else []
        loaded = []
        if isinstance(models, list):
            for m in models:
                if not isinstance(m, dict):
                    continue
                loaded.append(
                    {
                        "name": m.get("name") or m.get("model"),
                        "size": m.get("size"),
                        "size_vram": m.get("size_vram"),
                        "details": m.get("details"),
                    }
                )
        return {"ok": True, "url": base, "models": loaded}
    except Exception as e:
        return {"ok": False, "url": base, "error": str(e), "models": []}


def build_vram_snapshot() -> dict:
    nvidia = probe_nvidia_smi()
    comfy = probe_comfy()
    ollama = probe_ollama()
    tips = []
    if ollama.get("ok") and ollama.get("models"):
        tips.append(
            f"Ollama has {len(ollama['models'])} model(s) resident — unload before heavy FaceID/ReActor runs."
        )
    if comfy.get("ok"):
        for d in comfy.get("devices") or []:
            free = d.get("torch_vram_free")
            total = d.get("torch_vram_total")
            if isinstance(free, (int, float)) and isinstance(total, (int, float)) and total > 0:
                if free / total < 0.15:
                    tips.append("Comfy torch VRAM is nearly full — Free Comfy VRAM before the next img2img.")
    if not tips and nvidia.get("ok"):
        tips.append("GPU looks relatively free. FaceID+ReActor can still spike hard on a 12GB card during ONNX load.")
    return {
        "ok": True,
        "nvidia": nvidia,
        "comfy": comfy,
        "ollama": ollama,
        "tips": tips,
        "comfy_url": _comfy_base(),
        "ollama_url": _ollama_base(),
    }


def free_comfy_vram() -> dict:
    base = _comfy_base()
    try:
        _http_json(
            f"{base}/free",
            method="POST",
            body={"unload_models": True, "free_memory": True},
            timeout=20.0,
        )
        return {"ok": True, "message": f"Asked Comfy at {base} to unload models and free memory."}
    except Exception as e:
        return {"ok": False, "message": f"Comfy free failed ({base}): {e}"}


def unload_ollama_models() -> dict:
    base = _ollama_base()
    try:
        data = _http_json(f"{base}/api/ps", timeout=5.0)
    except Exception as e:
        return {"ok": False, "message": f"Ollama not reachable ({base}): {e}", "unloaded": []}
    models = data.get("models") if isinstance(data, dict) else []
    if not isinstance(models, list) or not models:
        return {"ok": True, "message": "No Ollama models currently loaded in VRAM.", "unloaded": []}
    unloaded: list[str] = []
    errors: list[str] = []
    for m in models:
        if not isinstance(m, dict):
            continue
        name = str(m.get("name") or m.get("model") or "").strip()
        if not name:
            continue
        try:
            # keep_alive=0 forces unload of the resident weights.
            _http_json(
                f"{base}/api/generate",
                method="POST",
                body={"model": name, "prompt": "", "keep_alive": 0},
                timeout=30.0,
            )
            unloaded.append(name)
        except Exception as e:
            errors.append(f"{name}: {e}")
    ok = not errors
    msg = (
        ("Unloaded: " + ", ".join(unloaded)) if unloaded else "No models unloaded"
    )
    if errors:
        msg += " · errors: " + "; ".join(errors[:3])
    return {"ok": ok, "message": msg, "unloaded": unloaded, "errors": errors}


def free_vram(targets: list[str] | None = None) -> dict:
    want = {str(t).strip().lower() for t in (targets or ["comfy", "ollama"]) if str(t).strip()}
    if "all" in want:
        want = {"comfy", "ollama"}
    results = []
    if "comfy" in want:
        results.append({"target": "comfy", **free_comfy_vram()})
    if "ollama" in want:
        results.append({"target": "ollama", **unload_ollama_models()})
    ok = all(r.get("ok") for r in results) if results else False
    snapshot = build_vram_snapshot()
    return {
        "ok": ok,
        "results": results,
        "message": " · ".join(str(r.get("message") or "") for r in results),
        "snapshot": snapshot,
    }
