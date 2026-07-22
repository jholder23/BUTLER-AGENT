"""
Single source of truth for Butler's user data directory (BUTLOR_CONFIG, or D:\\butlor on Windows, else ~/Documents/Butlor).

Other modules should import from here instead of duplicating os.environ.get("BUTLOR_CONFIG", ...).
"""
from __future__ import annotations

import json
import os
from pathlib import Path


def _default_butlor_dir() -> str:
    if os.name == "nt":
        return r"D:\butlor"
    return str(Path.home() / "Documents" / "Butlor")


def get_butlor_config_dir() -> Path:
    """Resolved absolute path; does not create the directory."""
    raw = (os.environ.get("BUTLOR_CONFIG") or "").strip()
    if not raw:
        raw = _default_butlor_dir()
    return Path(os.path.realpath(os.path.expanduser(str(raw))))


def ensure_butlor_config_dir() -> Path:
    p = get_butlor_config_dir()
    p.mkdir(parents=True, exist_ok=True)
    return p


def get_applications_dir() -> Path:
    return ensure_butlor_config_dir() / "applications"


def get_generated_dir() -> Path:
    d = ensure_butlor_config_dir() / "generated"
    d.mkdir(parents=True, exist_ok=True)
    return d


def get_print3d_dir() -> Path:
    """STL output from Butler 3D print (Settings → Data folder); .scad only if BUTLER_PRINT3D_OUTPUT=both."""
    d = ensure_butlor_config_dir() / "print3d"
    d.mkdir(parents=True, exist_ok=True)
    return d


def get_audio_samples_dir() -> Path:
    """WAV clips from local MusicGen (text→music / SFX-style samples)."""
    d = ensure_butlor_config_dir() / "audio_samples"
    d.mkdir(parents=True, exist_ok=True)
    return d


def get_training_log_path() -> Path:
    env = (os.environ.get("BUTLER_TRAINING_LOG") or "").strip()
    if env:
        p = Path(os.path.expanduser(env))
        try:
            p.parent.mkdir(parents=True, exist_ok=True)
        except OSError:
            pass
        return p
    return ensure_butlor_config_dir() / "butler_training.jsonl"


def _count_files(d: Path) -> int:
    if not d.is_dir():
        return 0
    try:
        return sum(1 for x in d.iterdir() if x.is_file())
    except OSError:
        return 0


