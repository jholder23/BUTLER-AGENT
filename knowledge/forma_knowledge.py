"""
Query FORMA (SerumBoi) music knowledge base for Butler chat / SEO.

FORMA ships a compiled KB under knowledge/compiled/ plus search indexes.
Butler treats this as an extra general music/sound-design knowledge source
alongside its own KnowledgeStore RAG.
"""
from __future__ import annotations

import json
import os
import re
from functools import lru_cache
from pathlib import Path
from typing import Any

_DEFAULT_ROOTS = (
    r"D:\FORMA\knowledge",
    r"D:\SERUMBOI\FORMA\knowledge",
    r"D:\SERUMBOI\knowledge",
)


def forma_knowledge_root() -> Path | None:
    for env in ("FORMA_KNOWLEDGE_PATH", "BUTLER_FORMA_KNOWLEDGE", "TONEFORM_KNOWLEDGE_PATH"):
        raw = (os.getenv(env) or "").strip()
        if raw:
            p = Path(os.path.realpath(os.path.expanduser(raw)))
            if p.is_dir():
                return p
    for cand in _DEFAULT_ROOTS:
        p = Path(cand)
        if p.is_dir() and (p / "compiled").is_dir():
            return p
    return None


def forma_enabled() -> bool:
    if (os.getenv("BUTLER_FORMA_KNOWLEDGE") or "1").strip().lower() in ("0", "false", "no", "off"):
        return False
    return forma_knowledge_root() is not None


def _tokens(s: str) -> set[str]:
    return {t for t in re.split(r"[^\w]+", (s or "").lower()) if len(t) > 1}


def _load_json(path: Path) -> Any:
    try:
        with open(path, "r", encoding="utf-8-sig") as f:
            return json.load(f)
    except Exception:
        return None


@lru_cache(maxsize=4)
def _companion_hits(root_s: str) -> list[dict[str, Any]]:
    root = Path(root_s)
    data = _load_json(root / "compiled" / "index" / "companion-index.json")
    if not isinstance(data, dict):
        return []
    hits = data.get("hits") or []
    return [h for h in hits if isinstance(h, dict)]


@lru_cache(maxsize=4)
def _search_entries(root_s: str) -> list[dict[str, Any]]:
    root = Path(root_s)
    data = _load_json(root / "index" / "search-index.json")
    if not isinstance(data, dict):
        return []
    entries = data.get("entries") or []
    return [e for e in entries if isinstance(e, dict)]


@lru_cache(maxsize=4)
def _alias_index(root_s: str) -> dict[str, str]:
    root = Path(root_s)
    data = _load_json(root / "compiled" / "taxonomy" / "alias-index.json")
    if not isinstance(data, dict):
        return {}
    by = data.get("byAlias") or {}
    return {str(k).lower(): str(v) for k, v in by.items() if k and v}


def _score_hit(query_tokens: set[str], blob: str, extra: list[str] | None = None) -> int:
    if not query_tokens:
        return 0
    hay = _tokens(blob)
    for t in extra or []:
        hay |= _tokens(t)
    if not hay:
        return 0
    overlap = len(query_tokens & hay)
    if overlap == 0:
        return 0
    # Bonus for denser overlap
    return overlap * 10 + min(20, len(query_tokens & hay) * 2)


def _read_compiled_doc(root: Path, relative: str) -> dict[str, Any] | None:
    rel = (relative or "").replace("\\", "/").lstrip("/")
    if not rel or ".." in rel:
        return None
    path = root / rel
    if not path.is_file():
        # Try under compiled/
        alt = root / "compiled" / rel
        if alt.is_file():
            path = alt
        else:
            return None
    data = _load_json(path)
    return data if isinstance(data, dict) else None


