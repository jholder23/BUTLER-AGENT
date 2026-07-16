"""
Fetch data from the web: search DuckDuckGo (ddgs / duckduckgo-search), extract content from URLs.

Search providers (future / ops):
- **Default:** DuckDuckGo via `ddgs` or `duckduckgo_search` — no API key; rate limits and blocks vary.
- **Alternatives** (add integration behind BUTLER_WEB_SEARCH_PROVIDER): Brave Search API, SerpAPI,
  Bing Web Search API, Google Custom Search, or a self-hosted SearXNG. Each needs keys or infra;
  swap `search_web` / `search_web_result_snippets_block` internals without changing agent contracts.

Content: requests + BeautifulSoup; Jina Reader for hard 403s; optional Playwright for Indeed-shaped pages.
"""
from __future__ import annotations

import concurrent.futures
import os
import re
import time
from typing import Any, Optional
from urllib.parse import parse_qs, quote, urlencode, urlparse, urlunparse

import requests
from bs4 import BeautifulSoup

try:
    from ddgs import DDGS
except ImportError:
    from duckduckgo_search import DDGS  # type: ignore

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)
MAX_CONTENT_LEN = 15000

# Trusted-source priority map for major research subjects. Search expansion uses these domains first
# when the query clearly falls into one of these categories.
_SUBJECT_SOURCE_PROFILES: tuple[dict[str, Any], ...] = (
    {
        "key": "coding_dev_docs",
        "label": "coding/dev docs",
        "keywords": (
            "api", "sdk", "docs", "documentation", "reference", "python", "javascript", "typescript",
            "react", "node", "npm", "sql", "postgres", "docker", "kubernetes", "css", "html",
            "debug", "stack trace", "error", "exception", "framework",
        ),
        "domains": (
            "docs.python.org", "developer.mozilla.org", "react.dev", "nodejs.org",
            "learn.microsoft.com", "docs.github.com", "docs.aws.amazon.com",
            "cloud.google.com", "developer.apple.com", "kubernetes.io",
        ),
        "search_terms": ("official docs", "api reference", "troubleshooting"),
        "comparison_terms": ("github discussion", "forum solution"),
        "page_fetches": 4,
    },
    {
        "key": "health_medical",
        "label": "health/medical",
        "keywords": (
            "symptom", "symptoms", "treatment", "diagnosis", "diagnostic", "doctor", "disease",
            "infection", "medication", "medicine", "side effect", "dose", "dosage", "vaccine",
            "condition", "illness", "pain", "therapy", "guideline",
        ),
        "domains": (
            "cdc.gov", "medlineplus.gov", "nih.gov", "ncbi.nlm.nih.gov",
            "mayoclinic.org", "nhs.uk", "who.int", "fda.gov",
        ),
        "search_terms": ("guideline", "treatment guidance", "patient information"),
        "comparison_terms": ("systematic review", "clinical evidence"),
        "page_fetches": 5,
    },
    {
        "key": "law_government_civic",
        "label": "law/government/civic",
        "keywords": (
            "law", "legal", "statute", "regulation", "ordinance", "rights", "court", "judge",
            "policy", "permit", "license", "licence", "tax", "benefits", "visa", "immigration",
            "ballot", "election", "government", "civic",
        ),
        "domains": (
            "usa.gov", "congress.gov", "supremecourt.gov", "law.cornell.edu",
            "irs.gov", "sec.gov", "ftc.gov", "canada.ca",
        ),
        "search_terms": ("official guidance", "requirements", "filing instructions"),
        "comparison_terms": ("state law", "agency guidance"),
        "page_fetches": 5,
    },
    {
        "key": "finance_investing",
        "label": "finance/investing",
        "keywords": (
            "stock", "stocks", "invest", "investing", "fund", "etf", "bond", "bonds", "dividend",
            "portfolio", "earnings", "inflation", "interest rate", "mortgage", "retirement",
            "401k", "ira", "tax loss", "valuation", "financial",
        ),
        "domains": (
            "sec.gov", "investor.gov", "finra.org", "federalreserve.gov",
            "treasury.gov", "morningstar.com", "investopedia.com",
        ),
        "search_terms": ("official filing", "investor bulletin", "market data"),
        "comparison_terms": ("analyst commentary", "fund comparison"),
        "page_fetches": 4,
    },
    {
        "key": "shopping_products",
        "label": "shopping/products",
        "keywords": (
            "buy", "price", "pricing", "deal", "coupon", "shipping", "review", "reviews",
            "compare", "comparison", "vs", "best", "product", "products", "warranty", "specs",
        ),
        "domains": (
            "wirecutter.com", "rtings.com", "consumerreports.org",
            "amazon.com", "bestbuy.com", "walmart.com", "target.com",
        ),
        "search_terms": ("buying guide", "expert review", "best price"),
        "comparison_terms": ("reddit review", "hands-on comparison"),
        "page_fetches": 4,
    },
    {
        "key": "travel_local_info",
        "label": "travel/local info",
        "keywords": (
            "hotel", "flight", "airport", "train", "bus", "subway", "restaurant", "near me",
            "open now", "hours", "directions", "tourism", "trip", "travel", "local", "parking",
            "visa", "customs", "tsa",
        ),
        "domains": (
            "tripadvisor.com", "rome2rio.com", "nps.gov", "tsa.gov",
            "faa.gov", "booking.com", "airbnb.com", "yelp.com",
        ),
        "search_terms": ("official hours", "visitor information", "route planner"),
        "comparison_terms": ("recent traveler review", "local forum"),
        "page_fetches": 4,
    },
    {
        "key": "news_current_events",
        "label": "news/current events",
        "keywords": (
            "news", "latest", "today", "current", "breaking", "update", "updates", "headline",
            "headlines", "developing", "live updates", "what happened", "current events",
        ),
        "domains": (
            "reuters.com", "apnews.com", "bbc.com", "npr.org",
            "nytimes.com", "wsj.com",
        ),
        "search_terms": ("latest update", "explainer", "timeline"),
        "comparison_terms": ("fact check", "analysis"),
        "page_fetches": 4,
    },
    {
        "key": "science_research",
        "label": "science/research",
        "keywords": (
            "study", "studies", "research", "paper", "papers", "journal", "trial", "evidence",
            "preprint", "meta analysis", "systematic review", "experiment", "scientific",
        ),
        "domains": (
            "pubmed.ncbi.nlm.nih.gov", "ncbi.nlm.nih.gov", "nature.com",
            "science.org", "arxiv.org", "sciencedirect.com",
        ),
        "search_terms": ("review paper", "evidence summary", "consensus"),
        "comparison_terms": ("systematic review", "meta analysis"),
        "page_fetches": 5,
    },
    {
        "key": "entertainment_media",
        "label": "entertainment/media",
        "keywords": (
            "movie", "movies", "tv", "show", "shows", "series", "actor", "actress", "cast",
            "album", "song", "music", "streaming", "trailer", "box office", "episode", "game",
            "games", "release date",
        ),
        "domains": (
            "imdb.com", "rottentomatoes.com", "metacritic.com",
            "thetvdb.com", "allmusic.com", "spotify.com", "youtube.com",
        ),
        "search_terms": ("official site", "cast list", "review roundup"),
        "comparison_terms": ("fan discussion", "critic review"),
        "page_fetches": 3,
    },
)


