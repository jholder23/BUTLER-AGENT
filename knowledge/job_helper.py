"""
Job search assistant for Butlor.
- Tailor resume for specific jobs
- Generate cover letters
- Track applications and interview dates
"""
from __future__ import annotations

import html as html_module
import json
import os
import re
from datetime import datetime
from pathlib import Path

from butlor_paths import ensure_butlor_config_dir


def _job_tracker_path() -> str:
    return str(ensure_butlor_config_dir() / "job_tracker.json")


def _load_tracker() -> dict:
    p = _job_tracker_path()
    if not os.path.isfile(p):
        return {"jobs": [], "updated": None}
    try:
        with open(p, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {"jobs": [], "updated": None}
    except Exception:
        return {"jobs": [], "updated": None}


def _save_tracker(data: dict) -> None:
    data["updated"] = datetime.now().isoformat()
    with open(_job_tracker_path(), "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)


def get_tracker() -> dict:
    """Return full job tracker."""
    return _load_tracker()


def add_job(
    company: str,
    role: str,
    url: str = "",
    status: str = "applied",
    interview_date: str | None = None,
    notes: str = "",
) -> dict:
    """Add a job to the tracker."""
    data = _load_tracker()
    job = {
        "id": f"job_{len(data['jobs'])}_{int(datetime.now().timestamp())}",
        "company": company.strip(),
        "role": role.strip(),
        "url": url.strip(),
        "status": status.strip() or "applied",
        "applied_date": datetime.now().strftime("%Y-%m-%d"),
        "interview_date": interview_date.strip() if interview_date else None,
        "notes": notes.strip() if notes else None,
    }
    data["jobs"].append(job)
    _save_tracker(data)
    return {"ok": True, "message": f"Added {role} at {company}", "job": job}


def update_job(job_id: str, **kwargs) -> dict:
    """Update a job's status, interview_date, etc."""
    data = _load_tracker()
    for j in data["jobs"]:
        if j.get("id") == job_id:
            for k, v in kwargs.items():
                if v is not None and k in j:
                    j[k] = v
            _save_tracker(data)
            return {"ok": True, "message": "Updated", "job": j}
    return {"ok": False, "message": f"Job {job_id} not found"}


def _resume_template_pdf_path() -> str:
    return os.path.join(os.path.dirname(_job_tracker_path()), "resume_template.pdf")


def save_resume_template_pdf_bytes(raw: bytes) -> None:
    p = _resume_template_pdf_path()
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "wb") as f:
        f.write(raw)


def resume_template_exists() -> bool:
    return os.path.isfile(_resume_template_pdf_path())


def html_to_plain(html_s: str) -> str:
    if not (html_s or "").strip():
        return ""
    try:
        from bs4 import BeautifulSoup

        soup = BeautifulSoup(html_s, "html.parser")
        return soup.get_text("\n", strip=True)
    except Exception:
        return re.sub(r"<[^>]+>", " ", html_s or "").strip()


def profile_plain_resume(profile: dict) -> str:
    if not profile:
        return ""
    h = (profile.get("base_resume_html") or "").strip()
    if h:
        p = html_to_plain(h)
        if p:
            return p
    return (profile.get("base_resume") or "").strip()


def _strip_ai_code_fence(raw: str) -> str:
    s = (raw or "").strip()
    if not s.startswith("```"):
        return s
    lines = s.split("\n")
    if lines and lines[0].startswith("```"):
        lines = lines[1:]
    if lines and lines[-1].strip() == "```":
        lines = lines[:-1]
    return "\n".join(lines).strip()


def render_resume_html_to_pdf_bytes(
    html_body: str,
    template_path: str | None = None,
    style_id: str | None = None,
) -> tuple[bytes, str | None]:
    """
    Render HTML resume into a PDF on a US Letter page (612×792 pt). If template_path is set and
    exists, draws on that PDF’s first page (legacy); the HTTP API always passes None. Requires PyMuPDF.
    style_id: ``standard`` (serif) or ``accent`` (sans + blue left bar); legacy ids are mapped.
    """
    try:
        import fitz
    except ImportError:
        return b"", "PyMuPDF is not installed. Run: pip install pymupdf"

    sid = (style_id or "standard").lower().strip()
    if sid in ("modern", "technical"):
        sid = "accent"
    elif sid in ("classic", "executive", "minimal"):
        sid = "standard"

    margin = 56
    raw = html_body or ""
    stripped = raw.lstrip()
    # Full HTML document: do not wrap in generic Times (fragments only get the Times wrapper).
    if stripped.upper().startswith("<!DOCTYPE") or stripped.lower().startswith("<html"):
        wrapped = raw
    elif sid == "accent":
        wrapped = (
            '<div style="font-family: Helvetica, Arial, sans-serif; font-size: 11pt; line-height: 1.35; color: #171717; '
            'border-left: 6px solid #2563eb; padding-left: 14px;">'
            + raw
            + "</div>"
        )
    else:
        wrapped = (
            '<div style="font-family: Times New Roman, Times, serif; font-size: 11pt; line-height: 1.35; color: #111;">'
            + raw
            + "</div>"
        )

    if template_path and os.path.isfile(template_path):
        doc = fitz.open(template_path)
        page = doc[0]
        r = page.rect
        box = fitz.Rect(margin, margin, r.width - margin, r.height - margin)
    else:
        doc = fitz.open()
        page = doc.new_page(width=612, height=792)
        box = fitz.Rect(margin, margin, 612 - margin, 792 - margin)

    try:
        page.insert_htmlbox(box, wrapped)
    except Exception as e:
        doc.close()
        return b"", str(e)
    out = doc.tobytes()
    doc.close()
    return out, None


def resolve_job_description_for_tailor(pasted: str, posting_url: str) -> tuple[str, str | None]:
    """
    Build job description from pasted text and/or fetched posting page.
    Returns (description, error_message). Long pasted text is used as-is (no fetch).
    """
    pasted = (pasted or "").strip()
    url = (posting_url or "").strip()
    min_paste = 120
    if len(pasted) >= min_paste:
        return pasted[:8000], None
    fetched = ""
    if url.startswith("http"):
        try:
            from web_fetcher import fetch_page

            fetched = (fetch_page(url) or "").strip()
        except Exception:
            fetched = ""
    if fetched.startswith("[Fetch error"):
        if pasted:
            return pasted[:8000], None
        tail = fetched.replace("[Fetch error:", "").strip().rstrip("]")
        return "", (tail or "Could not fetch posting.")[:500]
    if fetched:
        merged = f"{pasted}\n\n{fetched}".strip() if pasted else fetched
        return merged[:8000], None
    if pasted:
        return pasted[:8000], None
    return "", "Paste a job description or enter a posting URL."


def save_application_materials_bundle(
    *,
    posting_url: str,
    company: str,
    role: str,
    job_title: str = "",
    tailored_plain: str,
    tailored_html: str | None,
    cover_letter: str,
    company_research: str = "",
    applications_dir: str | None = None,
) -> dict:
    """Write tailored resume + cover letter to Butlor applications/ (same format as auto-apply)."""
    from butlor_paths import get_applications_dir

    ad = applications_dir or str(get_applications_dir())
    os.makedirs(ad, exist_ok=True)
    comp = (company or "").strip() or "Unknown"
    rol = (role or "").strip() or "Role"
    title = (job_title or "").strip() or (f"{rol} at {comp}" if comp != "Unknown" else rol)
    safe_name = re.sub(r"[^\w\-]", "_", comp)[:50]
    stem = f"{safe_name}_{int(datetime.now().timestamp())}"
    app_file = os.path.join(ad, f"{stem}.txt")
    with open(app_file, "w", encoding="utf-8") as f:
        parts = [f"=== {title} ===\nURL: {posting_url or '(pasted description only)'}\n"]
        if company_research:
            parts.append(f"\n--- COMPANY RESEARCH ---\n{company_research}\n")
        parts.append(f"\n--- COVER LETTER ---\n{cover_letter}\n")
        parts.append(f"\n--- TAILORED RESUME ---\n{tailored_plain}")
        if tailored_html:
            parts.append(f"\n--- TAILORED RESUME (HTML, for PDF) ---\n{tailored_html}\n")
        f.write("\n".join(parts))
    return {"ok": True, "app_file": app_file, "applications_dir": os.path.abspath(ad)}


def get_upcoming_interviews(days_ahead: int = 14) -> dict:
    """Return jobs with interview dates in the next N days."""
    from datetime import timedelta
    data = _load_tracker()
    today = datetime.now().date()
    end = today + timedelta(days=days_ahead)
    upcoming = []
    for j in data.get("jobs", []):
        d = j.get("interview_date")
        if not d:
            continue
        try:
            dt = datetime.strptime(d[:10], "%Y-%m-%d").date()
            if today <= dt <= end:
                upcoming.append({**j, "interview_date_parsed": d})
        except ValueError:
            pass
    upcoming.sort(key=lambda x: x.get("interview_date", ""))
    return {"ok": True, "interviews": upcoming, "message": f"{len(upcoming)} interview(s) in next {days_ahead} days"}


def tailor_resume(
    base_resume: str,
    job_description: str,
    company: str = "",
    role: str = "",
    openai_api_key: str = "",
    base_resume_html: str | None = None,
) -> dict:
    """Tailor resume for a specific job. Prefers HTML in/out when base_resume_html is provided."""
    if not openai_api_key or not openai_api_key.strip():
        return {
            "ok": False,
            "message": "OpenAI API key required for resume tailoring. Add it in settings.",
            "content": None,
            "content_html": None,
        }
    plain = (base_resume or "").strip() or html_to_plain(base_resume_html or "")
    if not plain:
        return {"ok": False, "message": "No base resume text provided.", "content": None, "content_html": None}
    html_src = (base_resume_html or "").strip()
    try:
        from openai import OpenAI
        client = OpenAI(api_key=openai_api_key.strip())
        if html_src:
            prompt = f"""Tailor this resume for the job below. Preserve the SAME HTML structure and tags as the original
(use <p>, <h2>/<h3> for section headings, <ul><li> for bullets, <strong> and <em> for emphasis—like a Word document).
Emphasize relevant experience and keywords from the job description. Do not invent employers, degrees, or dates.
Output ONLY the tailored resume as HTML fragment (no markdown fences, no preamble).

Company: {company or 'Unknown'}
Role: {role or 'Unknown'}

Job description:
{job_description[:4000]}

Original resume (HTML):
{html_src[:14000]}

Tailored resume (HTML only):"""
        else:
            prompt = f"""Tailor this resume for the following job. Keep the same format/structure. Emphasize relevant experience and keywords from the job description. Do not add false information.
Output the tailored resume as HTML (use <p>, <h2>/<h3>, <ul><li>, <strong>)—no markdown fences, no commentary.

Company: {company or 'Unknown'}
Role: {role or 'Unknown'}

Job description:
{job_description[:4000]}

Original resume (plain text):
{plain[:12000]}

Tailored resume (HTML only):"""
        r = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{"role": "user", "content": prompt}],
        )
        raw = _strip_ai_code_fence((r.choices[0].message.content or "").strip())
        if not raw:
            return {"ok": False, "message": "No content generated", "content": None, "content_html": None}
        if raw.lstrip().lower().startswith("<"):
            content_html = raw
        else:
            esc = html_module.escape(raw)
            content_html = "<p>" + esc.replace("\n\n", "</p><p>").replace("\n", "<br/>") + "</p>"
        content_plain = html_to_plain(content_html)
        if not content_plain:
            content_plain = raw
        return {
            "ok": True,
            "message": "Tailored resume generated",
            "content": content_plain,
            "content_html": content_html,
        }
    except Exception as e:
        return {"ok": False, "message": str(e), "content": None, "content_html": None}


