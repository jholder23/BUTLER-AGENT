"""
Cache ComfyUI /object_info as pre-encoded JSON bytes.

On 32GB Windows hosts, concurrent GET /object_info during checkpoint loads can
MemoryError inside json.dumps / text.encode while commit charge is high.
Serve a cached body after the first successful build; on MemoryError fall back
to cache or 503 {} instead of crashing the request loop.
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SERVER = ROOT / "sd" / "ComfyUI" / "server.py"

MARKER = "BUTLER_OBJECT_INFO_CACHE"

OLD = '''        @routes.get("/object_info")
        async def get_object_info(request):
            asset_seeder.start(roots=("models", "input", "output"))
            with folder_paths.cache_helper:
                out = {}
                for x in nodes.NODE_CLASS_MAPPINGS:
                    try:
                        out[x] = node_info(x)
                    except Exception:
                        logging.error(f"[ERROR] An error occurred while retrieving information for the '{x}' node.")
                        logging.error(traceback.format_exc())
                return web.json_response(out)
'''

NEW = '''        # BUTLER_OBJECT_INFO_CACHE: avoid rebuild+json.dumps on every GET under RAM pressure
        _butler_object_info_cache = {"sig": None, "body": None}

        @routes.get("/object_info")
        async def get_object_info(request):
            asset_seeder.start(roots=("models", "input", "output"))
            with folder_paths.cache_helper:
                try:
                    sig = (len(nodes.NODE_CLASS_MAPPINGS), id(nodes.NODE_CLASS_MAPPINGS))
                    cached = _butler_object_info_cache
                    if cached["body"] is not None and cached["sig"] == sig:
                        return web.Response(body=cached["body"], content_type="application/json")
                    out = {}
                    for x in nodes.NODE_CLASS_MAPPINGS:
                        try:
                            out[x] = node_info(x)
                        except Exception:
                            logging.error(f"[ERROR] An error occurred while retrieving information for the '{x}' node.")
                            logging.error(traceback.format_exc())
                    body = json.dumps(out, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
                    cached["sig"] = sig
                    cached["body"] = body
                    del out
                    return web.Response(body=body, content_type="application/json")
                except MemoryError:
                    logging.error(
                        "[BUTLER] /object_info MemoryError (system RAM/commit). "
                        "Serving cache or 503; retry after models unload."
                    )
                    if _butler_object_info_cache["body"] is not None:
                        return web.Response(
                            body=_butler_object_info_cache["body"],
                            content_type="application/json",
                        )
                    return web.Response(body=b"{}", content_type="application/json", status=503)
'''

NODE_INFO_OLD = '''            info = {}
            info['input'] = obj_class.INPUT_TYPES()
            info['input_order'] = {key: list(value.keys()) for (key, value) in obj_class.INPUT_TYPES().items()}
'''

NODE_INFO_NEW = '''            info = {}
            # BUTLER_OBJECT_INFO_CACHE: call INPUT_TYPES once (was duplicated)
            input_types = obj_class.INPUT_TYPES()
            info['input'] = input_types
            info['input_order'] = {key: list(value.keys()) for (key, value) in input_types.items()}
'''


def already_patched(text: str) -> bool:
    return MARKER in text and "_butler_object_info_cache" in text


def main() -> int:
    if not SERVER.is_file():
        print(f"ERROR: missing {SERVER}", file=sys.stderr)
        return 1
    text = SERVER.read_text(encoding="utf-8")
    if already_patched(text):
        if NODE_INFO_OLD in text:
            text = text.replace(NODE_INFO_OLD, NODE_INFO_NEW, 1)
            SERVER.write_text(text, encoding="utf-8", newline="\n")
            print(f"Updated INPUT_TYPES dedupe: {SERVER}")
            return 0
        print(f"Already patched: {SERVER}")
        return 0
    if OLD not in text:
        print(f"ERROR: unexpected get_object_info in {SERVER}", file=sys.stderr)
        return 1
    text = text.replace(OLD, NEW, 1)
    if NODE_INFO_OLD in text:
        text = text.replace(NODE_INFO_OLD, NODE_INFO_NEW, 1)
    if not already_patched(text):
        print("ERROR: patch did not apply cleanly", file=sys.stderr)
        return 1
    SERVER.write_text(text, encoding="utf-8", newline="\n")
    print(f"Patched: {SERVER}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
