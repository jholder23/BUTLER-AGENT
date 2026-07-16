import argparse
import gzip
import os
import re
from collections import Counter


def iter_attr_values(xml: str, attr: str):
    key = f'{attr} Value="'
    i = 0
    while True:
        j = xml.find(key, i)
        if j < 0:
            return
        j += len(key)
        k = xml.find('"', j)
        if k < 0:
            return
        yield xml[j:k]
        i = k + 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("als_path")
    ap.add_argument("--max-media", type=int, default=250)
    ap.add_argument("--show-paths", type=int, default=120)
    ap.add_argument("--check-exists", action="store_true")
    args = ap.parse_args()

    als_path = os.path.abspath(args.als_path)
    with gzip.open(als_path, "rb") as f:
        xml = f.read().decode("utf-8", "ignore")

    names = list(iter_attr_values(xml, "Name"))
    plugin_keywords = ("serum", "vital", "omni", "spectrasonics", "xfer")
    plugin_names = sorted(
        {n for n in names if any(k in n.lower() for k in plugin_keywords)}
    )

    print(f"als: {als_path}")
    print(f"plugin-name-hits: {len(plugin_names)}")
    for n in plugin_names[:400]:
        print(n)

    # Live often stores relative paths (no drive letter). Keep all non-empty paths.
    paths = [p for p in iter_attr_values(xml, "Path") if p]
    print("---")
    print(f"file-path-hits: {len(paths)}")

    media_exts = (".wav", ".aif", ".aiff", ".mp3", ".flac", ".ogg", ".asd")
    media = sorted({p for p in paths if p.lower().endswith(media_exts)})
    print(f"media-unique: {len(media)}")
    for p in media[: args.max_media]:
        print(p)

    if args.check_exists:
        print("---")
        print("media-missing-check:")
        base = os.path.dirname(als_path)
        missing = []
        for p in media:
            if re.match(r"^[A-Za-z]:\\", p) or p.startswith("\\\\"):
                resolved = p
            elif p.startswith("/"):
                # likely mac path stored in set
                resolved = p
            else:
                resolved = os.path.normpath(os.path.join(base, p))
            if not os.path.exists(resolved):
                missing.append((p, resolved))
        print(f"missing: {len(missing)}")
        for p, resolved in missing[:500]:
            print(f"MISSING\t{p}\t=>\t{resolved}")

    # quick stats: drive roots & top folders
    print("---")
    roots = Counter()
    top = Counter()
    for p in paths:
        if re.match(r"^[A-Za-z]:\\", p):
            roots[p[:3].upper()] += 1
            rest = p[3:].lstrip("\\")
            top[rest.split("\\", 1)[0].lower()] += 1 if rest else 0
        elif p.startswith("\\\\"):
            roots["UNC"] += 1
        else:
            roots["REL"] += 1
            top[p.split("\\", 1)[0].split("/", 1)[0].lower()] += 1
    print("path-roots:", ", ".join(f"{k}={v}" for k, v in roots.most_common(20)))
    if top:
        print("top-folders:", ", ".join(f"{k}={v}" for k, v in top.most_common(20)))

    # show a few raw paths (helps identify missing locations)
    print("---")
    print(f"sample-paths (first {args.show_paths}):")
    for p in paths[: args.show_paths]:
        print(p)


if __name__ == "__main__":
    main()

