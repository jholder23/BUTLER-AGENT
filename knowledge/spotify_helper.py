"""
Spotify SEO playlist manager for Butler.

Creates and maintains public playlists with search-friendly titles/descriptions,
seeds them with your tracks plus complementary popular tracks, and keeps them fresh
so algorithmic discovery has a better chance of playing your songs.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import secrets
import time
import urllib.parse
from datetime import datetime, timezone
from typing import Any

import requests

from butlor_paths import ensure_butlor_config_dir

SPOTIFY_AUTH_URL = "https://accounts.spotify.com/authorize"
SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token"
SPOTIFY_API = "https://api.spotify.com/v1"
SCOPES = " ".join(
    [
        "playlist-modify-public",
        "playlist-modify-private",
        "playlist-read-private",
        "user-read-private",
        "user-library-read",
    ]
)
DEFAULT_REDIRECT_URI = "http://127.0.0.1:4389/callback"
YEAR = datetime.now(timezone.utc).year

# Title / description templates tuned for Spotify search + playlist SEO.
_TITLE_TEMPLATES = [
    "{niche} Vibes {year}",
    "Best {niche} Songs {year}",
    "{niche} Playlist - Fresh Finds",
    "{keyword} - {niche}",
    "Top {niche} Hits & Hidden Gems",
    "{niche} Mix for Focus & Chill",
    "New {niche} Music {year}",
]
_DESC_TEMPLATES = [
    "Curated {niche} playlist featuring {artist} and similar artists. "
    "Search-friendly mix for {keywords}. Updated {year}. Listen, save, and discover new favorites.",
    "{niche} songs for everyday listening — mood, energy, and melody. "
    "Includes tracks by {artist}. Perfect for {keywords}. Fresh picks for {year}.",
    "Discover {niche} with this SEO-friendly public playlist. "
    "Spotlight on {artist} plus complementary tracks fans of {keywords} enjoy. Updated regularly.",
]


def _pick_description(niche: str, artist: str, keywords: list[str], cfg: dict | None = None) -> str:
    cfg = cfg or {}
    tpl = _DESC_TEMPLATES[hash(niche) % len(_DESC_TEMPLATES)]
    kw = ", ".join(keywords[:5]) if keywords else niche
    artist = artist or "featured artists"
    desc = tpl.format(niche=niche, artist=artist, keywords=kw, year=YEAR)
    tagline = (cfg.get("tagline") or "").strip()
    audience = (cfg.get("target_audience") or "").strip()
    voice = (cfg.get("brand_voice") or "").strip()
    extras = []
    if tagline:
        extras.append(tagline)
    if audience:
        extras.append(f"For: {audience[:120]}")
    if voice and len(desc) < 200:
        extras.append(voice[:80])
    if extras:
        desc = (desc.rstrip(". ") + ". " + " ".join(extras)).strip()
    # Soft-avoid phrases
    avoid = cfg.get("do_not_associate") or []
    for bad in avoid:
        if bad and bad.lower() in desc.lower():
            desc = re.sub(re.escape(bad), "", desc, flags=re.I)
    return desc[:300]


def _client_id() -> str:
    try:
        from config import SPOTIFY_CLIENT_ID

        return (SPOTIFY_CLIENT_ID or "").strip()
    except Exception:
        return (os.getenv("SPOTIFY_CLIENT_ID") or "").strip()


def _client_secret() -> str:
    try:
        from config import SPOTIFY_CLIENT_SECRET

        return (SPOTIFY_CLIENT_SECRET or "").strip()
    except Exception:
        return (os.getenv("SPOTIFY_CLIENT_SECRET") or "").strip()


def _redirect_uri() -> str:
    try:
        from config import SPOTIFY_REDIRECT_URI

        raw = (SPOTIFY_REDIRECT_URI or "").strip()
    except Exception:
        raw = (os.getenv("SPOTIFY_REDIRECT_URI") or "").strip()
    return raw or DEFAULT_REDIRECT_URI


def _token_path() -> str:
    return str(ensure_butlor_config_dir() / "spotify_token.json")


def _config_path() -> str:
    return str(ensure_butlor_config_dir() / "spotify_seo_config.json")


def _registry_path() -> str:
    return str(ensure_butlor_config_dir() / "spotify_seo_playlists.json")


def _pkce_path() -> str:
    return str(ensure_butlor_config_dir() / "spotify_oauth_pkce.json")


def _load_json(path: str, default: Any) -> Any:
    if not os.path.isfile(path):
        return default
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if data is not None else default
    except Exception:
        return default


def _save_json(path: str, data: Any) -> None:
    ensure_butlor_config_dir()
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)


def get_config() -> dict:
    cfg = _load_json(
        _config_path(),
        {
            "artist_ids": [],
            "artist_name": "",
            "track_uris": [],
            "genres": [],
            "keywords": [],
            "your_track_ratio": 0.12,
            "playlist_size": 50,
            "public": True,
        },
    )
    if not isinstance(cfg, dict):
        cfg = {}
    cfg.setdefault("artist_ids", [])
    cfg.setdefault("artist_name", "")
    cfg.setdefault("track_uris", [])
    cfg.setdefault("genres", [])
    cfg.setdefault("keywords", [])
    cfg.setdefault("your_track_ratio", 0.12)
    cfg.setdefault("playlist_size", 50)
    cfg.setdefault("public", True)
    # Overlay rich artist project (source of truth for SEO accuracy)
    try:
        from artist_project_helper import artist_project_has_content, seo_context

        if artist_project_has_content():
            ctx = seo_context()
            if ctx.get("artist_name") and not (cfg.get("artist_name") or "").strip():
                cfg["artist_name"] = ctx["artist_name"]
            elif ctx.get("artist_name"):
                cfg["artist_name"] = ctx["artist_name"]
            if ctx.get("spotify_artist_ids"):
                cfg["artist_ids"] = list(
                    dict.fromkeys(list(cfg.get("artist_ids") or []) + list(ctx["spotify_artist_ids"]))
                )
            if ctx.get("track_uris"):
                cfg["track_uris"] = list(
                    dict.fromkeys(list(cfg.get("track_uris") or []) + list(ctx["track_uris"]))
                )
            if ctx.get("genres") or ctx.get("subgenres"):
                merged_g = list(cfg.get("genres") or [])
                for g in list(ctx.get("genres") or []) + list(ctx.get("subgenres") or []):
                    if g not in merged_g:
                        merged_g.append(g)
                cfg["genres"] = merged_g
            if ctx.get("keywords") or ctx.get("seo_niches"):
                merged_k = list(cfg.get("keywords") or [])
                for k in list(ctx.get("keywords") or []) + list(ctx.get("seo_niches") or []):
                    if k not in merged_k:
                        merged_k.append(k)
                cfg["keywords"] = merged_k
            cfg["seo_niches"] = list(ctx.get("seo_niches") or [])
            cfg["similar_artists"] = list(ctx.get("similar_artists") or [])
            cfg["moods"] = list(ctx.get("moods") or [])
            cfg["bio"] = ctx.get("bio") or ""
            cfg["tagline"] = ctx.get("tagline") or ""
            cfg["target_audience"] = ctx.get("target_audience") or ""
            cfg["brand_voice"] = ctx.get("brand_voice") or ""
            cfg["do_not_associate"] = list(ctx.get("do_not_associate") or [])
            cfg["track_titles"] = list(ctx.get("track_titles") or [])
            cfg["from_artist_project"] = True
    except Exception:
        cfg["from_artist_project"] = False
    return cfg


def save_config(**kwargs: Any) -> dict:
    cfg = get_config()
    for k, v in kwargs.items():
        if v is None:
            continue
        if k in ("artist_ids", "track_uris", "genres", "keywords") and isinstance(v, str):
            v = [x.strip() for x in re.split(r"[,;\n]+", v) if x.strip()]
        if k == "your_track_ratio":
            try:
                v = max(0.05, min(0.8, float(v)))
            except (TypeError, ValueError):
                continue
        if k == "playlist_size":
            try:
                v = max(10, min(100, int(v)))
            except (TypeError, ValueError):
                continue
        if k == "public":
            v = bool(v)
        if k in cfg or k in (
            "artist_ids",
            "artist_name",
            "track_uris",
            "genres",
            "keywords",
            "your_track_ratio",
            "playlist_size",
            "public",
        ):
            cfg[k] = v
    cfg["updated"] = datetime.now(timezone.utc).isoformat()
    _save_json(_config_path(), cfg)
    return {"ok": True, "config": cfg, "message": "Spotify SEO config saved"}


def get_registry() -> dict:
    data = _load_json(_registry_path(), {"playlists": [], "updated": None})
    if not isinstance(data, dict):
        data = {"playlists": [], "updated": None}
    data.setdefault("playlists", [])
    return data


def _save_registry(data: dict) -> None:
    data["updated"] = datetime.now(timezone.utc).isoformat()
    _save_json(_registry_path(), data)


def _normalize_uri(value: str, kind: str = "track") -> str:
    v = (value or "").strip()
    if not v:
        return ""
    if v.startswith("spotify:"):
        return v
    # open.spotify.com/track/ID or /artist/ID
    m = re.search(rf"open\.spotify\.com/{kind}/([A-Za-z0-9]+)", v)
    if m:
        return f"spotify:{kind}:{m.group(1)}"
    if re.fullmatch(r"[A-Za-z0-9]{22}", v):
        return f"spotify:{kind}:{v}"
    return v


def _uri_id(uri: str) -> str:
    parts = (uri or "").split(":")
    return parts[-1] if parts else ""


# --- OAuth ---


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def start_oauth() -> dict:
    """Begin Authorization Code + PKCE flow. Returns authorize URL."""
    cid = _client_id()
    if not cid:
        return {
            "ok": False,
            "message": "Set SPOTIFY_CLIENT_ID (and SPOTIFY_CLIENT_SECRET) in .env. "
            "Create an app at https://developer.spotify.com/dashboard",
        }
    verifier = _b64url(secrets.token_bytes(32))
    challenge = _b64url(hashlib.sha256(verifier.encode("ascii")).digest())
    state = _b64url(secrets.token_bytes(16))
    _save_json(
        _pkce_path(),
        {"verifier": verifier, "state": state, "created": time.time()},
    )
    params = {
        "client_id": cid,
        "response_type": "code",
        "redirect_uri": _redirect_uri(),
        "scope": SCOPES,
        "state": state,
        "code_challenge_method": "S256",
        "code_challenge": challenge,
    }
    url = SPOTIFY_AUTH_URL + "?" + urllib.parse.urlencode(params)
    return {
        "ok": True,
        "authorize_url": url,
        "redirect_uri": _redirect_uri(),
        "message": "Open authorize_url, approve access, then POST the callback code to /spotify/oauth/callback",
    }


def complete_oauth(code: str, state: str | None = None) -> dict:
    """Exchange authorization code for tokens."""
    code = (code or "").strip()
    if not code:
        return {"ok": False, "message": "code required"}
    pkce = _load_json(_pkce_path(), {})
    if state and pkce.get("state") and state != pkce.get("state"):
        return {"ok": False, "message": "OAuth state mismatch — restart auth"}
    verifier = (pkce.get("verifier") or "").strip()
    if not verifier:
        return {"ok": False, "message": "No PKCE verifier — call start_oauth first"}
    cid = _client_id()
    secret = _client_secret()
    if not cid:
        return {"ok": False, "message": "SPOTIFY_CLIENT_ID missing"}
    data = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": _redirect_uri(),
        "client_id": cid,
        "code_verifier": verifier,
    }
    headers = {"Content-Type": "application/x-www-form-urlencoded"}
    if secret:
        basic = base64.b64encode(f"{cid}:{secret}".encode()).decode()
        headers["Authorization"] = f"Basic {basic}"
    try:
        r = requests.post(SPOTIFY_TOKEN_URL, data=data, headers=headers, timeout=30)
    except Exception as e:
        return {"ok": False, "message": f"Token request failed: {e}"}
    if r.status_code >= 400:
        return {"ok": False, "message": f"Spotify token error {r.status_code}: {r.text[:400]}"}
    tok = r.json()
    tok["obtained_at"] = int(time.time())
    _save_json(_token_path(), tok)
    try:
        os.remove(_pkce_path())
    except OSError:
        pass
    me = _api_get("/me", token_override=tok)
    display = ""
    if isinstance(me, dict) and me.get("ok") is not False:
        display = (me.get("display_name") or me.get("id") or "") if "error" not in me else ""
        if "id" in me:
            tok["user_id"] = me["id"]
            tok["display_name"] = me.get("display_name") or ""
            _save_json(_token_path(), tok)
    return {
        "ok": True,
        "message": f"Spotify connected{(' as ' + display) if display else ''}",
        "user_id": tok.get("user_id"),
        "display_name": tok.get("display_name") or display,
    }


def _load_token() -> dict | None:
    tok = _load_json(_token_path(), None)
    return tok if isinstance(tok, dict) and tok.get("access_token") else None


def _refresh_access_token(tok: dict) -> dict | None:
    refresh = (tok.get("refresh_token") or "").strip()
    if not refresh:
        return None
    cid = _client_id()
    secret = _client_secret()
    if not cid:
        return None
    data = {
        "grant_type": "refresh_token",
        "refresh_token": refresh,
        "client_id": cid,
    }
    headers = {"Content-Type": "application/x-www-form-urlencoded"}
    if secret:
        basic = base64.b64encode(f"{cid}:{secret}".encode()).decode()
        headers["Authorization"] = f"Basic {basic}"
    try:
        r = requests.post(SPOTIFY_TOKEN_URL, data=data, headers=headers, timeout=30)
    except Exception:
        return None
    if r.status_code >= 400:
        return None
    fresh = r.json()
    tok["access_token"] = fresh["access_token"]
    tok["obtained_at"] = int(time.time())
    tok["expires_in"] = fresh.get("expires_in", 3600)
    if fresh.get("refresh_token"):
        tok["refresh_token"] = fresh["refresh_token"]
    _save_json(_token_path(), tok)
    return tok


def _access_token(token_override: dict | None = None) -> str | None:
    tok = token_override or _load_token()
    if not tok:
        return None
    obtained = int(tok.get("obtained_at") or 0)
    expires = int(tok.get("expires_in") or 3600)
    if obtained and time.time() >= obtained + expires - 60:
        tok = _refresh_access_token(tok) or tok
    return (tok.get("access_token") or "").strip() or None


def auth_status() -> dict:
    tok = _load_token()
    if not tok:
        return {
            "ok": False,
            "connected": False,
            "message": "Not connected. Run OAuth (spotify_oauth_setup or POST /spotify/oauth/start).",
            "has_client_id": bool(_client_id()),
        }
    me = _api_get("/me")
    if isinstance(me, dict) and me.get("id"):
        artist_proj = None
        try:
            from artist_project_helper import get_artist_project, artist_project_has_content

            if artist_project_has_content():
                artist_proj = get_artist_project()
        except Exception:
            artist_proj = None
        return {
            "ok": True,
            "connected": True,
            "user_id": me.get("id"),
            "display_name": me.get("display_name"),
            "product": me.get("product"),
            "config": get_config(),
            "playlist_count": len(get_registry().get("playlists") or []),
            "artist_project": {
                "artist_name": (artist_proj or {}).get("artist_name"),
                "genres": (artist_proj or {}).get("genres"),
                "seo_niches": (artist_proj or {}).get("seo_niches"),
            }
            if artist_proj
            else None,
        }
    return {
        "ok": False,
        "connected": False,
        "message": (me or {}).get("message") if isinstance(me, dict) else "Token invalid — re-auth",
        "has_client_id": bool(_client_id()),
    }


# --- HTTP helpers ---


def _api(
    method: str,
    path: str,
    *,
    params: dict | None = None,
    json_body: Any = None,
    token_override: dict | None = None,
) -> dict:
    token = _access_token(token_override)
    if not token:
        return {"ok": False, "message": "Spotify not authenticated"}
    url = path if path.startswith("http") else SPOTIFY_API + path
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    try:
        r = requests.request(
            method.upper(),
            url,
            params=params,
            json=json_body,
            headers=headers,
            timeout=45,
        )
    except Exception as e:
        return {"ok": False, "message": str(e)}
    if r.status_code == 204:
        return {"ok": True}
    if r.status_code == 401 and not token_override:
        tok = _load_token()
        if tok and _refresh_access_token(tok):
            return _api(method, path, params=params, json_body=json_body, token_override=_load_token())
    try:
        body = r.json() if r.content else {}
    except Exception:
        body = {"raw": r.text[:500]}
    if r.status_code >= 400:
        err = body.get("error", {}) if isinstance(body, dict) else {}
        msg = err.get("message") if isinstance(err, dict) else None
        return {
            "ok": False,
            "status": r.status_code,
            "message": msg or f"Spotify API {r.status_code}: {str(body)[:400]}",
            "body": body,
        }
    if isinstance(body, dict):
        body.setdefault("ok", True)
        return body
    return {"ok": True, "data": body}


def _api_get(path: str, **kwargs: Any) -> dict:
    return _api("GET", path, **kwargs)


def _api_post(path: str, json_body: Any = None, **kwargs: Any) -> dict:
    return _api("POST", path, json_body=json_body, **kwargs)


def _api_put(path: str, json_body: Any = None, **kwargs: Any) -> dict:
    return _api("PUT", path, json_body=json_body, **kwargs)


def _user_id() -> str | None:
    tok = _load_token() or {}
    uid = (tok.get("user_id") or "").strip()
    if uid:
        return uid
    me = _api_get("/me")
    if isinstance(me, dict) and me.get("id"):
        tok["user_id"] = me["id"]
        tok["display_name"] = me.get("display_name") or ""
        _save_json(_token_path(), tok)
        return me["id"]
    return None


# --- Search / catalog ---


def search_tracks(query: str, limit: int = 20, market: str = "US") -> dict:
    q = (query or "").strip()
    if not q:
        return {"ok": False, "message": "query required", "tracks": []}
    r = _api_get(
        "/search",
        params={"q": q, "type": "track", "limit": max(1, min(50, int(limit))), "market": market},
    )
    if not r.get("ok", True) and r.get("message"):
        return {"ok": False, "message": r["message"], "tracks": []}
    items = ((r.get("tracks") or {}).get("items")) or []
    tracks = []
    for t in items:
        if not isinstance(t, dict) or not t.get("uri"):
            continue
        artists = ", ".join(a.get("name", "") for a in (t.get("artists") or []) if isinstance(a, dict))
        tracks.append(
            {
                "uri": t["uri"],
                "id": t.get("id"),
                "name": t.get("name"),
                "artists": artists,
                "popularity": t.get("popularity", 0),
            }
        )
    return {"ok": True, "tracks": tracks, "query": q}


def artist_top_tracks(artist_id: str, market: str = "US") -> dict:
    aid = _uri_id(_normalize_uri(artist_id, "artist"))
    if not aid:
        return {"ok": False, "message": "artist_id required", "tracks": []}
    r = _api_get(f"/artists/{aid}/top-tracks", params={"market": market})
    if r.get("ok") is False:
        return {"ok": False, "message": r.get("message", "failed"), "tracks": []}
    tracks = []
    for t in r.get("tracks") or []:
        if not isinstance(t, dict) or not t.get("uri"):
            continue
        tracks.append({"uri": t["uri"], "id": t.get("id"), "name": t.get("name"), "popularity": t.get("popularity", 0)})
    return {"ok": True, "tracks": tracks, "artist_id": aid}


def resolve_your_tracks(cfg: dict | None = None, market: str = "US") -> list[str]:
    """Return track URIs to promote (explicit list + artist top tracks)."""
    cfg = cfg or get_config()
    uris: list[str] = []
    seen: set[str] = set()
    for raw in cfg.get("track_uris") or []:
        u = _normalize_uri(str(raw), "track")
        if u and u not in seen:
            seen.add(u)
            uris.append(u)
    for aid in cfg.get("artist_ids") or []:
        top = artist_top_tracks(str(aid), market=market)
        for t in top.get("tracks") or []:
            u = t.get("uri")
            if u and u not in seen:
                seen.add(u)
                uris.append(u)
    return uris


def _complementary_tracks(
    niche: str,
    keywords: list[str],
    genres: list[str],
    exclude: set[str],
    need: int,
    market: str = "US",
    similar_artists: list[str] | None = None,
) -> list[str]:
    """Find popular complementary tracks via search (recommendations API is deprecated)."""
    queries: list[str] = []
    if niche:
        queries.append(niche)
        queries.append(f"{niche} hits")
    for g in genres[:4]:
        queries.append(f"genre:{g}" if " " not in g else g)
    for k in keywords[:4]:
        queries.append(k)
    for a in (similar_artists or [])[:5]:
        queries.append(f"artist:{a}" if " " not in a else a)
        queries.append(f"{a} mix")
    if not queries:
        queries = ["popular indie", "chill vibes", "new music"]

    scored: dict[str, int] = {}
    for q in queries:
        res = search_tracks(q, limit=20, market=market)
        for t in res.get("tracks") or []:
            uri = t.get("uri")
            if not uri or uri in exclude:
                continue
            pop = int(t.get("popularity") or 0)
            scored[uri] = max(scored.get(uri, 0), pop)
        if len(scored) >= need * 2:
            break
    ranked = sorted(scored.items(), key=lambda x: -x[1])
    return [u for u, _ in ranked[:need]]


def _pick_title(niche: str, keyword: str) -> str:
    tpl = _TITLE_TEMPLATES[hash(niche + keyword) % len(_TITLE_TEMPLATES)]
    title = tpl.format(niche=niche.title(), keyword=keyword.title() or niche.title(), year=YEAR)
    return title[:100]


def _interleave(yours: list[str], others: list[str], your_ratio: float, total: int) -> list[str]:
    """Place your tracks early and regularly so they get plays when someone starts the playlist."""
    your_n = max(1, min(len(yours), int(round(total * your_ratio)))) if yours else 0
    other_n = max(0, total - your_n)
    y = yours[:your_n]
    o = others[:other_n]
    out: list[str] = []
    # Lead with 1–2 of yours, then alternate roughly by ratio
    if y:
        out.append(y.pop(0))
    if y and your_ratio >= 0.25:
        out.append(y.pop(0))
    while y or o:
        # Prefer others mid-playlist for algorithmic “similar to popular” signal
        if o and (not y or len(out) % 3 != 0):
            out.append(o.pop(0))
        elif y:
            out.append(y.pop(0))
        elif o:
            out.append(o.pop(0))
    # Dedupe preserve order
    seen: set[str] = set()
    final: list[str] = []
    for u in out:
        if u not in seen:
            seen.add(u)
            final.append(u)
    return final[:total]


# --- Playlist CRUD / SEO ---


def create_seo_playlist(
    niche: str = "",
    *,
    keywords: list[str] | None = None,
    name: str | None = None,
    description: str | None = None,
    market: str = "US",
    dry_run: bool = False,
) -> dict:
    """
    Create one public SEO playlist: your tracks + complementary popular tracks,
    search-optimized title/description, registered for later maintenance.
    """
    cfg = get_config()
    niche = (niche or "").strip()
    if not niche:
        niches = cfg.get("seo_niches") or []
        genres = cfg.get("genres") or []
        niche = (
            (niches[0] if niches else "")
            or (genres[0] if genres else "")
            or (cfg.get("keywords") or ["new music"])[0]
        )
    kw = list(keywords or []) or list(cfg.get("keywords") or [])
    if niche and niche not in kw:
        kw = [niche] + kw
    genres = list(cfg.get("genres") or [])
    similar = list(cfg.get("similar_artists") or [])
    artist_name = (cfg.get("artist_name") or "").strip() or "featured artists"
    size = int(cfg.get("playlist_size") or 40)
    ratio = float(cfg.get("your_track_ratio") or 0.30)
    public = bool(cfg.get("public", True))

    yours = resolve_your_tracks(cfg, market=market)
    if not yours and not dry_run:
        return {
            "ok": False,
            "message": "No tracks to promote. Add Spotify artist IDs / track URIs to artist_project.json "
            "(or /artist/project) then sync, or set them via /spotify/config.",
        }

    title = (name or "").strip() or _pick_title(niche, kw[0] if kw else niche)
    desc = (description or "").strip() or _pick_description(niche, artist_name, kw, cfg)

    exclude = set(yours)
    need_others = max(0, size - max(1, int(round(size * ratio))))
    others = _complementary_tracks(
        niche,
        kw,
        genres,
        exclude,
        need=need_others + 10,
        market=market,
        similar_artists=similar,
    )
    uris = _interleave(yours, others, ratio, size)

    if dry_run:
        return {
            "ok": True,
            "dry_run": True,
            "name": title,
            "description": desc,
            "niche": niche,
            "track_count": len(uris),
            "your_track_count": sum(1 for u in uris if u in exclude),
            "sample_uris": uris[:8],
            "message": f"Would create playlist “{title}” with {len(uris)} tracks",
        }

    uid = _user_id()
    if not uid:
        return {"ok": False, "message": "Spotify not authenticated — complete OAuth first"}

    created = _api_post(
        f"/users/{uid}/playlists",
        json_body={
            "name": title,
            "description": desc,
            "public": public,
        },
    )
    if created.get("ok") is False or not created.get("id"):
        return {
            "ok": False,
            "message": created.get("message") or "Failed to create playlist",
            "body": created,
        }

    pid = created["id"]
    # Spotify accepts max 100 URIs per add
    for i in range(0, len(uris), 100):
        chunk = uris[i : i + 100]
        add = _api_post(f"/playlists/{pid}/tracks", json_body={"uris": chunk})
        if add.get("ok") is False:
            return {
                "ok": False,
                "message": f"Playlist created but adding tracks failed: {add.get('message')}",
                "playlist_id": pid,
                "url": (created.get("external_urls") or {}).get("spotify"),
            }

    entry = {
        "id": pid,
        "name": title,
        "description": desc,
        "niche": niche,
        "keywords": kw[:8],
        "url": (created.get("external_urls") or {}).get("spotify") or f"https://open.spotify.com/playlist/{pid}",
        "public": public,
        "your_track_uris": [u for u in uris if u in exclude],
        "track_count": len(uris),
        "created": datetime.now(timezone.utc).isoformat(),
        "last_maintained": datetime.now(timezone.utc).isoformat(),
    }
    reg = get_registry()
    reg["playlists"] = [p for p in (reg.get("playlists") or []) if p.get("id") != pid]
    reg["playlists"].append(entry)
    _save_registry(reg)

    return {
        "ok": True,
        "playlist": entry,
        "message": f"Created SEO playlist “{title}” ({len(uris)} tracks, "
        f"{len(entry['your_track_uris'])} yours) → {entry['url']}",
    }


def create_seo_batch(
    niches: list[str] | None = None,
    *,
    market: str = "US",
    dry_run: bool = False,
) -> dict:
    """Create one SEO playlist per niche (from args or config genres/keywords)."""
    cfg = get_config()
    niches = [n.strip() for n in (niches or []) if (n or "").strip()]
    if not niches:
        niches = (
            list(cfg.get("seo_niches") or [])
            + list(cfg.get("genres") or [])
            + list(cfg.get("keywords") or [])
        )
    # unique preserve order
    seen: set[str] = set()
    uniq: list[str] = []
    for n in niches:
        key = n.lower()
        if key not in seen:
            seen.add(key)
            uniq.append(n)
    niches = uniq[:12]
    if not niches:
        return {"ok": False, "message": "No niches — pass niches[] or set genres/keywords in config"}

    results = []
    for niche in niches:
        # Avoid duplicate niche playlists
        existing = [
            p
            for p in (get_registry().get("playlists") or [])
            if (p.get("niche") or "").strip().lower() == niche.lower()
        ]
        if existing and not dry_run:
            results.append(
                {
                    "ok": True,
                    "skipped": True,
                    "niche": niche,
                    "message": f"Already have playlist for niche “{niche}”: {existing[0].get('url')}",
                    "playlist": existing[0],
                }
            )
            continue
        results.append(create_seo_playlist(niche, market=market, dry_run=dry_run))

    ok_n = sum(1 for r in results if r.get("ok") and not r.get("skipped"))
    skip_n = sum(1 for r in results if r.get("skipped"))
    return {
        "ok": True,
        "results": results,
        "created": ok_n,
        "skipped": skip_n,
        "message": f"Batch done: {ok_n} created, {skip_n} skipped, {len(results)} niches",
    }


def maintain_playlists(
    *,
    playlist_ids: list[str] | None = None,
    refresh_copy: bool = True,
    ensure_your_tracks: bool = True,
    market: str = "US",
    dry_run: bool = False,
) -> dict:
    """
    Refresh SEO titles/descriptions (year/keywords) and ensure your tracks remain
    near the top of managed playlists.
    """
    cfg = get_config()
    reg = get_registry()
    playlists = list(reg.get("playlists") or [])
    if playlist_ids:
        want = set(playlist_ids)
        playlists = [p for p in playlists if p.get("id") in want]
    if not playlists:
        return {"ok": False, "message": "No registered SEO playlists to maintain"}

    yours = set(resolve_your_tracks(cfg, market=market))
    artist_name = (cfg.get("artist_name") or "").strip() or "featured artists"
    reports = []

    for p in playlists:
        pid = p.get("id")
        if not pid:
            continue
        niche = (p.get("niche") or "playlist").strip()
        kw = list(p.get("keywords") or cfg.get("keywords") or [])
        actions: list[str] = []

        if refresh_copy:
            new_name = _pick_title(niche, kw[0] if kw else niche)
            # Keep stable-ish names if already SEO-shaped with current year
            old_name = (p.get("name") or "").strip()
            if str(YEAR) in old_name and niche.lower() in old_name.lower():
                new_name = old_name
            new_desc = _pick_description(niche, artist_name, kw, cfg)
            if not dry_run:
                upd = _api_put(
                    f"/playlists/{pid}",
                    json_body={
                        "name": new_name,
                        "description": new_desc,
                        "public": bool(cfg.get("public", True)),
                    },
                )
                if upd.get("ok") is False:
                    reports.append(
                        {
                            "ok": False,
                            "id": pid,
                            "message": upd.get("message") or "update failed",
                        }
                    )
                    continue
            p["name"] = new_name
            p["description"] = new_desc
            actions.append("refreshed title/description")

        if ensure_your_tracks and yours:
            # Fetch current items (first 100)
            cur = _api_get(f"/playlists/{pid}/tracks", params={"limit": 100, "market": market})
            current_uris: list[str] = []
            for item in (cur.get("items") or []) if cur.get("ok") is not False else []:
                track = (item or {}).get("track") or {}
                if track.get("uri"):
                    current_uris.append(track["uri"])
            missing = [u for u in yours if u not in set(current_uris)]
            # Re-seed yours at front if missing or buried
            if missing or (yours and current_uris and current_uris[0] not in yours):
                # Build new order: yours first (up to ratio), then keep popular others
                size = int(cfg.get("playlist_size") or 40)
                ratio = float(cfg.get("your_track_ratio") or 0.30)
                others = [u for u in current_uris if u not in yours]
                if len(others) < size // 2:
                    others.extend(
                        _complementary_tracks(
                            niche,
                            kw,
                            list(cfg.get("genres") or []),
                            set(yours) | set(others),
                            need=size,
                            market=market,
                            similar_artists=list(cfg.get("similar_artists") or []),
                        )
                    )
                new_order = _interleave(list(yours), others, ratio, size)
                if not dry_run:
                    # Replace all items
                    put = _api_put(
                        f"/playlists/{pid}/tracks",
                        json_body={"uris": new_order[:100]},
                    )
                    if put.get("ok") is False:
                        reports.append(
                            {
                                "ok": False,
                                "id": pid,
                                "name": p.get("name"),
                                "message": put.get("message") or "replace tracks failed",
                            }
                        )
                        continue
                p["your_track_uris"] = [u for u in new_order if u in yours]
                p["track_count"] = len(new_order)
                actions.append(f"reordered tracks (+{len(missing)} missing yours)" if missing else "reordered yours to front")
            else:
                actions.append("your tracks already present")

        p["last_maintained"] = datetime.now(timezone.utc).isoformat()
        reports.append(
            {
                "ok": True,
                "id": pid,
                "name": p.get("name"),
                "url": p.get("url"),
                "actions": actions,
                "dry_run": dry_run,
            }
        )

    if not dry_run:
        # Write back updated entries
        by_id = {p.get("id"): p for p in (reg.get("playlists") or [])}
        for p in playlists:
            if p.get("id") in by_id:
                by_id[p["id"]] = p
        reg["playlists"] = list(by_id.values())
        _save_registry(reg)

    ok_n = sum(1 for r in reports if r.get("ok"))
    return {
        "ok": True,
        "maintained": ok_n,
        "results": reports,
        "message": f"Maintained {ok_n}/{len(reports)} SEO playlist(s)"
        + (" (dry run)" if dry_run else ""),
    }


def list_playlists() -> dict:
    reg = get_registry()
    return {
        "ok": True,
        "playlists": reg.get("playlists") or [],
        "updated": reg.get("updated"),
        "count": len(reg.get("playlists") or []),
    }


def sync_registry_from_spotify() -> dict:
    """Pull current user's playlists and merge any matching registry entries."""
    uid = _user_id()
    if not uid:
        return {"ok": False, "message": "Not authenticated"}
    remote = []
    url = f"/users/{uid}/playlists"
    params: dict[str, Any] = {"limit": 50}
    while url:
        page = _api_get(url if url.startswith("http") else url, params=params if not url.startswith("http") else None)
        if page.get("ok") is False and page.get("message"):
            return {"ok": False, "message": page["message"]}
        for item in page.get("items") or []:
            if not isinstance(item, dict):
                continue
            remote.append(
                {
                    "id": item.get("id"),
                    "name": item.get("name"),
                    "url": (item.get("external_urls") or {}).get("spotify"),
                    "public": item.get("public"),
                    "tracks": (item.get("tracks") or {}).get("total"),
                }
            )
        next_url = page.get("next")
        url = next_url or ""
        params = {}
    return {"ok": True, "spotify_playlists": remote, "count": len(remote)}


