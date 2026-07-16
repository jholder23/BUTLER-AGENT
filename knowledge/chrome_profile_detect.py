"""
Find Chrome profile folder name(s) under User Data that reference a given Google email.

Scans each profile's Preferences JSON (as text) and profile.info_cache in Local State.
Used for Facebook Marketplace + Playwright --profile-directory=...
"""
from __future__ import annotations

import json
import os
from pathlib import Path


def default_chrome_user_data_dir() -> str:
    if os.name == "nt":
        return os.path.join(os.environ.get("LOCALAPPDATA", ""), "Google", "Chrome", "User Data")
    return str(Path.home() / ".config" / "google-chrome")


def _profile_folder_candidates(user_data_root: str) -> list[str]:
    if not os.path.isdir(user_data_root):
        return []
    skip = {"System Profile", "Crash Reports", "ShaderCache", "GrShaderCache", "GraphiteDawnCache", "Safe Browsing"}
    out: list[str] = []
    for name in os.listdir(user_data_root):
        if name in skip or name.startswith("."):
            continue
        path = os.path.join(user_data_root, name)
        if not os.path.isdir(path):
            continue
        if os.path.isfile(os.path.join(path, "Preferences")):
            out.append(name)
    return sorted(out, key=lambda x: (0 if x == "Default" else 1, x.lower()))


def detect_chrome_profiles_for_email(
    email: str,
    user_data_root: str | None = None,
) -> list[dict]:
    """
    Return [{"profile_directory": "Default", "user_data_dir": "..."}, ...] for profiles
    whose Preferences or Local State info_cache mention this email (case-insensitive).
    """
    needle = (email or "").strip().lower()
    if not needle:
        return []

    root = (user_data_root or "").strip() or default_chrome_user_data_dir()
    if not os.path.isdir(root):
        return []

    matched: set[str] = set()

    for folder in _profile_folder_candidates(root):
        pref_path = os.path.join(root, folder, "Preferences")
        try:
            with open(pref_path, encoding="utf-8", errors="ignore") as f:
                blob = f.read()
            if needle in blob.lower():
                matched.add(folder)
        except OSError:
            continue

    local_state = os.path.join(root, "Local State")
    if os.path.isfile(local_state):
        try:
            with open(local_state, encoding="utf-8") as f:
                st = json.load(f)
            ic = (st.get("profile") or {}).get("info_cache") or {}
            for folder, info in ic.items():
                if not isinstance(info, dict):
                    continue
                try:
                    if needle in json.dumps(info).lower():
                        if os.path.isfile(os.path.join(root, folder, "Preferences")):
                            matched.add(folder)
                except Exception:
                    continue
        except Exception:
            pass

    ordered = [f for f in _profile_folder_candidates(root) if f in matched]
    return [{"profile_directory": f, "user_data_dir": root} for f in ordered]


def pick_best_chrome_profile(matches: list[dict]) -> dict | None:
    if not matches:
        return None
    for m in matches:
        if m.get("profile_directory") == "Default":
            return m
    return matches[0]
