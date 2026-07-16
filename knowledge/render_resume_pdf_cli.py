"""
stdin: UTF-8 JSON {"html": "...", "style_id": "standard"|"accent"}
stdout: raw PDF bytes
stderr: error message (exit 1)
"""
from __future__ import annotations

import json
import sys

from job_helper import render_resume_html_to_pdf_bytes


def main() -> None:
    raw = sys.stdin.buffer.read()
    data = json.loads(raw.decode("utf-8"))
    html = data.get("html") or ""
    style_id = data.get("style_id") or "standard"
    pdf, err = render_resume_html_to_pdf_bytes(html, None, style_id)
    if err:
        sys.stderr.write(err)
        sys.exit(1)
    sys.stdout.buffer.write(pdf)


if __name__ == "__main__":
    main()
