"""
Artist project profile for Butler.

Single source of truth for the user's music artist identity — used by Spotify SEO
playlists, chat context, and CLI. Combines hand-edited facts with optional sync from
Spotify artist pages and local Ableton project index signals.
"""
from __future__ import annotations

import csv
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from butlor_paths import ensure_butlor_config_dir

_MAX_BLOCK_CHARS = 2800

_EMPTY: dict[str, Any] = {
    "artist_name": "",
    "aliases": [],
    "spotify_artist_ids": [],
    "spotify_urls": [],
    "bio": "",
    "tagline": "",
    "location": "",
    "genres": [],
    "subgenres": [],
    "moods": [],
    "bpm_ranges": [],
    "themes": [],
    "keywords": [],
    "seo_niches": [],
    "similar_artists": [],
    "target_audience": "",
    "cities": [],
    "collaborators": [],
    "releases": [],
    "track_uris": [],
    "track_titles": [],
    "project_roots": [],
    "ableton_signals": [],
    "brand_voice": "",
    "do_not_associate": [],
    "notes": "",
    "sources": [],
    "updated": None,
}


def artist_project_path() -> Path:
    return ensure_butlor_config_dir() / "artist_project.json"


def _default_ableton_index() -> Path:
    env = (os.getenv("BUTLER_ABLETON_INDEX") or "").strip()
    if env:
        return Path(env)
    # Repo-relative when running from knowledge/
    here = Path(__file__).resolve().parent.parent
    return here / "tools" / "ableton_project_index.csv"


def _load_json(path: Path, default: Any) -> Any:
    if not path.is_file():
        return default
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if data is not None else default
    except Exception:
        return default


def _save_json(path: Path, data: Any) -> None:
    ensure_butlor_config_dir()
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


def _split_list(v: Any) -> list[str]:
    if v is None:
        return []
    if isinstance(v, list):
        out = []
        for x in v:
            s = str(x).strip()
            if s and s not in out:
                out.append(s)
        return out
    if isinstance(v, str):
        return [x.strip() for x in re.split(r"[,;\n]+", v) if x.strip()]
    return []


def _merge_unique(base: list[str], extra: list[str], *, cap: int = 80) -> list[str]:
    seen = {x.lower() for x in base}
    out = list(base)
    for x in extra:
        s = (x or "").strip()
        if not s or s.lower() in seen:
            continue
        seen.add(s.lower())
        out.append(s)
        if len(out) >= cap:
            break
    return out


def get_artist_project() -> dict[str, Any]:
    data = _load_json(artist_project_path(), None)
    if not isinstance(data, dict):
        data = {}
    out = dict(_EMPTY)
    out.update({k: v for k, v in data.items() if k in _EMPTY or k in ("updated", "sources")})
    for key, default in _EMPTY.items():
        if key not in out or out[key] is None:
            out[key] = default if not isinstance(default, list) else []
        elif isinstance(default, list) and not isinstance(out[key], list):
            out[key] = _split_list(out[key])
    return out


def artist_project_has_content(project: dict[str, Any] | None = None) -> bool:
    p = project if isinstance(project, dict) else get_artist_project()
    if (p.get("artist_name") or p.get("bio") or p.get("tagline") or p.get("target_audience") or "").strip():
        return True
    for key in (
        "aliases",
        "genres",
        "subgenres",
        "moods",
        "keywords",
        "seo_niches",
        "similar_artists",
        "track_uris",
        "track_titles",
        "releases",
        "spotify_artist_ids",
        "collaborators",
        "ableton_signals",
    ):
        if p.get(key):
            return True
    return False


