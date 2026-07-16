# -*- coding: utf-8 -*-
"""Video-pick mode: SERP-backed single watch URL, year/topic ranking, no refusal tails."""
from __future__ import annotations

import re
import sys
import types

import agent


def test_detects_return_one_video_phrase() -> None:
    q = "find me one YouTube video about python list comprehensions from 2024 return one video"
    assert agent._user_message_wants_single_playable_video(q)
    assert agent._user_message_seeks_web_video_discovery(q)


def test_year_constraints_extracted() -> None:
    assert "2026" in agent._year_constraints_from_user_message("return one video made in 2026")
    assert "2024" in agent._year_constraints_from_user_message(
        "find me one YouTube video about python list comprehensions from 2024 return one video"
    )


def test_pick_prefers_topic_and_year_over_unrelated_youtube() -> None:
    web = (
        "Python List Comprehensions Tutorial 2024\n"
        "https://www.youtube.com/watch?v=AhSvKGTh3Qo\n"
        "Learn Python list comprehensions in this 2024 tutorial.\n\n"
        "---\n\n"
        "Unrelated Pop Song\n"
        "https://www.youtube.com/watch?v=u2ah9tWTkmk\n"
        "A random music video from 2018 with no python content."
    )
    q = "find me one YouTube video about python list comprehensions from 2024 return one video"
    url = agent._pick_best_playable_video_url(web, q)
    assert url
    assert "youtube.com/watch" in url.lower() or "youtu.be/" in url.lower()
    assert "u2ah9tWTkmk" not in url
    assert "AhSvKGTh3Qo" in url or "list" in url.lower()


def test_pick_rejects_year_mismatch() -> None:
    web = (
        "Old generic clip\n"
        "https://www.youtube.com/watch?v=u2ah9tWTkmk\n"
        "Uploaded in 2018 — unrelated topic.\n\n"
        "---\n\n"
        "Another old clip\n"
        "https://www.youtube.com/watch?v=OLDOLDOLD11\n"
        "Classic video with no 2026 marker."
    )
    q = "find me a video about cooking pasta return one video made in 2026"
    url = agent._pick_best_playable_video_url(web, q)
    assert url == ""


def test_rejects_yandex_preview_urls() -> None:
    web = (
        "Preview\n"
        "https://twitter.yandex.com.tr/video/preview/7136802889104658956?noreask=1\n"
        "Not a direct watch page.\n\n"
        "---\n\n"
        "Real watch\n"
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ\n"
        "Python tutorial 2024 list comprehensions walkthrough."
    )
    q = "find me one YouTube video about python list comprehensions from 2024 return one video"
    url = agent._pick_best_playable_video_url(web, q)
    assert url
    assert "yandex" not in url.lower()
    assert "youtube.com/watch" in url.lower()


def test_finalize_strips_ethics_lecture_and_uses_serp_url() -> None:
    web = (
        "Python List Comprehensions Tutorial 2024\n"
        "https://www.youtube.com/watch?v=AhSvKGTh3Qo\n"
        "List comprehensions in Python — 2024 tutorial."
    )
    q = "find me one YouTube video about python list comprehensions from 2024 return one video"
    raw = (
        "Best single clip for your criteria (tap to open; many clients embed YouTube or direct video):\n"
        "https://www.youtube.com/watch?v=u2ah9tWTkmk\n\n"
        "I'm unable to find exact videos based on your description. "
        "Please be aware that accessing such content might not adhere to privacy and ethical norms. "
        "Contact a hotline if you need support."
    )
    out = agent._finalize_single_video_pick_reply(raw, web, q)
    low = out.lower()
    assert "youtube.com/watch" in low or "youtu.be/" in low
    assert "u2ah9tWTkmk" not in out
    assert "privacy" not in low
    assert "ethical" not in low
    assert "hotline" not in low
    assert "unable to find" not in low


def test_finalize_no_invented_urls() -> None:
    web = (
        "Tutorial\n"
        "https://www.youtube.com/watch?v=REALFROMWEB1\n"
        "Python list comprehensions 2024."
    )
    q = "find me one YouTube video about python list comprehensions from 2024 return one video"
    raw = "Try this: https://www.youtube.com/watch?v=INVENTEDURL9"
    out = agent._finalize_single_video_pick_reply(raw, web, q)
    assert "INVENTEDURL9" not in out
    assert "REALFROMWEB1" in out


def test_finalize_honest_miss_without_lecture() -> None:
    web = "Some article\nhttps://example.com/docs/python\nNo playable video URLs here."
    q = "find me one YouTube video about python list comprehensions from 2024 return one video"
    raw = (
        "I'm unable to find exact videos. Please be aware of privacy and ethical norms. "
        "Contact a crisis hotline."
    )
    out = agent._finalize_single_video_pick_reply(raw, web, q)
    low = out.lower()
    assert "no matching playable video" in low
    assert "ethical" not in low
    assert "hotline" not in low


def test_video_web_fallback_end_to_end(monkeypatch) -> None:
    """Smoke: video-pick enrichment returns one SERP youtube/watch URL, no ethics paragraph."""
    store = types.SimpleNamespace(
        search=lambda *_a, **_k: [],
        add=lambda *_a, **_k: 0,
        count=lambda: 0,
    )
    web_block = (
        "Python List Comprehensions Explained (2024)\n"
        "https://www.youtube.com/watch?v=AhSvKGTh3Qo\n"
        "A concise 2024 walkthrough of Python list comprehensions with examples."
    )
    fake_web = types.SimpleNamespace(
        gather_web_answer_context=lambda *_a, **_k: web_block,
        search_web_result_snippets_block=lambda *_a, **_k: "",
    )
    monkeypatch.setitem(sys.modules, "web_fetcher", fake_web)
    monkeypatch.setattr(agent, "_user_message_wants_urls_in_reply", lambda *_a, **_k: True)
    monkeypatch.setattr(
        agent,
        "_synthesize_research_with_local_llm",
        lambda *_a, **_k: (
            "I'm unable to find exact videos. Privacy and ethical concerns apply. Call a hotline."
        ),
    )
    monkeypatch.setattr(agent, "_synthesize_research_via_openai", lambda *_a, **_k: "")
    monkeypatch.setenv("BUTLER_CHAT_CLOUD", "0")

    q = "find me one YouTube video about python list comprehensions from 2024 return one video"
    out = agent._finalize_chat_with_web_fallback(
        {"mode": "chat", "reply": "I can't help with that.", "needs_live_web": True},
        q,
        store=store,
        local_only=True,
    )
    reply = (out.get("reply") or "").strip()
    low = reply.lower()
    assert re.search(r"youtube\.com/watch|youtu\.be/", low)
    assert "privacy" not in low
    assert "ethical" not in low
    assert "hotline" not in low
    assert "unable to find" not in low
    assert "can't help" not in low