def summarize_data_locations() -> dict:
    """
    JSON-serializable overview for Settings UI: paths, file counts, tracker size.
    """
    root = ensure_butlor_config_dir()
    applications = root / "applications"
    generated = root / "generated"
    print3d = get_print3d_dir()
    audio_samples = get_audio_samples_dir()
    jtp = root / "job_tracker.json"
    profile_p = root / "profile.json"
    user_mem_p = root / "user_memory.json"
    codebase_map_p = root / "butler_codebase_map.json"
    comfy_p = root / "comfy_config.json"
    apt_txt = root / "apartment_listings_latest.txt"
    apt_json = root / "apartment_listings_latest.json"
    payment_p = root / "payment_config.json"
    gigs_p = root / "gigs.json"

    job_tracked = 0
    if jtp.is_file():
        try:
            job_tracked = len(json.loads(jtp.read_text(encoding="utf-8")).get("jobs") or [])
        except Exception:
            pass

    training_path = get_training_log_path()
    training_lines = 0
    if training_path.is_file():
        try:
            with training_path.open("r", encoding="utf-8", errors="replace") as f:
                training_lines = sum(1 for _ in f)
        except OSError:
            pass

    env_override = (os.environ.get("BUTLOR_CONFIG") or "").strip() or None

    locations: list[dict] = [
        {
            "id": "root",
            "label": "Butler data folder",
            "detail": "Default: D:\\butlor on Windows, else ~/Documents/Butlor. Override with BUTLOR_CONFIG in .env.",
            "path": str(root),
            "kind": "folder",
            "count": _count_files(root),
            "count_label": "files in root",
        },
        {
            "id": "applications",
            "label": "Job application materials",
            "detail": "Tailored resumes & cover letters per posting (from job search / auto-apply).",
            "path": str(applications),
            "kind": "folder",
            "count": _count_files(applications),
            "count_label": "files",
        },
        {
            "id": "generated",
            "label": "Generated images & videos (disk)",
            "detail": "Copies saved from Stable Diffusion / Comfy workflows.",
            "path": str(generated),
            "kind": "folder",
            "count": _count_files(generated),
            "count_label": "files",
        },
        {
            "id": "print3d",
            "label": "3D print (STL)",
            "detail": "STL from chat (print3d) or API. Optional BUTLER_PRINT3D_OUTPUT=both also saves .scad.",
            "path": str(print3d),
            "kind": "folder",
            "count": _count_files(print3d),
            "count_label": "files",
        },
        {
            "id": "audio_samples",
            "label": "Audio samples (MusicGen)",
            "detail": "Free local text→music WAVs (sound_musicgen). Optional: pip install -r knowledge/requirements-audio.txt.",
            "path": str(audio_samples),
            "kind": "folder",
            "count": _count_files(audio_samples),
            "count_label": "files",
        },
        {
            "id": "profile",
            "label": "profile.json",
            "detail": "Résumé HTML/text, name, email, optional Indeed/Facebook fields.",
            "path": str(profile_p),
            "kind": "file",
            "count": 1 if profile_p.is_file() else 0,
            "count_label": "present",
        },
        {
            "id": "users",
            "label": "users/",
            "detail": "Per-person profiles Butler remembers from voice/chat introductions (name-based recognition).",
            "path": str(root / "users"),
            "kind": "folder",
            "count": _count_files(root / "users"),
            "count_label": "user profiles",
        },
        {
            "id": "user_memory",
            "label": "user_memory.json",
            "detail": "Personal facts Butler remembers from chat (name, pets, likes, people).",
            "path": str(user_mem_p),
            "kind": "file",
            "count": 1 if user_mem_p.is_file() else 0,
            "count_label": "present",
        },
        {
            "id": "butler_codebase_map",
            "label": "butler_codebase_map.json",
              "detail": "Durable Self-edit codebase map (+ butler_codebase_rag.jsonl). Loads first on Self-edit asks; incremental mtime refresh when files change; full rebuild via Settings → Refresh index or after Accept of many files. Max age: BUTLER_CODEBASE_INDEX_MAX_AGE_DAYS (default 7).",
            "path": str(codebase_map_p),
            "kind": "file",
            "count": 1 if codebase_map_p.is_file() else 0,
            "count_label": "present",
        },
        {
            "id": "job_tracker",
            "label": "job_tracker.json",
            "detail": "Tracked applications and interview notes.",
            "path": str(jtp),
            "kind": "file",
            "count": job_tracked,
            "count_label": "tracked jobs",
        },
        {
            "id": "training_log",
            "label": "butler_training.jsonl",
            "detail": "Append-only learning log (unless BUTLER_TRAINING_LOG points elsewhere).",
            "path": str(training_path),
            "kind": "file",
            "count": training_lines,
            "count_label": "lines",
        },
        {
            "id": "apartments",
            "label": "Apartment search outputs",
            "detail": "apartment_config.json, apartment_listings_latest.txt/.json, dated runs.",
            "path": str(root),
            "kind": "folder",
            "count": (1 if apt_txt.is_file() else 0) + (1 if apt_json.is_file() else 0),
            "count_label": "latest listing files",
        },
        {
            "id": "comfy_config",
            "label": "comfy_config.json",
            "detail": "ComfyUI workflow preferences.",
            "path": str(comfy_p),
            "kind": "file",
            "count": 1 if comfy_p.is_file() else 0,
            "count_label": "present",
        },
        {
            "id": "gmail",
            "label": "Gmail API (optional)",
            "detail": "gmail_credentials.json, gmail_token.json for job-email features.",
            "path": str(root),
            "kind": "folder",
            "count": (1 if (root / "gmail_credentials.json").is_file() else 0)
            + (1 if (root / "gmail_token.json").is_file() else 0),
            "count_label": "credential files",
        },
        {
            "id": "spotify",
            "label": "Spotify SEO playlists (optional)",
            "detail": "spotify_token.json, spotify_seo_config.json, spotify_seo_playlists.json, artist_project.json",
            "path": str(root),
            "kind": "folder",
            "count": sum(
                1
                for p in (
                    root / "spotify_token.json",
                    root / "spotify_seo_config.json",
                    root / "spotify_seo_playlists.json",
                    root / "artist_project.json",
                )
                if p.is_file()
            ),
            "count_label": "config files",
        },
        {
            "id": "gigs",
            "label": "Gigs / payment (optional)",
            "detail": "gigs.json, money_strategies.json, payment_config.json",
            "path": str(root),
            "kind": "folder",
            "count": sum(1 for p in (gigs_p, payment_p, root / "money_strategies.json") if p.is_file()),
            "count_label": "config files",
        },
    ]

    return {
        "ok": True,
        "root": str(root),
        "butlor_config_env": env_override,
        "locations": locations,
    }
