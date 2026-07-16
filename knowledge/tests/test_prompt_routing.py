"""
Routing is driven by Butler JSON + ``semantic_route`` (LLM), not host substring tables.
Legacy direct-SD shortcuts were removed from api_server.py.
"""

from __future__ import annotations

from agent import (
    _chat_cloud_llm_allowed,
    _finalize_chat_with_web_fallback,
    _get_knowledge_context,
    _is_meta_feedback_message,
    _is_short_social_message,
    _llm_resolve_effective_user_query,
    _looks_like_leaked_research_blob,
    _memory_blocks_cap,
    _memory_hit_rank_key,
    _memory_hit_relevant,
    _model_requests_live_web,
    _prior_history_window,
    _question_intent,
    _resolve_effective_user_query,
    _sanitize_memory_chunk_for_prompt,
)


def test_live_web_dispatcher_flag_truthy_when_bool():
    assert _model_requests_live_web({"mode": "chat", "needs_live_web": True}) is True


def test_live_web_dispatcher_flag_false_when_missing():
    assert _model_requests_live_web({"mode": "chat", "reply": "hi"}) is False


def test_live_web_dispatcher_string_one():
    assert _model_requests_live_web({"needs_live_web": "true"}) is True


def test_short_social_messages_detected():
    assert _is_short_social_message("hey")
    assert _is_short_social_message("Hi!")
    assert _is_short_social_message("what's up")
    assert not _is_short_social_message("hey can you explain how docker networking works")
    assert not _is_short_social_message("what is the capital of France?")


def test_leaked_research_blob_detected():
    blob = (
        "User: old question\n\n"
        "[Supporting web excerpts — saved for retrieval]:\n"
        "https://example.com/a\nhttps://example.com/b\nhttps://example.com/c\n"
        "lots of scraped text about something unrelated\n\n"
        "Assistant:\nHere is a long research dump..."
    )
    assert _looks_like_leaked_research_blob(blob)
    assert _looks_like_leaked_research_blob(
        "(B) Private research (search snippets + page text). For your reading only;\n" + ("x" * 80)
    )
    assert not _looks_like_leaked_research_blob("Hey — what's up?")
    digest = (
        "- How to fix Docker networking: long snippet about bridges\n"
        "- Docker docs overview: another long snippet about overlays\n"
        "- StackOverflow answer: yet more networking advice\n"
        "https://example.com/1\n"
    )
    assert _looks_like_leaked_research_blob(digest)
    assert _looks_like_leaked_research_blob(
        "User: how do I restart\nsoftware sources - How to remove a repository? - Ask Ubuntu\n---\nmore"
    )
    assert _looks_like_leaked_research_blob(
        "Here's the practical takeaway I'd go with: unrelated SERP text about repos"
    )


def test_sanitize_memory_chunk_strips_research_scaffold():
    raw = (
        "User: how do I restart butler knowledge\n\n"
        "[Supporting web excerpts — saved for retrieval]:\n"
        "Restart API headline\n"
        "https://example.com/a\n"
        "https://example.com/b\n"
        "scraped page text about unrelated research\n\n"
        "Assistant:\n"
        "From the repo root, run npm run dev:restart — that frees the ports and brings Knowledge back up."
    )
    cleaned = _sanitize_memory_chunk_for_prompt(raw)
    assert cleaned
    assert "supporting web" not in cleaned.lower()
    assert "https://example.com" not in cleaned.lower()
    assert "npm run dev:restart" in cleaned
    assert not cleaned.lower().startswith("user:")


def test_get_knowledge_context_sanitizes_research_hits():
    class FakeStore:
        def count(self):
            return 99

        def search(self, *_a, **_k):
            return [
                {
                    "content": (
                        "User: how do I restart the butler knowledge api\n\n"
                        "[Supporting web excerpts — saved for retrieval]:\n"
                        "https://en.wikipedia.org/wiki/Something\n"
                        "https://example.com/two\n"
                        "https://example.com/three\n"
                        "long scraped research notes\n\n"
                        "Assistant:\nRun npm run dev:restart from the repo root."
                    ),
                    "source": "internet_research",
                    "distance": 0.2,
                }
            ]

    ctx = _get_knowledge_context(
        FakeStore(), "how do I restart the butler knowledge api"
    )
    assert ctx
    assert "supporting web" not in ctx.lower()
    assert "npm run dev:restart" in ctx
    assert "[From the internet]" not in ctx


