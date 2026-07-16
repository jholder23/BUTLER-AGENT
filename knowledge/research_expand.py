"""
Expand a user question into many web-search phrases for background ingestion.
Runs on the local LLM only (no cloud); used when the user asks for information / overview / research.
"""
from __future__ import annotations

import json
import os
import re
from typing import Any

from config import LOCAL_MODEL
from peepee_ai import chat as peepee_chat


def _extract_json_object(text: str) -> dict[str, Any] | None:
    raw = (text or "").strip()
    if not raw:
        return None
    raw = re.sub(r"^```(?:json)?\s*", "", raw, flags=re.I)
    raw = re.sub(r"\s*```\s*$", "", raw)
    start = raw.find("{")
    if start < 0:
        return None
    depth = 0
    for i, c in enumerate(raw[start:], start):
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(raw[start : i + 1])
                except json.JSONDecodeError:
                    return None
    return None


def expand_background_research_queries(
    user_message: str,
    *,
    max_queries: int = 12,
    openai_api_key: str = "",
) -> list[str]:
    """
    Return short DuckDuckGo-style queries: main topic + closely related concepts
    (categories, comparisons, policy, chemistry, history—whatever fits the subject).
    """
    um = (user_message or "").strip()
    if len(um) < 16:
        return []
    cap = max(6, min(int(max_queries) or 12, 18))
    sys = (
        "You generate web search queries for a private, local-only knowledge base (Butler). "
        f"Return ONLY valid JSON: an object with key \"queries\" whose value is an array of {cap - 2} to {cap} strings. "
        "Each string is one English search phrase (max 18 words), neutral and factual—no URLs, no markdown, no prose outside JSON. "
        "Cover: the user's core subject; closely related entities and categories; important comparisons or adjacent topics "
        "someone researching seriously would look up. "
        "If the subject is a drug, medicine, or controlled substance, include lawful angles: pharmacology, public health, "
        "legal status by jurisdiction where relevant, harm reduction, and major related substances analysts often group together—"
        "still short search phrases only."
    )
    messages = [
        {"role": "system", "content": sys},
        {"role": "user", "content": um[:10000]},
    ]
    try:
        r = peepee_chat(messages=messages, model=LOCAL_MODEL, openai_api_key=openai_api_key or "")
        raw = ((r.get("message") or {}).get("content") or "").strip()
    except Exception:
        return []
    obj = _extract_json_object(raw)
    if not isinstance(obj, dict):
        return []
    arr = obj.get("queries")
    if not isinstance(arr, list):
        return []
    out: list[str] = []
    seen: set[str] = set()
    for item in arr:
        if not isinstance(item, str):
            continue
        q = " ".join(item.split())[:240]
        if len(q) < 14:
            continue
        k = q.lower()[:120]
        if k in seen:
            continue
        seen.add(k)
        out.append(q)
        if len(out) >= cap:
            break
    return out


def deep_background_research_enabled() -> bool:
    v = (os.environ.get("BUTLER_DEEP_BACKGROUND_RESEARCH") or "1").strip().lower()
    return v not in ("0", "false", "no", "off")