def run_seo_cycle(
    niches: list[str] | None = None,
    *,
    create_missing: bool = True,
    maintain: bool = True,
    market: str = "US",
    dry_run: bool = False,
) -> dict:
    """One-shot: ensure niche playlists exist, then maintain all registered ones."""
    out: dict[str, Any] = {"ok": True, "steps": []}
    if create_missing:
        batch = create_seo_batch(niches, market=market, dry_run=dry_run)
        out["steps"].append({"create_batch": batch})
    if maintain:
        maint = maintain_playlists(market=market, dry_run=dry_run)
        out["steps"].append({"maintain": maint})
    created = 0
    if create_missing:
        created = (out["steps"][0].get("create_batch") or {}).get("created") or 0
    maintained = 0
    if maintain:
        idx = 1 if create_missing else 0
        if idx < len(out["steps"]):
            maintained = (out["steps"][idx].get("maintain") or {}).get("maintained") or 0
    out["message"] = (
        f"SEO cycle complete: {created} playlist(s) created, {maintained} maintained"
        + (" (dry run)" if dry_run else "")
    )
    out["config"] = get_config()
    out["playlists"] = list_playlists().get("playlists") or []
    return out


# --- Song-first SEO planner (research-backed) ---
#
# Industry consensus (playlist SEO 2025–2026):
# - Title: front-load 1–2 primary keywords (genre + mood/activity), prefer ≤30–40 chars
# - Description: 100–300 chars; primary keyword in first sentence; 5–7 secondary keywords;
#   mention similar artists / use-case; note weekly updates for freshness
# - Curation: 40–100 tracks; first 5 tracks must deliver the keyword promise (high popularity
#   anchors); mix ~70–90% familiar/high-traction with ~10–15% your tracks
# - Place your focus track early but not always #1 (positions 3–6) so listeners hear expected
#   niche hits first, then discover you
# - Weekly maintain: refresh copy, add 2–5 traction tracks, reorder, signal activity


