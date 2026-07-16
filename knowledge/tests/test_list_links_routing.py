# -*- coding: utf-8 -*-
"""List-of-websites / return-N-links asks must web-enrich, not return a single knowledge clip."""
from __future__ import annotations

import re
import sys
import types

import agent
from semantic_route import is_informational_qa_turn


def test_detects_return_n_links_website_list() -> None:
    ok, n = agent._user_message_wants_website_link_list(
        "find me 5 official documentation websites for Python, return 5 links"
    )
    assert ok is True
    assert n == 5
    ok2, n2 = agent._user_message_wants_website_link_list("return 5 links to cooking recipe websites")
    assert ok2 is True
    assert n2 == 5


def test_does_not_treat_howto_as_link_list() -> None:
    ok, _ = agent._user_message_wants_website_link_list("how do I hard boil eggs")
    assert ok is False


def test_video_discovery_skipped_for_website_list() -> None:
    q = "return 5 links to official Python documentation websites"
    assert agent._user_message_wants_website_link_list(q)[0]
    assert not agent._user_message_seeks_web_video_discovery(q)
    assert not agent._user_message_wants_single_playable_video(q)


def test_single_video_url_fails_link_list_shape() -> None:
    clip = "https://yandex.ru/video/preview/1234567890abcdef"
    assert not agent._reply_satisfies_website_link_list(f"Here you go:\n{clip}", 5)
    assert agent._url_looks_like_video_clip_or_embed(clip)


def test_multi_site_urls_satisfy_shape() -> None:
    body = (
        "Useful links:\n"
        "https://docs.python.org/3/\n"
        "https://docs.python.org/3/tutorial/\n"
        "https://www.python.org/\n"
        "https://peps.python.org/\n"
        "https://docs.python.org/3/library/\n"
    )
    assert agent._reply_satisfies_website_link_list(body, 5)


def test_knowledge_first_rejects_single_clip_for_list_ask() -> None:
    store = type(
        "S",
        (),
        {
            "search": lambda self, q, n_results=5, where=None: [
                {
                    "content": (
                        "User: return 5 links to recipe websites\n\nAssistant:\n"
                        "Try this clip:\nhttps://twitter.com/user/status/1234567890"
                    ),
                    "source": "chat",
                    "distance": 0.2,
                }
            ],
        },
    )()
    assert (
        agent._try_direct_knowledge_answer(
            store, "return 5 links to cooking recipe websites"
        )
        == ""
    )


def test_wrong_shape_knowledge_forces_web_fallback(monkeypatch) -> None:
    store = types.SimpleNamespace(
        search=lambda *_a, **_k: [],
        add=lambda *_a, **_k: 1,
        count=lambda: 0,
    )
    fake_web = types.SimpleNamespace(
        gather_web_answer_context=lambda *_a, **_k: (
            "Python docs\nhttps://docs.python.org/3/\nOfficial Python documentation.\n\n"
            "---\n\n"
            "Python.org\nhttps://www.python.org/\nThe Python language site.\n\n"
            "---\n\n"
            "PEPs\nhttps://peps.python.org/\nPython Enhancement Proposals.\n\n"
            "---\n\n"
            "Tutorial\nhttps://docs.python.org/3/tutorial/\nOfficial tutorial.\n\n"
            "---\n\n"
            "Library\nhttps://docs.python.org/3/library/\nStandard library reference."
        ),
        search_web_result_snippets_block=lambda *_a, **_k: "",
        search_web=lambda *_a, **_k: [],
    )
    monkeypatch.setitem(sys.modules, "web_fetcher", fake_web)
    monkeypatch.setattr(agent, "_synthesize_research_with_local_llm", lambda *_a, **_k: "")
    monkeypatch.setattr(agent, "_synthesize_research_via_openai", lambda *_a, **_k: "")
    monkeypatch.setattr(agent, "_user_message_wants_urls_in_reply", lambda *_a, **_k: True)
    monkeypatch.setattr(agent, "_memory_research_excerpts", lambda *_a, **_k: "")
    # Avoid real search-planner network fan-out in unit tests.
    monkeypatch.setitem(
        sys.modules,
        "search_planner",
        types.SimpleNamespace(
            web_search_planner_enabled=lambda: False,
            plan_immediate_web_searches=lambda *_a, **_k: [],
            aggregate_planned_search_snippets=lambda *_a, **_k: "",
        ),
    )
    monkeypatch.setenv("BUTLER_CHAT_CLOUD", "0")
    monkeypatch.setenv("BUTLER_WEB_ENRICHMENT", "1")
    monkeypatch.setenv("BUTLER_WEB_SYNTHESIS", "0")

    out = agent._finalize_chat_with_web_fallback(
        {
            "mode": "chat",
            "reply": "https://yandex.ru/video/preview/999999",
            "source": "Local (knowledge)",
            "_butler_knowledge_first": True,
        },
        "find me 5 official documentation websites for Python, return 5 links",
        store=store,
        local_only=True,
    )
    reply = (out.get("reply") or "").strip()
    assert reply
    assert "yandex.ru/video" not in reply.lower()
    urls = agent._extract_http_urls_from_text(reply)
    assert len(urls) >= 5
    assert all(not agent._url_looks_like_video_clip_or_embed(u) for u in urls[:5])
    assert out.get("_butler_knowledge_first") is None


