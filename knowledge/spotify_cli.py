#!/usr/bin/env python3
"""
CLI for Butler Spotify SEO playlists.

Examples:
  python knowledge/spotify_cli.py status
  python knowledge/spotify_cli.py config --artist-ids ID --artist-name "You" --genres "indie pop,chill"
  python knowledge/spotify_cli.py create --niche "chill indie"
  python knowledge/spotify_cli.py batch --niches "lofi,study beats,chill vibes"
  python knowledge/spotify_cli.py maintain
  python knowledge/spotify_cli.py cycle
  python knowledge/spotify_cli.py list
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from spotify_helper import (  # noqa: E402
    auth_status,
    create_seo_batch,
    create_seo_playlist,
    get_config,
    list_playlists,
    maintain_playlists,
    run_seo_cycle,
    save_config,
)


def _print(data: dict) -> None:
    print(json.dumps(data, indent=2))


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Butler Spotify SEO playlist manager")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("status", help="Auth + config summary")
    sub.add_parser("list", help="List registered SEO playlists")

    pc = sub.add_parser("config", help="Show or update SEO config")
    pc.add_argument("--artist-ids", default=None, help="Comma-separated Spotify artist IDs")
    pc.add_argument("--artist-name", default=None)
    pc.add_argument("--track-uris", default=None, help="Comma-separated track URIs or IDs")
    pc.add_argument("--genres", default=None)
    pc.add_argument("--keywords", default=None)
    pc.add_argument("--ratio", type=float, default=None, help="Your-track ratio 0.05–0.8")
    pc.add_argument("--size", type=int, default=None, help="Playlist size 10–100")
    pc.add_argument("--show", action="store_true", help="Only print config")

    pcreate = sub.add_parser("create", help="Create one SEO playlist")
    pcreate.add_argument("--niche", required=True)
    pcreate.add_argument("--name", default=None)
    pcreate.add_argument("--dry-run", action="store_true")
    pcreate.add_argument("--market", default="US")

    pbatch = sub.add_parser("batch", help="Create playlists for many niches")
    pbatch.add_argument("--niches", default="", help="Comma-separated niches")
    pbatch.add_argument("--dry-run", action="store_true")
    pbatch.add_argument("--market", default="US")

    pm = sub.add_parser("maintain", help="Refresh copy + ensure your tracks")
    pm.add_argument("--dry-run", action="store_true")
    pm.add_argument("--market", default="US")
    pm.add_argument("--ids", default="", help="Comma-separated playlist IDs (default: all)")

    pcycle = sub.add_parser("cycle", help="Create missing niches + maintain all")
    pcycle.add_argument("--niches", default="", help="Comma-separated niches (optional)")
    pcycle.add_argument("--dry-run", action="store_true")
    pcycle.add_argument("--market", default="US")

    args = p.parse_args(argv)

    if args.cmd == "status":
        _print(auth_status())
        return 0
    if args.cmd == "list":
        _print(list_playlists())
        return 0
    if args.cmd == "config":
        if args.show or all(
            x is None
            for x in (
                args.artist_ids,
                args.artist_name,
                args.track_uris,
                args.genres,
                args.keywords,
                args.ratio,
                args.size,
            )
        ):
            _print({"ok": True, "config": get_config()})
            return 0
        _print(
            save_config(
                artist_ids=args.artist_ids,
                artist_name=args.artist_name,
                track_uris=args.track_uris,
                genres=args.genres,
                keywords=args.keywords,
                your_track_ratio=args.ratio,
                playlist_size=args.size,
            )
        )
        return 0
    if args.cmd == "create":
        _print(
            create_seo_playlist(
                args.niche,
                name=args.name,
                market=args.market,
                dry_run=args.dry_run,
            )
        )
        return 0
    if args.cmd == "batch":
        niches = [x.strip() for x in (args.niches or "").split(",") if x.strip()]
        _print(create_seo_batch(niches or None, market=args.market, dry_run=args.dry_run))
        return 0
    if args.cmd == "maintain":
        ids = [x.strip() for x in (args.ids or "").split(",") if x.strip()] or None
        _print(maintain_playlists(playlist_ids=ids, market=args.market, dry_run=args.dry_run))
        return 0
    if args.cmd == "cycle":
        niches = [x.strip() for x in (args.niches or "").split(",") if x.strip()] or None
        _print(run_seo_cycle(niches, market=args.market, dry_run=args.dry_run))
        return 0
    p.print_help()
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
