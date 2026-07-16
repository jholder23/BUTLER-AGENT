#!/usr/bin/env python3
"""Install ButlerEasyPrompt + native Base64 preset UI into ComfyUI custom_nodes."""
from __future__ import annotations
import shutil, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "knowledge" / "butler_simple_ui"
DEST = ROOT / "sd" / "ComfyUI" / "custom_nodes" / "butler_simple_ui"
def main() -> int:
    if not (SRC / "__init__.py").is_file():
        print("missing", SRC, file=sys.stderr); return 1
    shutil.copytree(SRC, DEST, dirs_exist_ok=True)
    print("Installed ButlerEasyPrompt + Base64 preset UI ->", DEST)
    print("RESTART ComfyUI, then load: img2img_juggernaut_faceid_easy_nsfw")
    return 0
if __name__ == "__main__":
    raise SystemExit(main())
