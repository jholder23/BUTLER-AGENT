"""
PEEPEEDEE AI - local chat bridge for Butler Knowledge.

Calls your AI via HTTP. Set BUTLOR_AI_URL / PEEPEEDEE_AI_URL in .env.

Supported upstream shapes:
  - Butler stub / LM-style: POST {base}/chat  → {content|message.content}
  - OpenAI-compatible (Ollama, LM Studio): {base}/v1 → POST …/v1/chat/completions
  - Bare Ollama host (:11434): OpenAI-compat first, native /api/chat as fallback
"""
import errno
import json
import os
import time
import urllib.error
import urllib.request
from typing import Any

from config import PEEPEEDEE_AI_URL


def _is_ollama_host(base: str) -> bool:
    low = (base or "").strip().lower()
    return ":11434" in low


def _ollama_origin(base: str) -> str:
    """Strip known Ollama path suffixes so we never double-append /v1 or /api."""
    u = (base or "").strip().rstrip("/")
    for suffix in (
        "/v1/chat/completions",
        "/chat/completions",
        "/api/chat",
        "/v1",
        "/chat",
    ):
        if u.lower().endswith(suffix):
            u = u[: -len(suffix)].rstrip("/")
            break
    return u


def _resolve_upstream_candidates(base: str) -> list[tuple[str, str]]:
    """
    Return ordered (request_url, style) pairs to try.
    style: openai | ollama_native | butler
    """
    u = (base or "").strip().rstrip("/")
    if not u:
        return [("", "butler")]
    low = u.lower()
    if low.endswith("/v1/chat/completions") or low.endswith("/chat/completions"):
        out: list[tuple[str, str]] = [(u, "openai")]
        if _is_ollama_host(u):
            out.append((f"{_ollama_origin(u)}/api/chat", "ollama_native"))
        return out
    if low.endswith("/api/chat"):
        return [(u, "ollama_native")]
    if low.endswith("/v1"):
        origin = _ollama_origin(u)
        out = [(f"{origin}/v1/chat/completions", "openai")]
        if _is_ollama_host(u):
            out.append((f"{origin}/api/chat", "ollama_native"))
        return out
    if _is_ollama_host(u) and "/chat" not in low and "/api/" not in low:
        origin = _ollama_origin(u)
        return [
            (f"{origin}/v1/chat/completions", "openai"),
            (f"{origin}/api/chat", "ollama_native"),
        ]
    if not low.endswith("/chat"):
        return [(f"{u}/chat", "butler")]
    return [(u, "butler")]


def _resolve_upstream(base: str) -> tuple[str, str]:
    """Primary upstream URL (first candidate). Kept for tests and status probes."""
    candidates = _resolve_upstream_candidates(base)
    return candidates[0] if candidates else ("", "butler")


