"""
Gig Runner - Adaptive money-making agent.
Discovers opportunities across many strategies, learns what works, keeps doing it.
Uses LLM to brainstorm diverse approaches when OpenAI key present.
User handles identity, payments, legal. Payment config: Documents/Butlor/payment_config.json
"""
from __future__ import annotations

import json
import sys
import os
import re
from datetime import datetime
from pathlib import Path


def _config_dir() -> str:
    from butlor_paths import ensure_butlor_config_dir

    return str(ensure_butlor_config_dir())


def _gig_config_path() -> str:
    os.makedirs(_config_dir(), exist_ok=True)
    return os.path.join(_config_dir(), "gigs.json")


def _strategy_store_path() -> str:
    os.makedirs(_config_dir(), exist_ok=True)
    return os.path.join(_config_dir(), "money_strategies.json")


def _payment_config_path() -> str:
    os.makedirs(_config_dir(), exist_ok=True)
    return os.path.join(_config_dir(), "payment_config.json")


def _load_strategies() -> dict:
    p = _strategy_store_path()
    if not os.path.isfile(p):
        return {"outcomes": [], "proven": []}
    try:
        with open(p, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {"outcomes": [], "proven": []}


def _save_strategies(data: dict) -> None:
    with open(_strategy_store_path(), "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)


def _record_outcome(query: str, platform: str, gigs_found: int, gigs_queued: int) -> None:
    """Record what worked so we do more of it next time. Also learns into knowledge store."""
    if not query.strip():
        return
    data = _load_strategies()
    data["outcomes"].append({
        "query": query[:200],
        "platform": platform,
        "gigs_found": gigs_found,
        "gigs_queued": gigs_queued,
        "at": datetime.now().isoformat(),
    })
    if gigs_found > 0 and query not in data["proven"]:
        data["proven"].append(query[:200])
    if len(data["outcomes"]) > 500:
        data["outcomes"] = data["outcomes"][-300:]
    if len(data["proven"]) > 100:
        data["proven"] = data["proven"][-80:]
    _save_strategies(data)
    if gigs_found > 0:
        try:
            from knowledge_store import KnowledgeStore
            store = KnowledgeStore()
            learn_content = f"Money-making strategy that worked: search query '{query[:150]}' found {gigs_found} gigs on {platform}. Use similar searches in future."
            store.add(learn_content, source="gig_runner", topic="money_strategies")
        except ImportError:
            pass


def _get_proven_strategies() -> list:
    """Strategies that previously found gigs."""
    data = _load_strategies()
    return list(data.get("proven", []))[-20:]


def _ensure_payment_config() -> dict:
    """Create payment config template. User fills in for direct deposit / PayPal."""
    p = _payment_config_path()
    if not os.path.isfile(p):
        default = {
            "direct_deposit": {"routing": "", "account": "", "bank_name": ""},
            "paypal_email": "",
            "venmo": "",
            "notes": "Fill in your payment details. Butler references this for gig proposals. You handle all legal.",
        }
        with open(p, "w", encoding="utf-8") as f:
            json.dump(default, f, indent=2)
        return default
    try:
        with open(p, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _load_gigs() -> dict:
    p = _gig_config_path()
    if not os.path.isfile(p):
        return {"gigs": [], "stats": {"applied": 0, "won": 0, "delivered": 0, "earnings": 0.0}}
    try:
        with open(p, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {"gigs": [], "stats": {"applied": 0, "won": 0, "delivered": 0, "earnings": 0.0}}


def _save_gigs(data: dict) -> None:
    with open(_gig_config_path(), "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)


# ----- Fallback strategies: broad, varied queries when LLM unavailable -----
FALLBACK_STRATEGIES = [
    ("upwork", "upwork.com remote jobs"),
    ("upwork", "site:upwork.com freelance work"),
    ("upwork", "upwork jobs 2025"),
    ("fiverr", "fiverr.com gigs"),
    ("fiverr", "site:fiverr.com services"),
    ("remoteco", "remote.co jobs"),
    ("remoteco", "site:remote.co remote work"),
    ("weworkremotely", "weworkremotely.com"),
    ("weworkremotely", "site:weworkremotely.com"),
    ("flexjobs", "flexjobs.com remote"),
    ("indeed", "remote freelance jobs indeed"),
    ("linkedin", "freelance remote linkedin"),
    ("reddit", "site:reddit.com/r/forhire"),
    ("reddit", "site:reddit.com r/slavelabour work"),
    ("general", "remote freelance gig hiring"),
    ("general", "work from home freelance pay"),
    ("general", "online money making opportunities 2025"),
    ("general", "microtasks paid online"),
    ("general", "transcription jobs remote"),
    ("general", "data entry freelance"),
]


def _search_single(query: str, platform: str, max_results: int = 5) -> list:
    """Run one search. Returns list of gig dicts. Never throws."""
    try:
        from web_fetcher import search_web
    except ImportError:
        return []
    try:
        results = search_web(query, max_results=max_results)
    except Exception:
        return []
    gigs = []
    for r in results:
        url = r.get("url") or r.get("href") or ""
        if not url or "login" in url.lower() or "signup" in url.lower():
            continue
        gigs.append({
            "id": f"gig_{len(gigs)}_{int(datetime.now().timestamp())}",
            "platform": platform,
            "title": r.get("title", ""),
            "url": url,
            "snippet": (r.get("snippet") or r.get("body") or "")[:400],
            "status": "discovered",
            "discovered_at": datetime.now().isoformat(),
            "_query": query,
        })
    return gigs


def _generate_strategies_with_llm(skills: str, openai_api_key: str) -> list[tuple[str, str]]:
    """Ask LLM for 15-20 diverse money-making search strategies."""
    if not openai_api_key or not openai_api_key.strip():
        return []
    try:
        from openai import OpenAI
        client = OpenAI(api_key=openai_api_key.strip())
        proven = _get_proven_strategies()
        proven_ctx = "\n".join(f"- {q}" for q in proven[-5:]) if proven else "(none yet)"
        prompt = f"""You are an autonomous agent finding ways to make money online for a freelancer.

Skills/interests: {skills}

Past strategies that FOUND gigs (do more like these):
{proven_ctx}

Generate 18 DIVERSE search queries to find freelance gigs, remote work, micro-tasks, or money-making opportunities.
- Mix: job boards (Upwork, Fiverr, Remote.co, FlexJobs), generic searches, Reddit, niche sites
- Vary phrasing: "freelance", "remote", "work from home", "contract", "gig", "side hustle"
- Include: transcription, data entry, writing, coding, design, microtasks
- Each line = one search query. No numbering. Just the query text.
- Be creative. Try things a human would try.
- Output ONLY the queries, one per line, nothing else."""

        r = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{"role": "user", "content": prompt}],
        )
        raw = (r.choices[0].message.content or "").strip()
        strategies = []
        for line in raw.split("\n"):
            q = line.strip().strip("0123456789.-) ").strip()
            if len(q) > 10 and len(q) < 150:
                platform = "general"
                if "upwork" in q.lower():
                    platform = "upwork"
                elif "fiverr" in q.lower():
                    platform = "fiverr"
                elif "remote" in q.lower():
                    platform = "remoteco"
                elif "reddit" in q.lower():
                    platform = "reddit"
                strategies.append((platform, q))
        return strategies[:20]
    except Exception:
        return []


def discover_gigs_adaptive(
    skills: str = "frontend development, transcription, writing",
    openai_api_key: str = "",
    max_strategies: int = 25,
) -> dict:
    """
    Adaptive discovery: try many strategies (LLM + proven + fallbacks).
    Returns all unique gigs found. Records outcomes for learning.
    """
    all_gigs = []
    seen_urls = set()
    strategies_used = []

    # 1. Proven strategies first (what worked before)
    for q in _get_proven_strategies():
        gigs = _search_single(q, "proven", max_results=4)
        for g in gigs:
            u = (g.get("url") or "").lower()
            if u and u not in seen_urls:
                seen_urls.add(u)
                all_gigs.append(g)
        strategies_used.append(("proven", q, len(gigs)))
        if gigs:
            _record_outcome(q, "proven", len(gigs), 0)

    # 2. LLM-generated strategies (diverse, creative)
    llm_strategies = _generate_strategies_with_llm(skills, openai_api_key)
    for platform, q in llm_strategies:
        if len(strategies_used) >= max_strategies:
            break
        gigs = _search_single(q, platform, max_results=4)
        for g in gigs:
            u = (g.get("url") or "").lower()
            if u and u not in seen_urls:
                seen_urls.add(u)
                all_gigs.append(g)
        strategies_used.append((platform, q, len(gigs)))
        if gigs:
            _record_outcome(q, platform, len(gigs), 0)

    # 3. Fallback strategies (broad, no site: restriction)
    skills_clean = skills.replace(",", " ").strip() or "freelance"
    for platform, base_query in FALLBACK_STRATEGIES:
        if len(strategies_used) >= max_strategies:
            break
        q = f"{base_query} {skills_clean}" if "site:" not in base_query else base_query
        gigs = _search_single(q, platform, max_results=4)
        for g in gigs:
            u = (g.get("url") or "").lower()
            if u and u not in seen_urls:
                seen_urls.add(u)
                all_gigs.append(g)
        strategies_used.append((platform, q, len(gigs)))
        if gigs:
            _record_outcome(q, platform, len(gigs), 0)

    return {
        "ok": True,
        "gigs": all_gigs,
        "message": f"Found {len(all_gigs)} gigs across {len(strategies_used)} strategies",
    }


def discover_gigs(
    skills: str | list[str],
    platforms: str | list[str] | None = None,
    max_per_platform: int = 5,
) -> dict:
    """Legacy: fixed-platform discovery. Prefer discover_gigs_adaptive for adaptive behavior."""
    return discover_gigs_adaptive(
        skills=", ".join(skills) if isinstance(skills, list) else skills,
        openai_api_key=os.environ.get("OPENAI_API_KEY", ""),
    )


def generate_proposal(gig: dict, profile: dict, openai_api_key: str = "") -> dict:
    """Generate a proposal/cover letter for a gig. Uses template if no OpenAI key."""
    if not openai_api_key or not openai_api_key.strip():
        about = profile.get("user_context", profile.get("base_resume", ""))[:300] or "experienced freelancer"
        template = f"Hi, I'm interested in this opportunity. {about} I can deliver quality work on time. Happy to discuss further."
        return {"ok": True, "content": template}
    try:
        from openai import OpenAI
        client = OpenAI(api_key=openai_api_key.strip())
        pay_cfg = _ensure_payment_config()
        pay_note = ""
        if pay_cfg.get("paypal_email"):
            pay_note = f"\nPayment: PayPal {pay_cfg['paypal_email']} or direct deposit."
        prompt = f"""Write a short freelance proposal (2-3 paragraphs) for this gig. Be professional, mention relevant skills, no generic fluff. Sound human.

Gig title: {gig.get('title', '')}
Description: {gig.get('snippet', '')}

About me: {profile.get('user_context', profile.get('base_resume', ''))[:800]}
{pay_note}

Proposal:"""
        r = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{"role": "user", "content": prompt}],
        )
        content = (r.choices[0].message.content or "").strip()
        return {"ok": True, "content": content}
    except Exception as e:
        return {"ok": False, "message": str(e), "content": None}


def add_gig_to_queue(gig: dict, proposal: str = "") -> dict:
    """Add a discovered gig to the apply queue."""
    data = _load_gigs()
    gig = {k: v for k, v in gig.items() if not k.startswith("_")}
    gig["status"] = "queued"
    gig["proposal"] = proposal
    gig["queued_at"] = datetime.now().isoformat()
    data["gigs"].append(gig)
    _save_gigs(data)
    return {"ok": True, "message": f"Queued: {gig.get('title', '')[:50]}"}


def get_gig_queue() -> dict:
    """Return gigs in queue and stats."""
    data = _load_gigs()
    queued = [g for g in data.get("gigs", []) if g.get("status") in ("discovered", "queued")]
    return {"ok": True, "queued": queued, "stats": data.get("stats", {})}


def execute_gig(gig_type: str, requirements: str, output_path: str = "") -> dict:
    """
    Execute the actual gig work. Types: frontend, landing_page, transcription.
    """
    if not output_path:
        output_dir = os.path.join(_config_dir(), "gig_deliverables")
        os.makedirs(output_dir, exist_ok=True)
        output_path = os.path.join(output_dir, f"deliverable_{int(datetime.now().timestamp())}")
    if gig_type in ("frontend", "landing_page", "website"):
        return _execute_frontend(requirements, output_path)
    if gig_type == "transcription":
        return _execute_transcription(requirements, output_path)
    return {"ok": False, "message": f"Unknown gig type: {gig_type}", "path": None}


def _execute_frontend(requirements: str, output_dir: str) -> dict:
    """Generate a front-end deliverable from requirements."""
    try:
        from openai import OpenAI
        import os as _os
        key = os.environ.get("OPENAI_API_KEY", "")
        if not key:
            return {"ok": False, "message": "OpenAI key required for frontend gen", "path": None}
        client = OpenAI(api_key=key)
        prompt = f"""Create a complete single-page website based on these requirements. Output valid HTML with embedded CSS and JS. No placeholders. Make it polished.

Requirements: {requirements[:2000]}

HTML:"""
        r = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{"role": "user", "content": prompt}],
        )
        html = (r.choices[0].message.content or "").strip()
        html = re.sub(r"^```html?\s*", "", re.sub(r"\s*```$", "", html))
        if not _os.path.isdir(output_dir):
            _os.makedirs(output_dir, exist_ok=True)
        index_path = os.path.join(output_dir, "index.html")
        with open(index_path, "w", encoding="utf-8") as f:
            f.write(html)
        return {"ok": True, "message": "Frontend generated", "path": index_path}
    except Exception as e:
        return {"ok": False, "message": str(e), "path": None}