def _count_subject_keyword_hits(query: str, keywords: tuple[str, ...]) -> int:
    low = (query or "").lower()
    hits = 0
    for keyword in keywords:
        kw = (keyword or "").strip().lower()
        if not kw:
            continue
        pattern = r"\b" + re.escape(kw).replace(r"\ ", r"\s+") + r"\b"
        if re.search(pattern, low):
            hits += 1
    return hits


def _query_subject_source_profile(query: str) -> dict[str, Any] | None:
    q = (query or "").strip()
    if not q:
        return None
    best: dict[str, Any] | None = None
    best_score = 0
    for profile in _SUBJECT_SOURCE_PROFILES:
        score = _count_subject_keyword_hits(q, tuple(profile.get("keywords") or ()))
        if score > best_score:
            best = profile
            best_score = score
    return best if best_score > 0 else None


def _query_wants_deeper_research(query: str) -> bool:
    low = (query or "").lower()
    if not low:
        return False
    if len(low) > 90:
        return True
    return bool(
        re.search(
            r"\b(compare|comparison|vs\b|versus|deep|in[- ]depth|research|sources|evidence|best|top|latest|"
            r"current|official|trust|trusted|review|reviews|pros and cons|trade[- ]offs|roundup|guide)\b",
            low,
        )
    )


def subject_source_category_summaries() -> list[dict[str, Any]]:
    """Human-readable category/source list for prompts, tests, and debugging."""
    out: list[dict[str, Any]] = []
    for profile in _SUBJECT_SOURCE_PROFILES:
        out.append(
            {
                "key": str(profile.get("key") or ""),
                "label": str(profile.get("label") or ""),
                "domains": list(profile.get("domains") or ())[:8],
            }
        )
    return out


def _host_from_url(url: str) -> str:
    try:
        host = urlparse((url or "").strip()).netloc.lower()
    except Exception:
        return ""
    if host.startswith("www."):
        host = host[4:]
    return host


def _host_matches_domain(host: str, domain: str) -> bool:
    h = (host or "").strip().lower()
    d = (domain or "").strip().lower()
    if not h or not d:
        return False
    return h == d or h.endswith("." + d)


def _profile_domain_rank(url: str, profile: dict[str, Any] | None) -> int:
    if not profile:
        return 10_000
    host = _host_from_url(url)
    for i, domain in enumerate(tuple(profile.get("domains") or ())):
        if _host_matches_domain(host, str(domain)):
            return i
    return 10_000


def _subject_priority_queries(query: str, profile: dict[str, Any] | None, max_queries: int = 3) -> list[str]:
    q = " ".join((query or "").split())[:220].strip()
    if not q or not profile:
        return []
    out: list[str] = []
    seen: set[str] = set()

    def _push(s: str) -> None:
        text = " ".join((s or "").split())[:240].strip()
        if len(text) < 10:
            return
        key = text.lower()
        if key in seen:
            return
        seen.add(key)
        out.append(text)

    for domain in tuple(profile.get("domains") or ())[: max(1, min(max_queries, 4))]:
        _push(f"{q} site:{domain}")
    for suffix in tuple(profile.get("search_terms") or ())[:2]:
        _push(f"{q} {suffix}")
    return out[: max(1, min(max_queries, 5))]


def _subject_comparison_queries(query: str, profile: dict[str, Any] | None, max_queries: int = 2) -> list[str]:
    q = " ".join((query or "").split())[:220].strip()
    if not q or not profile:
        return []
    out: list[str] = []
    seen: set[str] = set()
    for suffix in tuple(profile.get("comparison_terms") or ())[: max(1, min(max_queries, 3))]:
        text = f"{q} {suffix}".strip()
        key = text.lower()
        if key not in seen:
            seen.add(key)
            out.append(text[:240])
    return out[: max(1, min(max_queries, 3))]


def _rank_search_results(query: str, rows: list, profile: dict[str, Any] | None = None) -> list:
    q = (query or "").strip()
    if not rows:
        return []
    sig = _significant_query_tokens(q)
    strong = _strong_overlap_tokens(sig)

    def _key(item: tuple[int, dict]) -> tuple[int, int, int, int, int, int]:
        idx, row = item
        url = (row.get("url") or row.get("href") or "").strip()
        blob = _ddg_blob(row)
        domain_rank = _profile_domain_rank(url, profile)
        overlap_hits = sum(1 for tok in sig if tok in blob)
        strong_hits = sum(1 for tok in strong if tok in blob)
        relevant = 0 if _ddg_result_matches_query(q, row, sig) else 1
        trusted = 0 if domain_rank < 10_000 else 1
        return (
            relevant,
            trusted,
            domain_rank,
            -strong_hits,
            -overlap_hits,
            idx,
        )

    return [row for _, row in sorted(enumerate(rows), key=_key)]


def _ddg_search_timeout_sec() -> float:
    """Avoid a stuck metasearch call blocking /chat for many minutes."""
    # Video / open-web discovery can trigger multiple DDG passes; keep each pass short so the whole
    # /chat turn stays under UI timeouts. Users can raise via env if desired.
    raw = (os.environ.get("BUTLER_DDG_SEARCH_TIMEOUT_SEC") or "6").strip()
    try:
        v = float(raw)
        return max(3.0, min(v, 45.0))
    except ValueError:
        return 8.0


