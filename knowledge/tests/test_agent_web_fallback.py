from __future__ import annotations

import sys
import types

import agent
from agent import (
    _compact_research_fallback,
    _extract_reply_from_raw_loose,
    _is_research_mem_noise_chunk,
    _prefer_reply_over_short_fallback,
)


_HEDGE_MARKERS = (
    "ask me again",
    "more specifically",
    "clean answer",
    "couldn't turn them into a clean answer",
    "couldn’t turn them into a clean answer",
    "i've got some notes on that",
    "i’ve got some notes on that",
)


def _assert_no_specificity_hedge(reply: str) -> None:
    low = (reply or "").lower()
    for m in _HEDGE_MARKERS:
        assert m not in low, f"hedge marker present: {m!r} in {reply!r}"


def test_compact_research_fallback_returns_web_cards_instead_of_timeout_message() -> None:
    web = """
Example result title
https://example.com/result
This snippet contains a concise fact that can still be useful when synthesis times out.

---

Second result
https://example.org/other
Another useful snippet with enough detail to form a fallback answer.
"""

    reply = _compact_research_fallback("what did the web say?", "", web)

    assert "I pulled web material" not in reply
    assert "Please send the question again" not in reply
    _assert_no_specificity_hedge(reply)
    assert "concise fact" in reply
    assert "useful snippet" in reply.lower() or "another useful" in reply.lower()
    assert "https://" not in reply.lower()


def test_research_noise_filter_matches_curly_timeout_fragments() -> None:
    assert _is_research_mem_noise_chunk(
        "I pulled web material but couldn’t turn it into a short answer before timing out."
    )
    assert _is_research_mem_noise_chunk(
        "Please send the question again (or split it into one fact at a time)—I’ll take another run at it."
    )
    assert _is_research_mem_noise_chunk(
        "I’ve got some notes on that, but I couldn’t turn them into a clean answer just now—"
        "ask me again a bit more specifically and I’ll walk you through it."
    )


def test_prefer_reply_over_short_fallback_keeps_longer_model_answer() -> None:
    orig = "A" * 500 + " This is the full local model answer with enough detail to be useful."
    short = "Here is the clearest short version I can extract from the web material I found:\n\n- Site: snippet"
    assert _prefer_reply_over_short_fallback(orig, short) == orig


def test_extract_reply_from_truncated_json() -> None:
    raw = '{"mode":"chat","reply":"Paris is the capital of France and has been for many centuries because'
    got = _extract_reply_from_raw_loose(raw)
    assert got.startswith("Paris is the capital")


def test_local_only_web_fallback_does_not_use_openai_env(monkeypatch) -> None:
    calls: list[tuple[tuple, dict]] = []
    fake_web = types.SimpleNamespace(
        gather_web_answer_context=lambda *_args, **_kwargs: (
            "Example result title\n"
            "https://example.com/result\n"
            "A useful snippet that should be returned by the deterministic fallback."
        )
    )
    monkeypatch.setitem(sys.modules, "web_fetcher", fake_web)
    monkeypatch.setenv("OPENAI_API_KEY", "sk-should-not-be-used")
    monkeypatch.setattr(agent, "_user_message_wants_urls_in_reply", lambda *_args, **_kwargs: False)
    monkeypatch.setattr(agent, "_synthesize_research_with_local_llm", lambda *_args, **_kwargs: "")

    def fake_openai(*args, **kwargs):
        calls.append((args, kwargs))
        return "openai response"

    monkeypatch.setattr(agent, "_synthesize_research_via_openai", fake_openai)

    out = agent._finalize_chat_with_web_fallback(
        {"mode": "chat", "reply": "I don't have a direct answer."},
        "what is the answer?",
        store=None,
        local_only=True,
    )

    assert calls == []
    _assert_no_specificity_hedge(out["reply"])
    assert "useful snippet" in out["reply"].lower()


def test_howto_finalize_never_asks_for_more_specificity(monkeypatch) -> None:
    """How-to asks get a best-effort answer from web when synthesis is empty — never a hedge punt."""
    fake_web = types.SimpleNamespace(
        gather_web_answer_context=lambda *_args, **_kwargs: (
            "Restart Knowledge API\n"
            "https://example.com/restart\n"
            "From the repo root run npm run dev:restart to free ports and bring Knowledge back up.\n\n"
            "---\n\n"
            "Butler dev scripts\n"
            "https://example.com/scripts\n"
            "The package.json script restarts Knowledge on 8765 plus the UI API and Vite."
        )
    )
    monkeypatch.setitem(sys.modules, "web_fetcher", fake_web)
    monkeypatch.setattr(agent, "_user_message_wants_urls_in_reply", lambda *_args, **_kwargs: False)
    monkeypatch.setattr(agent, "_synthesize_research_with_local_llm", lambda *_args, **_kwargs: "")
    monkeypatch.setattr(agent, "_synthesize_research_via_openai", lambda *_args, **_kwargs: "")
    monkeypatch.setattr(agent, "_memory_research_excerpts", lambda *_args, **_kwargs: "")

    out = agent._finalize_chat_with_web_fallback(
        {"mode": "chat", "reply": "I don't have a direct answer."},
        "how do I restart the butler knowledge api from the repo?",
        store=None,
        local_only=True,
    )

    reply = out.get("reply") or ""
    assert reply.strip()
    _assert_no_specificity_hedge(reply)
    assert "https://" not in reply.lower()
    assert "dev:restart" in reply.lower() or "8765" in reply or "knowledge" in reply.lower()
