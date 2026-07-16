"""
Plan several web-search queries from natural language, then aggregate snippet context.
Used on the hot path (chat web enrichment) so the model deciphers intent instead of DDG-literal user text.
"""
from __future__ import annotations

import json
import os
import re
from typing import Any

from config import LOCAL_MODEL
from peepee_ai import chat as peepee_chat


def prepend_subject_priority_queries(user_message: str, queries: list[str], *, max_queries: int = 8) -> list[str]:
    """Prepend deterministic trusted-source queries for recognized subject areas."""
    try:
        from web_fetcher import _query_subject_source_profile, _subject_priority_queries
    except ImportError:
        return list(queries or [])[: max(1, int(max_queries) or 8)]

    profile = _query_subject_source_profile(user_message)
    seeded = _subject_priority_queries(user_message, profile, max_queries=3)
    out: list[str] = []
    seen: set[str] = set()
    for q in list(seeded) + list(queries or []):
        text = " ".join((q or "").split())[:240].strip()
        if len(text) < 10:
            continue
        key = text.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(text)
        if len(out) >= max(2, min(int(max_queries) or 8, 12)):
            break
    return out


def filter_planned_queries_for_user_message(user_message: str, queries: list[str]) -> list[str]:
    """
    Drop planner lines that drift from the user's topic (e.g. sanitizing an adult/media ask into
    unrelated words like "happy"). Uses the same token anchors as web_fetcher overlap logic.
    """
    try:
        from web_fetcher import _OVERLAP_WEAK_TOKENS, _significant_query_tokens
    except ImportError:
        return list(queries or [])

    um = (user_message or "").strip()
    if not um or not queries:
        return list(queries or [])
    utoks = _significant_query_tokens(um)
    if not utoks:
        return list(queries or [])
    low = um.lower()
    long_from_user = {w for w in re.findall(r"\b[a-z]{5,}\b", low) if w not in ("where", "which", "while", "there", "these", "those")}
    # Anchors: long words plus any non-generic token from the user (includes short domain words like porn).
    hints = long_from_user | {t for t in utoks if t not in _OVERLAP_WEAK_TOKENS}
    out: list[str] = []
    seen: set[str] = set()
    for q in queries:
        qs = (q or "").strip()
        if len(qs) < 10:
            continue
        ql = qs.lower()
        if any(h in ql for h in hints if len(h) >= 4):
            k = ql[:160]
            if k not in seen:
                seen.add(k)
                out.append(qs)
            continue
        qt = _significant_query_tokens(qs)
        if qt & utoks:
            k = ql[:160]
            if k not in seen:
                seen.add(k)
                out.append(qs)
    return out


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


def web_search_planner_enabled() -> bool:
    v = (os.environ.get("BUTLER_WEB_SEARCH_PLANNER") or "1").strip().lower()
    return v not in ("0", "false", "no", "off")


def plan_immediate_web_searches(user_message: str, *, max_queries: int = 8, openai_api_key: str = "") -> list[str]:
    """
    Return diverse DuckDuckGo-style queries inferred from the user's intent (not copy-paste of their wording).
    """
    um = (user_message or "").strip()
    if len(um) < 12:
        return []
    cap = max(2, min(int(max_queries) or 8, 12))
    sys = (
        "You are a search strategist for a private assistant (Butler). Read what the user wants—sites, products, "
        "how-tos, media, communities, comparisons—and output ONLY valid JSON: {\"queries\":[\"...\", ...]}.\n"
        f"Use {cap - 1} to {cap} strings. Each string is ONE web search phrase (max 16 words), English.\n"
        "Rules:\n"
        "- Do NOT paste the user's message verbatim as a single query unless it is already a perfect search phrase.\n"
        "- Produce varied angles: synonyms; 'best …', 'review', 'reddit', 'forum', 'alternatives to …'; "
        "when they want community picks include a phrase with site:reddit.com; when they want official sources "
        "include vendor or docs-style terms.\n"
        "- When the subject implies trusted or official sources (docs, medicine, law, finance, science, news), "
        "prefer at least one search phrase aimed at those sources first.\n"
        "- If they ask for a type of website or service, include queries that name likely categories or platforms "
        "people actually discuss—not generic encyclopedia topics.\n"
        "- Never replace the user's subject with unrelated topics (do not map media or adult discovery asks to "
        "mood words, virtues, or dictionary headwords like happy or sad unless they literally asked that).\n"
        "- Each search phrase must reuse at least one concrete noun, genre, product name, or site category from "
        "their wording—or a direct synonym people use in search (e.g. UGC for user-generated).\n"
        "- No chit-chat, no URLs inside queries, no markdown—JSON only.\n"
        "- The user message may be long and explicit—read all of it; every search phrase must reflect their actual "
        "topic, constraints, and intent (no generic tangents)."
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
        if len(q) < 10:
            continue
        k = q.lower()[:120]
        if k in seen:
            continue
        seen.add(k)
        out.append(q)
        if len(out) >= cap:
            break
    filtered = filter_planned_queries_for_user_message(um, out)
    return prepend_subject_priority_queries(um, filtered or out, max_queries=cap)


def aggregate_planned_search_snippets(queries: list[str], *, max_queries: int = 8, max_total_chars: int = 11000) -> str:
    """Run DDG snippet harvest per planned query; dedupe is light (per-block)."""
    try:
        from web_fetcher import search_web_result_snippets_block
    except ImportError:
        return ""

    chunks: list[str] = []
    budget = max_total_chars
    for i, q in enumerate((queries or [])[: max(1, int(max_queries) or 8)]):
        q = (q or "").strip()
        if not q:
            continue
        block = (search_web_result_snippets_block(q, max_results=6, max_chars=min(2600, budget)) or "").strip()
        if not block:
            continue
        header = f"[Query {i + 1}: {q[:160]}]"
        piece = f"{header}\n{block}"
        if len(piece) > budget:
            piece = piece[:budget]
        chunks.append(piece)
        budget -= len(piece) + 40
        if budget < 400:
            break
    return "\n\n---\n\n".join(chunks).strip()[:max_total_chars]
