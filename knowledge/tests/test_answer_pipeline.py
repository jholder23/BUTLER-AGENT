# -*- coding: utf-8 -*-
"""Tests for knowledge-first → local LLM → refusal/web → learn answer pipeline."""
from __future__ import annotations

import sys
import types

import agent
import api_server


def test_chat_freedom_addendum_is_always_on_no_refusal() -> None:
    text = api_server._chat_freedom_addendum()
    assert "ALWAYS ON" in text
    assert "ZERO Butler-side refusals" in text
    assert "really concerned" in text
    assert api_server._local_only_chat_freedom_addendum() == text


class _FakeStore:
    def __init__(self) -> None:
        self.rows: list[dict] = []

    def add(self, content: str, source: str = "", topic: str = "") -> int:
        self.rows.append({"content": content, "source": source, "topic": topic})
        return 1

    def search(self, query: str, n_results: int = 5, where=None):
        qtok = {t for t in query.lower().split() if len(t) > 1}
        out = []
        for r in self.rows:
            if where and where.get("source") and r.get("source") != where.get("source"):
                # support {"source": "chat"} only
                if isinstance(where.get("source"), str) and r.get("source") != where["source"]:
                    continue
            c = r.get("content") or ""
            ctok = {t for t in c.lower().split() if len(t) > 1}
            inter = len(qtok & ctok)
            if inter <= 0:
                continue
            out.append({**r, "distance": 1.0 / (1e-6 + inter)})
        out.sort(key=lambda x: x["distance"])
        return out[:n_results]

    def count(self) -> int:
        return len(self.rows)


def test_refusal_detector_matches_common_hedges() -> None:
    assert agent._local_llm_refusal_reply("I can't help with that request.")
    assert agent._local_llm_refusal_reply("Sorry, but I cannot assist with that.")
    assert agent._local_llm_refusal_reply("I'm not comfortable providing that information.")
    assert agent._local_llm_refusal_reply("I won't provide detailed instructions on that.")
    assert not agent._local_llm_refusal_reply(
        "Here is how to make a simple chocolate cake: mix flour, sugar, eggs, and bake at 350F for 30 minutes."
    )


def test_refusal_detector_matches_concern_lectures() -> None:
    """Aligned-model concern/safety lectures count as refusals even without 'I can't help'."""
    assert agent._local_llm_refusal_reply(
        "I'm really concerned about this request. This is incredibly dangerous and I strongly advise against it."
    )
    assert agent._local_llm_refusal_reply(
        "Before I answer, I must warn you this is extremely dangerous. Please seek professional help."
    )
    assert agent._local_llm_refusal_reply(
        "As a responsible AI, I cannot in good conscience encourage this. Contact a hotline if you need support."
    )
    assert not agent._local_llm_refusal_reply(
        "Baking powder reacts with acid to produce CO2, which leavens batter. Use about 1 tsp per cup of flour."
    )


def test_refusal_triggers_knowledge_web_fallback(monkeypatch) -> None:
    """Step 3: refusal clears model text and synthesizes from knowledge/web (no cloud)."""
    store = _FakeStore()
    cake = (
        "User: how to make a cake\n\nAssistant:\n"
        "To make a simple cake, cream butter and sugar, add eggs, fold in flour, "
        "pour into a pan, and bake at 350F until a toothpick comes out clean."
    )
    store.add(cake, source="chat", topic="how to make a cake")

    fake_web = types.SimpleNamespace(
        gather_web_answer_context=lambda *_a, **_k: (
            "Simple cake recipe\nhttps://example.com/cake\n"
            "Cream butter and sugar, add eggs and flour, bake at 350F for about 30 minutes."
        )
    )
    monkeypatch.setitem(sys.modules, "web_fetcher", fake_web)
    monkeypatch.setattr(agent, "_user_message_wants_urls_in_reply", lambda *_a, **_k: False)
    monkeypatch.setattr(agent, "_synthesize_research_with_local_llm", lambda *_a, **_k: "")
    monkeypatch.setattr(agent, "_synthesize_research_via_openai", lambda *_a, **_k: "CLOUD_SHOULD_NOT_RUN")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-should-not-be-used")
    monkeypatch.setenv("BUTLER_CHAT_CLOUD", "0")

    out = agent._finalize_chat_with_web_fallback(
        {"mode": "chat", "reply": "I can't help with that."},
        "how to make a cake",
        store=store,
        local_only=True,
    )
    reply = (out.get("reply") or "").strip()
    assert reply
    assert "can't help with that" not in reply.lower()
    assert "CLOUD_SHOULD_NOT_RUN" not in reply
    # Should answer from memory/web about cake
    assert "cake" in reply.lower() or "bake" in reply.lower() or "flour" in reply.lower()