def generate_cover_letter(
    job_description: str,
    company: str = "",
    role: str = "",
    user_context: str = "",
    openai_api_key: str = "",
    profile: dict | None = None,
) -> dict:
    """Generate a cover letter for a job. Use profile for name, email, etc. NO placeholders."""
    if not openai_api_key or not openai_api_key.strip():
        return {
            "ok": False,
            "message": "OpenAI API key required for cover letters. Add it in settings.",
            "content": None,
        }
    profile = profile or {}
    name = (profile.get("name") or "").strip()
    email = (profile.get("email") or "").strip()
    phone = (profile.get("phone") or "").strip()
    address = (profile.get("address") or "").strip()
    plain_r = profile_plain_resume(profile)
    if not name and plain_r:
        first_lines = plain_r.split("\n")[:3]
        for line in first_lines:
            line = line.strip()
            if line and len(line) < 50 and not any(c.isdigit() for c in line) and "email" not in line.lower() and "@" not in line:
                name = line
                break
    candidate_block = f"""
CANDIDATE (use these exact values—no placeholders like [Your Name]):
Name: {name or 'Candidate'}
Email: {email or ''}
Phone: {phone or ''}
Address: {address or ''}

{f'About: {user_context[:1500]}' if user_context else ''}
"""
    try:
        from openai import OpenAI
        client = OpenAI(api_key=openai_api_key.strip())
        prompt = f"""Write a professional cover letter for this job. Use the candidate's real name, email, phone, address below. Output the FINAL letter—no placeholders like [Your Name], [Email], etc. Be concise (3-4 paragraphs). Tailor to the role and company.

Company: {company or 'Unknown'}
Role: {role or 'Unknown'}

Job description:
{job_description[:4000]}
{candidate_block}

Cover letter (final, with real details filled in):"""
        r = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{"role": "user", "content": prompt}],
        )
        content = (r.choices[0].message.content or "").strip()
        if not content:
            return {"ok": False, "message": "No content generated", "content": None}
        # Replace common placeholders as fallback
        if name:
            for p in ["[Your Name]", "[your name]", "[Name]", "[NAME]"]:
                content = content.replace(p, name)
        if email:
            for p in ["[Email Address]", "[email address]", "[Email]", "[EMAIL]"]:
                content = content.replace(p, email)
        if phone:
            for p in ["[Phone Number]", "[phone number]", "[Phone]", "[PHONE]"]:
                content = content.replace(p, phone)
        if address:
            for p in ["[Your Address]", "[your address]", "[Address]", "[ADDRESS]", "[City, State, ZIP]"]:
                content = content.replace(p, address)
        if company:
            for p in ["[Company Name]", "[company name]", "[Company]", "[COMPANY]"]:
                content = content.replace(p, company)
        from datetime import datetime
        today = datetime.now().strftime("%B %d, %Y")
        for p in ["[Date]", "[DATE]"]:
            content = content.replace(p, today)
        for p in ["[Hiring Manager's Name]", "[Hiring Manager]", "[Hiring Manager Name]"]:
            content = content.replace(p, "Hiring Manager")
        return {"ok": True, "message": "Cover letter generated", "content": content}
    except Exception as e:
        return {"ok": False, "message": str(e), "content": None}


