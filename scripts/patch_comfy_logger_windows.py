"""
Harden ComfyUI app/logger.py LogInterceptor against Windows OSError Errno 22.

When the console/pipe behind stderr is detached, tqdm's KSampler progress bar
calls stderr.flush() and can abort the entire sample. Swallow write/flush OSError
so progress still lands in Comfy's in-memory log ring.
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LOGGER = ROOT / "sd" / "ComfyUI" / "app" / "logger.py"

WRITE_OLD = """    def write(self, data):
        entry = {"t": datetime.now().isoformat(), "m": data}
        with self._lock:
            self._logs_since_flush.append(entry)

            # Simple handling for cr to overwrite the last output if it isnt a full line
            # else logs just get full of progress messages
            if isinstance(data, str) and data.startswith("\\r") and not logs[-1]["m"].endswith("\\n"):
                logs.pop()
            logs.append(entry)
        super().write(data)
"""

WRITE_NEW = """    def write(self, data):
        entry = {"t": datetime.now().isoformat(), "m": data}
        with self._lock:
            self._logs_since_flush.append(entry)

            # Simple handling for cr to overwrite the last output if it isnt a full line
            # else logs just get full of progress messages
            if isinstance(data, str) and data.startswith("\\r") and not logs[-1]["m"].endswith("\\n"):
                logs.pop()
            logs.append(entry)
        try:
            super().write(data)
        except (OSError, ValueError):
            # Windows: console/pipe may return Errno 22 after detach; keep ring buffer only.
            pass
"""

FLUSH_OLD = """    def flush(self):
        super().flush()
        for cb in self._flush_callbacks:
            cb(self._logs_since_flush)
            self._logs_since_flush = []
"""

FLUSH_NEW = """    def flush(self):
        try:
            super().flush()
        except (OSError, ValueError):
            # tqdm status_printer flushes stderr on every KSampler start; a dead console
            # handle must not abort sampling (OSError: [Errno 22] Invalid argument).
            pass
        for cb in self._flush_callbacks:
            cb(self._logs_since_flush)
            self._logs_since_flush = []
"""


def already_patched(text: str) -> bool:
    return "dead console" in text and "except (OSError, ValueError):" in text


def main() -> int:
    if not LOGGER.is_file():
        print(f"ERROR: missing {LOGGER}", file=sys.stderr)
        return 1
    text = LOGGER.read_text(encoding="utf-8")
    if already_patched(text):
        print(f"Already patched: {LOGGER}")
        return 0
    # Upgrade OSError-only patch from an earlier revision of this script.
    if "dead console" in text and "except OSError:" in text:
        text = text.replace("except OSError:", "except (OSError, ValueError):")
        if already_patched(text):
            LOGGER.write_text(text, encoding="utf-8", newline="\n")
            print(f"Upgraded patch: {LOGGER}")
            return 0
    if FLUSH_OLD not in text or WRITE_OLD not in text:
        print(f"ERROR: unexpected logger.py contents at {LOGGER}", file=sys.stderr)
        return 1
    text = text.replace(WRITE_OLD, WRITE_NEW, 1).replace(FLUSH_OLD, FLUSH_NEW, 1)
    if not already_patched(text):
        print("ERROR: patch did not apply cleanly", file=sys.stderr)
        return 1
    LOGGER.write_text(text, encoding="utf-8", newline="\n")
    print(f"Patched: {LOGGER}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
