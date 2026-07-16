"""Configuration for Code Helper's knowledge and agent. Loads .env from project root."""
import os
from pathlib import Path

# Load .env: prefer BUTLOR_ENV_FILE (set by Electron), else project root.
# Electron pins COMFYUI_URL / KNOWLEDGE_API_PORT in the process env before spawn —
# keep those pins even when a shared .env still lists the other stack's ports.
_PINNED_ENV_KEYS = (
    "COMFYUI_URL",
    "USE_COMFYUI",
    "KNOWLEDGE_API_PORT",
    "KNOWLEDGE_API_URL",
    "BUTLER_UI_API_PORT",
    "SD_PROJECT_PATH",
)
_pinned_before_dotenv = {
    k: os.environ[k] for k in _PINNED_ENV_KEYS if (os.environ.get(k) or "").strip()
}
_env_path = os.getenv("BUTLOR_ENV_FILE") or os.getenv("PEEPEEDEE_ENV_FILE")
if _env_path and Path(_env_path).exists():
    from dotenv import load_dotenv
    load_dotenv(_env_path, override=True)
else:
    _root = Path(__file__).resolve().parent.parent
    _env = _root / ".env"
    if _env.exists():
        from dotenv import load_dotenv
        load_dotenv(str(_env), override=True)
for _k, _v in _pinned_before_dotenv.items():
    os.environ[_k] = _v


def _load_agent_env_json_into_os() -> None:
    """Overlay Agent Settings env vars (D:\\butlor\\agent-env.json) for cascade/MCP keys."""
    try:
        cfg = Path(
            (os.getenv("BUTLOR_CONFIG") or "").strip()
            or (r"D:\butlor" if os.name == "nt" else str(Path.home() / "Documents" / "Butlor"))
        )
        path = cfg / "agent-env.json"
        if not path.is_file():
            return
        import json

        raw = json.loads(path.read_text(encoding="utf-8"))
        blob = raw.get("vars") if isinstance(raw, dict) and isinstance(raw.get("vars"), dict) else raw
        if not isinstance(blob, dict):
            return
        for k, v in blob.items():
            key = str(k or "").strip()
            if not key or not key.replace("_", "").isalnum():
                continue
            val = "" if v is None else str(v).strip()
            if val:
                os.environ[key] = val
    except Exception:
        pass


_load_agent_env_json_into_os()

# ---- Hardcoded defaults (no .env needed for these) ----
# Stable Diffusion stack lives next to this repo: <Butler root>/sd (e.g. junction to your full SD folder).
_BUTLER_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SD_PROJECT_PATH = str(_BUTLER_ROOT / "sd")


def _resolve_sd_project_path() -> str:
    """Absolute SD root; relative SD_PROJECT_PATH in .env is resolved from Butler repo root."""
    raw = (os.getenv("SD_PROJECT_PATH") or "").strip()
    if not raw:
        return DEFAULT_SD_PROJECT_PATH
    p = Path(raw)
    if p.is_absolute():
        return str(p)
    return str((_BUTLER_ROOT / raw).resolve())
DEFAULT_SD_API_URL = "http://127.0.0.1:7860"
DEFAULT_COMFYUI_URL = "http://127.0.0.1:8188"
# Keep aligned with knowledge/butlor_paths.py (BUTLOR_CONFIG or D:\\butlor on Windows).
DEFAULT_BUTLOR_CONFIG = r"D:\butlor" if os.name == "nt" else str(Path.home() / "Documents" / "Butlor")
DEFAULT_SAMPLE_LIBRARY_PATH = "D:\\Samples"
# ---- End defaults ----

# Electron sets BUTLER_LOCAL_ONLY=1 when Settings → Local only is on, so a saved OPENAI_API_KEY in .env
# cannot override (load_dotenv uses override=True and would otherwise revive the key in-process).
def _env_flag(name: str) -> bool:
    return (os.getenv(name) or "").strip().lower() in ("1", "true", "yes", "on")


OPENAI_API_KEY = "" if _env_flag("BUTLER_LOCAL_ONLY") else (os.getenv("OPENAI_API_KEY", "") or "").strip()
LOCAL_MODEL = os.getenv("LOCAL_MODEL", "pepee")
LOCAL_AGENT_MODEL = (
    (os.getenv("LOCAL_AGENT_MODEL") or os.getenv("BUTLER_AGENT_MODEL") or "qwen2.5:7b-instruct")
).strip()
# Agent window provider: local (default) | gemini | groq | openrouter | mistral | cohere
BUTLER_AGENT_PROVIDER = (os.getenv("BUTLER_AGENT_PROVIDER") or "local").strip().lower()
# Per-provider API keys for Agent cloud models (agent path only — not regular /chat)
GEMINI_API_KEY = (os.getenv("GEMINI_API_KEY") or "").strip()
GROQ_API_KEY = (os.getenv("GROQ_API_KEY") or "").strip()
OPENROUTER_API_KEY = (os.getenv("OPENROUTER_API_KEY") or "").strip()
MISTRAL_API_KEY = (os.getenv("MISTRAL_API_KEY") or "").strip()
COHERE_API_KEY = (os.getenv("COHERE_API_KEY") or "").strip()
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
PEEPEEDEE_AI_URL = os.getenv("BUTLOR_AI_URL") or os.getenv("PEEPEEDEE_AI_URL", "http://localhost:5000")

SD_PROJECT_PATH = _resolve_sd_project_path()
SD_API_URL = (os.getenv("SD_API_URL") or "").strip() or DEFAULT_SD_API_URL
COMFYUI_URL = (os.getenv("COMFYUI_URL") or "").strip() or DEFAULT_COMFYUI_URL
USE_COMFYUI = (os.getenv("USE_COMFYUI") or "1").lower() in ("1", "true", "yes")
