"""
Patch ComfyUI Windows safetensors loader to avoid MemoryError.

Butler forces a Python safetensors path on Windows (Rust mmap/safe_open can AV).
The naive bytearray(f.read) + torch.frombuffer().clone() peaks at ~2-3x checkpoint
size and OOMs on ~6.5GB SDXL models. This patch reads directly into preallocated
tensor storage via ctypes readinto (peak ~1x file size).

Idempotent: safe to re-run. Marker: BUTLER_SAFETENSORS_READINTO
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
UTILS = ROOT / "sd" / "ComfyUI" / "comfy" / "utils.py"

MARKER = "BUTLER_SAFETENSORS_READINTO"

NEW_FN = '''def load_safetensors_python(ckpt, device=None):
    """Load safetensors by reading tensor bytes into owned storage.

    Avoids safetensors' Rust/torch UntypedStorage.from_file path, which can hard-crash
    (Windows access violation) on large checkpoints. Reads directly into preallocated
    torch tensors (no bytearray + clone peak) so host RAM stays near 1x file size.
    """
    if device is None:
        device = torch.device("cpu")

    # Always materialize on CPU first so we can readinto storage via ctypes.
    load_device = torch.device("cpu")
    with open(ckpt, "rb") as f:
        header_size = struct.unpack("<Q", f.read(8))[0]
        header = json.loads(f.read(header_size))
        metadata = header.get("__metadata__")
        data_start = 8 + header_size
        sd = {}
        for name, info in header.items():
            if name == "__metadata__":
                continue
            start, end = info["data_offsets"]
            dtype = _TYPES[info["dtype"]]
            nbytes = end - start
            tensor = torch.empty(info["shape"], dtype=dtype, device=load_device)
            if nbytes == 0:
                if device.type != "cpu":
                    tensor = tensor.to(device=device)
                sd[name] = tensor
                continue
            expected = tensor.numel() * tensor.element_size()
            if expected != nbytes:
                raise ValueError(
                    f"Safetensors size mismatch for '{name}': header says {nbytes} bytes, "
                    f"tensor needs {expected} ({info['shape']} {info['dtype']})"
                )
            f.seek(data_start + start)
            # BUTLER_SAFETENSORS_READINTO: write file bytes straight into tensor storage.
            buf = (ctypes.c_char * nbytes).from_address(tensor.data_ptr())
            nread = f.readinto(buf)
            if nread != nbytes:
                raise EOFError(
                    f"Truncated safetensors read for '{name}': got {nread}, expected {nbytes}"
                )
            if device.type != "cpu":
                tensor = tensor.to(device=device)
            sd[name] = tensor
        return sd, metadata
'''


def _replace_function(src: str, name: str, new_body: str) -> str:
    """Replace a top-level `def name(...):` block through the next top-level def/class."""
    import re

    pat = re.compile(rf"^def {re.escape(name)}\(.*?\n(?:.*?\n)*?(?=^def |^class |\Z)", re.M)
    m = pat.search(src)
    if not m:
        raise SystemExit(f"Could not find def {name} in {UTILS}")
    body = new_body if new_body.endswith("\n") else new_body + "\n"
    return src[: m.start()] + body + "\n" + src[m.end() :]


def main() -> int:
    if not UTILS.is_file():
        print("Missing", UTILS, file=sys.stderr)
        return 1
    text = UTILS.read_text(encoding="utf-8")
    if MARKER in text and "bytearray(f.read(nbytes))" not in text:
        print("Already patched:", UTILS)
        return 0
    text = _replace_function(text, "load_safetensors_python", NEW_FN)
    if MARKER not in text:
        raise SystemExit("Patch did not apply marker")
    UTILS.write_text(text, encoding="utf-8", newline="\n")
    print("Patched", UTILS)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