def _format_doc(kind: str, title: str, doc: dict[str, Any], preview: str = "") -> str:
    lines = [f"FORMA {kind}: {title}"]
    summary = (
        (doc.get("summary") or doc.get("displayName") or doc.get("whenUsed") or preview or "")
        .strip()
    )
    if summary:
        # Strip wiki junk / truncate
        summary = re.sub(r"\s+", " ", summary)
        if len(summary) > 500:
            summary = summary[:497] + "..."
        lines.append(summary)
    for key, label in (
        ("soundFamilies", "Sound families"),
        ("suggestedSoundTypes", "Sound types"),
        ("curriculumFamilies", "Families"),
        ("dialHints", "Dial hints"),
        ("commonMistakes", "Common mistakes"),
        ("artistHints", "Artist hints"),
        ("sonicCues", "Sonic cues"),
        ("antiPatterns", "Anti-patterns"),
        ("aliases", "Aliases"),
    ):
        vals = doc.get(key)
        if isinstance(vals, list) and vals:
            bits = [str(v).strip() for v in vals[:8] if str(v).strip()]
            if bits:
                lines.append(f"{label}: " + "; ".join(bits))
    traits = doc.get("traits") or doc.get("signatureTraits")
    if isinstance(traits, list) and traits:
        lines.append("Traits: " + "; ".join(str(t)[:80] for t in traits[:6]))
    elif isinstance(traits, dict) and traits:
        lines.append("Traits: " + "; ".join(f"{k}={v}" for k, v in list(traits.items())[:6]))
    knobs = doc.get("knobs") or (doc.get("demoHints") or {}).get("knobs")
    if isinstance(knobs, dict) and knobs:
        lines.append("Knob hints: " + ", ".join(f"{k}={v}" for k, v in list(knobs.items())[:8]))
    return "\n".join(lines)


def _load_sound_class(root: Path, class_id: str) -> dict[str, Any] | None:
    path = root / "compiled" / "taxonomy" / "classes" / f"{class_id}.json"
    data = _load_json(path)
    return data if isinstance(data, dict) else None


def search_forma(query: str, *, n_results: int = 4) -> list[dict[str, Any]]:
    """
    Rank FORMA companion + search-index + taxonomy hits for a natural-language query.
    Returns list of {score, kind, title, content, path}.
    """
    if not forma_enabled():
        return []
    root = forma_knowledge_root()
    if not root:
        return []
    q = (query or "").strip()
    if len(q) < 2:
        return []
    qtok = _tokens(q)
    if not qtok:
        return []

    scored: list[tuple[int, dict[str, Any]]] = []
    root_s = str(root)

    # Taxonomy alias exact / partial
    aliases = _alias_index(root_s)
    q_lower = q.lower()
    matched_class = aliases.get(q_lower)
    if not matched_class:
        for alias, cid in aliases.items():
            if alias in q_lower or (len(alias) > 3 and alias in qtok):
                matched_class = cid
                break
    if matched_class:
        doc = _load_sound_class(root, matched_class)
        if doc:
            title = doc.get("displayName") or doc.get("id") or matched_class
            content = _format_doc("sound class", str(title), doc)
            scored.append(
                (
                    100,
                    {
                        "score": 100,
                        "kind": "sound_class",
                        "title": title,
                        "content": content,
                        "path": f"compiled/taxonomy/classes/{matched_class}.json",
                        "source": "forma",
                    },
                )
            )

    for hit in _companion_hits(root_s):
        title = str(hit.get("title") or hit.get("id") or "")
        tokens = hit.get("tokens") or []
        preview = str(hit.get("preview") or "")
        blob = " ".join([title, preview] + [str(t) for t in tokens])
        sc = _score_hit(qtok, blob, [str(t) for t in tokens])
        if sc <= 0:
            continue
        rel = str(hit.get("relativePath") or "")
        doc = _read_compiled_doc(root, rel) if rel else None
        kind = str(hit.get("kind") or "entry")
        if doc:
            content = _format_doc(kind, title, doc, preview)
        else:
            content = f"FORMA {kind}: {title}\n{preview[:400]}".strip()
        scored.append(
            (
                sc,
                {
                    "score": sc,
                    "kind": kind,
                    "title": title,
                    "content": content,
                    "path": rel,
                    "source": "forma",
                },
            )
        )

    for ent in _search_entries(root_s):
        title = str(ent.get("title") or ent.get("topic") or "")
        tags = ent.get("tags") or []
        preview = str(ent.get("summaryPreview") or "")
        genre = str(ent.get("genre") or "")
        blob = " ".join([title, preview, genre] + [str(t) for t in tags])
        sc = _score_hit(qtok, blob, [str(t) for t in tags] + [genre])
        if sc <= 0:
            continue
        # Prefer loading compiled if we can map id
        eid = str(ent.get("id") or "")
        kind = str(ent.get("kind") or "research")
        content = f"FORMA {kind}: {title}\n{preview[:450]}".strip()
        # Try companion-style paths from kind
        for folder in ("genres", "techniques", "artists"):
            cand = root / "compiled" / folder / f"{eid}.json"
            # ids often genre_foo_hash — try display slug from topic
            if not cand.is_file() and ent.get("topic"):
                slug = re.sub(r"[^\w]+", "_", str(ent["topic"]).lower()).strip("_")
                cand2 = root / "compiled" / folder / f"{slug}.json"
                if cand2.is_file():
                    cand = cand2
            if cand.is_file():
                doc = _load_json(cand)
                if isinstance(doc, dict):
                    content = _format_doc(kind, title, doc, preview)
                break
        scored.append(
            (
                sc + (5 if kind in ("genre", "technique", "artist") else 0),
                {
                    "score": sc,
                    "kind": kind,
                    "title": title,
                    "content": content,
                    "path": eid,
                    "source": "forma",
                },
            )
        )

    scored.sort(key=lambda x: -x[0])
    # Dedupe by title
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for sc, item in scored:
        key = (item.get("title") or "").strip().lower()
        if not key or key in seen:
            continue
        seen.add(key)
        item["score"] = sc
        out.append(item)
        if len(out) >= max(1, min(12, int(n_results))):
            break
    return out