def _schedule_path() -> str:
    return str(ensure_butlor_config_dir() / "spotify_seo_schedule.json")


def get_schedule() -> dict:
    data = _load_json(
        _schedule_path(),
        {
            "enabled": False,
            "interval_days": 7,
            "weekday": None,
            "last_run": None,
            "next_due": None,
            "market": "US",
            "add_fresh_tracks": True,
            "refresh_copy": True,
            "ensure_your_tracks": True,
        },
    )
    if not isinstance(data, dict):
        data = {}
    data.setdefault("enabled", False)
    data.setdefault("interval_days", 7)
    data.setdefault("last_run", None)
    data.setdefault("next_due", None)
    data.setdefault("market", "US")
    data.setdefault("add_fresh_tracks", True)
    data.setdefault("refresh_copy", True)
    data.setdefault("ensure_your_tracks", True)
    return data


def save_schedule(**kwargs: Any) -> dict:
    sch = get_schedule()
    for k, v in kwargs.items():
        if v is None and k not in ("weekday", "last_run", "next_due"):
            continue
        if k == "enabled":
            sch["enabled"] = bool(v)
        elif k == "interval_days":
            try:
                sch["interval_days"] = max(1, min(30, int(v)))
            except (TypeError, ValueError):
                pass
        elif k in ("market",):
            sch[k] = str(v).strip() or "US"
        elif k in ("add_fresh_tracks", "refresh_copy", "ensure_your_tracks"):
            sch[k] = bool(v)
        elif k in ("last_run", "next_due", "weekday"):
            sch[k] = v
    if sch.get("enabled") and not sch.get("next_due"):
        from datetime import timedelta

        days = int(sch.get("interval_days") or 7)
        sch["next_due"] = (datetime.now(timezone.utc) + timedelta(days=days)).isoformat()
    _save_json(_schedule_path(), sch)
    return {"ok": True, "schedule": sch, "message": "Weekly Spotify SEO schedule saved"}


