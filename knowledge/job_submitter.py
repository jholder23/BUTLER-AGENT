"""
Robust auto-submit job applications using Playwright.
Handles multi-page flows, uses AI to adapt to unknown form layouts.
Supports Indeed login: use Chrome profile (indeed_use_chrome_profile) for Google login,
or indeed_email/indeed_password for email/password (if Indeed still offers it).
Runs in headed mode so user can see progress and intervene when needed.
"""
from __future__ import annotations

import json
import os
import re
import tempfile
from pathlib import Path


def _config_dir() -> str:
    """Butlor config dir (Documents/Butlor or BUTLOR_CONFIG)."""
    from butlor_paths import ensure_butlor_config_dir

    return str(ensure_butlor_config_dir())


def _indeed_profile_dir() -> str:
    """Persistent browser profile for Indeed (keeps login)."""
    d = os.path.join(_config_dir(), "playwright_indeed_profile")
    os.makedirs(d, exist_ok=True)
    return d


def _is_indeed_url(url: str) -> bool:
    return "indeed.com" in (url or "").lower()


def _default_chrome_profile_path() -> str:
    """Default Chrome User Data path (close Chrome before using)."""
    if os.name == "nt":
        return os.path.join(os.environ.get("LOCALAPPDATA", ""), "Google", "Chrome", "User Data")
    return os.path.join(Path.home(), ".config", "google-chrome")


def _login_indeed_google(page, timeout_ms: int = 20000) -> bool:
    """Click 'Continue with Google' - works when using Chrome profile with Google logged in."""
    try:
        page.goto("https://secure.indeed.com/auth?hl=en_CA&co=CA", wait_until="domcontentloaded", timeout=timeout_ms)
        page.wait_for_load_state("networkidle", timeout=timeout_ms)
        page.wait_for_timeout(2500)

        # Click "Continue with Google" or "Continue as [email]" (when Chrome has Google session)
        for sel in [
            'button:has-text("Continue with Google")',
            'a:has-text("Continue with Google")',
            '[data-tn-element="googleAuth"]',
            'button:has-text("Continue as")',
            'a:has-text("Continue as")',
            '[role="button"]:has-text("Continue")',
        ]:
            try:
                el = page.locator(sel).first
                if el.count() > 0 and el.is_visible():
                    el.click(timeout=5000)
                    page.wait_for_timeout(5000)
                    page.wait_for_load_state("domcontentloaded", timeout=10000)
                    return True
            except Exception:
                pass

        # Fallback: any element with "Continue with Google"
        for el in page.get_by_text("Continue with Google").all():
            try:
                if el.is_visible():
                    el.click(timeout=3000)
                    page.wait_for_timeout(5000)
                    return True
            except Exception:
                pass
        return False
    except Exception:
        return False


def _login_indeed_email(page, email: str, password: str, timeout_ms: int = 15000) -> bool:
    """Log into Indeed with email/password (if Indeed offers that option)."""
    try:
        page.goto("https://secure.indeed.com/auth?hl=en", wait_until="domcontentloaded", timeout=timeout_ms)
        page.wait_for_load_state("networkidle", timeout=timeout_ms)
        page.wait_for_timeout(1500)

        email_sel = 'input[type="email"], input[name="__email"], input[id="login-email-input"], input[placeholder*="mail" i], input[autocomplete="username"]'
        email_el = page.locator(email_sel).first
        if email_el.count() > 0:
            email_el.fill(email, timeout=5000)

        pw_el = page.locator('input[type="password"], input[name="__password"]').first
        if pw_el.count() > 0:
            pw_el.fill(password, timeout=5000)

        for btn_text in ["Sign in", "Continue", "Log in", "Submit"]:
            try:
                btn = page.get_by_role("button", name=re.compile(btn_text, re.I)).first
                if btn.count() > 0 and btn.is_visible():
                    btn.click(timeout=3000)
                    break
            except Exception:
                pass

        page.wait_for_timeout(4000)
        body = page.locator("body").inner_text(timeout=3000)
        if re.search(r"sign in|log in", body, re.I) and "account" not in body.lower():
            return False
        return True
    except Exception:
        return False


def _ensure_pdf_resume(resume_text: str) -> str | None:
    """Convert resume text to PDF. Returns path or None."""
    try:
        from fpdf import FPDF
    except ImportError:
        return None
    resume_dir = Path(tempfile.gettempdir()) / "butlor_applications"
    resume_dir.mkdir(exist_ok=True)
    pdf_path = resume_dir / "resume_upload.pdf"
    try:
        pdf = FPDF()
        pdf.add_page()
        pdf.set_font("Helvetica", size=11)
        # Simple wrap: split by newlines, use multi_cell
        for line in resume_text[:30000].replace("\r", "").split("\n"):
            line = line[:120]
            pdf.multi_cell(0, 6, line or " ")
        pdf.output(str(pdf_path))
        return str(pdf_path)
    except Exception:
        return None