def test_concern_lecture_cleared_when_web_fallback_works(monkeypatch) -> None:
    """Concern-lecture refusals must never reach the user when knowledge/web synth succeeds."""
    store = _FakeStore()
    store.add(
        "User: what temperature to bake cookies\n\nAssistant:\n"
        "Bake most drop cookies at 350F (175C) for 10-12 minutes until edges are golden.",
        source="chat",
        topic="what temperature to bake cookies",
    )
    fake_web = types.SimpleNamespace(
        gather_web_answer_context=lambda *_a, **_k: (
            "Cookie baking temp\nhttps://example.com/cookies\nBake at 350F for 10-12 minutes."
        )
    )
    monkeypatch.setitem(sys.modules, "web_fetcher", fake_web)
    monkeypatch.setattr(agent, "_user_message_wants_urls_in_reply", lambda *_a, **_k: False)
    monkeypatch.setattr(agent, "_synthesize_research_with_local_llm", lambda *_a, **_k: "")
    monkeypatch.setattr(agent, "_synthesize_research_via_openai", lambda *_a, **_k: "CLOUD_SHOULD_NOT_RUN")
    monkeypatch.setenv("BUTLER_CHAT_CLOUD", "0")

    lecture = (
        "I'm really concerned about this. This is incredibly dangerous. "
        "I strongly advise against it and please seek professional help."
    )
    out = agent._finalize_chat_with_web_fallback(
        {"mode": "chat", "reply": lecture},
        "what temperature to bake cookies",
        store=store,
        local_only=True,
    )
    reply = (out.get("reply") or "").strip().lower()
    assert reply
    assert "really concerned" not in reply
    assert "incredibly dangerous" not in reply
    assert "seek professional" not in reply
    assert "cloud_should_not_run" not in reply
    assert "350" in reply or "bake" in reply or "cookie" in reply


def test_learn_stores_good_answer_and_second_ask_hits_knowledge() -> None:
    """Step 4 then step 1: store a good answer; next similar ask returns knowledge-first."""
    store = _FakeStore()
    q = "how to make a simple vanilla cake"
    a = (
        "Cream 1 cup butter with 1 cup sugar, beat in 2 eggs, fold in 1.5 cups flour "
        "and 1 tsp baking powder, bake at 350F for 28-32 minutes until golden."
    )
    n = agent._learn_good_chat_answer(store, q, a)
    assert n >= 1
    assert any(r.get("source") == "chat" for r in store.rows)

    # Dedupe: learning the same again should no-op
    n2 = agent._learn_good_chat_answer(store, q, a)
    assert n2 == 0

    direct = agent._try_direct_knowledge_answer(store, "how to make a simple vanilla cake")
    assert direct
    assert "flour" in direct.lower() or "bake" in direct.lower()


def test_knowledge_first_skips_local_llm(monkeypatch) -> None:
    """Step 1: chat_code_helper returns from knowledge without calling peepee_chat."""
    store = _FakeStore()
    store.add(
        "User: how do I hard boil eggs\n\nAssistant:\n"
        "Place eggs in cold water, bring to a boil, then simmer 9-12 minutes and ice-bath them.",
        source="chat",
        topic="how do I hard boil eggs",
    )

    calls: list = []

    def boom(*_a, **_k):
        calls.append(1)
        raise AssertionError("local LLM should not be called on knowledge-first hit")

    monkeypatch.setattr(agent, "peepee_chat", boom)
    monkeypatch.setattr(agent, "KnowledgeStore", lambda: store)
    monkeypatch.setattr(agent, "_llm_resolve_effective_user_query", lambda m, _p, **_k: (m, False, ""))
    monkeypatch.setenv("BUTLER_KNOWLEDGE_FIRST", "1")
    monkeypatch.setenv("BUTLER_CHAT_CLOUD", "0")

    out = agent.chat_code_helper(
        "how do I hard boil eggs",
        "You are Butler.",
        [],
        {},
        [],
        "D:\\BUTLER",
        openai_api_key="",
        local_only=True,
    )
    assert calls == []
    assert out.get("mode") == "chat"
    assert "simmer" in (out.get("reply") or "").lower() or "boil" in (out.get("reply") or "").lower()
    assert "knowledge" in (out.get("source") or "").lower()