# Sites to exclude (not job listings)
_NON_JOB_DOMAINS = [
    "linkedin.com/company", "facebook.com", "twitter.com", "zhidao.baidu.com",
    "baidu.com", "quora.com", "reddit.com", "wikipedia.org", "youtube.com",
    "stackoverflow.com", "medium.com", "blog.", "news.", "archive.org",
]
# Job boards (use substring to match indeed.ca, indeed.co.uk, etc.)
_JOB_DOMAINS = ["indeed.", "linkedin.com/jobs", "glassdoor.com", "monster.com", "careerbuilder.com", "remotive.com"]


def _is_search_page(url: str) -> bool:
    """True if URL is a search/results page, not an individual job posting."""
    u = (url or "").lower()
    if "indeed" in u:
        return "/q-" in u or "/jobs.html" in u or "/jobs?" in u  # search page, not viewjob
    if "linkedin" in u:
        return "/jobs/search" in u or re.search(r"/jobs/[^/]+-jobs", u)  # e.g. remote-full-stack-developer-jobs
    if "glassdoor" in u:
        return "SRCH_" in u or ("/Job/" in u and "jobs-" in u)  # search results
    return False


def _is_indeed_viewjob(url: str) -> bool:
    """True if URL is Indeed individual job page (viewjob?jk=)."""
    return "indeed" in (url or "").lower() and "viewjob" in (url or "").lower() and "jk=" in (url or "").lower()


