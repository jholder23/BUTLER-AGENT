"""peepee_ai chat() retries on transient TCP failures."""

from __future__ import annotations

import os
import urllib.error
from unittest.mock import patch

import pytest

from peepee_ai import _resolve_upstream, _resolve_upstream_candidates


def test_resolve_upstream_ollama_bare_no_double_v1():
    assert _resolve_upstream("http://127.0.0.1:11434") == (
        "http://127.0.0.1:11434/v1/chat/completions",
        "openai",
    )


def test_resolve_upstream_ollama_v1_base_appends_chat_completions_only():
    assert _resolve_upstream("http://127.0.0.1:11434/v1") == (
        "http://127.0.0.1:11434/v1/chat/completions",
        "openai",
    )


def test_resolve_upstream_candidates_ollama_includes_native_fallback():
    urls = [u for u, _ in _resolve_upstream_candidates("http://127.0.0.1:11434/v1")]
    assert urls == [
        "http://127.0.0.1:11434/v1/chat/completions",
        "http://127.0.0.1:11434/api/chat",
    ]


def test_resolve_upstream_stub_uses_chat_path():
    assert _resolve_upstream("http://127.0.0.1:5000") == ("http://127.0.0.1:5000/chat", "butler")


def test_peer_reset_triggers_retry_then_success():
    import sys

    from peepee_ai import chat as peepee_chat

    ok_body = b'{"message":{"content":"ok"}}'

    class _FakeResp:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return ok_body

    calls = {"n": 0}

    def fake_urlopen(req, timeout):
        calls["n"] += 1
        if calls["n"] == 1:
            if sys.platform == "win32":
                err = OSError(10054, "forcibly closed")
            else:
                import errno

                err = OSError(errno.ECONNRESET, "reset")
            raise urllib.error.URLError(err)
        return _FakeResp()

    with patch("peepee_ai.PEEPEEDEE_AI_URL", "http://127.0.0.1:9"):
        with patch("urllib.request.urlopen", side_effect=fake_urlopen):
            with patch("peepee_ai._peepee_retry_delay_sec", return_value=0.01):
                r = peepee_chat([{"role": "user", "content": "hi"}], timeout_sec=30.0)
    assert (r.get("message") or {}).get("content") == "ok"
    assert calls["n"] == 2


def test_disable_local_llm_returns_offline_fallback_without_network():
    from peepee_ai import chat as peepee_chat

    with patch.dict(os.environ, {"BUTLER_DISABLE_LOCAL_LLM": "1"}, clear=False):
        with patch("urllib.request.urlopen", side_effect=AssertionError("network should not be used")) as mock_urlopen:
            r = peepee_chat([{"role": "user", "content": "hi"}], timeout_sec=10.0)

    content = (r.get("message") or {}).get("content") or ""
    assert "low-memory" in content.lower()
    assert "local model is disabled" in content.lower()
    mock_urlopen.assert_not_called()