def get_track(uri_or_id: str, market: str = "US") -> dict:
    """Fetch a Spotify track by URI, URL, or ID."""
    uri = _normalize_uri(uri_or_id, "track")
    tid = _uri_id(uri)
    if not tid:
        return {"ok": False, "message": "track URI/ID required"}
    r = _api_get(f"/tracks/{tid}", params={"market": market})
    if r.get("ok") is False or not r.get("id"):
        return {"ok": False, "message": r.get("message") or "Track not found"}
    artists = [
        {"id": a.get("id"), "name": a.get("name")}
        for a in (r.get("artists") or [])
        if isinstance(a, dict)
    ]
    return {
        "ok": True,
        "uri": r.get("uri") or uri,
        "id": r.get("id"),
        "name": r.get("name"),
        "artists": artists,
        "artist_names": [a["name"] for a in artists if a.get("name")],
        "popularity": int(r.get("popularity") or 0),
        "explicit": bool(r.get("explicit")),
        "duration_ms": r.get("duration_ms"),
        "album": (r.get("album") or {}).get("name"),
        "preview_url": r.get("preview_url"),
        "external_url": ((r.get("external_urls") or {}).get("spotify") or ""),
    }


def _craft_seo_title(
    niche: str,
    mood: str = "",
    activity: str = "",
    *,
    year: bool = True,
) -> str:
    """Front-load genre/mood/activity keywords; keep short for mobile search."""
    niche = (niche or "").strip()
    mood = (mood or "").strip()
    activity = (activity or "").strip()
    parts = []
    if mood and mood.lower() not in niche.lower():
        parts.append(mood.title())
    if niche:
        parts.append(niche.title())
    if activity and activity.lower() not in " ".join(parts).lower():
        parts.append(activity.title())
    base = " ".join(parts) if parts else "New Music Mix"
    if year and str(YEAR) not in base:
        # Prefer year only if still short
        candidate = f"{base} {YEAR}"
        if len(candidate) <= 40:
            base = candidate
    # Hard cap ~40 (research prefers ≤30 but genre+mood often needs more)
    if len(base) > 42:
        base = base[:42].rsplit(" ", 1)[0]
    return base.strip() or f"New Music {YEAR}"