def _extract_form_structure(page) -> list[dict]:
    """Extract visible form fields and buttons for AI analysis."""
    return page.evaluate("""
    () => {
        const fields = [];
        const seen = new Set();
        document.querySelectorAll('input, textarea, select, button, [role="button"], [role="link"]').forEach(el => {
            if (!el.offsetParent && el.offsetParent !== null) return;
            const rect = el.getBoundingClientRect();
            if (rect.width < 2 || rect.height < 2) return;
            const tag = el.tagName.toLowerCase();
            const type = el.type || '';
            const name = el.name || '';
            const id = el.id || '';
            const placeholder = el.placeholder || '';
            const ariaLabel = el.getAttribute('aria-label') || '';
            const value = (el.value || '').slice(0, 50);
            const text = (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
            let label = '';
            if (id && document.querySelector(`label[for="${id}"]`)) {
                label = document.querySelector(`label[for="${id}"]`).textContent.replace(/\\s+/g, ' ').trim().slice(0, 80);
            } else if (el.closest('label')) {
                label = el.closest('label').textContent.replace(/\\s+/g, ' ').trim().slice(0, 80);
            }
            const parentText = (el.closest('div, form, fieldset')?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 150);
            const key = `${tag}:${type}:${name}:${id}:${label}`;
            if (seen.has(key)) return;
            seen.add(key);
            fields.push({
                tag, type, name, id, placeholder, ariaLabel, label, value, text, parentText,
                isButton: tag === 'button' || type === 'submit' || el.getAttribute('role') === 'button' || el.getAttribute('role') === 'link'
            });
        });
        return fields;
    }
    """)


def _ai_suggest_actions(page, fields: list[dict], name: str, email: str, phone: str, cover_letter: str, openai_api_key: str, page_url: str = "") -> list[dict] | None:
    """Use OpenAI to analyze form and suggest fill/click actions. Passes full form structure."""
    if not openai_api_key or not openai_api_key.strip():
        return None
    try:
        from openai import OpenAI
        client = OpenAI(api_key=openai_api_key.strip())
        form_context = "Indeed job application" if "indeed.com" in (page_url or "") else "job application form"
        first_name = name.split(maxsplit=1)[0] if name else ""
        last_name = name.split(maxsplit=1)[1] if name and " " in name else ""
        prompt = f"""You are filling a {form_context}. Analyze the form elements and output a JSON array of actions.

CANDIDATE DATA:
- Full name: "{name}"
- First name: "{first_name}"
- Last name: "{last_name}"
- Email: "{email}"
- Phone: "{phone}"
- Cover letter (use for message/why/description): "{cover_letter[:300]}..."
- Resume: use "resume" for file upload fields

FORM ELEMENTS (tag, type, name, id, placeholder, ariaLabel, label, text, parentText):
{json.dumps(fields[:80], indent=0)}

RULES:
1. Output ONLY a JSON array of actions.
2. Each action: {{"action":"fill","match":"exact label/placeholder/ariaLabel/name from element","value":"from candidate data or 'resume'"}} or {{"action":"click","match":"button/link text"}}
3. Match using the EXACT text from label, placeholder, ariaLabel, or name—these forms vary.
4. For name: try "first name"/"firstname" and "last name"/"lastname" separately if those fields exist.
5. Indeed often has multi-step: fill visible fields, then click "Continue" or "Next". Submit only on final step.
6. For file upload: use value "resume".
7. Suggest 5-15 fill actions and 1-2 click actions. Fill all visible input fields before clicking."""

        r = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{"role": "user", "content": prompt}],
            max_tokens=800,
        )
        raw = (r.choices[0].message.content or "").strip()
        # Extract JSON from response (might have markdown)
        m = re.search(r"\[[\s\S]*\]", raw)
        if m:
            return json.loads(m.group(0))
    except Exception:
        pass
    return None