def _html_to_plain_text(html: str) -> str:
    if not (html or "").strip():
        return ""
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style", "nav", "footer", "header"]):
        tag.decompose()
    text = re.sub(r"\s+", " ", soup.get_text(separator=" ", strip=True)).strip()
    return text


def _jina_text_is_blocked_stub(text: str) -> bool:
    """Jina may return 200 with a Cloudflare / 403 stub instead of the job page."""
    low = (text or "").lower()
    if "target url returned error 403" in low:
        return True
    if "just a moment" in low and ("checking your browser" in low or "enable javascript" in low):
        return True
    return False


def _fetch_via_jina_reader(url: str) -> str:
    """Indeed/LinkedIn often 403 plain HTTP; Jina Reader returns article text (third-party service)."""
    try:
        # Encode full target URL so ?& in query are not treated as our request's query string.
        jina = "https://r.jina.ai/" + quote(url, safe="")
        r = requests.get(jina, headers={"User-Agent": USER_AGENT, "Accept": "text/plain,text/markdown,*/*"}, timeout=35)
        r.raise_for_status()
        t = (r.text or "").strip()
        if len(t) < 80 or _jina_text_is_blocked_stub(t):
            return ""
        return t
    except Exception:
        return ""


def _fetch_indeed_via_playwright(url: str) -> str:
    """Last resort: real Chromium (Indeed often 403s TLS/http clients). Requires: playwright install chromium."""
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        return ""
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            try:
                page = browser.new_page(user_agent=USER_AGENT)
                page.goto(url, wait_until="domcontentloaded", timeout=55_000)
                page.wait_for_timeout(2500)
                text = _html_to_plain_text(page.content())
                if text and len(text) > 80:
                    return text
            finally:
                browser.close()
    except Exception:
        pass
    return ""


def _indeed_url_variants(url: str) -> list[str]:
    """Try full URL then jk-only query (fewer params can change bot scoring)."""
    u = (url or "").strip()
    out = []
    if u:
        out.append(u)
    try:
        p = urlparse(u)
        qs = parse_qs(p.query)
        if "jk" in qs and qs["jk"]:
            minimal = urlunparse(
                (p.scheme, p.netloc, p.path, "", urlencode({"jk": qs["jk"][0]}), "")
            )
            if minimal not in out:
                out.append(minimal)
    except Exception:
        pass
    return out


def _fetch_indeed_job_page(url: str) -> str:
    """Indeed blocks naive requests (403); try cloudscraper (retry + URL variants), then browser-like GET, then Jina."""
    last_err = None
    variants = _indeed_url_variants(url)
    try:
        import cloudscraper

        session = cloudscraper.create_scraper()
        for attempt in range(3):
            for u in variants:
                try:
                    r = session.get(
                        u,
                        headers={
                            "User-Agent": USER_AGENT,
                            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                            "Accept-Language": "en-US,en;q=0.9",
                            "Referer": "https://www.indeed.com/",
                        },
                        timeout=25,
                        allow_redirects=True,
                    )
                    r.raise_for_status()
                    r.encoding = r.apparent_encoding or "utf-8"
                    text = _html_to_plain_text(r.text)
                    if text and len(text) > 80:
                        return text
                except Exception as e:
                    last_err = e
            if attempt < 2:
                time.sleep(0.6 * (attempt + 1))
    except Exception as e:
        last_err = e
    for u in variants:
        try:
            r = requests.get(
                u,
                headers={
                    "User-Agent": USER_AGENT,
                    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
                    "Accept-Language": "en-US,en;q=0.9",
                    "Cache-Control": "no-cache",
                    "Referer": "https://www.indeed.com/",
                },
                timeout=20,
                allow_redirects=True,
            )
            r.raise_for_status()
            r.encoding = r.apparent_encoding or "utf-8"
            text = _html_to_plain_text(r.text)
            if text and len(text) > 80:
                return text
        except Exception as e:
            last_err = e
    pw = _fetch_indeed_via_playwright(url)
    if pw:
        return pw
    t = _fetch_via_jina_reader(url)
    if t:
        return t
    hint = " Indeed often blocks bots - paste the job description into the box, or try again later."
    if last_err is not None:
        return f"[Fetch error: {last_err}]{hint}"
    return f"[Fetch error: Could not load posting.]{hint}"


def _search_web_blocking(query: str, max_results: int) -> list:
    mr = max(1, min(int(max_results) or 5, 20))
    q = (query or "").strip()[:500]
    if not q:
        return []
    with DDGS() as ddgs:
        results = list(ddgs.text(q, max_results=mr))
    return [
        {"title": r.get("title", ""), "url": r.get("href") or r.get("url", ""), "snippet": r.get("body") or r.get("description", "")}
        for r in results
        if r.get("href") or r.get("url")
    ]


def search_web(query: str, max_results: int = 5) -> list:
    """
    DuckDuckGo-style text SERP via `ddgs` (successor package). Wrapped in a hard wall-clock timeout so hung
    DDG backends cannot stall Butler's local model path for tens of minutes.
    """
    t = _ddg_search_timeout_sec()
    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as ex:
            fut = ex.submit(_search_web_blocking, query, max_results)
            rows = fut.result(timeout=t)
            return _rank_search_results((query or "").strip(), rows, _query_subject_source_profile(query))
    except concurrent.futures.TimeoutError:
        print(f"  [Search timeout ({t:.0f}s): {(query or '')[:90]!r}]")
        return []
    except Exception as e:
        print(f"  [Search error: {e}]")
        return []


_STRONG_QUERY_STOP = frozenset(
    "what would could should that this with from your have been were they their about into "
    "year years tell explain consider considered please just like know want need help".split()
)

# Tokens that appear in many unrelated snippets (dictionaries, blogs); never let them alone
# "prove" a DDG hit matches the query (e.g. "good" in happy definitions for a "... good ... porn" search).
# Includes "saved"/"save" — Chrome/Google help pages rank for that word but are not media results.
_OVERLAP_WEAK_TOKENS = frozenset(
    _STRONG_QUERY_STOP
    | frozenset(
        "good great greater greatest better best worst bad real really truly find show shows "
        "free online type types kind kinds list long high low new old big small most much many "
        "some make made work works well hard easy part parts ways back home down sure open "
        "close world life live lived living feel feeling feelings happy happier happiest sad "
        "where when which while whose whom how why what who "
        "learn mean means meaning meant watch watching page pages "
        "saved save saves saving "
        # site / websites alone match Chrome & Google help SEO, not the user's topic.
        "site sites website websites webpages webpage "
        "thing things stuff info news read reading get got use used using try tried "
        "look looking looked seem seems seemed take took give gave need needs needed "
        "want wants wanted help helps helped keep kept put puts end ends".split()
    )
)

