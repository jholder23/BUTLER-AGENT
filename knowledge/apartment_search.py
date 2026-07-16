"""
Apartment search for Butler/Butlor. Search listings, run daily, save results to the Butlor folder.
"""
from __future__ import annotations

import json
import os
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path


def _butlor_dir() -> str:
    from butlor_paths import ensure_butlor_config_dir

    return str(ensure_butlor_config_dir())


def _config_path() -> str:
    return os.path.join(_butlor_dir(), "apartment_config.json")


def get_apartment_config() -> dict:
    """Load apartment search config (location, rent, bedrooms, run time)."""
    p = _config_path()
    if not os.path.isfile(p):
        return {}
    try:
        with open(p, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def save_apartment_config(config: dict) -> None:
    """Save apartment config."""
    with open(_config_path(), "w", encoding="utf-8") as f:
        json.dump(config, f, indent=2)


def _listing_source(url: str) -> str:
    u = (url or "").lower()
    if "facebook.com/marketplace" in u or "marketplace.facebook.com" in u:
        return "facebook"
    if "zillow" in u:
        return "zillow"
    if "apartments.com" in u:
        return "apartments"
    if "craigslist" in u:
        return "craigslist"
    return "web"


def _enrich_listings(listings: list, max_enrich: int = 14, workers: int = 4) -> list:
    """Fetch og:image / description for each listing (parallel, best-effort)."""
    try:
        from web_fetcher import fetch_og_meta
    except ImportError:
        return listings
    n = min(len(listings), max_enrich)

    def enrich_one(i: int) -> tuple[int, dict]:
        L = dict(listings[i])
        url = (L.get("url") or "").strip()
        if not url.startswith("http"):
            return i, L
        meta = fetch_og_meta(url)
        if meta.get("image_url"):
            L["image_url"] = meta["image_url"]
        desc = (meta.get("description") or "").strip()
        if desc and len(desc) > len(L.get("snippet") or ""):
            L["description"] = desc
        elif desc:
            L["description"] = desc
        if meta.get("title") and len(meta["title"]) > len(L.get("title") or ""):
            L["title"] = meta["title"]
        return i, L

    if n <= 0:
        return listings
    out = list(listings)
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futures = [ex.submit(enrich_one, i) for i in range(n)]
        for fut in as_completed(futures, timeout=75):
            try:
                i, L2 = fut.result()
                out[i] = L2
            except Exception:
                continue
    return out


def search_apartments(requirements: dict | str, max_results: int = 15) -> dict:
    """
    Search for apartments based on requirements.
    requirements: dict with location, max_rent, bedrooms, keywords, etc. Or string query.
    """
    try:
        from web_fetcher import search_web
    except ImportError:
        return {"ok": False, "message": "web_fetcher not available", "listings": []}
    if isinstance(requirements, str):
        query = requirements
    else:
        loc = requirements.get("location", "")
        max_rent = requirements.get("max_rent", "")
        beds = requirements.get("bedrooms", "")
        keywords = requirements.get("keywords", "")
        parts = []
        if loc:
            parts.append(f"apartments {loc}")
        if max_rent:
            parts.append(f"under ${max_rent}")
        if beds:
            parts.append(f"{beds} bedroom")
        if keywords:
            parts.append(keywords)
        query = " ".join(parts) if parts else "apartments for rent"
    # Facebook Marketplace first (DDG site:); user may need to log in on facebook.com for full access in browser.
    queries = [
        f"site:facebook.com/marketplace {query}",
        f"facebook marketplace {query} apartment rent",
        f"site:zillow.com {query}",
        f"site:apartments.com {query}",
        f"site:craigslist.org {query}",
        f"{query} apartment rental",
    ]
    seen_urls = set()
    listings = []
    for q in queries:
        results = search_web(q, max_results=6)
        for r in results:
            url = r.get("url") or r.get("href") or ""
            if not url or url in seen_urls:
                continue
            ul = url.lower()
            if any(x in ul for x in ["login", "signup", "/twitter.", "/oauth"]):
                continue
            if "facebook.com" in ul and "marketplace" not in ul:
                continue
            seen_urls.add(url)
            title = r.get("title", "")
            snippet = (r.get("snippet") or r.get("body") or "")[:500]
            price = ""
            if snippet:
                m = re.search(r"\$[\d,]+(?:/\s*mo|\s*per\s*month)?", snippet, re.I)
                if m:
                    price = m.group(0)
            if not price and title:
                m = re.search(r"\$[\d,]+", title)
                if m:
                    price = m.group(0)
            listings.append({
                "title": title,
                "url": url,
                "snippet": snippet,
                "price": price,
                "source": _listing_source(url),
            })
            if len(listings) >= max_results:
                break
        if len(listings) >= max_results:
            break
    listings = _enrich_listings(listings, max_enrich=min(16, max(len(listings), max_results)))
    return {"ok": True, "listings": listings, "message": f"Found {len(listings)} listings", "query": query}


def _build_report_body(listings: list, query: str) -> str:
    lines = [
        f"Apartment listings – {datetime.now().strftime('%Y-%m-%d %H:%M')}\n",
        f"Query: {query}\n",
    ]
    if not listings:
        lines.append("\n(No listings returned for this search.)\n")
        return "\n".join(lines)
    for i, L in enumerate(listings, 1):
        lines.append(f"\n{i}. {L.get('title', '')[:80]}")
        if L.get("price"):
            lines.append(f"   Price: {L['price']}")
        lines.append(f"   URL: {L.get('url', '')}")
        if L.get("snippet"):
            lines.append(f"   {L['snippet'][:150]}...")
    return "\n".join(lines)


def _save_listings_to_butlor(body: str, listings: list, query: str) -> dict:
    """Write dated + latest .txt and .json under Documents/Butlor (or BUTLOR_CONFIG)."""
    butlor = _butlor_dir()
    date_str = datetime.now().strftime("%Y-%m-%d")
    stem = os.path.join(butlor, f"apartment_listings_{date_str}")
    txt_path = stem + ".txt"
    json_path = stem + ".json"
    latest_txt = os.path.join(butlor, "apartment_listings_latest.txt")
    latest_json = os.path.join(butlor, "apartment_listings_latest.json")

    payload = {
        "saved_at": datetime.now().isoformat(timespec="seconds"),
        "query": query,
        "count": len(listings),
        "listings": listings,
        "facebook_marketplace_note": "Facebook often requires a logged-in browser to view photos. Use Open Facebook below if previews are missing.",
    }

    with open(txt_path, "w", encoding="utf-8") as f:
        f.write(body)
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)
    with open(latest_txt, "w", encoding="utf-8") as f:
        f.write(body)
    with open(latest_json, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)

    return {
        "txt": txt_path,
        "json": json_path,
        "latest_txt": latest_txt,
        "latest_json": latest_json,
    }


