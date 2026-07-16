"""CLI for job search features. Usage: python job_cli.py <action> [args...]"""
import json
import os
import sys

# Inject OPENAI_API_KEY from env for job operations
def _get_openai_key():
    return os.environ.get("OPENAI_API_KEY", "")


def main():
    args = sys.argv[1:]
    if not args:
        print(json.dumps({
            "ok": False,
            "message": "Usage: job_cli.py <tracker|add_job|interviews|tailor_resume|cover_letter> [args]"
        }))
        return

    action = args[0].lower()
    try:
        from job_helper import (
            get_tracker,
            add_job,
            update_job,
            get_upcoming_interviews,
            tailor_resume,
            generate_cover_letter,
        )

        if action == "tracker":
            r = get_tracker()
            print(json.dumps(r))

        elif action == "add_job":
            # add_job company role [url] [status] [interview_date]
            company = args[1] if len(args) > 1 else ""
            role = args[2] if len(args) > 2 else ""
            url = args[3] if len(args) > 3 else ""
            status = args[4] if len(args) > 4 else "applied"
            interview_date = args[5] if len(args) > 5 else None
            if not company or not role:
                r = {"ok": False, "message": "Usage: job_cli.py add_job <company> <role> [url] [status] [interview_date]"}
            else:
                r = add_job(company=company, role=role, url=url, status=status, interview_date=interview_date)
            print(json.dumps(r))

        elif action == "interviews":
            days = int(args[1]) if len(args) > 1 else 14
            r = get_upcoming_interviews(days_ahead=days)
            print(json.dumps(r))

        elif action == "tailor_resume":
            # Read from stdin or file path: base_resume, job_desc, company, role
            data = {}
            if len(args) > 1 and args[1] == "--json":
                import sys
                inp = sys.stdin.read()
                try:
                    data = json.loads(inp)
                except json.JSONDecodeError:
                    r = {"ok": False, "message": "Invalid JSON input"}
                    print(json.dumps(r))
                    return
            base = data.get("base_resume", "")
            job_desc = data.get("job_description", "")
            company = data.get("company", "")
            role = data.get("role", "")
            key = _get_openai_key() or data.get("openai_api_key", "")
            r = tailor_resume(base, job_desc, company, role, openai_api_key=key)
            print(json.dumps(r))

        elif action == "cover_letter":
            data = {}
            if len(args) > 1 and args[1] == "--json":
                inp = sys.stdin.read()
                try:
                    data = json.loads(inp)
                except json.JSONDecodeError:
                    r = {"ok": False, "message": "Invalid JSON input"}
                    print(json.dumps(r))
                    return
            job_desc = data.get("job_description", "")
            company = data.get("company", "")
            role = data.get("role", "")
            user_context = data.get("user_context", "")
            key = _get_openai_key() or data.get("openai_api_key", "")
            r = generate_cover_letter(job_desc, company, role, user_context, openai_api_key=key)
            print(json.dumps(r))

        else:
            r = {"ok": False, "message": f"Unknown action: {action}"}
            print(json.dumps(r))

    except Exception as e:
        print(json.dumps({"ok": False, "message": str(e)}))


if __name__ == "__main__":
    main()
