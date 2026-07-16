"""CLI for gig runner. Usage: python gig_cli.py <action> [args...]"""
import json
import os
import sys


def main():
    args = sys.argv[1:]
    if not args:
        print(json.dumps({
            "ok": False,
            "message": "Usage: gig_cli.py <discover|run|queue|execute> [args]. Use --json for JSON input via stdin."
        }))
        return
    action = args[0].lower()
    try:
        from gig_runner import (
            discover_gigs,
            run_autonomous_cycle,
            get_gig_queue,
            execute_gig,
        )
        if action == "discover":
            skills = args[1] if len(args) > 1 else "frontend development"
            r = discover_gigs(skills, platforms="all", max_per_platform=5)
            print(json.dumps(r))
        elif action == "run":
            data = {}
            if len(args) > 1 and args[1] == "--json":
                try:
                    data = json.loads(sys.stdin.read())
                except json.JSONDecodeError:
                    print(json.dumps({"ok": False, "message": "Invalid JSON"}))
                    return
            skills = data.get("skills", "frontend development, transcription")
            max_gigs = int(data.get("max_gigs", 5))
            key = os.environ.get("OPENAI_API_KEY") or data.get("openai_api_key", "")
            r = run_autonomous_cycle(skills=skills, max_gigs=max_gigs, openai_api_key=key)
            print(json.dumps(r))
        elif action == "queue":
            r = get_gig_queue()
            print(json.dumps(r))
        elif action == "execute":
            data = {}
            if len(args) > 1 and args[1] == "--json":
                try:
                    data = json.loads(sys.stdin.read())
                except json.JSONDecodeError:
                    print(json.dumps({"ok": False, "message": "Invalid JSON"}))
                    return
            r = execute_gig(
                gig_type=data.get("type", "frontend"),
                requirements=data.get("requirements", ""),
                output_path=data.get("output_path", ""),
            )
            print(json.dumps(r))
        else:
            print(json.dumps({"ok": False, "message": f"Unknown action: {action}"}))
    except Exception as e:
        print(json.dumps({"ok": False, "message": str(e)}))


if __name__ == "__main__":
    main()