def _craft_seo_description(
    *,
    niche: str,
    artist: str,
    focus_track: str,
    keywords: list[str],
    similar: list[str],
    moods: list[str],
    activity: str = "",
    cfg: dict | None = None,
) -> str:
    """100–300 chars: primary keyword first, secondary keywords, artists, weekly note."""
    cfg = cfg or {}
    primary = (niche or "electronic").strip()
    artist = (artist or "featured artists").strip()
    focus_track = (focus_track or "").strip()
    kw_bank = []
    for x in list(keywords or []) + list(moods or []) + ([activity] if activity else []):
        s = (x or "").strip()
        if s and s.lower() not in {k.lower() for k in kw_bank} and s.lower() != primary.lower():
            kw_bank.append(s)
    kw_bank = kw_bank[:6]
    sim = [s for s in (similar or [])[:4] if s]
    first = f"{primary} playlist"
    if focus_track:
        first += f" featuring {focus_track} by {artist}"
    else:
        first += f" featuring {artist}"
    mid_bits = []
    if kw_bank:
        mid_bits.append("Vibes: " + ", ".join(kw_bank[:5]))
    if sim:
        mid_bits.append("For fans of " + ", ".join(sim))
    if activity:
        mid_bits.append(f"Perfect for {activity}")
    tagline = (cfg.get("tagline") or "").strip()
    if tagline and len(tagline) < 90:
        mid_bits.append(tagline)
    mid = ". ".join(mid_bits)
    tail = f"Updated weekly · fresh {YEAR} picks."
    desc = first + ". " + (mid + ". " if mid else "") + tail
    desc = re.sub(r"\s+", " ", desc).strip()
    if len(desc) > 300:
        desc = desc[:297].rsplit(" ", 1)[0] + "…"
    if len(desc) < 100:
        desc = (
            f"{primary} mix with {artist} and similar high-energy tracks. "
            f"Keywords: {', '.join([primary] + kw_bank[:4])}. {tail}"
        )[:300]
    return desc