def _build_payload(
    *,
    style: str,
    messages: list,
    model: str,
    max_tokens: int | None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {"messages": messages, "model": model}
    if style in ("openai", "ollama_native"):
        payload["stream"] = False
    if max_tokens is not None:
        try:
            mt = int(max_tokens)
            if mt > 0:
                if style == "openai":
                    payload["max_tokens"] = mt
                elif style == "ollama_native":
                    payload["options"] = {"num_predict": mt}
        except (TypeError, ValueError):
            pass
    return payload


def _parse_http_error_body(raw: str) -> str:
    raw = (raw or "").strip()
    if not raw:
        return ""
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return raw[:500]
    err = data.get("error")
    if isinstance(err, dict):
        return str(err.get("message") or err.get("detail") or err)[:500]
    if isinstance(err, str):
        return err[:500]
    return raw[:500]


def _extract_content(data: dict) -> str:
    return (
        data.get("content")
        or (data.get("message") or {}).get("content")
        or (data.get("choices") or [{}])[0].get("message", {}).get("content")
        or ""
    )


def _peepee_http_timeout_sec() -> float:
    """
    Per-request socket timeout for POST /chat to the local LLM host (urllib).
    A single Butler turn chains several calls (main + repair + web synthesis)—each waits up to this cap.
    Slow CPU models and the bundled stub (DDG + synthesis) routinely exceed ~60–90s per call.
    Set BUTLER_PEEPEE_HTTP_TIMEOUT_SEC (or PEEPEEDEE_HTTP_TIMEOUT_SEC) on the Knowledge process to override (min 30s, max 2h).
    """
    for key in ("BUTLER_PEEPEE_HTTP_TIMEOUT_SEC", "PEEPEEDEE_HTTP_TIMEOUT_SEC", "PEEPEEDEE_HTTP_TIMEOUT"):
        raw = (os.environ.get(key) or "").strip()
        if not raw:
            continue
        try:
            v = float(raw)
            if v >= 30.0:
                return min(v, 7200.0)
        except ValueError:
            continue
    return 420.0


def _peepee_retry_delay_sec() -> float:
    raw = (os.environ.get("BUTLER_PEEPEE_RETRY_DELAY_SEC") or "2").strip()
    try:
        v = float(raw)
        return max(0.5, min(v, 30.0))
    except ValueError:
        return 2.0


def _urllib_err_is_connection_refused(e: urllib.error.URLError) -> bool:
    reason = getattr(e, "reason", e)
    rs = str(reason).lower()
    return (
        "10061" in str(reason)
        or "actively refused" in rs
        or "connection refused" in rs
        or "errno 111" in rs
    )


def _urllib_err_is_peer_reset(e: urllib.error.URLError) -> bool:
    """Remote closed the socket while answering (Windows 10054, ECONNRESET, stub restart, overload)."""
    reason = getattr(e, "reason", e)
    if isinstance(reason, OSError):
        if getattr(reason, "winerror", None) in (10053, 10054):
            return True
        en = getattr(reason, "errno", None)
        if en in (errno.ECONNRESET, errno.EPIPE):
            return True
    rs = str(reason).lower()
    return (
        "forcibly closed" in rs
        or "connection reset" in rs
        or "10054" in str(reason)
        or "10053" in str(reason)
    )


def _urllib_err_should_retry(e: urllib.error.URLError) -> bool:
    return _urllib_err_is_connection_refused(e) or _urllib_err_is_peer_reset(e)


def _local_llm_disabled() -> bool:
    """When enabled, skip contacting the local model entirely to save VRAM and CPU."""
    v = (os.environ.get("BUTLER_DISABLE_LOCAL_LLM") or "").strip().lower()
    return v in ("1", "true", "yes", "on")


def _offline_fallback_response() -> dict:
    return {
        "message": {
            "content": (
                "I’m running in low-memory / offline mode right now to save VRAM. "
                "The local model is disabled, so I’ll keep using Butler’s lighter fallback path."
            )
        }
    }


def _post_upstream(
    *,
    url: str,
    style: str,
    payload: dict[str, Any],
    headers: dict[str, str],
    timeout_eff: float,
) -> dict:
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    last_http: urllib.error.HTTPError | None = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=timeout_eff) as resp:
                return json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            last_http = e
            break
        except urllib.error.URLError as e:
            if attempt < 2 and _urllib_err_should_retry(e):
                time.sleep(_peepee_retry_delay_sec())
                continue
            reason = getattr(e, "reason", e)
            hint = ""
            if _urllib_err_is_connection_refused(e):
                hint = (
                    " Nothing is listening there. The Knowledge API (port 8765) is separate: "
                    "start your local LLM on this URL (default: run `py -3 ai_server.py` or `python ai_server.py` "
                    "from the `knowledge` folder, or set BUTLOR_AI_URL / PEEPEEDEE_AI_URL to Ollama "
                    "(e.g. http://127.0.0.1:11434 — no extra path; Butler adds /v1/chat/completions or /api/chat)."
                )
            elif _urllib_err_is_peer_reset(e):
                hint = (
                    " The LLM host closed the connection mid-request (restart, overload, or long run). "
                    "Send again after it is idle; avoid kicking `npm run dev:restart` while a chat is in flight."
                )
            raise ConnectionError(f"Could not reach your AI at {url}: {reason}.{hint}") from e
    if last_http is not None:
        raw = last_http.read().decode("utf-8", errors="replace") if last_http.fp else ""
        detail = _parse_http_error_body(raw) or last_http.reason
        raise RuntimeError(
            f"Local LLM HTTP {last_http.code} at {url}: {detail}"
        ) from last_http
    raise ConnectionError(f"Could not reach your AI at {url} after retries.")


def chat(
    messages: list,
    model: str = "pepee",
    openai_api_key: str = "",
    *,
    skip_stub_web: bool = False,
    timeout_sec: float | None = None,
    max_tokens: int | None = None,
) -> dict:
    """
    Call your AI. Expects your server to accept:
      POST { "messages": [...], "model": "..." }
    And return: { "content": "..." } or { "message": { "content": "..." } }
    Pass openai_api_key to enable OpenAI fallback on the server.

    skip_stub_web: when True, sends X-Butler-Skip-Stub-Web so bundled ai_server.py skips
    DuckDuckGo / fetch work (semantic router only — avoids doubling slow web per /chat).

    max_tokens: optional cap forwarded when the upstream LM is OpenAI-compatible (Ollama, LM Studio, etc.).
    Ignored by lightweight stubs that do not read the field.
    """
    if _local_llm_disabled():
        return _offline_fallback_response()

    if not PEEPEEDEE_AI_URL or PEEPEEDEE_AI_URL.strip() == "":
        raise ConnectionError("PEEPEEDEE_AI_URL not set. Start your AI server and set it in .env")

    timeout_eff = _peepee_http_timeout_sec()
    if timeout_sec is not None:
        try:
            tv = float(timeout_sec)
            if tv >= 2.0:
                timeout_eff = max(2.0, min(tv, timeout_eff))
        except Exception:
            pass

    headers = {"Content-Type": "application/json"}
    if openai_api_key and openai_api_key.strip():
        headers["X-OPENAI-API-KEY"] = openai_api_key.strip()

    candidates = _resolve_upstream_candidates(PEEPEEDEE_AI_URL)
    errors: list[str] = []
    data: dict | None = None

    for url, style in candidates:
        if not url:
            continue
        req_headers = dict(headers)
        if skip_stub_web and style == "butler":
            req_headers["X-Butler-Skip-Stub-Web"] = "1"
        payload = _build_payload(style=style, messages=messages, model=model, max_tokens=max_tokens)
        try:
            data = _post_upstream(
                url=url,
                style=style,
                payload=payload,
                headers=req_headers,
                timeout_eff=timeout_eff,
            )
            break
        except RuntimeError as e:
            errors.append(str(e))
            continue
        except ConnectionError:
            raise
        except Exception as e:
            errors.append(f"{url}: {e}")
            continue

    if data is None:
        base = (PEEPEEDEE_AI_URL or "").strip()
        detail = errors[-1] if errors else "no response"
        raise RuntimeError(
            f"Local LLM failed for {base!r}. Tried: "
            + ", ".join(u for u, _ in candidates if u)
            + f". Last: {detail}"
        )

    content = _extract_content(data)
    return {"message": {"content": content}}