def test_memory_hit_rejects_unrelated_research_for_greeting():
    row = {
        "content": (
            "User: what's the best way to do X\n\n"
            "[Supporting web excerpts — saved for retrieval]:\n"
            + ("https://en.wikipedia.org/wiki/Something\n" * 3)
            + "long scraped research notes\n\nAssistant:\nA long answer about X"
        ),
        "source": "internet_research",
        "distance": 0.2,
    }
    assert not _memory_hit_relevant("hey", row)


def test_memory_hit_accepts_overlapping_chat_turn():
    row = {
        "content": (
            "User: how do I restart the butler knowledge api\n\n"
            "Assistant:\nRun npm run dev:restart from the repo root."
        ),
        "source": "chat",
        "distance": 0.3,
    }
    assert _memory_hit_relevant("how do I restart butler knowledge", row)


def test_get_knowledge_context_skips_social():
    class FakeStore:
        def count(self):
            return 99

        def search(self, *_a, **_k):
            return [
                {
                    "content": "User: unrelated research\n\nAssistant:\nsecret dump",
                    "source": "internet_research",
                    "distance": 0.1,
                }
            ]

    assert _get_knowledge_context(FakeStore(), "hey") == ""


def test_finalize_social_greeting_skips_enrichment_and_clears_leak():
    out = _finalize_chat_with_web_fallback(
        {
            "mode": "chat",
            "reply": (
                "User: old ask\n\n[Supporting web excerpts — saved for retrieval]:\n"
                "https://a.com\nhttps://b.com\nhttps://c.com\nscraped notes"
            ),
        },
        "hey",
        store=None,
        local_only=True,
    )
    assert out["mode"] == "chat"
    # Leak cleared; no canned greeting short-circuit — main LLM answers greetings.
    assert "supporting web" not in (out.get("reply") or "").lower()
    assert not (out.get("reply") or "").strip()


def test_compact_research_fallback_no_serp_digest():
    from agent import _compact_research_fallback

    web = (
        "Butler GitHub Topics\nhttps://github.com/topics/butler\n"
        "Add a description to the butler topic page\n\n---\n\n"
        "Butler - LSST\nhttps://example.com/lsst\n"
        "URI to the Butler repository associated with the given label\n"
    )
    fb = _compact_research_fallback("how do I restart butler knowledge", "", web)
    assert fb
    assert "supporting web" not in fb.lower()
    assert "https://" not in fb.lower()
    # No bullet title:snippet digest shape
    assert not any(
        line.strip().startswith(("- ", "* ", "• ")) and ": " in line
        for line in fb.splitlines()
    )
    # Must answer with snippet prose — never ask the user to be more specific
    low = fb.lower()
    assert "ask me again" not in low
    assert "more specifically" not in low
    assert "clean answer" not in low
    assert "description to the butler topic" in low or "uri to the butler" in low


def test_howto_compact_fallback_no_specificity_hedge():
    from agent import _compact_research_fallback

    web = (
        "How to restart Knowledge\nhttps://example.com/howto\n"
        "Run npm run dev:restart from the Butler repo root to restart Knowledge and related services.\n"
    )
    fb = _compact_research_fallback(
        "how do I restart the butler knowledge api from the repo?",
        "",
        web,
    )
    assert fb
    low = fb.lower()
    assert "ask me again" not in low
    assert "more specifically" not in low
    assert "couldn't turn them into a clean answer" not in low
    assert "dev:restart" in low
    assert "https://" not in low


def test_meta_feedback_detected():
    assert _is_meta_feedback_message("you didn't answer my question")
    assert _is_meta_feedback_message("try again")
    assert _is_meta_feedback_message("be more specific")
    assert _is_meta_feedback_message("That wasn't an answer")
    assert not _is_meta_feedback_message("how do I eat a cake?")
    assert not _is_meta_feedback_message("hey")


def test_resolve_meta_followup_to_prior_howto():
    prior = [
        {"role": "user", "content": "how do I eat a cake?"},
        {
            "role": "assistant",
            "content": "Cake is a baked dessert made from flour, sugar, and eggs…",
        },
    ]
    rq, is_repair, prior_q = _resolve_effective_user_query(
        "you didn't answer my question", prior
    )
    assert is_repair
    assert prior_q == "how do I eat a cake?"
    assert rq == "how do I eat a cake?"
    assert "didn't answer" not in rq.lower()