def _traction_track_candidates(
    niche: str,
    keywords: list[str],
    genres: list[str],
    similar_artists: list[str],
    exclude: set[str],
    *,
    need: int,
    market: str = "US",
    min_popularity: int = 35,
) -> list[dict]:
    """Search for high-popularity niche tracks (anchors for algorithm + retention)."""
    queries: list[str] = []
    if niche:
        queries.extend([niche, f"{niche} hits", f"best {niche}"])
    for g in genres[:3]:
        queries.append(g)
    for k in keywords[:4]:
        queries.append(k)
    for a in similar_artists[:6]:
        queries.append(a)
        queries.append(f"{a} radio")
    scored: dict[str, dict] = {}
    for q in queries:
        res = search_tracks(q, limit=20, market=market)
        for t in res.get("tracks") or []:
            uri = t.get("uri")
            if not uri or uri in exclude:
                continue
            pop = int(t.get("popularity") or 0)
            if pop < min_popularity and len(scored) > need:
                continue
            prev = scored.get(uri)
            if not prev or pop > int(prev.get("popularity") or 0):
                scored[uri] = {
                    "uri": uri,
                    "name": t.get("name"),
                    "artists": t.get("artists"),
                    "popularity": pop,
                    "query": q,
                }
        if len(scored) >= need * 3:
            break
    ranked = sorted(scored.values(), key=lambda x: -int(x.get("popularity") or 0))
    return ranked[:need]


def _build_seo_track_order(
    focus_uri: str,
    your_uris: list[str],
    anchors: list[dict],
    *,
    size: int,
    your_ratio: float,
) -> list[str]:
    """
    Research-backed order:
    - Slots 1–2: high-popularity niche anchors (deliver keyword promise)
    - Slots 3–5: focus track + more anchors
    - Rest: ~your_ratio yours interleaved with remaining anchors
    """
    focus_uri = _normalize_uri(focus_uri, "track")
    yours = []
    seen: set[str] = set()
    if focus_uri:
        yours.append(focus_uri)
        seen.add(focus_uri)
    for u in your_uris:
        u = _normalize_uri(u, "track")
        if u and u not in seen:
            seen.add(u)
            yours.append(u)
    anchor_uris = []
    for a in anchors:
        u = a.get("uri")
        if u and u not in seen:
            seen.add(u)
            anchor_uris.append(u)

    your_n = max(1, min(len(yours), int(round(size * your_ratio)))) if yours else 0
    out: list[str] = []
    # Open with 2 anchors when available
    while len(out) < 2 and anchor_uris:
        out.append(anchor_uris.pop(0))
    # Insert focus early (pos ~3)
    if focus_uri and focus_uri in yours:
        out.append(focus_uri)
        yours = [u for u in yours if u != focus_uri]
        your_n = max(0, your_n - 1)
    # Fill remaining with interleave
    y = yours[:your_n]
    while len(out) < size and (y or anchor_uris):
        if anchor_uris and (not y or len(out) % 8 != 0):
            out.append(anchor_uris.pop(0))
        elif y:
            out.append(y.pop(0))
        elif anchor_uris:
            out.append(anchor_uris.pop(0))
    # Dedup
    final: list[str] = []
    seen2: set[str] = set()
    for u in out:
        if u not in seen2:
            seen2.add(u)
            final.append(u)
    return final[:size]


