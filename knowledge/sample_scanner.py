"""
Scan user's sample library for kicks, snares, hats, bass, etc.
Supports: Documents\\Ableton\\User Library, Music, custom paths from env.
"""
from __future__ import annotations

import os
import re
from pathlib import Path


def _default_search_paths() -> list[str]:
    """Default folders to search for samples."""
    home = Path.home()
    paths = [
        home / "Documents" / "Ableton" / "User Library",
        home / "Documents" / "Ableton" / "User Library" / "Samples",
        home / "Music" / "Ableton" / "User Library",
        home / "Music" / "Samples",
        home / "Music",
        home / "Documents",
    ]
    return [str(p) for p in paths if p.exists()]


def _categorize(filename: str) -> str | None:
    """Return category (kick, snare, hat, bass, etc.) or None."""
    lower = filename.lower()
    patterns = {
        "kick": r"\b(kick|kd|kik|bass.?drum|bd)\b",
        "snare": r"\b(snare|snr|sd|clap|rim)\b",
        "hat": r"\b(hat|hh|hi.?hat|hihat|cymbal|open.?hat|closed.?hat)\b",
        "bass": r"\b(bass|sub|808|subbass|sub.?bass)\b",
        "perc": r"\b(perc|tom|crash|ride|fx|impact)\b",
    }
    for cat, pat in patterns.items():
        if re.search(pat, lower):
            return cat
    return None


def scan_sample_library(
    search_paths: list[str] | None = None,
    extensions: tuple[str, ...] = (".wav", ".aif", ".aiff", ".mp3"),
    max_per_category: int = 20,
    extra_paths_env: str = "SAMPLE_LIBRARY_PATH",
) -> dict:
    """
    Scan folders for audio samples, categorized by filename.
    Returns: {category: [{"path": str, "name": str}, ...], "paths_searched": [...]}
    """
    paths = search_paths or _default_search_paths()

    env_paths = os.environ.get(extra_paths_env, "")
    if env_paths:
        for p in env_paths.replace(",", ";").split(";"):
            p = p.strip()
            if p and os.path.isdir(p):
                paths.insert(0, p)

    found: dict[str, list[dict]] = {
        "kick": [],
        "snare": [],
        "hat": [],
        "bass": [],
        "perc": [],
    }
    seen_paths: set[str] = set()

    for folder in paths:
        if not os.path.isdir(folder):
            continue
        try:
            for root, _, files in os.walk(folder, topdown=True):
                for f in files:
                    if not f.lower().endswith(extensions):
                        continue
                    path = os.path.normpath(os.path.join(root, f))
                    if path in seen_paths:
                        continue
                    seen_paths.add(path)
                    cat = _categorize(f)
                    if cat and cat in found and len(found[cat]) < max_per_category:
                        found[cat].append({"path": path, "name": f})
        except (PermissionError, OSError):
            continue

    return {
        "samples": found,
        "paths_searched": paths[:20],
        "total": sum(len(v) for v in found.values()),
    }