def test_list_links_stay_informational_chat_not_tools() -> None:
    q = "return 5 links to official documentation websites for Python"
    assert is_informational_qa_turn(q) is True
    coerced = agent.coerce_tool_mode_for_informational_ask(
        q,
        {"mode": "sd_img2img", "prompt": "silhouette", "reply": "generating"},
        [],
        has_init_image=False,
    )
    assert coerced.get("mode") == "chat"


def test_clean_useful_links_reply_not_flagged_as_leak() -> None:
    body = (
        "Here are official / documentation-style sites that match what you asked:\n\n"
        "Useful links:\n"
        "https://docs.python.org/3/\n"
        "https://docs.python.org/3/tutorial/\n"
        "https://www.python.org/\n"
        "https://peps.python.org/\n"
        "https://docs.python.org/3/library/\n"
    )
    assert agent._looks_like_intentional_website_link_list_reply(body)
    assert not agent._looks_like_leaked_research_blob(body)
    assert agent._reply_satisfies_website_link_list(body, 5)


def test_names_only_list_gets_serp_urls_attached() -> None:
    names = (
        "Here are five useful Python documentation sites:\n\n"
        "1. Python Docs — official language documentation\n"
        "2. Python.org — the language homepage\n"
        "3. PEPs — enhancement proposals\n"
        "4. Tutorial — getting started guide\n"
        "5. Library reference — standard library\n"
    )
    assert not agent._reply_satisfies_website_link_list(names, 5)
    web = (
        "Python Docs\nhttps://docs.python.org/3/\nOfficial Python documentation.\n\n"
        "---\n\n"
        "Python.org\nhttps://www.python.org/\nThe Python language site.\n\n"
        "---\n\n"
        "PEPs\nhttps://peps.python.org/\nPython Enhancement Proposals.\n\n"
        "---\n\n"
        "Tutorial\nhttps://docs.python.org/3/tutorial/\nOfficial tutorial.\n\n"
        "---\n\n"
        "Library\nhttps://docs.python.org/3/library/\nStandard library reference."
    )
    fixed = agent._ensure_website_link_list_urls(names, web, 5)
    urls = agent._extract_http_urls_from_text(fixed)
    assert len(urls) >= 5
    assert len(re.findall(r"https?://", fixed, flags=re.I)) >= 5
    assert agent._reply_satisfies_website_link_list(fixed, 5)