def test_resolve_what_about_followup_grounds_on_prior():
    prior = [
        {"role": "user", "content": "how do I eat a cake?"},
        {"role": "assistant", "content": "Use a fork and plate."},
    ]
    rq, is_repair, prior_q = _resolve_effective_user_query("what about frosting?", prior)
    assert not is_repair
    assert prior_q == "how do I eat a cake?"
    assert "how do I eat a cake?" in rq
    assert "frosting" in rq.lower()


def test_get_knowledge_context_skips_meta_complaint_phrase():
    class FakeStore:
        def count(self):
            return 99

        def search(self, q, *_a, **_k):
            # Would wrongly match if we searched the complaint phrase.
            assert "didn't answer" not in (q or "").lower()
            return [
                {
                    "content": "User: you didn't answer\n\nAssistant:\nInternet excerpt about not answering",
                    "source": "internet_research",
                    "distance": 0.1,
                }
            ]

    assert _get_knowledge_context(FakeStore(), "you didn't answer my question") == ""


def test_finalize_meta_without_prior_skips_enrichment():
    out = _finalize_chat_with_web_fallback(
        {"mode": "chat", "reply": "Sorry about that."},
        "you didn't answer my question",
        store=None,
        local_only=True,
        retrieval_query="you didn't answer my question",
    )
    assert out["mode"] == "chat"
    assert "didn't answer" not in (out.get("reply") or "").lower() or out.get("reply") == "Sorry about that."


def test_question_intent_howto():
    assert _question_intent("how do I eat a cake?") == "howto"
    assert _question_intent("what is a cake?") == "definition"
    assert _memory_blocks_cap("how do I eat a cake?") <= 6


def test_memory_hit_rejects_meta_query():
    row = {
        "content": "User: how to bake\n\nAssistant:\nPreheat the oven.",
        "source": "chat",
        "distance": 0.2,
    }
    assert not _memory_hit_relevant("you didn't answer my question", row)

def test_question_intent_howto_and_definition():
    assert _question_intent("how to eat a cake") == "howto"
    assert _question_intent("How do I restart Butler?") == "howto"
    assert _question_intent("what is a cake") == "definition"
    assert _question_intent("why is the sky blue") == "why"
    assert _question_intent("tell me a joke") == "general"


def test_meta_feedback_detection():
    assert _is_meta_feedback_message("you didn't answer my question")
    assert _is_meta_feedback_message("Try again")
    assert _is_meta_feedback_message("be clearer please")
    assert not _is_meta_feedback_message("how to eat a cake")
    assert not _is_meta_feedback_message("hey")


def test_resolve_effective_query_from_prior_howto():
    prior = [
        {"role": "user", "content": "how to eat a cake"},
        {
            "role": "assistant",
            "content": "Cakes are desserts. History of cake: frosting types: recipes:",
        },
    ]
    rq, is_repair, prior_q = _resolve_effective_user_query(
        "you didn't answer my question", prior
    )
    assert is_repair
    assert "eat a cake" in rq.lower()
    assert prior_q == "how to eat a cake"


def test_memory_blocks_cap_tight_for_howto():
    assert _memory_blocks_cap("how to eat a cake") <= 4


def test_howto_context_prefers_answer_shaped_over_topic_blobs():
    class FakeStore:
        def count(self):
            return 99

        def search(self, *_a, **_k):
            return [
                {
                    "content": (
                        "Cake is a flour-based baked sweet. Types include pound cake, "
                        "sponge cake, cheesecake, and many regional varieties worldwide."
                    ),
                    "source": "internet_research",
                    "distance": 0.15,
                },
                {
                    "content": (
                        "User: how to eat a cake\n\n"
                        "Assistant:\n"
                        "Cut a slice, use a fork or your hands, take small bites, and enjoy. "
                        "Optional: add ice cream. That's it—no ceremony required."
                    ),
                    "source": "chat",
                    "distance": 0.35,
                },
                {
                    "content": (
                        "The history of cake dates back to ancient Egypt. Wedding cakes, "
                        "birthday cakes, and ceremonial cakes appear across cultures."
                    ),
                    "source": "internet_research",
                    "distance": 0.18,
                },
            ]

    ctx = _get_knowledge_context(FakeStore(), "how to eat a cake")
    assert ctx
    assert "Cut a slice" in ctx or "small bites" in ctx
    assert ctx.count("---") <= 3