def format_forma_context(query: str, *, max_blocks: int = 3, max_chars: int = 2200) -> str:
    """Prompt-ready block from FORMA KB (empty if nothing relevant)."""
    hits = search_forma(query, n_results=max_blocks)
    if not hits:
        return ""
    parts = []
    total = 0
    for h in hits:
        c = (h.get("content") or "").strip()
        if not c:
            continue
        if total + len(c) > max_chars and parts:
            break
        parts.append(c)
        total += len(c)
    if not parts:
        return ""
    header = (
        "[FORMA music knowledge — private; use for accurate music/sound-design answers "
        "and SEO playlist niches; do not dump paths or say you scraped a folder]:\n"
    )
    return header + "\n\n---\n\n".join(parts)


def forma_system_addendum(query: str) -> str:
    """Safe to append to chat system prompts when query looks music-related or always-on."""
    if not forma_enabled():
        return ""
    # Always try for music-ish asks; also try for general when BUTLER_FORMA_ALWAYS=1
    always = (os.getenv("BUTLER_FORMA_ALWAYS") or "0").strip().lower() in ("1", "true", "yes", "on")
    q = (query or "").lower()
    musicish = bool(
        re.search(
            r"\b(music|genre|bass|dubstep|drum|dnb|techno|house|synth|serum|reese|wobble|"
            r"growl|pluck|pad|lead|bpm|playlist|seo|sound\s*design|producer|ableton|"
            r"forma|sine\s*language|skrillex|neuro|riddim|garage)\b",
            q,
            re.I,
        )
    )
    if not always and not musicish:
        # Still cheap-search; if strong hit, include
        hits = search_forma(query, n_results=1)
        if not hits or hits[0].get("score", 0) < 25:
            return ""
        block = format_forma_context(query, max_blocks=2)
    else:
        block = format_forma_context(query, max_blocks=3)
    return ("\n\n" + block) if block else ""