# Bare tech acronyms in user text → Wikipedia opensearch often returns unrelated articles (e.g. "LLM" → language model).
# Skip pushing these as wiki queries; filament acronyms are handled above via _filament_acronym_wikipedia_title.
_WIKI_BARE_ACRONYM_BLACKLIST = frozenset(
    "LLM AI ML DL NLP GPU CPU API SDK CLI GUI HTTP HTTPS JSON XML HTML CSS SQL TLS SSH DNS URI URL "
    "REST CRUD IDE OOP RPC JWT SSO MFA CDN VPS LAN WAN USB RAM ROM SSD HDD FTP SMTP IMAP LDAP YAML TOML "
    "GRPC WEB WASM NPM PY JS TS GIT CI CD".split()
)


def _significant_query_tokens(q: str) -> set[str]:
    """Tokens DDG hits must overlap with; filters poisoned results (e.g. 'male' → unrelated sports)."""
    low = (q or "").lower()
    words = re.findall(r"[a-z]{4,}", low)
    toks = {w for w in words if w not in _STRONG_QUERY_STOP}
    # Short domain words matter for overlap but are skipped by [a-z]{4,} (e.g. "porn").
    for m in re.findall(r"\b(porn|xxx|sex|nsfw|bdsm|anal|oral|cum|fuck|cock|dick|tits|nude|nudes)\b", low):
        toks.add(m)
    for m in re.findall(
        r"\b(mdma|molly|cocaine|coke|heroin|ketamine|fentanyl|methamphetamine|meth|tramadol|"
        r"buprenorphine|naloxone|oxycodone|hydrocodone|percocet|xanax|alprazolam|benzo|benzodiazepine|opioid|opiate|"
        r"fent|cannabis|marijuana|weed|thc|psilocybin|lsd|pcp|dmt|ghb|gbl|kratom|edibles)\b",
        low,
    ):
        toks.add(m)
    for m in re.findall(r"\b[A-Z][A-Z0-9]{1,5}\b", q or ""):
        toks.add(m.lower())
    return toks


def _strong_overlap_tokens(sig: set[str]) -> set[str]:
    """Subset of sig that can single-handedly indicate a relevant hit."""
    return {t for t in sig if t not in _OVERLAP_WEAK_TOKENS}


def _ddg_blob(r: dict) -> str:
    return f"{r.get('title', '')} {r.get('snippet', '')} {r.get('body', '')} {r.get('description', '')}".lower()


def _ddg_result_matches_query(query: str, r: dict, sig: set[str]) -> bool:
    if not sig:
        return True
    blob = _ddg_blob(r)
    strong = _strong_overlap_tokens(sig)
    if strong:
        return any(t in blob for t in strong)
    # Only weak / generic tokens: require two independent hits to reduce false positives.
    hits = sum(1 for t in sig if t in blob)
    return hits >= min(3, max(2, len(sig)))


_FDM_OR_FILAMENT_MARKERS = frozenset(
    "filament fdm fff 3d print printer printing extruder hotend nozzle slicer cura prusa prusaslicer "
    "bambu petg abs infill layer gcode mold mould concrete cement casting cast resin warping "
    "bed adhesion polylactic openscad stl".split()
)


def _query_suggests_fdm_or_filament(q: str) -> bool:
    """True when the user is probably talking about desktop 3D printing, not military/geopolitical acronyms."""
    low = (q or "").lower()
    if any(m in low for m in _FDM_OR_FILAMENT_MARKERS):
        return True
    if re.search(r"\bpla\b", low) or re.search(r"\bpetg\b", low):
        return True
    return False


def _filament_acronym_wikipedia_title(acronym: str, full_query: str) -> Optional[str]:
    if not _query_suggests_fdm_or_filament(full_query):
        return None
    a = (acronym or "").strip().upper()
    return {
        "PLA": "Polylactic acid",
        "ABS": "Acrylonitrile butadiene styrene",
        "PETG": "Polyethylene terephthalate glycol",
    }.get(a)


def _wikipedia_query_variants(q: str) -> list[str]:
    """Shorter / entity-focused queries when the full question yields no DDG hits."""
    q = (q or "").strip()
    out: list[str] = []
    seen_lower: set[str] = set()

    def _push(s: str) -> None:
        s = (s or "").strip()
        if not s:
            return
        k = s.lower()
        if k in seen_lower:
            return
        seen_lower.add(k)
        out.append(s)

    # Prefer polymer articles when PLA/PETG/ABS appear in a printing context (avoids "PLA" → Chinese military).
    low_full = q.lower()
    if re.search(r"\bpla\b", low_full) and _query_suggests_fdm_or_filament(q):
        _push("Polylactic acid")
    if re.search(r"\bpetg\b", low_full) and _query_suggests_fdm_or_filament(q):
        _push("Polyethylene terephthalate glycol")
    if re.search(r"\babs\b", low_full) and re.search(
        r"\b(filament|print|printer|extruder|slicer|fdm|hotend|nozzle|3d)\b", low_full
    ):
        _push("Acrylonitrile butadiene styrene")

    for m in re.findall(r"\b[A-Z][A-Z0-9]{1,5}\b", q):
        wiki_title = _filament_acronym_wikipedia_title(m, q)
        if wiki_title:
            _push(wiki_title)
            continue
        if m in _WIKI_BARE_ACRONYM_BLACKLIST:
            continue
        _push(m)
    if q:
        _push(q[:200])
    core = re.sub(r"(?i)^\s*(what|how|why|when|where|who)\s+", "", q)
    core = re.sub(
        r"(?i)\b(what|would|could|should|is|are|the|a|an|for|of|in|to|be|considered|safe|dosage|dose|dosing|"
        r"year|years|old|male|female|man|woman|person|people|about|explain|tell|me|any|some)\b",
        " ",
        core,
    )
    core = re.sub(r"\d+\s*[-]?\s*year\s*[-]?\s*old", " ", core, flags=re.I)
    core = re.sub(r"[\d\-_]+", " ", core)
    core = re.sub(r"\s+", " ", core).strip()[:100]
    if core and len(core) > 2 and re.search(r"[a-zA-Z]{3}", core):
        _push(core)
    return out[:6]


