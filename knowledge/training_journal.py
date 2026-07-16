"""
Append-only training log + helpers for Butler self-learning (RAG reinforcement, future LoRA/export).

Default log: Documents/Butlor/butler_training.jsonl (override with BUTLER_TRAINING_LOG).
"""
from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path
from typing import Any

from butlor_paths import get_training_log_path as _training_log_path

_write_lock = threading.Lock()

_MAX_CHAT_CHARS = 12000
_MAX_INTENT_USER = 2000


def get_training_log_path() -> Path:
    return _training_log_path()


def _truncate(s: str, max_len: int) -> str:
    s = (s or "").strip()
    if len(s) <= max_len:
        return s
    return s[: max_len - 20] + "\n…[truncated]"


def append_entry(entry: dict[str, Any]) -> None:
    """Append one JSON object as a line (thread-safe). Fails silently if disk errors."""
    if os.environ.get("BUTLER_HEAVY_LEARNING", "1").strip().lower() in ("0", "false", "no", "off"):
        return
    try:
        row = {"ts": time.time(), **entry}
        line = json.dumps(row, ensure_ascii=False) + "\n"
        path = get_training_log_path()
        with _write_lock:
            with open(path, "a", encoding="utf-8") as f:
                f.write(line)
    except OSError:
        pass


def record_chat_turn(*, topic: str, source: str, content: str) -> None:
    append_entry(
        {
            "kind": "chat_turn",
            "topic": (topic or "conversation")[:120],
            "source": (source or "chat")[:200],
            "content": _truncate(content, _MAX_CHAT_CHARS),
        }
    )


def record_intent(*, user_message: str, mode: str, params: dict | None) -> None:
    append_entry(
        {
            "kind": "intent",
            "user_message": _truncate(user_message, _MAX_INTENT_USER),
            "mode": (mode or "")[:120],
            "params": params if isinstance(params, dict) else {},
        }
    )


def record_activity(*, line: str, kind: str) -> None:
    append_entry(
        {
            "kind": "activity",
            "activity_kind": (kind or "activity")[:120],
            "line": _truncate(line, 8000),
        }
    )


def read_tail_jsonl(path: Path, max_lines: int = 200) -> list[dict]:
    if not path.is_file():
        return []
    try:
        raw = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    lines = raw.strip().split("\n")
    out: list[dict] = []
    for line in lines[-max_lines:]:
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return out


def journal_line_count(path: Path) -> int:
    if not path.is_file():
        return 0
    try:
        n = 0
        with open(path, "rb") as f:
            for _ in f:
                n += 1
        return n
    except OSError:
        return 0


def auto_intent_examples_path() -> Path:
    return Path(__file__).resolve().parent / "auto_intent_examples.json"


def compact_intents_to_auto_examples(max_examples: int = 40) -> int:
    """
    Promote recent intent journal rows into auto_intent_examples.json for few-shot injection.
    Runs periodically while the Knowledge API is up—no OpenAI required.
    """
    if os.environ.get("BUTLER_HEAVY_LEARNING", "1").strip().lower() in ("0", "false", "no", "off"):
        return 0
    path = get_training_log_path()
    rows = read_tail_jsonl(path, 500)
    intents = [r for r in rows if r.get("kind") == "intent" and r.get("user_message") and r.get("mode")]
    seen_keys: set[tuple[str, str]] = set()
    examples: list[dict] = []
    for r in reversed(intents):
        u = str(r.get("user_message", "")).strip()[:800]
        m = str(r.get("mode", "")).strip()[:120]
        if not u or not m:
            continue
        k = (u[:120], m)
        if k in seen_keys:
            continue
        seen_keys.add(k)
        resp: dict = {"mode": m, "reply": f"Routing: {m} (learned from your phrasing)."}
        params = r.get("params")
        if isinstance(params, dict):
            for pk in ("prompt", "description", "role", "location", "summary", "max_jobs", "auto_submit", "skills", "max_gigs"):
                pv = params.get(pk)
                if pv is not None and str(pv).strip():
                    resp[pk] = pv
        examples.append({"user": u, "response": resp})
        if len(examples) >= max_examples:
            break
    examples.reverse()
    out_path = auto_intent_examples_path()
    try:
        payload = {
            "_generated": "Butler heavy-learning compactor — refreshed from butler_training.jsonl; safe to delete to reset.",
            "examples": examples,
        }
        tmp = out_path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(out_path)
    except OSError:
        return 0
    return len(examples)
