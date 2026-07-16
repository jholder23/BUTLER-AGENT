#!/usr/bin/env python3
"""
Run once to get Gmail token for job search email reading.
1. Create a project at https://console.cloud.google.com/
2. Enable Gmail API
3. Create OAuth 2.0 credentials (Desktop app)
4. Download credentials.json to your Butler data folder as gmail_credentials.json (default: Documents/Butlor)
5. Run: python gmail_oauth_setup.py
"""
import os

from butlor_paths import ensure_butlor_config_dir


def main():
    root = ensure_butlor_config_dir()
    creds_path = str(root / "gmail_credentials.json")
    token_path = str(root / "gmail_token.json")
    if not os.path.isfile(creds_path):
        print(f"Add gmail_credentials.json to {creds_path}")
        print("Get it from: https://console.cloud.google.com/ → APIs & Services → Credentials")
        return
    try:
        from google_auth_oauthlib.flow import InstalledAppFlow
        from google.oauth2.credentials import Credentials

        SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
]
        flow = InstalledAppFlow.from_client_secrets_file(creds_path, SCOPES)
        creds = flow.run_local_server(port=0)
        with open(token_path, "w") as f:
            f.write(creds.to_json())
        print(f"Token saved to {token_path}. You can now use 'check my email for interviews'.")
    except ImportError:
        print("pip install google-auth-oauthlib google-api-python-client")
    except Exception as e:
        print(f"Error: {e}")


if __name__ == "__main__":
    main()