def _parse_description_to_search(description: str, openai_api_key: str) -> tuple[str, str]:
    """Parse freeform description into (role, location) for job search."""
    if not (description or "").strip():
        return "software developer", ""
    if not openai_api_key or not openai_api_key.strip():
        # Simple heuristic: extract job terms, skip "find me X positions" etc.
        d = description.lower().strip()
        stop = {"find", "me", "get", "give", "a", "an", "the", "positions", "jobs", "for", "based", "in"}
        if any(t in d for t in ("full-stack", "front-end", "frontend", "backend", "back-end")):
            role = "full stack developer"
        else:
            parts = [p for p in description.strip().split() if p.lower() not in stop and not p.isdigit()][:6]
            role = " ".join(parts) if parts else "software developer"
        role = role[:80]
        loc = "remote" if "remote" in d else ("usa" if "usa" in d or " us " in d or d.endswith(" us") else "")
        return role, loc
    try:
        from openai import OpenAI
        client = OpenAI(api_key=openai_api_key.strip())
        r = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{
                "role": "user",
                "content": f"""Extract job search terms from this description. Return JSON only: {{"role": "job title/type (2-6 words)", "location": "city, remote, or empty"}}
Description: {description[:500]}
JSON:""",
            }],
            max_tokens=80,
        )
        raw = (r.choices[0].message.content or "").strip()
        m = re.search(r'\{[^{}]*\}', raw)
        if m:
            obj = json.loads(m.group(0))
            return (obj.get("role") or "developer")[:80], (obj.get("location") or "")[:60]
    except Exception:
        pass
    role = " ".join(description.strip().split()[:5])[:80] or "developer"
    loc = "remote" if "remote" in description.lower() else ""
    return role, loc


def research_company(company_name: str, openai_api_key: str) -> str:
    """Research a company via web search and optional summarization. Returns brief summary."""
    if not (company_name or "").strip() or company_name.strip().lower() == "unknown":
        return ""
    try:
        from web_fetcher import search_web
        results = search_web(f"{company_name} company about", max_results=3)
        if not results:
            return ""
        snippets = [r.get("snippet") or r.get("body") or "" for r in results[:3] if r.get("snippet") or r.get("body")]
        combined = " ".join(snippets)[:2000]
        if not combined.strip():
            return ""
        if openai_api_key and len(combined) > 200:
            try:
                from openai import OpenAI
                client = OpenAI(api_key=openai_api_key.strip())
                r = client.chat.completions.create(
                    model="gpt-4o-mini",
                    messages=[{
                        "role": "user",
                        "content": f"Summarize this company info in 2-4 sentences (what they do, industry, size if known):\n\n{combined[:1500]}",
                    }],
                    max_tokens=150,
                )
                return (r.choices[0].message.content or "").strip() or combined[:500]
            except Exception:
                pass
        return combined[:500]
    except ImportError:
        return ""