def test_meta_feedback_skips_rag_on_complaint_phrase():
    class FakeStore:
        def count(self):
            return 99

        def search(self, query, *_a, **_k):
            raise AssertionError(f"RAG must not run on meta-feedback query: {query!r}")

    assert _get_knowledge_context(FakeStore(), "you didn't answer my question") == ""


def test_howto_rank_key_prefers_assistant_prose():
    howto = "how to eat a cake"
    blob = {
        "content": "Cakes are sweet baked goods with frosting and layers.",
        "source": "internet_research",
        "distance": 0.1,
    }
    answer = {
        "content": (
            "User: how to eat a cake\n\nAssistant:\nUse a fork, take bites, enjoy."
        ),
        "source": "chat",
        "distance": 0.4,
    }
    assert _memory_hit_rank_key(howto, answer, "howto") < _memory_hit_rank_key(
        howto, blob, "howto"
    )


def test_finalize_repair_retrieval_query_targets_prior_ask(monkeypatch):
    """Repair enrichment must target the prior how-to, never the complaint phrase."""
    seen: list[str] = []

    def fake_excerpts(store, user_message, max_chars=3200):
        seen.append(user_message)
        return (
            "Slice the cake, pick up a piece with a fork or your fingers, "
            "and take small bites. That's how you eat cake—simple as that."
        )

    monkeypatch.setattr("agent._memory_research_excerpts", fake_excerpts)
    monkeypatch.setattr("agent._web_enrichment_enabled", lambda: True)
    monkeypatch.setattr("agent._web_synthesis_enabled", lambda: False)
    monkeypatch.setattr(
        "agent._chat_reply_needs_web_enrichment",
        lambda _r: True,
    )

    out = _finalize_chat_with_web_fallback(
        {
            "mode": "chat",
            "reply": "Long cake encyclopedia dump " + ("history frosting types " * 40),
        },
        "you didn't answer my question",
        store=object(),
        local_only=True,
        retrieval_query="how to eat a cake",
    )
    assert seen, "expected memory retrieval for repair"
    assert all("eat a cake" in q.lower() for q in seen)
    assert all("didn't answer" not in q.lower() for q in seen)
    reply = (out.get("reply") or "").lower()
    assert "supporting web" not in reply
    assert "eat" in reply or "slice" in reply or "cake" in reply

def test_chat_cloud_llm_off_by_default(monkeypatch):
    monkeypatch.delenv("BUTLER_CHAT_CLOUD", raising=False)
    assert _chat_cloud_llm_allowed() is False
    monkeypatch.setenv("BUTLER_CHAT_CLOUD", "1")
    assert _chat_cloud_llm_allowed() is True


def test_prior_history_window_default():
    assert _prior_history_window() >= 16


def test_llm_resolve_falls_back_to_heuristic(monkeypatch):
    """When local resolve LLM is unavailable, heuristic maps meta → prior ask."""
    monkeypatch.setenv("BUTLER_LLM_QUERY_RESOLVE", "0")
    prior = [
        {"role": "user", "content": "how do I eat a cake?"},
        {"role": "assistant", "content": "Cake encyclopedia dump…"},
    ]
    rq, is_repair, prior_q = _llm_resolve_effective_user_query(
        "you didn't answer my question", prior
    )
    assert is_repair
    assert prior_q == "how do I eat a cake?"
    assert "didn't answer" not in rq.lower()


def test_llm_resolve_uses_model_when_available(monkeypatch):
    prior = [
        {"role": "user", "content": "how do I restart butler knowledge?"},
        {"role": "assistant", "content": "Here is a long unrelated dump."},
    ]

    def fake_chat(**kwargs):
        return {
            "message": {
                "content": '{"retrieval_query":"how do I restart butler knowledge?","is_repair":true,"skip_retrieval":false}'
            }
        }

    monkeypatch.setenv("BUTLER_LLM_QUERY_RESOLVE", "1")
    monkeypatch.setattr("agent.peepee_chat", fake_chat)
    rq, is_repair, prior_q = _llm_resolve_effective_user_query(
        "you didn't answer my question", prior
    )
    assert is_repair
    assert "restart butler" in rq.lower()
    assert "didn't answer" not in rq.lower()


def test_question_intent_softener_prefix_still_howto():
    assert (
        _question_intent("no sorry I want to know how to bake bread") == "howto"
    )
    assert _question_intent("Just tell me how to restart the API") == "howto"


