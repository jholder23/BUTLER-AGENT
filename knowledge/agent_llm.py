"""
Multi-provider LLM for Butler Agent — local Ollama + ranked free cloud tiers.

Ranked fallback order (best → worst for agent/coding, verified 2025–2026 free tiers):
  1. Google Gemini 2.0 Flash — ~1,500 req/day, strong tool-use, no credit card
  2. Groq Llama 3.3 70B Versatile — ~30 RPM, fastest inference, no credit card
  3. OpenRouter meta-llama/llama-3.3-70b-instruct:free — aggregator free route
  4. Mistral Small — experiment/dev tier, 256K context
  5. Cohere Command R — free trial, strong RAG/instruction following
  local — final fallback (LOCAL_AGENT_MODEL via Ollama)
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable

try:
    from config import LOCAL_AGENT_MODEL
except ImportError:
    LOCAL_AGENT_MODEL = (
        os.environ.get("LOCAL_AGENT_MODEL")
        or os.environ.get("BUTLER_AGENT_MODEL")
        or "qwen2.5:7b-instruct"
    )

try:
    from peepee_ai import chat as peepee_chat
except ImportError:
    peepee_chat = None  # type: ignore


# id → provider metadata (order in AGENT_FREE_PROVIDER_IDS is the fallback rank)
AGENT_FREE_PROVIDER_IDS: tuple[str, ...] = (
    "gemini",
    "groq",
    "openrouter",
    "mistral",
    "cohere",
)

AGENT_PROVIDERS: dict[str, dict[str, str]] = {
    "local": {
        "label": "Local (Ollama)",
        "model": LOCAL_AGENT_MODEL,
        "env_key": "",
        "hint": "Uses LOCAL_AGENT_MODEL / BUTLOR_AI_URL — no API key.",
    },
    "gemini": {
        "label": "Google Gemini 2.0 Flash",
        "model": "gemini-2.0-flash",
        "env_key": "GEMINI_API_KEY",
        "hint": "Free tier via Google AI Studio — https://aistudio.google.com/apikey",
    },
    "groq": {
        "label": "Groq Llama 3.3 70B",
        "model": "llama-3.3-70b-versatile",
        "env_key": "GROQ_API_KEY",
        "hint": "Free tier — https://console.groq.com/keys",
    },
    "openrouter": {
        "label": "OpenRouter Llama 3.3 70B (free)",
        "model": "meta-llama/llama-3.3-70b-instruct:free",
        "env_key": "OPENROUTER_API_KEY",
        "hint": "Free models — https://openrouter.ai/keys",
    },
    "mistral": {
        "label": "Mistral Small",
        "model": "mistral-small-latest",
        "env_key": "MISTRAL_API_KEY",
        "hint": "Experiment tier — https://console.mistral.ai/api-keys",
    },
    "cohere": {
        "label": "Cohere Command R",
        "model": "command-r-08-2024",
        "env_key": "COHERE_API_KEY",
        "hint": "Free trial — https://dashboard.cohere.com/api-keys",
    },
}


@dataclass
class AgentLLMResult:
    content: str
    provider: str
    model: str
    source_label: str
    fallbacks_used: list[str]


class AgentLLMError(Exception):
    def __init__(self, message: str, *, status_code: int | None = None, retryable: bool = True):
        super().__init__(message)
        self.status_code = status_code
        self.retryable = retryable


def list_agent_providers() -> list[dict[str, str]]:
    """UI-friendly provider list (auto cascade, local, then ranked free tiers)."""
    out: list[dict[str, str]] = [
        {
            "id": "auto_free",
            "label": "Auto free-tier cascade",
            "model": "gemini → groq → openrouter → mistral → cohere → local",
            "env_key": "",
            "hint": (
                "Burn through free-tier providers (best→worst) using available API keys; "
                "falls back to local Ollama (LOCAL_AGENT_MODEL). Same as provider=cascade."
            ),
        }
    ]
    meta = AGENT_PROVIDERS["local"]
    out.append({"id": "local", "label": meta["label"], "model": meta["model"], "env_key": "", "hint": meta["hint"]})
    for pid in AGENT_FREE_PROVIDER_IDS:
        m = AGENT_PROVIDERS[pid]
        out.append({"id": pid, "label": m["label"], "model": m["model"], "env_key": m["env_key"], "hint": m["hint"]})
    return out


def _resolve_api_key(provider_id: str, api_keys: dict[str, str] | None) -> str:
    meta = AGENT_PROVIDERS.get(provider_id) or {}
    env_name = meta.get("env_key") or ""
    keys = api_keys if isinstance(api_keys, dict) else {}
    for src in (keys.get(provider_id), keys.get(env_name), os.environ.get(env_name) if env_name else None):
        v = (src or "").strip() if isinstance(src, str) else ""
        if v:
            return v
    return ""


def build_fallback_chain(selected: str) -> list[str]:
    """Build provider try-order.

    - local: Ollama only
    - auto_free / cascade / auto: full free-tier rank (best→worst) then local
    - a free provider id: that provider → lower ranks → local
    - unknown: full free list → local
    """
    sel = (selected or "local").strip().lower()
    if sel == "local":
        return ["local"]
    if sel in ("auto_free", "cascade", "auto"):
        return list(AGENT_FREE_PROVIDER_IDS) + ["local"]
    chain: list[str] = []
    if sel in AGENT_FREE_PROVIDER_IDS:
        idx = AGENT_FREE_PROVIDER_IDS.index(sel)
        chain.extend(AGENT_FREE_PROVIDER_IDS[idx:])
    elif sel in AGENT_PROVIDERS:
        chain.append(sel)
    else:
        chain.extend(AGENT_FREE_PROVIDER_IDS)
    if "local" not in chain:
        chain.append("local")
    return chain


def resolve_agent_llm(provider: str, api_keys: dict[str, str] | None = None) -> dict[str, Any]:
    """Resolve first provider in fallback chain that has credentials (local always ok)."""
    chain = build_fallback_chain(provider)
    for pid in chain:
        if pid == "local":
            return {
                "provider": "local",
                "model": LOCAL_AGENT_MODEL,
                "api_key": "",
                "label": AGENT_PROVIDERS["local"]["label"],
                "chain": chain,
            }
        key = _resolve_api_key(pid, api_keys)
        if key:
            meta = AGENT_PROVIDERS[pid]
            return {
                "provider": pid,
                "model": meta["model"],
                "api_key": key,
                "label": meta["label"],
                "chain": chain,
            }
    # No cloud keys — use local
    return {
        "provider": "local",
        "model": LOCAL_AGENT_MODEL,
        "api_key": "",
        "label": AGENT_PROVIDERS["local"]["label"],
        "chain": ["local"],
    }


def _is_fallback_error(exc: Exception, status_code: int | None = None) -> bool:
    if status_code in (429, 402, 503, 500, 502, 504, 401, 403):
        return True
    msg = str(exc).lower()
    markers = (
        "rate limit",
        "rate_limit",
        "too many requests",
        "quota",
        "resource_exhausted",
        "resource exhausted",
        "insufficient",
        "credit",
        "billing",
        "exceeded",
        "unauthorized",
        "invalid api key",
        "authentication",
    )
    return any(m in msg for m in markers)


def _http_post_json(url: str, payload: dict, headers: dict[str, str], timeout: float = 120.0) -> dict:
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8", errors="replace"))
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace") if e.fp else ""
        raise AgentLLMError(f"HTTP {e.code}: {raw[:500]}", status_code=e.code, retryable=_is_fallback_error(e, e.code)) from e
    except urllib.error.URLError as e:
        raise AgentLLMError(f"Network error: {e.reason}", retryable=True) from e


def _messages_to_openai(messages: list[dict[str, str]]) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for m in messages:
        role = (m.get("role") or "user").strip()
        content = str(m.get("content") or "")
        if role == "system":
            out.append({"role": "system", "content": content})
        elif role == "assistant":
            out.append({"role": "assistant", "content": content})
        else:
            out.append({"role": "user", "content": content})
    return out


def _chat_openai_compatible(
    *,
    url: str,
    api_key: str,
    model: str,
    messages: list[dict[str, str]],
    max_tokens: int,
    extra_headers: dict[str, str] | None = None,
) -> str:
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
    }
    if extra_headers:
        headers.update(extra_headers)
    data = _http_post_json(
        url,
        {"model": model, "messages": _messages_to_openai(messages), "max_tokens": max_tokens, "stream": False},
        headers,
    )
    content = (
        (data.get("choices") or [{}])[0].get("message", {}).get("content")
        or data.get("content")
        or ""
    )
    if not (content or "").strip():
        raise AgentLLMError("Empty response from provider", retryable=True)
    return str(content)


def _chat_gemini(api_key: str, model: str, messages: list[dict[str, str]], max_tokens: int) -> str:
    system_parts: list[str] = []
    contents: list[dict[str, Any]] = []
    for m in messages:
        role = (m.get("role") or "user").strip()
        text = str(m.get("content") or "")
        if role == "system":
            system_parts.append(text)
            continue
        gem_role = "model" if role == "assistant" else "user"
        contents.append({"role": gem_role, "parts": [{"text": text}]})
    if not contents:
        contents = [{"role": "user", "parts": [{"text": " "}]}]
    payload: dict[str, Any] = {
        "contents": contents,
        "generationConfig": {"maxOutputTokens": max_tokens},
    }
    if system_parts:
        payload["systemInstruction"] = {"parts": [{"text": "\n\n".join(system_parts)}]}
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
    data = _http_post_json(url, payload, {"Content-Type": "application/json"})
    candidates = data.get("candidates") or []
    if not candidates:
        err = data.get("error") or data
        raise AgentLLMError(f"Gemini error: {err}", retryable=True)
    parts = (candidates[0].get("content") or {}).get("parts") or []
    text = "".join(p.get("text", "") for p in parts if isinstance(p, dict))
    if not text.strip():
        raise AgentLLMError("Empty Gemini response", retryable=True)
    return text


def _chat_cohere(api_key: str, model: str, messages: list[dict[str, str]], max_tokens: int) -> str:
    oai = _messages_to_openai(messages)
    payload = {"model": model, "messages": oai, "max_tokens": max_tokens}
    data = _http_post_json(
        "https://api.cohere.com/v2/chat",
        payload,
        {"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
    )
    msg = data.get("message") or {}
    content = msg.get("content") or []
    if isinstance(content, list):
        text = "".join(
            (c.get("text") or "") for c in content if isinstance(c, dict) and c.get("type") == "text"
        )
    else:
        text = str(content or "")
    if not text.strip():
        raise AgentLLMError("Empty Cohere response", retryable=True)
    return text


def _chat_provider(
    provider_id: str,
    api_key: str,
    model: str,
    messages: list[dict[str, str]],
    max_tokens: int,
) -> str:
    if provider_id == "gemini":
        return _chat_gemini(api_key, model, messages, max_tokens)
    if provider_id == "groq":
        return _chat_openai_compatible(
            url="https://api.groq.com/openai/v1/chat/completions",
            api_key=api_key,
            model=model,
            messages=messages,
            max_tokens=max_tokens,
        )
    if provider_id == "openrouter":
        return _chat_openai_compatible(
            url="https://openrouter.ai/api/v1/chat/completions",
            api_key=api_key,
            model=model,
            messages=messages,
            max_tokens=max_tokens,
            extra_headers={"HTTP-Referer": "https://butler.local", "X-Title": "Butler Agent"},
        )
    if provider_id == "mistral":
        return _chat_openai_compatible(
            url="https://api.mistral.ai/v1/chat/completions",
            api_key=api_key,
            model=model,
            messages=messages,
            max_tokens=max_tokens,
        )
    if provider_id == "cohere":
        return _chat_cohere(api_key, model, messages, max_tokens)
    raise AgentLLMError(f"Unknown provider: {provider_id}", retryable=False)


def _chat_local(messages: list[dict[str, str]], max_tokens: int) -> str:
    if not peepee_chat:
        raise AgentLLMError("Local LLM unavailable (peepee_ai not loaded)", retryable=False)
    r = peepee_chat(messages=messages, model=LOCAL_AGENT_MODEL, openai_api_key="", max_tokens=max_tokens)
    return str((r.get("message") or {}).get("content") or "")


def agent_llm_chat(
    messages: list[dict[str, str]],
    *,
    provider: str = "local",
    api_keys: dict[str, str] | None = None,
    max_tokens: int = 6144,
    on_provider_switch: Callable[[str, str], None] | None = None,
) -> AgentLLMResult:
    """
    Chat with selected provider; on rate-limit/auth/quota errors fall through ranked free list → local.
    """
    chain = build_fallback_chain(provider)
    fallbacks: list[str] = []
    last_err: Exception | None = None

    for pid in chain:
        meta = AGENT_PROVIDERS.get(pid) or {}
        model = meta.get("model") or LOCAL_AGENT_MODEL
        label = meta.get("label") or pid

        if pid == "local":
            try:
                content = _chat_local(messages, max_tokens)
                if on_provider_switch:
                    on_provider_switch("local", f"Local ({LOCAL_AGENT_MODEL})")
                return AgentLLMResult(
                    content=content,
                    provider="local",
                    model=LOCAL_AGENT_MODEL,
                    source_label=f"Agent · Local ({LOCAL_AGENT_MODEL})",
                    fallbacks_used=fallbacks,
                )
            except Exception as e:
                last_err = e
                fallbacks.append(f"local:{e}")
                break

        api_key = _resolve_api_key(pid, api_keys)
        if not api_key:
            fallbacks.append(f"{pid}:no_key")
            continue

        try:
            content = _chat_provider(pid, api_key, model, messages, max_tokens)
            src = f"Agent · {label} ({model})"
            if on_provider_switch:
                on_provider_switch(pid, src)
            if fallbacks:
                src += f" [fallback after {', '.join(fallbacks)}]"
            return AgentLLMResult(
                content=content,
                provider=pid,
                model=model,
                source_label=src,
                fallbacks_used=fallbacks,
            )
        except AgentLLMError as e:
            last_err = e
            fallbacks.append(f"{pid}:{e.status_code or 'err'}")
            if not e.retryable:
                continue
            continue
        except Exception as e:
            last_err = e
            fallbacks.append(f"{pid}:err")
            if not _is_fallback_error(e):
                continue
            continue

    raise AgentLLMError(
        f"All agent LLM providers failed. Last: {_format_exc(last_err)}",
        retryable=False,
    )


def _format_exc(exc: Exception | None) -> str:
    if exc is None:
        return "(none)"
    name = type(exc).__name__
    text = (str(exc) or "").strip()
    return f"{name}: {text}" if text else f"{name} (no message)"
