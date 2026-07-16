#!/usr/bin/env python3
"""Remove ComfyUI preview/temp PNGs (PreviewImage writes here, not output/)."""
from __future__ import annotations

import os
import shutil
from pathlib import Path


def _comfy_root() -> Path:
    raw = (os.environ.get("SD_PROJECT_PATH") or "").strip()
    root = Path(__file__).resolve().parent.parent
    base = Path(raw) if raw else root / "sd"
    if not base.is_absolute():
        base = (root / base).resolve()
    return base / "ComfyUI"


def main() -> int:
    comfy = _comfy_root()
    dirs = [
        comfy / "temp",
        Path(os.environ.get("TEMP", "")) / "butler-comfyui" / "temp",
    ]
    removed = 0
    for d in dirs:
        if not d.is_dir():
            continue
        for p in d.rglob("*"):
            if p.is_file():
                p.unlink(missing_ok=True)
                removed += 1
        for p in sorted(d.rglob("*"), reverse=True):
            if p.is_dir():
                try:
                    p.rmdir()
                except OSError:
                    pass
    print(f"Cleared {removed} temp file(s) under ComfyUI temp dirs.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