def search_jobs(role: str, location: str = "", max_results: int = 10) -> dict:
    """Search for jobs. Prioritizes Indeed, then Remotive API (remote), then DuckDuckGo."""
    try:
        from web_fetcher import search_web, fetch_page, search_indeed_jobs, search_remotive_jobs
    except ImportError:
        return {"ok": False, "message": "web_fetcher not available", "jobs": []}

    def is_bad_url(url: str) -> bool:
        """True if URL is from a known non-job site."""
        u = (url or "").lower()
        if not u:
            return True
        return any(x in u for x in _NON_JOB_DOMAINS)

    def is_job_url(url: str, strict: bool = True) -> bool:
        u = (url or "").lower()
        if is_bad_url(url):
            return False
        if strict:
            return any(d in u for d in _JOB_DOMAINS) or "/job" in u or "/jobs" in u or "/careers" in u
        return "/job" in u or "/jobs" in u or "/careers" in u or "indeed" in u or "linkedin" in u

    def job_score(url: str) -> int:
        u = (url or "").lower()
        if "indeed" in u:
            return 100
        if "linkedin.com/jobs" in u:
            return 80
        if "remotive.com" in u:
            return 75
        if "glassdoor.com" in u or "monster.com" in u:
            return 60
        return 10

    # Simplify complex roles for better search (e.g. "full-stack, front-end, or backend" -> "full stack developer")
    role_for_query = (role or "").strip()
    if not role_for_query:
        role_for_query = "software developer"
    role_lower_q = role_for_query.lower()
    if ("full-stack" in role_lower_q or "front-end" in role_lower_q or "backend" in role_lower_q or "back-end" in role_lower_q) and (
        " or " in role_lower_q or "," in role_lower_q
    ):
        role_for_query = "full stack developer"
    # Normalize location: USA/US/remote -> United States for Indeed (avoids 403)
    loc_for_indeed = (location or "").strip()
    if loc_for_indeed.lower() in ("usa", "us", "remote") or "remote" in loc_for_indeed.lower() or "usa" in loc_for_indeed.lower():
        loc_for_indeed = "United States"

    # Primary: direct Indeed scrape (reliable, bypasses DDG)
    indeed_direct = search_indeed_jobs(f"{role_for_query} jobs", loc_for_indeed, max_results * 2)
    role_lower = (role or "").lower()
    title_lower = lambda t: (t or "").lower()
    # Filter out Senior/Lead/Principal when user asked for intermediate or mid-level
    if "intermediate" in role_lower or "mid-level" in role_lower or "mid level" in role_lower:
        senior_words = ("senior", "sr ", "lead ", "principal", "staff ", "director")
        indeed_direct = [j for j in indeed_direct if not any(w in title_lower(j.get("title")) for w in senior_words)]
    # When user asks for full-stack, prefer titles with full/stack/fullstack/software developer
    if "full-stack" in role_lower or "full stack" in role_lower:
        fullstack_words = ("full-stack", "full stack", "fullstack", "software engineer", "software developer", "web developer")
        indeed_direct = [j for j in indeed_direct if any(w in title_lower(j.get("title")) for w in fullstack_words)] or indeed_direct
    for j in indeed_direct:
        j["_source"] = "indeed"

    # Fallback: Remotive API (free, no auth—USA remote dev jobs) when Indeed fails
    remotive_jobs = []
    if not indeed_direct and any(x in (role_for_query or "").lower() for x in ("developer", "engineer", "full-stack", "frontend", "backend", "software")):
        remotive_jobs = search_remotive_jobs(
            query=role_for_query.replace("full stack developer", "software").strip(),
            category="software-dev",
            max_results=max_results,
        )
        # Prefer developer/engineer roles when user asked for developer—software-dev category is broad
        if "developer" in role_lower or "engineer" in role_lower:
            dev_jobs = [j for j in remotive_jobs if any(w in title_lower(j.get("title")) for w in ("developer", "engineer", "software", "full-stack", "frontend", "backend"))]
            remotive_jobs = dev_jobs if dev_jobs else remotive_jobs
        # Filter intermediate/mid when requested
        if "intermediate" in role_lower or "mid-level" in role_lower or "mid level" in role_lower:
            senior_words = ("senior", "sr ", "lead ", "principal", "staff ", "director")
            remotive_jobs = [j for j in remotive_jobs if not any(w in title_lower(j.get("title")) for w in senior_words)]
        for j in remotive_jobs:
            j["_source"] = "remotive"

    # Fallback: DuckDuckGo search
    query = f"{role} jobs"
    if location:
        query += f" {location}"
    results = search_web(query, max_results=max_results * 3)
    if not results:
        results = search_web(f"{role} hiring remote", max_results=max_results * 2)

    jobs = []
    seen = set()
    for r in indeed_direct:
        url = (r.get("url") or "").strip()
        if url and url not in seen and _is_indeed_viewjob(url):
            seen.add(url)
            jobs.append({"title": r.get("title", "Job"), "url": url, "snippet": r.get("snippet", ""), "company": r.get("company", "")})

    for r in remotive_jobs:
        url = (r.get("url") or "").strip()
        if url and url not in seen:
            seen.add(url)
            jobs.append({"title": r.get("title", "Job"), "url": url, "snippet": r.get("snippet", ""), "company": r.get("company", "")})

    for r in results:
        url = (r.get("url") or r.get("href") or "").strip()
        if not url or url in seen:
            continue
        if _is_search_page(url):
            continue
        if not is_job_url(url) and not is_job_url(url, strict=False):
            continue
        seen.add(url)
        title = r.get("title", "") or "Job"
        # Parse company from title if possible (e.g. "Role - Company - Indeed")
        company = ""
        if " - " in title:
            parts = title.split(" - ")
            if len(parts) >= 2 and "indeed" not in parts[-1].lower():
                company = parts[-1].strip()
        elif " at " in title:
            company = title.split(" at ")[-1].split(" - ")[0].strip()
        jobs.append({
            "title": title,
            "url": url,
            "snippet": (r.get("snippet") or r.get("body") or "")[:500],
            "company": company or "",
        })

    # Filter senior/lead when user asked for intermediate (apply to all sources)
    if "intermediate" in role_lower or "mid-level" in role_lower or "mid level" in role_lower:
        senior_words = ("senior", "sr ", "lead ", "principal", "staff ", "director")
        jobs = [j for j in jobs if not any(w in title_lower(j.get("title")) for w in senior_words)]

    jobs.sort(key=lambda j: (-job_score(j["url"]), j["title"]))
    search_links = []
    if not jobs:
        # Build direct search links for UI to show when scraping fails
        import urllib.parse
        q = (role_for_query or "").strip()
        if "remote" in (location or "").lower() and "remote" not in q.lower():
            q = f"{q} remote"
        q_enc = urllib.parse.quote_plus(q)
        loc_enc = urllib.parse.quote_plus(loc_for_indeed) if loc_for_indeed else ""
        search_links = [
            {"name": "Indeed", "url": f"https://www.indeed.com/jobs?q={q_enc}&l={loc_enc}"},
            {"name": "SimplyHired", "url": f"https://www.simplyhired.com/search?q={q_enc}&l={loc_enc}"},
            {"name": "LinkedIn", "url": f"https://www.linkedin.com/jobs/search/?keywords={q_enc}&location={loc_enc}"},
            {"name": "Glassdoor", "url": f"https://www.glassdoor.com/Job/jobs.htm?sc.keyword={q_enc}&locT=N&locKeyword={loc_enc}"},
            {"name": "ZipRecruiter", "url": f"https://www.ziprecruiter.com/jobs-search?search={q_enc}&location={loc_enc}"},
        ]
        msg = "Scraping returned no results (Indeed may be blocking). Open the links below to search manually."
    elif results and len(jobs) < max_results // 2:
        msg = f"Found {len(jobs)} jobs"
    else:
        msg = f"Found {len(jobs)} jobs"
    return {"ok": True, "jobs": jobs[:max_results], "message": msg, "search_links": search_links}