def wikipedia_context_from_queries(
    queries: list[str], max_chars: int = 3200, user_message_for_disambig: str = ""
) -> str:
    """
    Wikipedia opensearch + REST summary. Works when DDG blocks or empty for sensitive topics.
    """
    seen_titles: set[str] = set()
    blocks: list[str] = []
    budget = max(800, min(max_chars, 6000))
    skip_pla_army = bool(
        user_message_for_disambig
        and _query_suggests_fdm_or_filament(user_message_for_disambig)
    )
    for raw_q in queries:
        q = (raw_q or "").strip()[:220]
        if not q:
            continue
        try:
            r = requests.get(
                "https://en.wikipedia.org/w/api.php",
                params={
                    "action": "opensearch",
                    "search": q,
                    "limit": 2,
                    "namespace": 0,
                    "format": "json",
                },
                headers={"User-Agent": USER_AGENT},
                timeout=16,
            )
            r.raise_for_status()
            data = r.json()
            titles = data[1] if isinstance(data, list) and len(data) > 1 else []
        except Exception:
            continue
        for title in titles[:2]:
            if not title or title in seen_titles:
                continue
            if skip_pla_army and title == "People's Liberation Army":
                continue
            seen_titles.add(title)
            try:
                path_title = quote(title.replace(" ", "_"), safe="")
                sr = requests.get(
                    f"https://en.wikipedia.org/api/rest_v1/page/summary/{path_title}",
                    headers={"User-Agent": USER_AGENT},
                    timeout=16,
                )
                if sr.status_code != 200:
                    continue
                jd = sr.json()
                if jd.get("type") == "disambiguation":
                    continue
                extract = (jd.get("extract") or "").strip()
                if not extract:
                    continue
                url = (jd.get("content_urls") or {}).get("desktop", {}).get("page", "")
                blocks.append(f"(Wikipedia — {title})\n{url}\n\n{extract}")
                joined = "\n\n---\n\n".join(blocks)
                if len(joined) >= budget * 0.85:
                    return joined[:budget]
            except Exception:
                continue
    if not blocks:
        return ""
    return "\n\n---\n\n".join(blocks)[:budget]


def _query_year_constraints(q: str) -> list[str]:
    """Calendar years explicitly mentioned in the query."""
    low = (q or "").strip().lower()
    if not low:
        return []
    years: list[str] = []
    for m in re.finditer(r"\b(?:made in|from|in|dated|uploaded|posted)\s+(20\d{2}|19\d{2})\b", low):
        years.append(m.group(1))
    for y in re.findall(r"\b(20\d{2}|19\d{2})\b", low):
        if y not in years:
            years.append(y)
    return years[:3]


def _query_suggests_video_discovery(q: str) -> bool:
    """User is looking for clips / streams / uploads—not browser UI about 'saved passwords'."""
    low = (q or "").lower()
    if re.search(
        r"\b(?:return|find|give|show)\s+(?:me\s+)?(?:one|a)\s+(?:video|clip)\b",
        low,
    ):
        return True
    if "return one video" in low or (
        "one video" in low and any(k in low for k in ("find", "return", "give", "want", "need"))
    ):
        return True
    if any(
        h in low
        for h in (
            "youtube.com",
            "youtu.be",
            "vimeo.com",
            "twitch.tv",
            "dailymotion",
            "tiktok.com",
            "streamable",
        )
    ):
        return True
    wants = any(
        x in low
        for x in (
            "find ",
            "search ",
            "watch ",
            "show ",
            "play ",
            "looking for",
            "where can",
            "where to",
            "need a",
            "give me",
            "link to",
            "playable",
        )
    )
    media = bool(
        re.search(r"\b(video|videos|clip|clips|reel|reels|stream|streaming|movie|movies|film|footage)\b", low)
    )
    return wants and media


def _video_discovery_ddg_boost_query(q: str) -> str | None:
    """
    Second DDG pass: broaden toward video/watch SERPs without locking to one host.
    (A YouTube-only `site:youtube.com` boost hid matching pages on other domains, including adult tubes.)
    """
    if not _query_suggests_video_discovery(q):
        return None
    base = " ".join((q or "").split())[:220].strip()
    if not base:
        return None
    return f"{base} video"


def _video_discovery_secondary_boost_query(q: str) -> str | None:
    """Third DDG pass: alternate ‘watch/stream’ phrasing tends to broaden SERPs (beyond `… video`)."""
    if not _query_suggests_video_discovery(q):
        return None
    base = " ".join((q or "").split())[:220].strip()
    if not base:
        return None
    return f"{base} watch online"


_SUBSTANCE_TOPIC_WORDS_RE = re.compile(
    r"\b(?:mdma|molly|ecstasy|ketamine|cocaine|coke|crack|heroin|fentanyl|fent|methamphetamine|meth|"
    r"tramadol|buprenorphine|suboxone|naloxone|narcan|oxycodone|oxycontin|oxy|hydrocodone|percocet|vicodin|"
    r"xanax|alprazolam|clonazepam|lorazepam|diazepam|valium|klonopin|benzo|benzos|benzodiazepine|benzodiazepines|"
    r"opioid|opioids|opiate|opiates|kratom|psilocybin|shrooms|lsd|dmt|ayahuasca|mescaline|peyote|salvia|"
    r"2c-b|2cb|nbome|ghb|gbl|nitrous|whippet|whippets|mephedrone|spice|k2|cannabis|marijuana|thc|"
    r"hash|edibles|dab|dabs|cartridge|amphetamine|adderall|vyvanse|ritalin|concerta|dexedrine|modafinil|"
    r"codeine|lean|promethazine)\b",
    re.I,
)
_SUBSTANCE_TOPIC_PHRASE_RE = re.compile(
    r"\b(acid trip|bad trip|trip report|harm reduction|serotonin syndrome|polydrug|boofing|plugging|"
    r"reagent test|pressed pill|ego death|set and setting|comedown|street dose|recreational drug|"
    r"recreational use|club drugs?|party drugs?|illegal drugs?|synthetic opioids?|"
    r"erowid|psychonaut wiki|psychonaut\b|drug combinations?|volumetric dosing|microdosing|microdose|"
    r"nbome|research chemicals?|black tar|speedball)\b",
    re.I,
)