def test_pack_final_keeps_urls_when_synth_returns_names_only(monkeypatch) -> None:
    store = types.SimpleNamespace(
        search=lambda *_a, **_k: [],
        add=lambda *_a, **_k: 1,
        count=lambda: 0,
    )
    names_only = (
        "Five documentation sites:\n"
        "Python Docs — language reference\n"
        "Python.org — homepage\n"
        "PEPs — proposals\n"
        "Tutorial — learn Python\n"
        "Library — stdlib docs"
    )
    fake_web = types.SimpleNamespace(
        gather_web_answer_context=lambda *_a, **_k: (
            "Python Docs\nhttps://docs.python.org/3/\nOfficial Python documentation.\n\n"
            "---\n\n"
            "Python.org\nhttps://www.python.org/\nThe Python language site.\n\n"
            "---\n\n"
            "PEPs\nhttps://peps.python.org/\nPython Enhancement Proposals.\n\n"
            "---\n\n"
            "Tutorial\nhttps://docs.python.org/3/tutorial/\nOfficial tutorial.\n\n"
            "---\n\n"
            "Library\nhttps://docs.python.org/3/library/\nStandard library reference."
        ),
        search_web_result_snippets_block=lambda *_a, **_k: "",
        search_web=lambda *_a, **_k: [],
    )
    monkeypatch.setitem(sys.modules, "web_fetcher", fake_web)
    monkeypatch.setattr(
        agent, "_synthesize_research_with_local_llm", lambda *_a, **_k: names_only
    )
    monkeypatch.setattr(agent, "_synthesize_research_via_openai", lambda *_a, **_k: "")
    monkeypatch.setattr(agent, "_user_message_wants_urls_in_reply", lambda *_a, **_k: True)
    monkeypatch.setattr(agent, "_memory_research_excerpts", lambda *_a, **_k: "")
    monkeypatch.setitem(
        sys.modules,
        "search_planner",
        types.SimpleNamespace(
            web_search_planner_enabled=lambda: False,
            plan_immediate_web_searches=lambda *_a, **_k: [],
            aggregate_planned_search_snippets=lambda *_a, **_k: "",
        ),
    )
    monkeypatch.setenv("BUTLER_CHAT_CLOUD", "0")
    monkeypatch.setenv("BUTLER_WEB_ENRICHMENT", "1")
    monkeypatch.setenv("BUTLER_WEB_SYNTHESIS", "1")

    out = agent._finalize_chat_with_web_fallback(
        {
            "mode": "chat",
            "reply": names_only,
            "source": "Local",
        },
        "find me 5 official documentation websites for Python, return 5 links",
        store=store,
        local_only=True,
    )
    reply = (out.get("reply") or "").strip()
    assert len(re.findall(r"https?://", reply, flags=re.I)) >= 5
    assert agent._reply_satisfies_website_link_list(reply, 5)


def test_python_docs_link_list_smoke_real_serp() -> None:
    """Benign live SERP smoke: gather context must yield ≥5 real https URLs in the enforced reply."""
    try:
        from web_fetcher import gather_web_answer_context, search_web
    except ImportError:
        return
    q = "official Python documentation websites"
    raw = ""
    try:
        raw = (gather_web_answer_context(q, max_chars=4500) or "").strip()
        if len(raw) < 80:
            parts = []
            for r in search_web(q, max_results=8) or []:
                title = (r.get("title") or "").strip()
                url = (r.get("url") or r.get("href") or "").strip()
                sn = (r.get("snippet") or r.get("body") or "").strip()
                if url:
                    parts.append(f"{title}\n{url}\n{sn}".strip())
            raw = "\n\n---\n\n".join(parts)
    except Exception:
        return
    if len(agent._extract_urls_from_web_block(raw, limit=20)) < 3:
        return
    names = (
        "Python documentation sites:\n"
        "Python Docs\nPython.org\nPEPs\nTutorial\nLibrary reference"
    )
    fixed = agent._ensure_website_link_list_urls(names, raw, 5)
    assert len(re.findall(r"https?://", fixed, flags=re.I)) >= 5
    assert all(u.startswith("http") for u in agent._extract_http_urls_from_text(fixed)[:5])