def submit_application(
    url: str,
    name: str,
    email: str,
    phone: str,
    resume_text: str,
    cover_letter: str,
    timeout_ms: int = 35000,
    openai_api_key: str = "",
    indeed_email: str = "",
    indeed_password: str = "",
    use_chrome_profile: bool = False,
    chrome_profile_path: str = "",
) -> dict:
    """
    Navigate to job URL and attempt to fill and submit the application form.
    For Indeed: use_chrome_profile=true uses your Chrome profile (Google login). Close Chrome first.
    Or use indeed_email/indeed_password for email/password login.
    Returns {"ok": bool, "message": str, "submitted": bool}.
    """
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        return {
            "ok": False,
            "message": "Install playwright: pip install playwright && playwright install chromium",
            "submitted": False,
        }

    if not name or not email:
        return {"ok": False, "message": "Profile needs 'name' and 'email' for auto-submit", "submitted": False}

    resume_path = None
    pdf_path = _ensure_pdf_resume(resume_text)
    if not pdf_path:
        resume_dir = Path(tempfile.gettempdir()) / "butlor_applications"
        resume_dir.mkdir(exist_ok=True)
        resume_path = resume_dir / "resume_upload.txt"
        resume_path.write_text(resume_text[:50000], encoding="utf-8")
        resume_path = str(resume_path)
    else:
        resume_path = pdf_path

    use_indeed_login = _is_indeed_url(url) and (use_chrome_profile or (indeed_email and indeed_password))
    if use_indeed_login and use_chrome_profile:
        user_data_dir = (chrome_profile_path or _default_chrome_profile_path()).strip()
        if not user_data_dir or not os.path.isdir(user_data_dir):
            return {"ok": False, "message": f"Chrome profile not found at {user_data_dir}. Set chrome_profile_path in profile.json or close Chrome and use default.", "submitted": False}
    elif use_indeed_login:
        user_data_dir = _indeed_profile_dir()
    else:
        user_data_dir = None

    try:
        with sync_playwright() as p:
            browser = None
            if user_data_dir:
                launch_opts = dict(
                    headless=False,
                    viewport={"width": 1280, "height": 900},
                    user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
                )
                if use_chrome_profile:
                    launch_opts["channel"] = "chrome"
                context = p.chromium.launch_persistent_context(
                    user_data_dir,
                    **launch_opts,
                )
            else:
                browser = p.chromium.launch(headless=False)
                context = browser.new_context(
                    viewport={"width": 1280, "height": 900},
                    user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
                )
            page = context.new_page() if context.pages else context.pages[0] if context.pages else context.new_page()
            if not page:
                page = context.new_page()

            # Indeed: ensure logged in before applying
            if use_indeed_login:
                page.goto("https://www.indeed.com", wait_until="domcontentloaded", timeout=15000)
                page.wait_for_timeout(2000)
                body = page.locator("body").inner_text(timeout=3000)
                if re.search(r"Sign\s*in|Log\s*in", body, re.I):
                    logged_in = False
                    if use_chrome_profile:
                        logged_in = _login_indeed_google(page, 20000)
                    if not logged_in and indeed_email and indeed_password:
                        logged_in = _login_indeed_email(page, indeed_email, indeed_password, 15000)
                    if not logged_in:
                        if browser:
                            browser.close()
                        else:
                            context.close()
                        return {"ok": True, "message": "Indeed login failed. For Google login: set indeed_use_chrome_profile=true in profile.json and close Chrome before applying.", "submitted": False}

            try:
                page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
                page.wait_for_load_state("networkidle", timeout=timeout_ms)
            except Exception as e:
                if browser:
                    browser.close()
                else:
                    context.close()
                return {"ok": False, "message": f"Could not load page: {e}", "submitted": False}

            # Detect captcha / human verification
            try:
                body_text = page.locator("body").inner_text(timeout=3000)
                if re.search(r"captcha|verify you're human|robot|recaptcha|honeypot", body_text, re.I):
                    if browser:
                        browser.close()
                    else:
                        context.close()
                    return {"ok": True, "message": "Human verification detected. Open the URL manually to complete.", "submitted": False}
            except Exception:
                pass

            name_parts = name.strip().split(maxsplit=1)
            first_name = name_parts[0] if name_parts else name
            last_name = name_parts[1] if len(name_parts) > 1 else ""

            label_variants = {
                "first": (first_name, ["first name", "firstname", "given name", "fname"]),
                "last": (last_name, ["last name", "lastname", "surname", "family name", "lname"]),
                "full_name": (name, ["full name", "your name", "applicant name", "candidate name", "name"]),
                "email": (email, ["email", "e-mail", "email address", "work email"]),
                "phone": (phone or "", ["phone", "telephone", "mobile", "cell", "phone number"]),
                "cover": (cover_letter[:4000], ["cover letter", "coverletter", "message", "additional info", "why you", "introduction", "additional comments"]),
            }

            def fill_by_label(page, key: str):
                value, labels = label_variants[key]
                if not value and key not in ("cover", "phone"):
                    return 0
                filled = 0
                for lbl in labels:
                    try:
                        # For "name" alone, use exact to avoid matching "first name" / "last name"
                        if lbl == "name":
                            el = page.get_by_label("name", exact=True).first
                        else:
                            el = page.get_by_label(re.compile(lbl.replace(" ", "\\s*"), re.I), exact=False).first
                        if el.count() > 0:
                            el.fill(str(value), timeout=3000)
                            filled += 1
                            break
                    except Exception:
                        pass
                return filled

            def click_next_button(page):
                for text in ["submit", "apply", "next", "continue", "save", "send application", "complete"]:
                    try:
                        btn = page.get_by_role("button", name=re.compile(text, re.I)).first
                        if btn.count() > 0 and btn.is_visible():
                            btn.click(timeout=3000)
                            return True
                    except Exception:
                        pass
                try:
                    btn = page.locator('button:has-text("Submit"), button:has-text("Apply"), button:has-text("Next"), input[type="submit"], a:has-text("Apply")').first
                    if btn.count() > 0 and btn.is_visible():
                        btn.click(timeout=3000)
                        return True
                except Exception:
                    pass
                return False

            total_filled = 0
            submitted = False
            max_steps = 8

            for step in range(max_steps):
                step_filled = 0

                # Try AI-assisted fill if we have key and (first step or stuck)
                if openai_api_key:
                    fields = _extract_form_structure(page)
                    actions = _ai_suggest_actions(page, fields, name, email, phone or "", cover_letter, openai_api_key, url)
                    if actions:
                        for act in actions:
                            try:
                                if act.get("action") == "fill":
                                    match = act.get("match", "")
                                    val = act.get("value", "")
                                    if val == "resume" and resume_path:
                                        file_inp = page.locator("input[type=file]").first
                                        if file_inp.count() > 0:
                                            file_inp.set_input_files(resume_path, timeout=3000)
                                            step_filled += 1
                                    elif match and val:
                                        filled_this = False
                                        for try_fn in [
                                            lambda: page.get_by_label(re.compile(re.escape(match), re.I), exact=False).first,
                                            lambda: page.get_by_placeholder(re.compile(re.escape(match), re.I)).first,
                                            lambda: page.locator(f'input[name*="{match[:20]}"], textarea[name*="{match[:20]}"]').first,
                                        ]:
                                            try:
                                                el = try_fn()
                                                if el.count() > 0 and el.is_visible():
                                                    el.fill(val[:4000], timeout=3000)
                                                    step_filled += 1
                                                    filled_this = True
                                                    break
                                            except Exception:
                                                pass
                                        if not filled_this and match:
                                            try:
                                                el = page.get_by_label(match, exact=False).first
                                                if el.count() > 0:
                                                    el.fill(val[:4000], timeout=3000)
                                                    step_filled += 1
                                            except Exception:
                                                pass
                                elif act.get("action") == "click":
                                    match = act.get("match", "")
                                    if match:
                                        btn = page.get_by_role("button", name=re.compile(re.escape(match), re.I)).first
                                        if btn.count() > 0 and btn.is_visible():
                                            btn.click(timeout=3000)
                                            break
                            except Exception:
                                pass

                # Heuristic fill (always run as fallback/supplement)
                for key in ["first", "last", "full_name", "email", "phone", "cover"]:
                    step_filled += fill_by_label(page, key)

                # Resume file upload
                try:
                    file_inp = page.locator("input[type=file]").first
                    if file_inp.count() > 0 and file_inp.is_visible():
                        file_inp.set_input_files(resume_path, timeout=3000)
                        step_filled += 1
                except Exception:
                    pass

                total_filled += step_filled

                # Click submit/next
                if click_next_button(page):
                    page.wait_for_timeout(2500)
                    try:
                        # Check for success indicators
                        body = page.locator("body").inner_text(timeout=2000)
                        if re.search(r"thank you|success|submitted|application (sent|received)", body, re.I):
                            submitted = True
                            break
                    except Exception:
                        pass
                    # Check if we navigated (new page in multi-step)
                    page.wait_for_load_state("domcontentloaded", timeout=5000)
                else:
                    break

            page.wait_for_timeout(1500)
            if browser:
                browser.close()
            else:
                context.close()

    except Exception as e:
        return {"ok": False, "message": str(e), "submitted": False}
    finally:
        if resume_path and os.path.isfile(resume_path):
            try:
                os.unlink(resume_path)
            except Exception:
                pass

    msg = f"Filled {total_filled} field(s). Form {'submitted' if submitted else 'left open for you to review and submit.'}"
    return {"ok": True, "message": msg, "submitted": submitted}
