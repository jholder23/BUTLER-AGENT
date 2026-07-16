"""
Daily apartment search scheduler. Runs every morning at configured time.
"""
from __future__ import annotations

import threading
import time
from datetime import datetime


def _get_run_time() -> tuple[int, int]:
    """Get hour, minute from config. Default 8:00."""
    try:
        from apartment_search import get_apartment_config
        cfg = get_apartment_config()
        run_at = cfg.get("run_at", "08:00")
        parts = str(run_at).split(":")
        h = int(parts[0]) if parts else 8
        m = int(parts[1]) if len(parts) > 1 else 0
        return max(0, min(23, h)), max(0, min(59, m))
    except Exception:
        return 8, 0


def _should_run_now() -> bool:
    """True if current time matches run_at."""
    hour, minute = _get_run_time()
    now = datetime.now()
    return now.hour == hour and now.minute == minute


def _run_once():
    try:
        from apartment_search import run_daily_search_and_email
        r = run_daily_search_and_email()
        if r.get("ok"):
            print(f"[Apartment] {r.get('message', '')}")
        else:
            print(f"[Apartment] {r.get('message', 'Failed')}")
    except Exception as e:
        print(f"[Apartment] Error: {e}")


_last_run_day: int | None = None


def _scheduler_loop():
    """Check every minute; run if it's the right time and we haven't run today."""
    global _last_run_day
    while True:
        try:
            now = datetime.now()
            hour, minute = _get_run_time()
            if now.hour == hour and now.minute == minute:
                if _last_run_day != now.date().toordinal():
                    _last_run_day = now.date().toordinal()
                    _run_once()
            time.sleep(60)
        except Exception:
            time.sleep(60)


def start_apartment_scheduler():
    """Start background thread for daily apartment search."""
    t = threading.Thread(target=_scheduler_loop, daemon=True)
    t.start()