def _resolve_similar_artists(cfg: dict, track_artists: list[str]) -> list[str]:
    similar = list(cfg.get("similar_artists") or [])
    # FORMA enrichment for genres
    try:
        from forma_knowledge import similar_artists_for_genres, forma_enabled

        if forma_enabled():
            genres = list(cfg.get("genres") or []) + list(cfg.get("subgenres") or [])
            similar = list(
                dict.fromkeys(similar + similar_artists_for_genres(genres, limit=12))
            )
    except Exception:
        pass
    # Don't list yourself as "similar"
    artist = (cfg.get("artist_name") or "").strip().lower()
    aliases = {a.lower() for a in (cfg.get("aliases") or []) if a}
    if artist:
        aliases.add(artist)
    for name in track_artists:
        if name:
            aliases.add(name.lower())
    return [s for s in similar if s and s.lower() not in aliases][:12]


def plan_seo_playlist_from_song(
    focus_track: str,
    *,
    niche: str = "",
    mood: str = "",
    activity: str = "",
    keywords: list[str] | None = None,
    similar_artists: list[str] | None = None,
    name: str | None = None,
    description: str | None = None,
    playlist_size: int | None = None,
    your_track_ratio: float | None = None,
    market: str = "US",
    extra_your_uris: list[str] | None = None,
) -> dict:
    """
    Song-first planner: inspect the focus track + artist project + FORMA, then propose
    SEO title, description, niche keywords, similar artists, and a traction-weighted track list.
    Does not create the playlist until create_seo_playlist_from_song / create with plan.
    """
    focus = (focus_track or "").strip()
    if not focus:
        return {"ok": False, "message": "focus_track (Spotify URI, URL, or ID) is required"}

    track = get_track(focus, market=market)
    if not track.get("ok"):
        return track

    cfg = get_config()
    artist_name = (cfg.get("artist_name") or "").strip()
    if not artist_name and track.get("artist_names"):
        artist_name = track["artist_names"][0]

    genres = list(cfg.get("genres") or [])
    moods = list(cfg.get("moods") or [])
    if mood and mood not in moods:
        moods = [mood] + moods

    # Niche: override → genre from profile matching track vibe → first genre
    niche = (niche or "").strip()
    if not niche:
        niches = list(cfg.get("seo_niches") or [])
        niche = niches[0] if niches else (genres[0] if genres else "bass music")

    activity = (activity or "").strip()
    if not activity:
        # Infer light activity from niche words
        low = niche.lower()
        if any(x in low for x in ("workout", "gym", "run")):
            activity = "workout"
        elif any(x in low for x in ("chill", "study", "focus", "liquid")):
            activity = "focus"
        elif any(x in low for x in ("club", "festival", "rave", "party")):
            activity = "club"
        else:
            activity = "listening"

    kw = list(keywords or []) or list(cfg.get("keywords") or [])
    for extra in (niche, mood, activity, *(moods[:3]), *(genres[:3])):
        if extra and extra not in kw:
            kw.append(extra)

    similar = list(similar_artists or []) or _resolve_similar_artists(
        cfg, list(track.get("artist_names") or [])
    )

    size = int(playlist_size if playlist_size is not None else (cfg.get("playlist_size") or 50))
    size = max(20, min(100, size))
    ratio = float(
        your_track_ratio
        if your_track_ratio is not None
        else (cfg.get("your_track_ratio") or 0.12)
    )
    ratio = max(0.05, min(0.25, ratio))

    title = (name or "").strip() or _craft_seo_title(niche, mood or (moods[0] if moods else ""), activity)
    desc = (description or "").strip() or _craft_seo_description(
        niche=niche,
        artist=artist_name or "featured artists",
        focus_track=str(track.get("name") or ""),
        keywords=kw,
        similar=similar,
        moods=moods,
        activity=activity,
        cfg=cfg,
    )

    focus_uri = track["uri"]
    yours = list(dict.fromkeys([focus_uri] + list(extra_your_uris or []) + resolve_your_tracks(cfg, market=market)))
    exclude = set(yours)
    need_anchors = max(15, size - max(1, int(round(size * ratio))) + 10)
    anchors = _traction_track_candidates(
        niche,
        kw,
        genres,
        similar,
        exclude,
        need=need_anchors,
        market=market,
        min_popularity=30,
    )
    uris = _build_seo_track_order(focus_uri, yours, anchors, size=size, your_ratio=ratio)

    your_set = set(yours)
    proposed = []
    for i, u in enumerate(uris):
        if u == focus_uri:
            proposed.append(
                {
                    "position": i + 1,
                    "uri": u,
                    "name": track.get("name"),
                    "artists": ", ".join(track.get("artist_names") or []),
                    "popularity": track.get("popularity"),
                    "role": "focus",
                }
            )
            continue
        if u in your_set:
            proposed.append({"position": i + 1, "uri": u, "role": "yours"})
            continue
        meta = next((a for a in anchors if a.get("uri") == u), None) or {"uri": u}
        proposed.append(
            {
                "position": i + 1,
                "uri": u,
                "name": meta.get("name"),
                "artists": meta.get("artists"),
                "popularity": meta.get("popularity"),
                "role": "anchor",
            }
        )

    return {
        "ok": True,
        "plan": {
            "focus_track": track,
            "niche": niche,
            "mood": mood or (moods[0] if moods else ""),
            "activity": activity,
            "keywords": kw[:12],
            "similar_artists": similar,
            "name": title,
            "description": desc,
            "playlist_size": size,
            "your_track_ratio": ratio,
            "market": market,
            "track_uris": uris,
            "proposed_tracks": proposed[: size],
            "anchor_count": sum(1 for p in proposed if p.get("role") == "anchor"),
            "your_count": sum(1 for p in proposed if p.get("role") in ("focus", "yours")),
            "artist_name": artist_name,
            "rationale": (
                "Title front-loads search keywords; description packs secondary keywords + similar artists "
                "+ weekly freshness. First tracks are high-popularity niche anchors so searchers hear the "
                "promised vibe immediately; your focus song sits early (not always #1) among traction tracks."
            ),
        },
        "message": f"Planned SEO playlist “{title}” around {track.get('name')} ({len(uris)} tracks)",
    }