def save_artist_project(updates: dict[str, Any] | None = None, *, replace: bool = False) -> dict:
    """Merge updates into artist_project.json (or replace entirely)."""
    cur = {} if replace else get_artist_project()
    updates = updates or {}
    list_keys = {
        "aliases",
        "spotify_artist_ids",
        "spotify_urls",
        "genres",
        "subgenres",
        "moods",
        "bpm_ranges",
        "themes",
        "keywords",
        "seo_niches",
        "similar_artists",
        "cities",
        "collaborators",
        "releases",
        "track_uris",
        "track_titles",
        "project_roots",
        "ableton_signals",
        "do_not_associate",
        "sources",
    }
    for k, v in updates.items():
        if v is None:
            continue
        if k in list_keys:
            incoming = _split_list(v)
            if replace or updates.get("_replace_lists"):
                cur[k] = incoming
            else:
                cur[k] = _merge_unique(_split_list(cur.get(k)), incoming)
        elif k in _EMPTY or k in ("updated", "sources"):
            cur[k] = v
    # Normalize Spotify IDs from URLs
    ids = []
    for raw in _split_list(cur.get("spotify_artist_ids")):
        m = re.search(r"open\.spotify\.com/artist/([A-Za-z0-9]+)", raw)
        if m:
            ids.append(m.group(1))
        elif re.fullmatch(r"[A-Za-z0-9]{22}", raw):
            ids.append(raw)
        elif raw.startswith("spotify:artist:"):
            ids.append(raw.split(":")[-1])
        else:
            ids.append(raw)
    cur["spotify_artist_ids"] = _merge_unique([], ids, cap=20)
    cur["updated"] = datetime.now(timezone.utc).isoformat()
    _save_json(artist_project_path(), cur)
    # Keep spotify_seo_config in sync for playlist CRUD
    try:
        _push_to_spotify_seo_config(cur)
    except Exception:
        pass
    return {"ok": True, "project": cur, "message": "Artist project saved", "path": str(artist_project_path())}


def _push_to_spotify_seo_config(project: dict[str, Any]) -> None:
    from spotify_helper import save_config

    save_config(
        artist_name=(project.get("artist_name") or "").strip() or None,
        artist_ids=project.get("spotify_artist_ids") or None,
        track_uris=project.get("track_uris") or None,
        genres=_merge_unique(
            _split_list(project.get("genres")),
            _split_list(project.get("subgenres")),
            cap=24,
        )
        or None,
        keywords=_merge_unique(
            _split_list(project.get("keywords")),
            _split_list(project.get("seo_niches")),
            cap=40,
        )
        or None,
    )


def seo_context(project: dict[str, Any] | None = None) -> dict[str, Any]:
    """Flattened context for playlist title/description/niche selection."""
    p = project if isinstance(project, dict) else get_artist_project()
    genres = _split_list(p.get("genres"))
    sub = _split_list(p.get("subgenres"))
    moods = _split_list(p.get("moods"))
    niches = _split_list(p.get("seo_niches"))
    keywords = _split_list(p.get("keywords"))
    # Auto niches from genre × mood if none set
    if not niches:
        for g in (genres + sub)[:6]:
            niches.append(g)
            for m in moods[:3]:
                niches.append(f"{m} {g}")
        niches = _merge_unique([], niches, cap=16)
    kw = _merge_unique(keywords, niches + moods + genres + sub, cap=40)
    similar = _split_list(p.get("similar_artists"))
    bpm = _split_list(p.get("bpm_ranges"))
    return {
        "artist_name": (p.get("artist_name") or "").strip(),
        "aliases": _split_list(p.get("aliases")),
        "bio": (p.get("bio") or "").strip(),
        "tagline": (p.get("tagline") or "").strip(),
        "genres": genres,
        "subgenres": sub,
        "moods": moods,
        "keywords": kw,
        "seo_niches": niches,
        "similar_artists": similar,
        "target_audience": (p.get("target_audience") or "").strip(),
        "bpm_ranges": bpm,
        "themes": _split_list(p.get("themes")),
        "collaborators": _split_list(p.get("collaborators")),
        "track_uris": _split_list(p.get("track_uris")),
        "track_titles": _split_list(p.get("track_titles")),
        "spotify_artist_ids": _split_list(p.get("spotify_artist_ids")),
        "brand_voice": (p.get("brand_voice") or "").strip(),
        "do_not_associate": _split_list(p.get("do_not_associate")),
        "cities": _split_list(p.get("cities")),
        "location": (p.get("location") or "").strip(),
    }