def _execute_transcription(audio_path: str, output_path: str) -> dict:
    """Transcribe audio file to text using stt.py."""
    if not os.path.isfile(audio_path):
        return {"ok": False, "message": f"Audio file not found: {audio_path}", "path": None}
    try:
        import subprocess
        stt_py = os.path.join(os.path.dirname(__file__), "stt.py")
        result = subprocess.run(
            [sys.executable, stt_py, audio_path],
            capture_output=True,
            text=True,
            timeout=120,
            cwd=os.path.dirname(__file__),
        )
        text = (result.stdout or "").strip()
    except Exception as e:
        return {"ok": False, "message": str(e), "path": None}
    if not text:
        return {"ok": False, "message": "Transcription empty", "path": None}
    out_file = output_path if output_path.endswith(".txt") else output_path + ".txt"
    with open(out_file, "w", encoding="utf-8") as f:
        f.write(text)
    return {"ok": True, "message": "Transcription complete", "path": out_file}


def _ensure_profile() -> dict:
    """Create minimal profile if none exists."""
    profile_path = os.path.join(_config_dir(), "profile.json")
    if not os.path.isfile(profile_path):
        default = {"base_resume": "", "user_context": "Experienced freelancer. Skilled in frontend development, web design, and general tech. Available for remote work."}
        with open(profile_path, "w", encoding="utf-8") as f:
            json.dump(default, f, indent=2)
        return default
    try:
        with open(profile_path, "r", encoding="utf-8") as f:
            p = json.load(f)
        if not p.get("user_context") and not p.get("base_resume"):
            p["user_context"] = "Experienced freelancer. Skilled in frontend development, web design, and general tech. Available for remote work."
            with open(profile_path, "w", encoding="utf-8") as f:
                json.dump(p, f, indent=2)
        return p
    except Exception:
        return {"user_context": "Experienced freelancer. Skilled in frontend development and tech."}