def run_daily_search_and_email() -> dict:
    """
    Run apartment search using saved config; save results under the Butlor folder.
    (Name kept for compatibility with api_server / scheduler.)
    """
    config = get_apartment_config()
    if not config:
        return {"ok": False, "message": "No apartment config. Say 'set up apartment search' with your requirements."}
    search_r = search_apartments(config, max_results=15)
    if not search_r.get("ok"):
        return search_r
    listings = search_r.get("listings", [])
    query = search_r.get("query", "")
    body = _build_report_body(listings, query)
    paths = _save_listings_to_butlor(body, listings, query)

    n = len(listings)
    fb = sum(1 for L in listings if L.get("source") == "facebook")
    msg = (
        f"Saved {n} listing(s) to your Butlor folder:\n"
        f"• {paths['latest_txt']}\n"
        f"• {paths['latest_json']}\n"
        f"(dated copy: {paths['txt']})"
    )
    if fb:
        msg += f"\n\n{fb} from Facebook Marketplace—open the **Listings** tab for photos; log in to Facebook in your browser if images don’t load."
    else:
        msg += "\n\nOpen the **Listings** tab in Butler to browse cards with photos and links."
    return {
        "ok": True,
        "message": msg,
        "listings": listings,
        "paths": paths,
        "query": query,
        "facebook_count": fb,
    }


# Backwards-compatible alias
run_daily_apartment_search = run_daily_search_and_email