def get_user_profile() -> dict:
    """Load user's resume and preferences from profile.json under the Butler data folder."""
    profile_path = str(ensure_butlor_config_dir() / "profile.json")
    if not os.path.isfile(profile_path):
        return {"has_resume_template": resume_template_exists()}
    try:
        with open(profile_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            data = {}
        data["has_resume_template"] = resume_template_exists()
        return data
    except Exception:
        return {"has_resume_template": resume_template_exists()}


def save_user_profile(profile: dict) -> None:
    """Save user profile (base_resume, target_role, location, etc.)."""
    config_dir = os.path.dirname(_job_tracker_path())
    os.makedirs(config_dir, exist_ok=True)
    profile_path = os.path.join(config_dir, "profile.json")
    with open(profile_path, "w", encoding="utf-8") as f:
        json.dump(profile, f, indent=2)


def auto_apply_pipeline(
    role: str,
    location: str = "",
    max_jobs: int = 5,
    openai_api_key: str = "",
    auto_submit: bool = False,
) -> dict:
    """
    Full pipeline: search jobs -> tailor resume + cover letter -> add to tracker.
    If auto_submit=True, also attempts to fill and submit each job's application form via Playwright.
    Profile needs: base_resume, name, email (phone optional for auto_submit).
    """
    profile = get_user_profile()
    base_resume = profile_plain_resume(profile)
    if not base_resume:
        return {"ok": False, "message": "Add your resume in Profile (or profile.json base_resume / base_resume_html).", "applied": 0}
    if auto_submit and (not profile.get("name") or not profile.get("email")):
        return {"ok": False, "message": "For auto-submit, add 'name' and 'email' to Documents/Butlor/profile.json", "applied": 0}
    search_r = search_jobs(role, location, max_results=max_jobs)
    if not search_r.get("ok") or not search_r.get("jobs"):
        return {"ok": True, "message": "No jobs found", "applied": 0, "tracked": 0}
    jobs_to_apply = search_r["jobs"]
    if auto_submit:
        indeed_jobs = [j for j in jobs_to_apply if _is_indeed_viewjob(j.get("url", ""))]
        if indeed_jobs:
            jobs_to_apply = indeed_jobs[:max_jobs]
        elif jobs_to_apply:
            return {
                "ok": True,
                "message": "Auto-submit only works with Indeed job postings (we support Indeed login). The search found LinkedIn/Glassdoor links which require their own login.\n\nTry: 'apply to X jobs' (materials only) to get resumes & cover letters, then apply manually. Or run again—Indeed may return more results.",
                "applied": 0,
                "tracked": 0,
            }
    applied = 0
    tracked = 0
    try:
        from web_fetcher import fetch_page
    except ImportError:
        fetch_page = lambda u: ""
    applications_dir = os.path.join(os.path.dirname(_job_tracker_path()), "applications")
    os.makedirs(applications_dir, exist_ok=True)
    applied_jobs = []
    for i, job in enumerate(jobs_to_apply[:max_jobs]):
        url = job.get("url", "")
        title = job.get("title", "Unknown Role")
        snippet = job.get("snippet", "")
        job_desc = snippet
        try:
            full_page = fetch_page(url)
            if full_page and len(full_page) > 200:
                job_desc = full_page[:6000]
        except Exception:
            pass
        company = (job.get("company") or "").strip()
        if not company and job_desc:
            m = re.search(r"(?:company|employer|at)\s+([A-Za-z0-9][A-Za-z0-9\s&.,'-]{2,60}?)(?:\n|Remote|Full-time|$)", job_desc[:3000], re.I)
            if m:
                company = m.group(1).strip()[:80]
        if not company:
            company = title.split(" at ")[-1].split(" - ")[0] if " at " in title else "Unknown"
        company_research = research_company(company, openai_api_key) if company else ""
        # Tailor resume and cover letter
        br_html = (profile.get("base_resume_html") or "").strip()
        tailor_r = (
            tailor_resume(
                base_resume,
                job_desc,
                company,
                role,
                openai_api_key,
                base_resume_html=br_html or None,
            )
            if base_resume and openai_api_key
            else {"ok": False, "content": base_resume, "content_html": None}
        )
        cover_r = generate_cover_letter(
            job_desc, company, role, profile.get("user_context", ""), openai_api_key, profile=profile
        ) if openai_api_key else {"ok": False, "content": ""}
        tailored_resume = tailor_r.get("content") or base_resume
        tailored_html = tailor_r.get("content_html")
        cover_letter = cover_r.get("content") or ""
        add_job(company=company, role=role, url=url, status="applied")
        tracked += 1
        safe_name = re.sub(r"[^\w\-]", "_", company)[:50]
        app_file = os.path.join(applications_dir, f"{safe_name}_{i}.txt")
        with open(app_file, "w", encoding="utf-8") as f:
            parts = [f"=== {title} at {company} ===\nURL: {url}\n"]
            if company_research:
                parts.append(f"\n--- COMPANY RESEARCH ---\n{company_research}\n")
            parts.append(f"\n--- COVER LETTER ---\n{cover_letter}\n")
            parts.append(f"\n--- TAILORED RESUME ---\n{tailored_resume}")
            if tailored_html:
                parts.append(f"\n--- TAILORED RESUME (HTML, for PDF) ---\n{tailored_html}\n")
            f.write("\n".join(parts))
        applied += 1
        applied_jobs.append({"company": company, "role": role, "url": url, "title": title, "app_file": app_file})

        # Auto-submit: fill and submit the application form
        if auto_submit:
            try:
                from job_submitter import submit_application
                sub = submit_application(
                    url=url,
                    name=profile.get("name", "").strip(),
                    email=profile.get("email", "").strip(),
                    phone=profile.get("phone", "").strip(),
                    resume_text=tailored_resume,
                    cover_letter=cover_letter,
                    openai_api_key=openai_api_key or "",
                    indeed_email=(profile.get("indeed_email") or "").strip(),
                    indeed_password=(profile.get("indeed_password") or "").strip(),
                    use_chrome_profile=profile.get("indeed_use_chrome_profile") in (True, "true", "1"),
                    chrome_profile_path=(profile.get("chrome_profile_path") or "").strip(),
                )
                applied_jobs[-1]["submitted"] = sub.get("submitted", False)
                applied_jobs[-1]["submit_note"] = sub.get("message", "")
            except ImportError:
                applied_jobs[-1]["submitted"] = False
                applied_jobs[-1]["submit_note"] = "Playwright not installed. pip install playwright && playwright install chromium"
            except Exception as e:
                applied_jobs[-1]["submitted"] = False
                applied_jobs[-1]["submit_note"] = str(e)

    submitted_count = sum(1 for j in applied_jobs if j.get("submitted"))
    manual_count = tracked - submitted_count
    apps_path = os.path.abspath(applications_dir)  # used in both branches
    if auto_submit:
        lines = []
        lines.append("=== JOB APPLICATION RESULTS ===")
        lines.append("")
        if submitted_count > 0 and manual_count == 0:
            lines.append(f"✅ All {submitted_count} applications submitted successfully.")
        elif submitted_count > 0 and manual_count > 0:
            lines.append(f"✅ Submitted: {submitted_count}  |  ⚠️ Manual needed: {manual_count}")
        else:
            lines.append(f"⚠️ No forms auto-submitted. All {tracked} need manual completion.")
        lines.append("")
        lines.append("--- Per-job status ---")
        for idx, j in enumerate(applied_jobs, 1):
            status = "✅ submitted" if j.get("submitted") else f"⚠️ manual: {j.get('submit_note', 'open URL to complete')}"
            lines.append(f"{idx}. {j['title']} at {j['company']}")
            lines.append(f"   URL: {j['url']}")
            lines.append(f"   Status: {status}")
            if j.get("app_file") and os.path.isfile(j["app_file"]):
                lines.append(f"   Resume & cover: {j['app_file']}")
            lines.append("")
        lines.append("--- Where to find things ---")
        lines.append(f"• Materials folder: {apps_path}")
        lines.append("• Indeed: https://www.indeed.com/applied — check \"Applied\" for submissions")
        if manual_count > 0:
            lines.append("")
            lines.append("For manual jobs: open the URL above, paste your resume and cover letter from the file, and submit.")
        msg = "\n".join(lines)
    else:
        lines = [f"Tracked {tracked} application(s).", ""]
        for idx, j in enumerate(applied_jobs, 1):
            lines.append(f"{idx}. {j['title']} at {j['company']}")
            lines.append(f"   URL: {j['url']}")
            if j.get("app_file"):
                lines.append(f"   Materials: {j['app_file']}")
            lines.append("")
        lines.append(f"Materials folder: {apps_path}")
        lines.append('Open each URL, paste resume & cover letter, and submit. Say "apply and submit to X jobs" for Butler to fill forms.')
        msg = "\n".join(lines)
    return {"ok": True, "message": msg, "applied": applied, "tracked": tracked, "jobs": applied_jobs}


def _process_job_to_materials(
    job: dict,
    role: str,
    base_resume: str,
    profile: dict,
    openai_api_key: str,
    applications_dir: str,
    index: int,
    fetch_page,
) -> dict | None:
    """Fetch job page, research company, tailor resume & cover letter, save. Returns job_done dict or None."""
    url = job.get("url", "").strip()
    if not url or not url.startswith("http"):
        return None
    title = job.get("title", "Unknown Role")
    snippet = job.get("snippet", "")
    job_desc = snippet
    try:
        full_page = fetch_page(url)
        if full_page and len(full_page) > 200:
            job_desc = full_page[:6000]
    except Exception:
        pass

    company = (job.get("company") or "").strip()
    if not company and job_desc:
        m = re.search(r"(?:company|employer|at)\s+([A-Za-z0-9][A-Za-z0-9\s&.,'-]{2,60}?)(?:\n|Remote|Full-time|$)", job_desc[:3000], re.I)
        if m:
            company = m.group(1).strip()[:80]
    if not company:
        company = title.split(" at ")[-1].split(" - ")[0] if " at " in title else "Unknown"

    company_research = research_company(company, openai_api_key) if company else ""
    br_html = (profile.get("base_resume_html") or "").strip()
    tailor_r = (
        tailor_resume(
            base_resume,
            job_desc,
            company,
            role,
            openai_api_key,
            base_resume_html=br_html or None,
        )
        if base_resume and openai_api_key
        else {"ok": False, "content": base_resume, "content_html": None}
    )
    cover_r = generate_cover_letter(
        job_desc, company, role, profile.get("user_context", ""), openai_api_key, profile=profile
    ) if openai_api_key else {"ok": False, "content": ""}
    tailored_resume = tailor_r.get("content") or base_resume
    tailored_html = tailor_r.get("content_html")
    cover_letter = cover_r.get("content") or ""

    add_job(company=company, role=role, url=url, status="prepared")
    safe_name = re.sub(r"[^\w\-]", "_", company)[:50]
    app_file = os.path.join(applications_dir, f"{safe_name}_{index}.txt")
    with open(app_file, "w", encoding="utf-8") as f:
        parts = [f"=== {title} at {company} ===\nURL: {url}\n"]
        if company_research:
            parts.append(f"\n--- COMPANY RESEARCH ---\n{company_research}\n")
        parts.append(f"\n--- COVER LETTER ---\n{cover_letter}\n")
        parts.append(f"\n--- TAILORED RESUME ---\n{tailored_resume}")
        if tailored_html:
            parts.append(f"\n--- TAILORED RESUME (HTML, for PDF) ---\n{tailored_html}\n")
        f.write("\n".join(parts))
    return {"company": company, "role": role, "url": url, "title": title, "app_file": app_file}


def prepare_materials_for_urls(
    urls: list[str],
    role: str = "developer",
    openai_api_key: str = "",
) -> dict:
    """
    Prepare tailored materials (research, resume, cover letter) for job URLs.
    Use when scraping fails—user opens search links, copies job URLs, and pastes them here.
    """
    profile = get_user_profile()
    base_resume = profile_plain_resume(profile)
    if not base_resume:
        return {"ok": False, "message": "Add your resume in Profile (or profile.json).", "jobs": []}
    urls = [u.strip() for u in urls if (u or "").strip().startswith("http")]
    if not urls:
        return {"ok": False, "message": "Provide job URLs (e.g. indeed.com/viewjob?jk=...). Open search links, pick jobs, copy URLs, then say 'prepare materials for [paste URLs]'.", "jobs": []}

    try:
        from web_fetcher import fetch_page
    except ImportError:
        fetch_page = lambda u: ""

    config_dir = os.path.dirname(_job_tracker_path())
    applications_dir = os.path.join(config_dir, "applications")
    os.makedirs(applications_dir, exist_ok=True)

    jobs_done = []
    for i, url in enumerate(urls[:10]):
        job = {"url": url, "title": "Job", "company": "", "snippet": ""}
        r = _process_job_to_materials(job, role, base_resume, profile, openai_api_key, applications_dir, i, fetch_page)
        if r:
            jobs_done.append(r)

    if not jobs_done:
        return {"ok": False, "message": "Could not fetch job pages. Ensure URLs are valid job postings (Indeed viewjob, etc.).", "jobs": []}
    lines = [f"Prepared materials for {len(jobs_done)} job(s).", ""]
    for idx, j in enumerate(jobs_done, 1):
        lines.append(f"{idx}. {j['title']} at {j['company']}")
        lines.append(f"   Link: {j['url']}")
        lines.append(f"   Materials: {j['app_file']}")
        lines.append("")
    lines.append(f"All materials: {os.path.abspath(applications_dir)}")
    return {"ok": True, "message": "\n".join(lines), "jobs": jobs_done, "tracked": len(jobs_done)}


def job_search_materials_only(
    description: str,
    max_jobs: int = 5,
    openai_api_key: str = "",
) -> dict:
    """
    Simplified pipeline: description → search → company research → tailored resume & cover letter → store with link.
    No application submission. Materials only.
    """
    profile = get_user_profile()
    base_resume = profile_plain_resume(profile)
    if not base_resume:
        return {"ok": False, "message": "Add your resume in Profile (or profile.json).", "jobs": []}

    role, location = _parse_description_to_search(description, openai_api_key)
    search_r = search_jobs(role, location, max_results=max_jobs)
    if not search_r.get("ok") or not search_r.get("jobs"):
        msg = search_r.get("message", "No jobs found")
        links = search_r.get("search_links", [])
        if links:
            link_str = ", ".join(f"[{x['name']}]({x['url']})" for x in links[:3])
            msg += f" Fallback links: {link_str}"
        return {"ok": True, "message": msg, "jobs": [], "search_links": links}

    try:
        from web_fetcher import fetch_page
    except ImportError:
        fetch_page = lambda u: ""

    config_dir = os.path.dirname(_job_tracker_path())
    applications_dir = os.path.join(config_dir, "applications")
    os.makedirs(applications_dir, exist_ok=True)
    apps_path = os.path.abspath(applications_dir)

    jobs_done = []
    for i, job in enumerate(search_r["jobs"][:max_jobs]):
        r = _process_job_to_materials(job, role, base_resume, profile, openai_api_key, applications_dir, i, fetch_page)
        if r:
            jobs_done.append(r)

    lines = [f"Found {len(jobs_done)} jobs. Stored materials with links.", ""]
    for idx, j in enumerate(jobs_done, 1):
        lines.append(f"{idx}. {j['title']} at {j['company']}")
        lines.append(f"   Link: {j['url']}")
        lines.append(f"   Materials: {j['app_file']}")
        lines.append("")
    lines.append(f"All materials: {apps_path}")
    msg = "\n".join(lines)
    return {"ok": True, "message": msg, "jobs": jobs_done, "tracked": len(jobs_done)}


def parse_interview_from_text(text: str) -> list[dict]:
    """Extract potential interview dates from text (e.g. email body)."""
    dates = []
    # Common patterns: "interview on March 20", "Monday, 3/20", "2025-03-20", "March 20th at 2pm"
    patterns = [
        r"(?:interview|meeting|call)\s+(?:on|scheduled for|at)?\s*(\d{4}-\d{2}-\d{2})",
        r"(?:interview|meeting|call)\s+(?:on|for)?\s*(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)[,\s]+(\w+\s+\d{1,2}(?:st|nd|rd|th)?)",
        r"(\d{1,2}/\d{1,2}/\d{2,4})",
        r"(\w+\s+\d{1,2}(?:st|nd|rd|th)?(?:\s+at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm))?)",
    ]
    for pat in patterns:
        for m in re.finditer(pat, text, re.I):
            dates.append({"raw": m.group(0), "context": text[max(0, m.start() - 50) : m.end() + 50]})
    return dates[:10]
