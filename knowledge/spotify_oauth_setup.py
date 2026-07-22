#!/usr/bin/env python3
"""
One-time Spotify OAuth for Butler SEO playlists.

1. Create an app at https://developer.spotify.com/dashboard
2. Add Redirect URI: http://127.0.0.1:4389/callback  (or SPOTIFY_REDIRECT_URI)
3. Put SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in repo .env
4. Run:  python knowledge/spotify_oauth_setup.py

Opens a local callback server, completes PKCE auth, saves token under Butlor data
(spotify_token.json).
"""
from __future__ import annotations

import sys
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

# Ensure knowledge/ is on path when run as script
_ROOT = Path(__file__).resolve().parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from spotify_helper import (  # noqa: E402
    DEFAULT_REDIRECT_URI,
    complete_oauth,
    start_oauth,
    _redirect_uri,
)


def main() -> int:
    started = start_oauth()
    if not started.get("ok"):
        print(started.get("message") or "Failed to start OAuth")
        return 1
    auth_url = started["authorize_url"]
    redirect = started.get("redirect_uri") or _redirect_uri() or DEFAULT_REDIRECT_URI
    parsed = urlparse(redirect)
    host = parsed.hostname or "127.0.0.1"
    port = parsed.port or 4389
    path = parsed.path or "/callback"

    result: dict = {}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            u = urlparse(self.path)
            if u.path != path:
                self.send_response(404)
                self.end_headers()
                self.wfile.write(b"Not found")
                return
            qs = parse_qs(u.query)
            code = (qs.get("code") or [""])[0]
            state = (qs.get("state") or [""])[0]
            err = (qs.get("error") or [""])[0]
            if err:
                result["error"] = err
                body = f"<h1>Spotify auth error</h1><p>{err}</p>".encode()
                self.send_response(400)
                self.send_header("Content-Type", "text/html")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                threading.Thread(target=httpd.shutdown, daemon=True).start()
                return
            done = complete_oauth(code, state)
            result.update(done)
            if done.get("ok"):
                body = (
                    b"<h1>Butler connected to Spotify</h1>"
                    b"<p>You can close this tab and return to the terminal.</p>"
                )
                self.send_response(200)
            else:
                msg = (done.get("message") or "failed").encode()
                body = b"<h1>Auth failed</h1><p>" + msg + b"</p>"
                self.send_response(400)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            threading.Thread(target=httpd.shutdown, daemon=True).start()

        def log_message(self, fmt, *args):  # noqa: A003
            return

    print("Opening browser for Spotify authorization…")
    print(f"Redirect URI must match your app settings: {redirect}")
    print(auth_url)
    print()
    webbrowser.open(auth_url)
    httpd = HTTPServer((host, port), Handler)
    print(f"Listening on {host}:{port}{path} …")
    httpd.serve_forever()
    if result.get("ok"):
        print(result.get("message") or "Connected.")
        return 0
    print(result.get("error") or result.get("message") or "Auth failed")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
