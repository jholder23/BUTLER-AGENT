#!/usr/bin/env python3
"""
CLI for Butler artist project profile (feeds Spotify SEO playlists).

Examples:
  python knowledge/artist_project_cli.py show
  python knowledge/artist_project_cli.py seed
  python knowledge/artist_project_cli.py sync --source ableton
  python knowledge/artist_project_cli.py sync --source spotify --artist-id YOUR_ID
  python knowledge/artist_project_cli.py update --artist-name Sine --genres "dubstep,bass music,drum and bass"
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from artist_project_helper import (  # noqa: E402
    format_artist_project_block,
    get_artist_project,
    infer_from_ableton_index,
    save_artist_project,
    seed_starter_profile,
    sync_from_spotify,
)


def _print(data: dict) -> None:
    print(json.dumps(data, indent=2, ensure_ascii=False))


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Butler artist project profile")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("show", help="Print artist_project.json")
    sub.add_parser("block", help="Print system-prompt block")
    sub.add_parser("seed", help="Infer starter profile from Ableton index if empty")

    ps = sub.add_parser("sync", help="Sync from Ableton index and/or Spotify and/or FORMA")
    ps.add_argument("--source", default="all", choices=["all", "ableton", "spotify", "seed", "forma"])
    ps.add_argument("--artist-id", default=None)
    ps.add_argument("--force", action="store_true")
    ps.add_argument("--market", default="US")

    pu = sub.add_parser("update", help="Merge fields into artist project")
    pu.add_argument("--artist-name", default=None)
    pu.add_argument("--aliases", default=None)
    pu.add_argument("--bio", default=None)
    pu.add_argument("--tagline", default=None)
    pu.add_argument("--location", default=None)
    pu.add_argument("--genres", default=None)
    pu.add_argument("--subgenres", default=None)
    pu.add_argument("--moods", default=None)
    pu.add_argument("--keywords", default=None)
    pu.add_argument("--seo-niches", default=None)
    pu.add_argument("--similar-artists", default=None)
    pu.add_argument("--collaborators", default=None)
    pu.add_argument("--spotify-artist-ids", default=None)
    pu.add_argument("--track-uris", default=None)
    pu.add_argument("--target-audience", default=None)
    pu.add_argument("--brand-voice", default=None)
    pu.add_argument("--notes", default=None)

    args = p.parse_args(argv)

    if args.cmd == "show":
        _print({"ok": True, "project": get_artist_project()})
        return 0
    if args.cmd == "block":
        print(format_artist_project_block() or "(empty artist project)")
        return 0
    if args.cmd == "seed":
        _print(seed_starter_profile(force=True))
        return 0
    if args.cmd == "sync":
        steps = []
        if args.source in ("ableton", "all", "seed"):
            if args.source == "seed":
                steps.append(seed_starter_profile(force=args.force))
            else:
                steps.append(infer_from_ableton_index(apply=True))
        if args.source in ("spotify", "all"):
            steps.append(sync_from_spotify(args.artist_id, market=args.market))
        if args.source in ("forma", "all"):
            try:
                from forma_knowledge import enrich_artist_project_from_forma

                steps.append(enrich_artist_project_from_forma())
            except Exception as e:
                steps.append({"ok": False, "message": str(e)})
        _print({"ok": any(s.get("ok") for s in steps), "steps": steps, "project": get_artist_project()})
        return 0
    if args.cmd == "update":
        updates = {
            "artist_name": args.artist_name,
            "aliases": args.aliases,
            "bio": args.bio,
            "tagline": args.tagline,
            "location": args.location,
            "genres": args.genres,
            "subgenres": args.subgenres,
            "moods": args.moods,
            "keywords": args.keywords,
            "seo_niches": args.seo_niches,
            "similar_artists": args.similar_artists,
            "collaborators": args.collaborators,
            "spotify_artist_ids": args.spotify_artist_ids,
            "track_uris": args.track_uris,
            "target_audience": args.target_audience,
            "brand_voice": args.brand_voice,
            "notes": args.notes,
        }
        _print(save_artist_project(updates))
        return 0
    p.print_help()
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