def format_artist_project_block(
    project: dict[str, Any] | None = None,
    *,
    max_chars: int = _MAX_BLOCK_CHARS,
) -> str:
    """System-prompt block so Butler 'knows' the artist project."""
    p = project if isinstance(project, dict) else get_artist_project()
    if not artist_project_has_content(p):
        return ""
    lines: list[str] = []
    name = (p.get("artist_name") or "").strip()
    if name:
        lines.append(f"- Artist / project name: {name}")
    aliases = _split_list(p.get("aliases"))
    if aliases:
        lines.append("- Aliases: " + ", ".join(aliases[:8]))
    if (p.get("tagline") or "").strip():
        lines.append(f"- Tagline: {p['tagline'].strip()}")
    if (p.get("bio") or "").strip():
        bio = p["bio"].strip()
        if len(bio) > 420:
            bio = bio[:417] + "..."
        lines.append(f"- Bio: {bio}")
    if (p.get("location") or "").strip():
        lines.append(f"- Based in: {p['location'].strip()}")
    cities = _split_list(p.get("cities"))
    if cities:
        lines.append("- Scenes / cities: " + ", ".join(cities[:8]))
    genres = _split_list(p.get("genres"))
    sub = _split_list(p.get("subgenres"))
    if genres or sub:
        lines.append("- Genres: " + ", ".join((genres + sub)[:12]))
    moods = _split_list(p.get("moods"))
    if moods:
        lines.append("- Moods / energy: " + ", ".join(moods[:10]))
    bpm = _split_list(p.get("bpm_ranges"))
    if bpm:
        lines.append("- BPM ranges: " + ", ".join(bpm[:6]))
    themes = _split_list(p.get("themes"))
    if themes:
        lines.append("- Themes: " + ", ".join(themes[:8]))
    niches = _split_list(p.get("seo_niches"))
    keywords = _split_list(p.get("keywords"))
    if niches:
        lines.append("- SEO playlist niches: " + ", ".join(niches[:12]))
    if keywords:
        lines.append("- SEO keywords: " + ", ".join(keywords[:16]))
    similar = _split_list(p.get("similar_artists"))
    if similar:
        lines.append("- Similar / adjacent artists: " + ", ".join(similar[:12]))
    collab = _split_list(p.get("collaborators"))
    if collab:
        lines.append("- Collaborators: " + ", ".join(collab[:10]))
    if (p.get("target_audience") or "").strip():
        lines.append(f"- Target listeners: {p['target_audience'].strip()}")
    if (p.get("brand_voice") or "").strip():
        lines.append(f"- Brand voice: {p['brand_voice'].strip()}")
    titles = _split_list(p.get("track_titles"))
    if titles:
        lines.append("- Known tracks: " + ", ".join(titles[:16]))
    releases = p.get("releases") or []
    if isinstance(releases, list) and releases:
        bits = []
        for r in releases[:8]:
            if isinstance(r, dict):
                bits.append(str(r.get("title") or r.get("name") or r).strip())
            else:
                bits.append(str(r).strip())
        bits = [b for b in bits if b]
        if bits:
            lines.append("- Releases: " + "; ".join(bits))
    ids = _split_list(p.get("spotify_artist_ids"))
    if ids:
        lines.append("- Spotify artist IDs: " + ", ".join(ids[:4]))
    avoid = _split_list(p.get("do_not_associate"))
    if avoid:
        lines.append("- Do NOT associate with: " + ", ".join(avoid[:8]))
    if (p.get("notes") or "").strip():
        notes = p["notes"].strip()
        if len(notes) > 240:
            notes = notes[:237] + "..."
        lines.append(f"- Notes: {notes}")
    signals = _split_list(p.get("ableton_signals"))
    if signals:
        lines.append("- Local Ableton project signals: " + ", ".join(signals[:10]))
    if not lines:
        return ""
    body = "\n".join(lines)
    header = (
        "[Artist project — private; use for accurate Spotify SEO playlists & music talk]:\n"
        "This is the user's music artist identity. When creating or maintaining SEO playlists, "
        "match niches/keywords/moods/similar artists to THIS project. Prefer their real genres, "
        "BPM, collaborators, and track titles over generic guesses. Never invent a different artist brand.\n"
    )
    block = header + body
    if len(block) > max_chars:
        block = block[: max_chars - 3] + "..."
    return "\n\n" + block


