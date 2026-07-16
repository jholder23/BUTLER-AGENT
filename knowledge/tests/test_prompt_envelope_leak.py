"""Regression: never surface JSON-repair / code_workspace prompt echoes as chat replies."""

from __future__ import annotations

import agent
from agent import (
    _looks_like_prompt_envelope_leak,
    _pick_chat_reply_from_model_raws,
    _usable_chat_text_from_model_raw,
)


_LEAK_PAYLOAD = """{
    "previous_model_output_excerpt": "{\\n    \\"code_ide\\": {\\n       \\"messages_outgoing_background\\": [\\n          {\\n             \\"#\\": \\"Setup (human + Butler): Install the Cursor CLI from Cursor\\\\u2019s docs\\",\\n             \\"body\\": \\"run agent login\\"\\n          }\\n       ]\\n    }\\n}",
    "parsed_mode_if_any": null,
    "code_workspace_background": "Setup (human + Butler): Install the Cursor CLI from Cursor's docs, run agent login once in a normal terminal. In Butler → Settings, set Global project root to the same repo folder you open in Cursor so run_command cwd matches your workspace."
}"""


def test_detects_previous_model_output_excerpt_leak() -> None:
    assert _looks_like_prompt_envelope_leak(_LEAK_PAYLOAD)
    assert agent._local_llm_unusable_reply(_LEAK_PAYLOAD)


def test_detects_code_ide_cursor_cli_blob() -> None:
    blob = (
        '{\n  "code_ide": {\n    "messages_outgoing_background": [\n'
        '      {"#": "Setup (human + Butler): Install the Cursor CLI"}\n'
        "    ]\n  }\n}"
    )
    assert _looks_like_prompt_envelope_leak(blob)


def test_normal_chat_reply_is_not_a_leak() -> None:
    ok = (
        "Taking that much MDMA at once is far above common recreational doses and is "
        "dangerous — risk of overheating, serotonin syndrome, and other acute harm. "
        "If someone already took it, seek emergency care."
    )
    assert not _looks_like_prompt_envelope_leak(ok)
    assert not agent._local_llm_unusable_reply(ok)


def test_pick_prefers_plain_text_over_repair_echo() -> None:
    plain = (
        "At ~1.7 g, that is a very high dose. Expect severe toxicity risk; "
        "this is not a safe amount. Harm-reduction: do not redose, cool down, "
        "and get medical help if overheating or seizure occurs."
    )
    got = _pick_chat_reply_from_model_raws(plain, _LEAK_PAYLOAD)
    assert got == plain
    assert "code_workspace_background" not in got
    assert "previous_model_output_excerpt" not in got


def test_usable_raw_rejects_envelope_and_keeps_butler_chat_json() -> None:
    assert _usable_chat_text_from_model_raw(_LEAK_PAYLOAD) == ""
    wrapped = '{"mode":"chat","reply":"Hello - how can I help?"}'
    assert _usable_chat_text_from_model_raw(wrapped) == "Hello - how can I help?"


def test_finalize_clears_prompt_envelope_leak(monkeypatch) -> None:
    monkeypatch.setattr(agent, "_is_short_social_message", lambda *_a, **_k: True)
    out = agent._finalize_chat_with_web_fallback(
        {"mode": "chat", "reply": _LEAK_PAYLOAD},
        "hi",
        store=None,
        local_only=True,
    )
    reply = out.get("reply") or ""
    assert "previous_model_output_excerpt" not in reply
    assert "code_workspace_background" not in reply
    assert "messages_outgoing_background" not in reply


def test_learn_rejects_prompt_envelope_leak() -> None:
    class _FakeStore:
        def add(self, *_a, **_k):
            raise AssertionError("must not learn prompt envelope leaks")

        def search(self, *_a, **_k):
            return []

    n = agent._learn_good_chat_answer(
        _FakeStore(),
        "what would happen if I took 1.7 G of MDMA at one time",
        _LEAK_PAYLOAD,
    )
    assert n == 0