def _query_substance_topic_prefers_open_web(query: str) -> bool:
    """Psychoactive / harm-reduction-style questions: prefer diverse SERPs + scraped pages over Wikipedia summaries."""
    low = (query or "").strip().lower()
    if not low:
        return False
    if _SUBSTANCE_TOPIC_WORDS_RE.search(low):
        return True
    if _SUBSTANCE_TOPIC_PHRASE_RE.search(low):
        return True
    # Generic "drug(s)" wording about use, dosing, mixing — open web beats encyclopedia stubs.
    if re.search(r"\b(drugs?|substances?|pill|pills|narcotics?)\b", low) and re.search(
        r"\b(dose|dosing|dosage|effects?|high|experience|withdrawal|combo|interaction|safely|fatal| overdose|potency)\b",
        low,
    ):
        return True
    return False


def _open_web_serp_followup_queries(q: str) -> list[str]:
    """
    Extra DDG queries when the bare user string often yields censored or generic SERPs
    (Chrome / Google Account help, Baidu dictionary, etc.).
    """
    if not (
        _query_prefers_open_web_over_wikipedia(q) or _query_substance_topic_prefers_open_web(q)
    ):
        return []
    base = " ".join((q or "").split())[:280].strip()
    if not base:
        return []
    return [
        f"{base} site:reddit.com",
        f"{base} forum discussion",
    ]


def _collect_merged_ddg_rows(
    q: str, *, primary_max: int, extra_max: int = 6
) -> list:
    """Primary DDG + optional video boost + open-web follow-ups; deduped by URL."""
    q = (q or "").strip()
    if not q:
        return []
    profile = _query_subject_source_profile(q)
    wants_deeper = _query_wants_deeper_research(q)
    seen_u: set[str] = set()
    out: list = []

    def _add(rows: list) -> None:
        for r in rows or []:
            u = (r.get("url") or r.get("href") or "").strip()
            if u and u not in seen_u:
                seen_u.add(u)
                out.append(r)

    _add(search_web(q[:500], max_results=primary_max))
    if profile and not _query_suggests_video_discovery(q):
        trusted_cap = 3 if wants_deeper else 2
        for trusted_q in _subject_priority_queries(q, profile, max_queries=trusted_cap):
            _add(search_web(trusted_q[:500], max_results=max(4, min(extra_max, 6))))
    boost_q = _video_discovery_ddg_boost_query(q)
    if boost_q:
        _add(search_web(boost_q[:500], max_results=extra_max))
    boost2 = _video_discovery_secondary_boost_query(q)
    if boost2 and boost2.strip().lower() != (boost_q or "").strip().lower():
        _add(search_web(boost2[:500], max_results=max(4, extra_max - 1)))
    years = _query_year_constraints(q)
    if years and _query_suggests_video_discovery(q):
        base = " ".join((q or "").split())[:200].strip()
        if base:
            y = years[0]
            year_q = f"{base} {y} video"
            _add(search_web(year_q[:500], max_results=max(4, extra_max - 1)))
    # Pure video-style discovery already gets diversification from `boost_q`/`boost2`; Reddit/forum follow-ups are
    # two extra metasearch round-trips and often slow or irrelevant for tube-style asks.
    if not boost_q or _query_substance_topic_prefers_open_web(q):
        for fq in _open_web_serp_followup_queries(q):
            _add(search_web(fq[:500], max_results=extra_max))
    if profile and not _query_suggests_video_discovery(q) and (wants_deeper or len(out) < max(6, primary_max)):
        for deep_q in _subject_comparison_queries(q, profile, max_queries=2):
            _add(search_web(deep_q[:500], max_results=max(3, min(extra_max, 5))))
    return _rank_search_results(q, out, profile)


def _apply_ddg_overlap_filter(query: str, rows: list) -> list:
    """Same relevance gate as gather_web_answer_context (drops Chrome/help spam)."""
    sig = _significant_query_tokens(query)
    if not sig:
        return list(rows or [])
    filtered = [r for r in rows if _ddg_result_matches_query(query, r, sig)]
    strong = _strong_overlap_tokens(sig)
    if filtered:
        return filtered
    if strong:
        return []
    return list(rows or [])


def _query_prefers_open_web_over_wikipedia(query: str) -> bool:
    """
    Skip Wikipedia + medical DDG boosters when the user wants live web / media / explicit discovery.
    (Otherwise unrelated opensearch hits—e.g. from acronyms in long prompts—can bury useful DDG links.)
    """
    low = (query or "").lower()
    if any(
        x in low
        for x in (
            "porn",
            "xxx",
            "nsfw",
            "onlyfans",
            "deepfake",
            "nude",
            "nudes",
            "erotic",
            "sex video",
            "sex videos",
            "amateur",
            "camgirl",
            "cam girl",
            "chaturbate",
            "redtube",
            "pornhub",
            "xvideos",
            "xhamster",
            "spankbang",
        )
    ):
        return True
    if re.search(r"\b(ind|find)\s+me\b", low) and any(
        x in low
        for x in (
            "website",
            "websites",
            "video",
            "videos",
            "porn",
            "amateur",
            "nsfw",
            "link",
            "links",
            "stream",
            "watch",
        )
    ):
        return True
    if any(x in low for x in ("find me", "find good", "find some", "best sites", "good sites", "show me")) and any(
        x in low for x in ("video", "videos", "site", "sites", "link", "links", "stream", "watch")
    ):
        return True
    if _query_suggests_video_discovery(query):
        return True
    return False