def artist_project_system_addendum() -> str:
    try:
        return format_artist_project_block()
    except Exception:
        return ""


# --- Ableton index inference ---


_GENRE_HINTS: list[tuple[re.Pattern[str], list[str], list[str]]] = [
    (re.compile(r"dubstep|wub|bass.?music|riddim", re.I), ["dubstep", "bass music"], ["dark bass", "festival bass"]),
    (re.compile(r"\b174\b|drum.?and.?bass|dnb|neuro|liquid", re.I), ["drum and bass"], ["liquid dnb", "neurofunk"]),
    (re.compile(r"\bdub\b|reggae|steppers", re.I), ["dub"], ["dub techno", "roots dub"]),
    (re.compile(r"house|techno|garage", re.I), ["electronic"], ["club"]),
    (re.compile(r"trap|phonk", re.I), ["trap"], ["dark"]),
]


def infer_from_ableton_index(
    index_path: Path | None = None,
    *,
    apply: bool = True,
    max_rows: int = 200,
) -> dict:
    """
    Scan tools/ableton_project_index.csv for artist name, collaborators, genre hints,
    and project roots. Merges into artist_project when apply=True.
    """
    path = index_path or _default_ableton_index()
    if not path.is_file():
        return {"ok": False, "message": f"Ableton index not found: {path}"}

    rows: list[dict[str, str]] = []
    try:
        with open(path, "r", encoding="utf-8", errors="replace", newline="") as f:
            reader = csv.DictReader(f)
            for i, row in enumerate(reader):
                if i >= max_rows:
                    break
                rows.append({k: (v or "") for k, v in row.items()})
    except Exception as e:
        return {"ok": False, "message": str(e)}

    name_hits: dict[str, int] = {}
    collab_hits: dict[str, int] = {}
    genre_hits: dict[str, int] = {}
    mood_hits: dict[str, int] = {}
    bpm_hits: set[str] = set()
    roots: list[str] = []
    signals: list[str] = []
    track_titles: list[str] = []

    for row in rows:
        p = row.get("project_path") or row.get("path") or ""
        if not p:
            continue
        # Prefer real user projects over sample packs / templates
        low = p.lower()
        if any(
            x in low
            for x in (
                "sample pack",
                "dream bundle",
                "mr. bill",
                "production labs",
                "user library",
                "temp project",
                "live recordings",
                "\\packs\\",
                "/packs/",
            )
        ):
            continue
        name = Path(p.rstrip("\\/")).name
        signals.append(name[:120])
        # Roots (parent of Project folders)
        try:
            root = str(Path(p).parent)
            if root and root not in roots and len(roots) < 12:
                # Only keep large / primary music folders
                if "music" in root.lower() or "project" in root.lower() or root.lower().startswith("d:\\"):
                    roots.append(root)
        except Exception:
            pass

        # Collaborators: "Ft. X" / "Ft X"
        for m in re.finditer(r"(?:ft\.?|feat\.?|featuring)\s+([A-Za-z0-9][\w .'+-]{1,40})", name, re.I):
            c = m.group(1).strip(" -_")
            if c:
                collab_hits[c] = collab_hits.get(c, 0) + 2

        # Artist tokens often appear as "Sine - …" or "Sine Ft."
        for m in re.finditer(r"^([A-Za-z][\w']{1,24})\s*(?:-|Ft\.?|feat)", name, re.I):
            tok = m.group(1)
            if tok.lower() not in ("new", "the", "audio", "copy", "bounce", "shared"):
                name_hits[tok] = name_hits.get(tok, 0) + 3

        if re.search(r"sinesdead|sine\b", name, re.I):
            name_hits["Sine"] = name_hits.get("Sine", 0) + 5
            name_hits["sinesdead"] = name_hits.get("sinesdead", 0) + 2

        for pat, genres, moods in _GENRE_HINTS:
            if pat.search(name) or pat.search(p):
                for g in genres:
                    genre_hits[g] = genre_hits.get(g, 0) + 1
                for m in moods:
                    mood_hits[m] = mood_hits.get(m, 0) + 1

        bpm_m = re.search(r"(\d{2,3})\s*BPM", name, re.I)
        if bpm_m:
            bpm_hits.add(f"{bpm_m.group(1)} BPM")
        if re.search(r"\b174\b", name):
            bpm_hits.add("170-175 BPM (DnB)")

        # Likely track titles
        if " Project" in name:
            title = name.replace(" Project", "").strip()
            if 3 < len(title) < 80 and not title.lower().startswith("temp"):
                track_titles.append(title)

    aliases = [n for n, _ in sorted(name_hits.items(), key=lambda x: -x[1])[:6]]
    artist_name = ""
    if "Sine" in aliases or any(a.lower() == "sine" for a in aliases):
        artist_name = "Sine"
    elif aliases:
        artist_name = aliases[0]

    genres = [g for g, _ in sorted(genre_hits.items(), key=lambda x: -x[1])[:8]]
    moods = [m for m, _ in sorted(mood_hits.items(), key=lambda x: -x[1])[:8]]
    collaborators = [c for c, _ in sorted(collab_hits.items(), key=lambda x: -x[1])[:10]]

    # Default SEO niches for bass-heavy projects when genres found
    niches: list[str] = []
    for g in genres:
        niches.append(g)
        niches.append(f"best {g} {datetime.now(timezone.utc).year}")
        niches.append(f"{g} vibes")
    if "drum and bass" in genres or any("174" in b for b in bpm_hits):
        niches.extend(["drum and bass workout", "neurofunk energy", "liquid dnb chill"])
    if "dubstep" in genres or "bass music" in genres:
        niches.extend(["bass music 2026", "dark dubstep mix", "festival bass bangers"])
    if "dub" in genres:
        niches.extend(["dub reggae vibes", "deep dub mix"])

    keywords = _merge_unique(
        niches,
        moods
        + [
            "underground bass",
            "new electronic music",
            "independent artist playlist",
        ],
        cap=30,
    )

    inferred = {
        "artist_name": artist_name,
        "aliases": aliases,
        "genres": genres or ["bass music", "electronic"],
        "subgenres": [],
        "moods": moods or ["dark", "energetic", "atmospheric"],
        "bpm_ranges": sorted(bpm_hits),
        "seo_niches": _merge_unique([], niches, cap=20),
        "keywords": keywords,
        "collaborators": collaborators,
        "project_roots": roots[:8],
        "ableton_signals": signals[:20],
        "track_titles": _merge_unique([], track_titles, cap=30),
        "sources": [f"ableton_index:{path}"],
    }
    if artist_name.lower() == "sine":
        inferred["tagline"] = inferred.get("tagline") or "Bass-forward electronic - dub, dubstep, and DnB energy"
        inferred["themes"] = ["bass weight", "dark atmosphere", "club / sound system"]
        inferred["target_audience"] = (
            "Listeners into underground bass music, dubstep, drum & bass, and dub - "
            "playlist curators and fans of heavy low-end electronic"
        )
        inferred["brand_voice"] = "Dark, heavy, underground - not mainstream pop EDM"

    if not apply:
        return {"ok": True, "inferred": inferred, "rows_scanned": len(rows), "applied": False}

    # Don't overwrite a richer hand-edited name with empty
    cur = get_artist_project()
    payload = dict(inferred)
    if (cur.get("artist_name") or "").strip() and not (payload.get("artist_name") or "").strip():
        payload.pop("artist_name", None)
    elif (cur.get("artist_name") or "").strip() and (payload.get("artist_name") or "").strip():
        # Keep existing primary name; fold inferred into aliases
        payload["aliases"] = _merge_unique(
            _split_list(payload.get("aliases")),
            [payload.pop("artist_name")],
        )
    result = save_artist_project(payload)
    result["inferred"] = inferred
    result["rows_scanned"] = len(rows)
    result["applied"] = True
    result["message"] = (
        f"Inferred artist project from Ableton index ({len(rows)} rows). "
        f"Primary name: {(result.get('project') or {}).get('artist_name') or artist_name or '(none)'}"
    )
    return result


