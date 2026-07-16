"""
Email integration for job search - read responses, find interview invites.
Requires Gmail API setup: credentials.json + token.json (run gmail_oauth_setup.py once).
"""
from __future__ import annotations

import os
import re
from datetime import datetime


def fetch_recent_emails(max_results: int = 20) -> dict:
    """
    Fetch recent emails from Gmail. Returns {ok, emails: [{subject, body, date, from}]}.
    Requires GMAIL_CREDENTIALS and GMAIL_TOKEN paths, or defaults to ~/Documents/Butlor/.
    """
    from butlor_paths import ensure_butlor_config_dir

    _root = ensure_butlor_config_dir()
    creds_path = os.environ.get("GMAIL_CREDENTIALS") or str(_root / "gmail_credentials.json")
    token_path = os.environ.get("GMAIL_TOKEN") or str(_root / "gmail_token.json")
    if not os.path.isfile(creds_path) or not os.path.isfile(token_path):
        return {"ok": False, "message": "Gmail not configured. Add gmail_credentials.json and run OAuth flow.", "emails": []}
    try:
        from google.oauth2.credentials import Credentials
        from google_auth_oauthlib.flow import InstalledAppFlow
        from google.auth.transport.requests import Request
        from googleapiclient.discovery import build
        import base64

        SCOPES = ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.send"]
        creds = None
        if os.path.exists(token_path):
            creds = Credentials.from_authorized_user_file(token_path, SCOPES)
        if not creds or not creds.valid:
            if creds and creds.expired and creds.refresh_token:
                creds.refresh(Request())
            else:
                flow = InstalledAppFlow.from_client_secrets_file(creds_path, SCOPES)
                creds = flow.run_local_server(port=0)
            with open(token_path, "w") as t:
                t.write(creds.to_json())

        service = build("gmail", "v1", credentials=creds)
        results = service.users().messages().list(userId="me", maxResults=max_results).execute()
        messages = results.get("messages", [])
        emails = []
        for msg_ref in messages:
            m = service.users().messages().get(userId="me", id=msg_ref["id"], format="full").execute()
            payload = m.get("payload", {})
            headers = {h["name"].lower(): h["value"] for h in payload.get("headers", [])}
            subject = headers.get("subject", "")
            fr = headers.get("from", "")
            date = headers.get("date", "")
            body = ""
            if "body" in payload and payload["body"].get("data"):
                body = base64.urlsafe_b64decode(payload["body"]["data"]).decode("utf-8", errors="replace")
            else:
                for part in payload.get("parts", []):
                    if part.get("mimeType") == "text/plain" and part.get("body", {}).get("data"):
                        body = base64.urlsafe_b64decode(part["body"]["data"]).decode("utf-8", errors="replace")
                        break
            emails.append({"subject": subject, "from": fr, "date": date, "body": body[:5000]})
        return {"ok": True, "emails": emails, "message": f"Fetched {len(emails)} emails"}
    except ImportError:
        return {"ok": False, "message": "Install: pip install google-auth-oauthlib google-api-python-client", "emails": []}
    except Exception as e:
        return {"ok": False, "message": str(e), "emails": []}


def parse_interview_invites(emails: list[dict]) -> list[dict]:
    """Extract potential interview info from emails."""
    invites = []
    keywords = ["interview", "schedule", "meeting", "call", "zoom", "teams", "calendar"]
    for e in emails:
        subj = (e.get("subject") or "").lower()
        body = (e.get("body") or "").lower()
        if not any(k in subj or k in body for k in keywords):
            continue
        # Simple date extraction
        date_matches = re.findall(r"(\d{1,2}/\d{1,2}/\d{2,4})|(\d{4}-\d{2}-\d{2})|(\w+\s+\d{1,2}(?:st|nd|rd|th)?)", body)
        dates = [m for g in date_matches for m in g if m]
        invites.append({
            "subject": e.get("subject", ""),
            "from": e.get("from", ""),
            "date": e.get("date", ""),
            "extracted_dates": dates[:3],
        })
    return invites