def gather_web_answer_context(query: str, max_chars: int = 4000) -> str:
    """
    Open web first: merged DuckDuckGo SERP (video / Reddit / forum diversification when applicable),
    overlap-filtered relevance, optional multi-page text extraction, then a **small** Wikipedia tail
    only when the query is not open-web- or substance-heavy (Wikipedia is supplementary, not the primary answer).
    """
    q = (query or "").strip()
    if not q:
        return ""
    sig = _significant_query_tokens(q)
    profile = _query_subject_source_profile(q)
    wants_deeper = _query_wants_deeper_research(q)
    open_web_rich = _query_prefers_open_web_over_wikipedia(q) or _query_substance_topic_prefers_open_web(q)
    primary_max = 12 if open_web_rich else 9
    extra_max = 9 if open_web_rich else 7

    seen_urls: set[str] = set()
    results: list = []

    def _merge(new: list) -> None:
        for r in new or []:
            u = (r.get("url") or r.get("href") or "").strip()
            if u and u not in seen_urls:
                seen_urls.add(u)
                results.append(r)

    _merge(_collect_merged_ddg_rows(q, primary_max=primary_max, extra_max=extra_max))
    if len(results) < 4:
        _merge(search_web(q[:500], max_results=12))

    if sig:
        filtered = [r for r in results if _ddg_result_matches_query(q, r, sig)]
        strong = _strong_overlap_tokens(sig)
        if filtered:
            results = filtered
        elif strong:
            results = []
        # else: weak-only sig — keep original results
    results = _rank_search_results(q, results, profile)

    parts: list[str] = []
    for r in results[:10]:
        title = (r.get("title") or "").strip()
        url = (r.get("url") or r.get("href") or "").strip()
        sn = (r.get("snippet") or r.get("body") or r.get("description") or "").strip()
        line = f"{title}\n{url}\n{sn}".strip()
        if line:
            parts.append(line[:950])

    wiki_reserve = 0 if open_web_rich else min(1400, max(400, int(max_chars * 0.26)))
    ddg_cap = max(520, max_chars - wiki_reserve - 100)

    snippet_blob = "\n\n---\n\n".join(parts)
    shallow = len(snippet_blob) < (300 if open_web_rich else 220)
    # Page fetches are the biggest latency + failure risk (Cloudflare, slow sites). For open-web rich
    # queries (video/adult discovery, etc.), rely on SERP snippets only by default.
    # BUTLER_WEB_MAX_PAGE_FETCHES (0–6): more fetches = more "read the page" context for synthesis (not for pasting raw).
    max_fetches = 0
    if not open_web_rich:
        raw_mf = (os.environ.get("BUTLER_WEB_MAX_PAGE_FETCHES") or "").strip()
        if raw_mf:
            try:
                max_fetches = max(0, min(int(raw_mf), 6))
            except ValueError:
                max_fetches = 3
        else:
            max_fetches = 3
        if profile and wants_deeper:
            try:
                max_fetches = max(max_fetches, int(profile.get("page_fetches") or max_fetches))
            except Exception:
                pass
        max_fetches = min(max_fetches, 6)
    fetches_done = 0
    fetched_domains: set[str] = set()
    slice_cap = min(3400, max(1800, max_chars // 2))
    fetch_ok = bool(results and max_fetches > 0 and (shallow or (not open_web_rich and len(snippet_blob) < 650)))
    if fetch_ok:
        for r in results[:10]:
            if fetches_done >= max_fetches:
                break
            url = (r.get("url") or r.get("href") or "").strip()
            if not url.startswith("http") or "indeed.com" in url.lower():
                continue
            host = _host_from_url(url)
            if host and host in fetched_domains:
                continue
            try:
                pg = fetch_page(url)
            except Exception:
                pg = ""
            if pg and not pg.startswith("[Fetch error") and len(pg) > 120:
                marker = "(Trusted source page)" if _profile_domain_rank(url, profile) < 10_000 else "(From page)"
                parts.append(f"{marker}\n{url}\n{pg[:slice_cap]}")
                if host:
                    fetched_domains.add(host)
                fetches_done += 1

    ddg_text = "\n\n---\n\n".join(parts)[:ddg_cap] if parts else ""

    wiki_block = ""
    if not open_web_rich:
        room = max(0, max_chars - len(ddg_text) - 100)
        if room > 500:
            wiki_block = wikipedia_context_from_queries(
                _wikipedia_query_variants(q), max_chars=min(room, 1500), user_message_for_disambig=q
            )

    blocks = []
    if ddg_text.strip():
        blocks.append(ddg_text.strip())
    if wiki_block.strip():
        blocks.append(wiki_block.strip())
    return "\n\n---\n\n".join(blocks)[:max_chars]


def search_web_result_snippets_block(query: str, max_results: int = 10, max_chars: int = 4500) -> str:
    """
    DuckDuckGo titles + URLs + snippets: same merges as gather (video boost, Reddit/forum follow-ups)
    plus the same overlap filter so censored SERPs do not dump Chrome / Baidu junk.
    """
    q = (query or "").strip()
    if not q:
        return ""
    profile = _query_subject_source_profile(q)
    try:
        rows = _collect_merged_ddg_rows(q, primary_max=max_results, extra_max=6)
        rows = _apply_ddg_overlap_filter(q, rows)
        rows = _rank_search_results(q, rows, profile)
    except Exception:
        return ""
    parts: list[str] = []
    for r in rows or []:
        title = (r.get("title") or "").strip()
        url = (r.get("url") or r.get("href") or "").strip()
        sn = (r.get("snippet") or r.get("body") or r.get("description") or "").strip()
        if not url.startswith("http"):
            continue
        line = f"{title}\n{url}\n{sn}".strip()
        if line:
            parts.append(line[:950])
    return "\n\n---\n\n".join(parts)[:max_chars] if parts else ""


def search_indeed_jobs(query: str, location: str = "", max_results: int = 10) -> list:
    """Fetch Indeed search page and extract job links. Uses cloudscraper to bypass 403."""
    import urllib.parse
    # Typo fixes for common misspellings
    q = query.replace(" jobs", "").strip().lower().replace("bakend", "backend")
    if "intermediate" in q or "mid-level" in q or "mid level" in q:
        q = q + " -senior -lead -principal"
    elif "senior" not in q and "lead" not in q and "principal" not in q:
        q = q + " -senior"
    loc = (location or "").strip()
    # Indeed returns 403 when using remotejob param; use United States + "remote" in query instead
    want_remote = "remote" in loc.lower() or "usa" in loc.lower() or "us" in loc.lower()
    if want_remote or not loc:
        loc = "United States"
        if "remote" not in q:
            q = q + " remote"
    elif any(x in loc.lower() for x in ("usa", "us ", " united states")):
        loc = "United States"
    try:
        import cloudscraper
        session = cloudscraper.create_scraper()
    except ImportError:
        session = requests

    def _fetch(base: str, q_override: str = None) -> list:
        p = {"q": q_override or q, "l": loc}
        try:
            r = session.get(
                f"{base}/jobs",
                params={k: v for k, v in p.items() if v},
                headers={"User-Agent": USER_AGENT, "Accept-Language": "en-US,en;q=0.9"},
                timeout=20,
            )
            r.raise_for_status()
            soup = BeautifulSoup(r.text, "html.parser")
            jobs = []
            seen = set()
            for a in soup.find_all("a", href=True):
                href = a.get("href", "").strip().replace("&amp;", "&")
                if not href or "jk=" not in href:
                    continue
                if "/rc/clk" not in href and "viewjob" not in href:
                    continue
                if "career/" in href or "salaries" in href or "addlLoc" in href:
                    continue
                full_url = href if href.startswith("http") else urllib.parse.urljoin(base, href)
                jk_match = re.search(r"jk=([a-f0-9]+)", full_url, re.I)
                if jk_match:
                    jk = jk_match.group(1)
                    if jk in seen:
                        continue
                    seen.add(jk)
                    view_url = f"{base}/viewjob?jk={jk}"
                else:
                    if full_url in seen:
                        continue
                    seen.add(full_url)
                    view_url = full_url
                title = (a.get_text() or "").strip()[:200] or "Job"
                company = ""
                card = a.find_parent(class_=re.compile(r"job_seen_beacon|jobcard|result", re.I)) or a.find_parent(["div", "li"])
                if card:
                    company_el = card.find(class_=re.compile("companyName|company", re.I))
                    if company_el:
                        company = (company_el.get_text() or "").strip()[:100]
                jobs.append({"title": title, "url": view_url, "snippet": "", "company": company})
                if len(jobs) >= max_results:
                    break
            return jobs[:max_results] if jobs else []
        except Exception as e:
            print(f"  [Indeed {base}: {e}]")
            return []

    for base in ["https://www.indeed.com", "https://ca.indeed.com"]:
        jobs = _fetch(base)
        # If 403 with "remote" in query, retry without remote (US jobs often include remote)
        if not jobs and " remote" in q:
            q_fallback = q.replace(" remote", "").strip()
            if q_fallback:
                jobs = _fetch(base, q_fallback)
        if jobs:
            return jobs
    return []


def search_remotive_jobs(query: str = "", category: str = "software-dev", max_results: int = 20) -> list:
    """Fetch remote jobs from Remotive API (free, no auth). USA-friendly remote roles."""
    try:
        params = {"limit": min(max_results, 50)}
        if category:
            params["category"] = category
        # Remotive search is strict—"intermediate developer" returns 0. Use core term only.
        if query:
            q = query.replace(" jobs", "").strip().lower()
            for term in ("developer", "engineer", "software", "fullstack", "frontend", "backend"):
                if term in q:
                    params["search"] = term
                    break
        r = requests.get(
            "https://remotive.com/api/remote-jobs",
            params=params,
            headers={"User-Agent": USER_AGENT},
            timeout=15,
        )
        r.raise_for_status()
        data = r.json()
        jobs = data.get("jobs", [])
        if not isinstance(jobs, list):
            return []
        out = []
        for j in jobs[:max_results]:
            title = (j.get("title") or "Job").strip()
            url = (j.get("url") or "").strip()
            if not url or not url.startswith("http"):
                continue
            company = (j.get("company_name") or "").strip()
            desc = (j.get("description") or "")[:500]
            # Strip HTML tags for snippet
            if desc and "<" in desc:
                desc = re.sub(r"<[^>]+>", " ", desc)
                desc = re.sub(r"\s+", " ", desc).strip()[:400]
            out.append({"title": title, "url": url, "snippet": desc, "company": company})
        return out
    except Exception as e:
        print(f"  [Remotive: {e}]")
        return []


def fetch_og_meta(url: str) -> dict:
    """
    Best-effort Open Graph / Twitter meta for listing previews (image, description).
    Many sites (including Facebook) may block or return login pages—caller should handle empty results.
    """
    out = {"image_url": "", "description": "", "title": ""}
    if not url or not url.startswith("http"):
        return out
    try:
        r = requests.get(
            url,
            headers={"User-Agent": USER_AGENT, "Accept": "text/html,application/xhtml+xml"},
            timeout=12,
            allow_redirects=True,
        )
        r.raise_for_status()
        ct = (r.headers.get("Content-Type") or "").lower()
        if "html" not in ct and "text" not in ct and ct:
            return out
        soup = BeautifulSoup(r.text, "html.parser")

        def _meta(prop=None, name=None):
            tag = None
            if prop:
                tag = soup.find("meta", property=prop)
            elif name:
                tag = soup.find("meta", attrs={"name": name})
            return (tag.get("content") or "").strip() if tag else ""

        img = _meta(prop="og:image") or _meta(name="twitter:image") or _meta(name="twitter:image:src")
        if img and img.startswith("//"):
            img = "https:" + img
        out["image_url"] = img[:2000] if img else ""
        desc = _meta(prop="og:description") or _meta(name="description") or _meta(name="twitter:description")
        out["description"] = desc[:1200] if desc else ""
        title = _meta(prop="og:title") or _meta(name="twitter:title")
        out["title"] = title[:500] if title else ""
    except Exception:
        pass
    return out


def fetch_page(url: str) -> str:
    url = (url or "").strip()
    if not url.startswith("http"):
        return ""
    if "indeed.com" in url.lower():
        out = _fetch_indeed_job_page(url)
        if out.startswith("[Fetch error"):
            return out
        return out[:MAX_CONTENT_LEN] if out else "[Fetch error: Empty page. Paste the job description.]"
    try:
        r = requests.get(
            url,
            headers={
                "User-Agent": USER_AGENT,
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9",
            },
            timeout=15,
            allow_redirects=True,
        )
        r.raise_for_status()
        r.encoding = r.apparent_encoding or "utf-8"
        text = _html_to_plain_text(r.text)
        return text[:MAX_CONTENT_LEN] if text else ""
    except Exception as e:
        return f"[Fetch error: {e}]"