def sync_from_spotify(artist_id: str | None = None, *, market: str = "US") -> dict:
    """Pull Spotify artist profile + top tracks into artist_project."""
    try:
        from spotify_helper import _api_get, _normalize_uri, _uri_id, artist_top_tracks
    except ImportError:
        return {"ok": False, "message": "spotify_helper not available"}

    p = get_artist_project()
    aid = (artist_id or "").strip()
    if not aid:
        ids = _split_list(p.get("spotify_artist_ids"))
        aid = ids[0] if ids else ""
    aid = _uri_id(_normalize_uri(aid, "artist")) if aid else ""
    if not aid:
        return {
            "ok": False,
            "message": "No Spotify artist ID. Set spotify_artist_ids on the artist project first.",
        }

    info = _api_get(f"/artists/{aid}")
    if info.get("ok") is False or not info.get("id"):
        return {"ok": False, "message": info.get("message") or "Failed to fetch Spotify artist"}

    top = artist_top_tracks(aid, market=market)
    track_uris = [t["uri"] for t in (top.get("tracks") or []) if t.get("uri")]
    track_titles = [t["name"] for t in (top.get("tracks") or []) if t.get("name")]

    genres = _split_list(info.get("genres"))
    name = (info.get("name") or "").strip()
    url = ((info.get("external_urls") or {}).get("spotify") or "").strip()

    updates = {
        "artist_name": name or None,
        "spotify_artist_ids": [aid],
        "spotify_urls": [url] if url else [],
        "genres": genres,
        "track_uris": track_uris,
        "track_titles": track_titles,
        "sources": [f"spotify:artist:{aid}"],
    }
    # Seed niches from Spotify genres
    niches = []
    for g in genres[:8]:
        niches.append(g)
        niches.append(f"{g} playlist")
        niches.append(f"best {g} songs")
    updates["seo_niches"] = niches
    updates["keywords"] = _merge_unique(niches, genres + track_titles[:5], cap=36)

    result = save_artist_project(updates)
    result["spotify"] = {
        "id": aid,
        "name": name,
        "genres": genres,
        "followers": (info.get("followers") or {}).get("total"),
        "popularity": info.get("popularity"),
        "url": url,
        "top_track_count": len(track_uris),
    }
    result["message"] = (
        f"Synced Spotify artist “{name}” ({len(genres)} genres, {len(track_uris)} top tracks) into artist project"
    )
    return result


def seed_starter_profile(*, force: bool = False) -> dict:
    """
    If no artist project exists yet, infer from Ableton index and write a starter file.
    force=True re-runs inference merge even if a file exists.
    """
    path = artist_project_path()
    if path.is_file() and artist_project_has_content() and not force:
        return {
            "ok": True,
            "skipped": True,
            "message": f"Artist project already exists at {path}",
            "project": get_artist_project(),
        }
    return infer_from_ableton_index(apply=True)