def test_just_tell_me_how_followup_grounds_on_prior():
    from agent import _looks_like_context_dependent_followup

    prior = [
        {"role": "user", "content": "how do I do X safely?"},
        {"role": "assistant", "content": "Can you provide more details on the silhouette?"},
    ]
    assert _looks_like_context_dependent_followup("Just tell me how to do it")
    rq, is_repair, prior_q = _resolve_effective_user_query(
        "Just tell me how to do it", prior
    )
    assert not is_repair
    assert prior_q == "how do I do X safely?"
    assert "how do I do X safely?" in rq
    assert "Follow-up" in rq


def test_howto_rag_rejects_jobs_feature_memories():
    class FakeStore:
        def count(self):
            return 99

        def search(self, *_a, **_k):
            return [
                {
                    "content": (
                        'User: apply to jobs\n\nAssistant:\n'
                        '{"mode":"jobs_auto_apply","role":"engineer","reply":'
                        '"Which job posting would you like me to auto-apply for?"}'
                    ),
                    "source": "intent",
                    "topic": "jobs_auto_apply",
                    "distance": 0.05,
                },
                {
                    "content": (
                        "User: how do I do X?\n\nAssistant:\n"
                        "Here are clear steps for doing X carefully."
                    ),
                    "source": "chat",
                    "distance": 0.4,
                },
            ]

    ctx = _get_knowledge_context(FakeStore(), "how do I do X?")
    assert ctx
    assert "auto-apply" not in ctx.lower()
    assert "job posting" not in ctx.lower()
    assert "steps for doing X" in ctx


def test_coerce_jobs_mode_away_from_howto_followup():
    from agent import coerce_tool_mode_for_informational_ask

    prior = [
        {"role": "user", "content": "how do I do X?"},
        {"role": "assistant", "content": "Which silhouette should I automate?"},
    ]
    out = coerce_tool_mode_for_informational_ask(
        "Just tell me how to do it",
        {
            "mode": "jobs_auto_apply",
            "role": "engineer",
            "reply": "Which job posting would you like me to auto-apply for?",
        },
        prior,
    )
    assert out["mode"] == "chat"
    assert "job posting" not in (out.get("reply") or "").lower()
    assert out.get("_butler_coerced_from_tool") == "jobs_auto_apply"


def test_informational_qa_host_guard_blocks_tool_routes():
    from semantic_route import apply_host_route_guards, is_informational_qa_turn

    assert is_informational_qa_turn("how do I do X?")
    prior = [
        {"role": "user", "content": "how do I do X?"},
        {"role": "assistant", "content": "Need more silhouette details?"},
    ]
    assert is_informational_qa_turn("Just tell me how to do it", prior)
    guarded = apply_host_route_guards(
        {
            "route": "jobs_auto_apply",
            "confidence": 0.9,
            "clarify": "Which job posting should I auto-apply for?",
            "rationale": "apply",
            "low_confidence": False,
        },
        "Just tell me how to do it",
        prior,
    )
    assert guarded["route"] == "chat"
    assert guarded["clarify"] == ""


def test_feature_hijack_clarify_dropped_for_unrelated_ask():
    from semantic_route import apply_host_route_guards

    guarded = apply_host_route_guards(
        {
            "route": "questions",
            "confidence": 0.5,
            "clarify": "Can you provide more details on the specific silhouette you're looking to automate?",
            "rationale": "unclear",
            "low_confidence": True,
        },
        "how do I restart the knowledge API?",
        None,
    )
    assert guarded["route"] == "chat"
    assert "silhouette" not in (guarded.get("clarify") or "").lower()


def test_offtopic_howto_reply_fails_topic_match():
    from agent import _reply_topically_matches_ask

    assert _reply_topically_matches_ask(
        "how do I restart the butler knowledge api from the repo?",
        "Run npm run dev:restart from the Butler repo to bounce Knowledge on 8765.",
    )
    assert not _reply_topically_matches_ask(
        "how do I restart the butler knowledge api from the repo?",
        "To remove a repository in Ubuntu, use the ppa-purge command.",
    )


def test_butler_json_catalog_reply_is_tool_hijack():
    from agent import _reply_looks_like_tool_hijack

    assert _reply_looks_like_tool_hijack(
        "To execute a task, provide a command in natural language and Butler will provide the JSON payload to accomplish the job."
    )
    assert _reply_looks_like_tool_hijack(
        "To learn how Butler operates, simply refer to the JSON payload which provides you with the tools needed for your task."
    )