def create_seo_playlist_from_song(
    focus_track: str,
    *,
    niche: str = "",
    mood: str = "",
    activity: str = "",
    keywords: list[str] | None = None,
    similar_artists: list[str] | None = None,
    name: str | None = None,
    description: str | None = None,
    playlist_size: int | None = None,
    your_track_ratio: float | None = None,
    market: str = "US",
    extra_your_uris: list[str] | None = None,
    dry_run: bool = False,
    plan: dict | None = None,
) -> dict:
    """Plan (or reuse plan) then create the Spotify playlist and register it for weekly maintain."""
    if plan and isinstance(plan, dict) and plan.get("track_uris"):
        built = {"ok": True, "plan": plan}
    else:
        built = plan_seo_playlist_from_song(
            focus_track,
            niche=niche,
            mood=mood,
            activity=activity,
            keywords=keywords,
            similar_artists=similar_artists,
            name=name,
            description=description,
            playlist_size=playlist_size,
            your_track_ratio=your_track_ratio,
            market=market,
            extra_your_uris=extra_your_uris,
        )
    if not built.get("ok"):
        return built
    p = built["plan"]
    title = (name or p.get("name") or "").strip()
    desc = (description or p.get("description") or "").strip()
    uris = list(p.get("track_uris") or [])
    niche_f = (niche or p.get("niche") or "").strip()
    kw = list(keywords or p.get("keywords") or [])

    if dry_run:
        return {
            "ok": True,
            "dry_run": True,
            "plan": p,
            "message": f"Would create “{title}” with {len(uris)} tracks",
        }

    uid = _user_id()
    if not uid:
        return {"ok": False, "message": "Spotify not authenticated — complete OAuth first", "plan": p}

    cfg = get_config()
    public = bool(cfg.get("public", True))
    created = _api_post(
        f"/users/{uid}/playlists",
        json_body={"name": title, "description": desc, "public": public},
    )
    if created.get("ok") is False or not created.get("id"):
        return {
            "ok": False,
            "message": created.get("message") or "Failed to create playlist",
            "plan": p,
            "body": created,
        }

    pid = created["id"]
    for i in range(0, len(uris), 100):
        add = _api_post(f"/playlists/{pid}/tracks", json_body={"uris": uris[i : i + 100]})
        if add.get("ok") is False:
            return {
                "ok": False,
                "message": f"Playlist created but adding tracks failed: {add.get('message')}",
                "playlist_id": pid,
                "plan": p,
            }

    focus_uri = (p.get("focus_track") or {}).get("uri") or _normalize_uri(focus_track, "track")
    your_uris = [u for u in uris if u == focus_uri or u in set(resolve_your_tracks(cfg, market=market))]
    entry = {
        "id": pid,
        "name": title,
        "description": desc,
        "niche": niche_f,
        "keywords": kw[:8],
        "mood": p.get("mood"),
        "activity": p.get("activity"),
        "focus_track_uri": focus_uri,
        "similar_artists": list(p.get("similar_artists") or [])[:8],
        "url": (created.get("external_urls") or {}).get("spotify")
        or f"https://open.spotify.com/playlist/{pid}",
        "public": public,
        "your_track_uris": your_uris,
        "track_count": len(uris),
        "created": datetime.now(timezone.utc).isoformat(),
        "last_maintained": datetime.now(timezone.utc).isoformat(),
        "seo_mode": "song_first",
    }
    reg = get_registry()
    reg["playlists"] = [x for x in (reg.get("playlists") or []) if x.get("id") != pid]
    reg["playlists"].append(entry)
    _save_registry(reg)

    # Persist focus track onto artist project
    try:
        from artist_project_helper import save_artist_project

        save_artist_project(
            {
                "track_uris": [focus_uri] if focus_uri else [],
                "track_titles": [(p.get("focus_track") or {}).get("name")]
                if (p.get("focus_track") or {}).get("name")
                else [],
                "similar_artists": list(p.get("similar_artists") or [])[:12],
            }
        )
    except Exception:
        pass

    return {
        "ok": True,
        "playlist": entry,
        "plan": p,
        "message": f"Created SEO playlist “{title}” ({len(uris)} tracks) → {entry['url']}",
    }


def maintain_playlists_weekly(
    *,
    market: str | None = None,
    dry_run: bool = False,
) -> dict:
    """
    Weekly maintenance pass: refresh SEO copy, inject 2–5 fresh high-traction tracks,
    reorder so focus/your tracks stay well placed, mark schedule last_run.
    """
    from datetime import timedelta

    sch = get_schedule()
    market = (market or sch.get("market") or "US").strip() or "US"
    cfg = get_config()
    base = maintain_playlists(
        refresh_copy=bool(sch.get("refresh_copy", True)),
        ensure_your_tracks=bool(sch.get("ensure_your_tracks", True)),
        market=market,
        dry_run=dry_run,
    )
    fresh_reports = []
    if sch.get("add_fresh_tracks", True):
        for p in get_registry().get("playlists") or []:
            pid = p.get("id")
            if not pid:
                continue
            niche = (p.get("niche") or "playlist").strip()
            kw = list(p.get("keywords") or cfg.get("keywords") or [])
            similar = list(p.get("similar_artists") or cfg.get("similar_artists") or [])
            cur = _api_get(f"/playlists/{pid}/tracks", params={"limit": 100, "market": market})
            current = []
            for item in (cur.get("items") or []) if cur.get("ok") is not False else []:
                tr = (item or {}).get("track") or {}
                if tr.get("uri"):
                    current.append(tr["uri"])
            exclude = set(current)
            anchors = _traction_track_candidates(
                niche,
                kw,
                list(cfg.get("genres") or []),
                similar,
                exclude,
                need=8,
                market=market,
                min_popularity=40,
            )
            fresh = [a["uri"] for a in anchors[:5] if a.get("uri")]
            if not fresh:
                fresh_reports.append({"id": pid, "ok": True, "added": 0})
                continue
            if not dry_run:
                # Prepend fresh anchors (front-load new for engagement)
                add = _api_post(
                    f"/playlists/{pid}/tracks",
                    json_body={"uris": fresh, "position": 0},
                )
                if add.get("ok") is False:
                    fresh_reports.append(
                        {"id": pid, "ok": False, "message": add.get("message")}
                    )
                    continue
                # Cap length ~100 by trimming from end if needed
                if len(current) + len(fresh) > 100:
                    # Spotify has no bulk delete-by-position in one call without URIs;
                    # leave oversize — next ensure_your_tracks replace handles sizing.
                    pass
            fresh_reports.append({"id": pid, "ok": True, "added": len(fresh), "uris": fresh})

    now = datetime.now(timezone.utc)
    days = int(sch.get("interval_days") or 7)
    sch["last_run"] = now.isoformat()
    sch["next_due"] = (now + timedelta(days=days)).isoformat()
    if not dry_run:
        _save_json(_schedule_path(), sch)

    return {
        "ok": True,
        "maintain": base,
        "fresh": fresh_reports,
        "schedule": sch,
        "dry_run": dry_run,
        "message": (
            f"Weekly maintain done ({base.get('maintained', 0)} playlists)"
            + (" (dry run)" if dry_run else "")
        ),
    }


def run_due_scheduled_maintenance() -> dict:
    """Called by background worker; runs weekly maintain if enabled and due."""
    sch = get_schedule()
    if not sch.get("enabled"):
        return {"ok": True, "skipped": True, "reason": "schedule disabled"}
    next_due = sch.get("next_due")
    now = datetime.now(timezone.utc)
    if next_due:
        try:
            due = datetime.fromisoformat(str(next_due).replace("Z", "+00:00"))
            if due.tzinfo is None:
                due = due.replace(tzinfo=timezone.utc)
            if now < due:
                return {
                    "ok": True,
                    "skipped": True,
                    "reason": "not due yet",
                    "next_due": next_due,
                }
        except Exception:
            pass
    if not _load_token():
        return {"ok": False, "skipped": True, "reason": "spotify not authenticated"}
    return maintain_playlists_weekly(market=sch.get("market") or "US", dry_run=False)