def similar_artists_for_genres(genres: list[str], *, limit: int = 12) -> list[str]:
    """Pull artist names from FORMA compiled artists / search index matching genres."""
    if not forma_enabled():
        return []
    root = forma_knowledge_root()
    if not root:
        return []
    gtok = set()
    for g in genres:
        gtok |= _tokens(g)
    if not gtok:
        return []
    names: list[tuple[int, str]] = []
    artists_dir = root / "compiled" / "artists"
    if artists_dir.is_dir():
        for path in artists_dir.glob("*.json"):
            doc = _load_json(path)
            if not isinstance(doc, dict):
                continue
            name = (doc.get("displayName") or doc.get("name") or path.stem or "").strip()
            if not name or name.lower() in ("electronic body music",):
                continue
            blob = " ".join(
                [
                    name,
                    str(doc.get("summary") or ""),
                    " ".join(str(x) for x in (doc.get("genres") or [])),
                    " ".join(str(x) for x in (doc.get("tags") or [])),
                ]
            )
            sc = _score_hit(gtok, blob)
            if sc > 0:
                names.append((sc, name))
    # Fallback: search-index artist entries
    for ent in _search_entries(str(root)):
        if str(ent.get("kind") or "") != "artist":
            continue
        title = str(ent.get("title") or ent.get("topic") or "").strip()
        if not title:
            continue
        # Clean "Artist - Wikipedia"
        title = re.sub(r"\s*-\s*Wikipedia\s*$", "", title, flags=re.I).strip()
        blob = " ".join(
            [title, str(ent.get("summaryPreview") or ""), str(ent.get("genre") or "")]
            + [str(t) for t in (ent.get("tags") or [])]
        )
        sc = _score_hit(gtok, blob)
        if sc > 0:
            names.append((sc, title))
    names.sort(key=lambda x: -x[0])
    out: list[str] = []
    seen: set[str] = set()
    for _, n in names:
        key = n.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(n)
        if len(out) >= limit:
            break
    return out


def enrich_artist_project_from_forma() -> dict[str, Any]:
    """Merge FORMA-derived similar artists / genre keywords into artist_project."""
    try:
        from artist_project_helper import get_artist_project, save_artist_project
    except ImportError:
        return {"ok": False, "message": "artist_project_helper missing"}
    if not forma_enabled():
        return {"ok": False, "message": "FORMA knowledge not found"}
    p = get_artist_project()
    genres = list(p.get("genres") or []) + list(p.get("subgenres") or [])
    similar = similar_artists_for_genres(genres, limit=16)
    # Extra niches from FORMA companion genre hits
    niches = []
    root = forma_knowledge_root()
    if root:
        for hit in _companion_hits(str(root)):
            if str(hit.get("kind") or "") != "genre":
                continue
            title = str(hit.get("title") or "").strip()
            if not title:
                continue
            sc = _score_hit(_tokens(" ".join(genres)), title + " " + " ".join(hit.get("tokens") or []))
            if sc > 0:
                niches.append(title.lower())
    updates = {
        "similar_artists": similar,
        "seo_niches": niches[:12],
        "keywords": niches[:12],
        "sources": [f"forma:{root}"],
    }
    result = save_artist_project(updates)
    result["forma_similar"] = similar
    result["forma_niches"] = niches[:12]
    result["message"] = (
        f"Enriched artist project from FORMA ({len(similar)} similar artists, {len(niches[:12])} niches)"
    )
    return result


def status() -> dict[str, Any]:
    root = forma_knowledge_root()
    if not root:
        return {"ok": False, "enabled": False, "message": "FORMA knowledge folder not found"}
    return {
        "ok": True,
        "enabled": forma_enabled(),
        "root": str(root),
        "companion_hits": len(_companion_hits(str(root))),
        "search_entries": len(_search_entries(str(root))),
        "taxonomy_aliases": len(_alias_index(str(root))),
    }
