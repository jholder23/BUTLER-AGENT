"""
Open Facebook Marketplace in a headed Playwright window using profile.json:
- facebook_use_chrome_profile: use Chrome User Data (close Chrome first).
- chrome_profile_path: User Data folder (optional; defaults to OS Chrome path).
- facebook_chrome_profile_directory: e.g. Default or Profile 1 (optional; auto-picked from facebook_email via scan).
- facebook_email + facebook_password: optional password login if the login form appears
  (2FA / checkpoints must be completed manually in the window).

Run standalone: python facebook_marketplace.py
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
from pathlib import Path

from chrome_profile_detect import (
    default_chrome_user_data_dir,
    detect_chrome_profiles_for_email,
    pick_best_chrome_profile,
)


def _config_dir() -> str:
    from butlor_paths import ensure_butlor_config_dir

    return str(ensure_butlor_config_dir())


def _default_chrome_user_data() -> str:
    return default_chrome_user_data_dir()


def _load_profile() -> dict:
    p = os.path.join(_config_dir(), "profile.json")
    if not os.path.isfile(p):
        return {}
    try:
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _try_facebook_password_login(page, email: str, password: str, timeout_ms: int = 25000) -> bool:
    if not email or not password:
        return False
    try:
        page.wait_for_timeout(1200)
        email_sel = 'input[name="email"], input#email, input[type="email"]'
        pass_sel = 'input[name="pass"], input#pass, input[type="password"]'
        el = page.locator(email_sel).first
        if el.count() == 0 or not el.is_visible(timeout=3000):
            return False
        el.fill(email, timeout=5000)
        page.locator(pass_sel).first.fill(password, timeout=5000)
        for sel in ('button[name="login"]', 'button[type="submit"]', 'text=Log in', 'text=Log In'):
            try:
                btn = page.locator(sel).first
                if btn.count() and btn.is_visible(timeout=2000):
                    btn.click(timeout=5000)
                    break
            except Exception:
                continue
        page.wait_for_timeout(4000)
        return True
    except Exception:
        return False


def open_facebook_marketplace(profile: dict | None = None) -> dict:
    """
    Blocks until all browser pages are closed by the user.
    Returns {"ok": bool, "message": str}.
    """
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        return {
            "ok": False,
            "message": "Install Playwright: pip install playwright && playwright install chromium",
        }

    profile = profile or _load_profile()
    use_chrome = bool(profile.get("facebook_use_chrome_profile"))
    chrome_path = (profile.get("chrome_profile_path") or "").strip() or _default_chrome_user_data()
    fb_email = (profile.get("facebook_email") or "").strip()
    fb_pass = (profile.get("facebook_password") or "").strip()
    profile_subdir = (profile.get("facebook_chrome_profile_directory") or "").strip()
    if use_chrome and not profile_subdir and fb_email:
        hits = detect_chrome_profiles_for_email(fb_email, chrome_path)
        best = pick_best_chrome_profile(hits)
        if best:
            profile_subdir = best["profile_directory"]

    if use_chrome and not os.path.isdir(chrome_path):
        return {
            "ok": False,
            "message": f"Chrome User Data not found at {chrome_path}. Set chrome_profile_path in profile.json or turn off 'Use Chrome for Facebook'.",
        }

    user_data_dir = chrome_path if use_chrome else os.path.join(_config_dir(), "playwright_facebook_profile")
    if not use_chrome:
        os.makedirs(user_data_dir, exist_ok=True)

    launch_args: list[str] = []
    if use_chrome and profile_subdir:
        launch_args.append(f"--profile-directory={profile_subdir}")

    launch_kw = dict(
        headless=False,
        viewport={"width": 1320, "height": 900},
        user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
        args=launch_args,
    )

    try:
        with sync_playwright() as p:
            if use_chrome:
                context = p.chromium.launch_persistent_context(
                    user_data_dir,
                    channel="chrome",
                    **launch_kw,
                )
            else:
                context = p.chromium.launch_persistent_context(
                    user_data_dir,
                    **launch_kw,
                )
            page = context.new_page()
            page.goto("https://www.facebook.com/marketplace", wait_until="domcontentloaded", timeout=40000)
            page.wait_for_timeout(2000)
            try:
                body = page.locator("body").inner_text(timeout=5000)
            except Exception:
                body = ""
            if re.search(r"log in|log in to facebook|sign up for facebook", body, re.I) and fb_email and fb_pass:
                _try_facebook_password_login(page, fb_email, fb_pass)
            page.goto("https://www.facebook.com/marketplace", wait_until="domcontentloaded", timeout=40000)

            print("Butler: Facebook Marketplace is open. Close the browser window when finished.", flush=True)
            # Wait until user closes all pages (or timeout 2h)
            deadline = time.time() + 7200
            while time.time() < deadline:
                try:
                    if len(context.pages) == 0:
                        break
                    time.sleep(0.4)
                except Exception:
                    break
            try:
                context.close()
            except Exception:
                pass
        return {"ok": True, "message": "Session ended."}
    except Exception as e:
        return {"ok": False, "message": str(e)}


def main() -> int:
    r = open_facebook_marketplace()
    if not r["ok"]:
        print(r.get("message", "Failed"), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