def run_autonomous_cycle(
    skills: str = "frontend development, transcription, writing, data entry",
    max_gigs: int = 5,
    openai_api_key: str = "",
) -> dict:
    """
    Adaptive cycle: discover via many strategies -> generate proposals -> queue.
    Learns from what works. Tries proven strategies first, then LLM-generated, then fallbacks.
    """
    _ensure_payment_config()
    profile = _ensure_profile()
    key = (openai_api_key or os.environ.get("OPENAI_API_KEY", "")).strip()

    discover_r = discover_gigs_adaptive(skills=skills, openai_api_key=key, max_strategies=25)

    if not discover_r.get("gigs"):
        return {
            "ok": True,
            "message": "Tried many strategies—no gigs found this run. I'll keep learning. Add an OpenAI key in settings for AI-generated search strategies, or say 'find gigs for [your skills]' to broaden.",
            "queued": 0,
            "gigs": [],
        }

    queued = 0
    queued_urls = []
    for gig in discover_r["gigs"][:max_gigs]:
        prop_r = generate_proposal(gig, profile, key)
        proposal = prop_r.get("content", "") if prop_r.get("ok") else ""
        add_gig_to_queue(gig, proposal)
        queued += 1
        if gig.get("url"):
            queued_urls.append(gig["url"])

    return {
        "ok": True,
        "message": f"Found {len(discover_r['gigs'])} gigs, queued {queued} with proposals. Opened gigs in browser.",
        "queued": queued,
        "gigs": discover_r["gigs"][:max_gigs],
        "urls": queued_urls,
        "gigs_path": os.path.join(_config_dir(), "gigs.json"),
    }
