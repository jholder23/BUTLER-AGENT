"""Focused tests for agent todos, final-reply synthesis, and auto_free cascade."""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from agent_llm import build_fallback_chain, list_agent_providers  # noqa: E402
from butler_agent import (  # noqa: E402
    CONTINUE_WORK_NUDGE,
    advance_todos_after_tool,
    apply_todo_updates,
    checklist_continue_nudge,
    finalize_todos,
    is_premature_act_final,
    looks_like_clarifying_or_blocker,
    looks_like_intent_to_act,
    normalize_todos,
    seed_todos_from_goal,
    should_continue_for_incomplete_checklist,
    strip_final_envelope,
    synthesize_final_reply,
    todos_have_open_items,
)


def test_build_fallback_chain_auto_free():
    chain = build_fallback_chain("auto_free")
    assert chain[0] == "gemini"
    assert chain[-1] == "local"
    assert "groq" in chain
    assert build_fallback_chain("cascade") == chain
    assert build_fallback_chain("local") == ["local"]
    assert build_fallback_chain("groq")[0] == "groq"
    assert build_fallback_chain("groq")[-1] == "local"


def test_list_providers_includes_auto_free():
    ids = [p["id"] for p in list_agent_providers()]
    assert ids[0] == "auto_free"
    assert "local" in ids
    assert "gemini" in ids


def test_normalize_and_apply_todos():
    todos = normalize_todos(
        [
            {"id": "1", "content": "Scan", "status": "in_progress"},
            "Implement fix",
            {"id": "x", "content": "", "status": "pending"},
        ]
    )
    assert len(todos) == 2
    assert todos[0]["status"] == "in_progress"
    assert todos[1]["id"] == "2"

    updated = apply_todo_updates(
        todos,
        updates=[{"id": "1", "status": "completed"}, {"id": "2", "status": "in_progress"}],
    )
    assert updated[0]["status"] == "completed"
    assert updated[1]["status"] == "in_progress"


def test_seed_and_advance_todos():
    seeded = seed_todos_from_goal("fix the crash in AgentWindow")
    assert seeded and seeded[0]["status"] == "in_progress"
    after = advance_todos_after_tool(seeded, "edit_file")
    assert after[0]["status"] == "completed"
    assert any(t["status"] == "in_progress" for t in after)


def test_finalize_and_synthesize_reply():
    todos = seed_todos_from_goal("add a settings panel")
    done = finalize_todos(todos, success=True)
    assert all(t["status"] in ("completed", "cancelled") for t in done)

    steps = [
        {
            "type": "tool",
            "tool": "edit_file",
            "result": {"ok": True, "path": "ui/src/AgentWindow.tsx"},
        },
        {
            "type": "tool",
            "tool": "run_shell",
            "result": {"ok": True, "stdout": "build ok\n"},
        },
    ]
    reply = synthesize_final_reply("add settings", steps)
    assert "edit_file" in reply or "ran" in reply.lower()
    assert len(reply) > 20

    empty = synthesize_final_reply("do something vague", [])
    assert "?" in empty or "clarify" in empty.lower() or "detail" in empty.lower()


def test_strip_final_envelope():
    assert strip_final_envelope('{"final":"Hello there"}') == "Hello there"
    assert strip_final_envelope("Plain reply") == "Plain reply"
    assert "implement" in strip_final_envelope(
        '{"final":"I will fully implement this. Let me make these updates now."}'
    )


def test_premature_act_final_detection():
    promise = "I will fully implement the changes. Let me make these updates now."
    assert looks_like_intent_to_act(promise)
    assert is_premature_act_final(promise, [])
    assert is_premature_act_final(promise, [{"type": "tool", "tool": "manage_todos"}])
    assert is_premature_act_final(
        promise, [{"type": "tool", "tool": "read_file", "result": {"ok": True}}]
    )
    assert not is_premature_act_final(
        promise,
        [{"type": "tool", "tool": "edit_file", "result": {"ok": True, "path": "a.ts"}}],
    )
    assert not looks_like_intent_to_act("Updated AgentWindow and restarted the stack.")
    assert CONTINUE_WORK_NUDGE.startswith("You said you would make changes")
    assert "tool" in CONTINUE_WORK_NUDGE.lower()


def test_incomplete_todos_keep_looping():
    open_todos = [
        {"id": "1", "content": "Scan workspace", "status": "completed"},
        {"id": "2", "content": "Apply fix", "status": "in_progress"},
        {"id": "3", "content": "Verify build", "status": "pending"},
    ]
    assert todos_have_open_items(open_todos)
    # Premature "done" with open checklist → keep looping
    assert should_continue_for_incomplete_checklist(
        "All done — fixed the crash and verified.", open_todos
    )
    # Clarifying question → allow ending
    assert looks_like_clarifying_or_blocker("Which approach should I use for the fix?")
    assert not should_continue_for_incomplete_checklist(
        "Which approach should I use for the fix?", open_todos
    )
    # Hard blocker → allow ending
    assert looks_like_clarifying_or_blocker(
        "Blocked: missing deploy API key, cannot proceed."
    )
    assert not should_continue_for_incomplete_checklist(
        "Blocked: missing deploy API key, cannot proceed.", open_todos
    )
    # Intent-to-act is not a clarifying question even with "?"
    assert looks_like_intent_to_act("Let me implement the changes now?")
    assert not looks_like_clarifying_or_blocker("Let me implement the changes now?")

    done = [
        {"id": "1", "content": "Scan", "status": "completed"},
        {"id": "2", "content": "Apply", "status": "cancelled"},
    ]
    assert not todos_have_open_items(done)
    assert not should_continue_for_incomplete_checklist("Finished the request.", done)

    nudge = checklist_continue_nudge(open_todos)
    assert nudge.startswith("Checklist incomplete:")
    assert "Continue with tools until all items are completed or cancelled" in nudge
    assert "2 (in_progress)" in nudge
    assert "3 (pending)" in nudge


def test_checklist_continue_end_conditions_matrix():
    """Exact end-condition matrix for incomplete-checklist looping."""
    todos = [
        {"id": "1", "content": "A", "status": "completed"},
        {"id": "2", "content": "B", "status": "pending"},
    ]
    # End only when: all completed/cancelled OR clarify/blocker OR (budget handled by caller)
    assert should_continue_for_incomplete_checklist("Summary of work done.", todos) is True
    assert should_continue_for_incomplete_checklist("Could you confirm the target path?", todos) is False
    assert should_continue_for_incomplete_checklist("Hard stop — waiting for your decision.", todos) is False
    closed = [{"id": "1", "content": "A", "status": "completed"}, {"id": "2", "content": "B", "status": "completed"}]
    assert should_continue_for_incomplete_checklist("Summary of work done.", closed) is False


def test_run_loop_keeps_going_on_incomplete_checklist(monkeypatch, tmp_path):
    """Integration: premature final with open todos injects continue nudge, not Finished."""
    import butler_agent as ba

    class _Out:
        def __init__(self, content: str):
            self.content = content
            self.source_label = "Agent · test"
            self.model = "test-model"
            self.provider = "local"

    responses = [
        json.dumps(
            {
                "tool": "manage_todos",
                "args": {
                    "todos": [
                        {"id": "1", "content": "Scan", "status": "completed"},
                        {"id": "2", "content": "Edit", "status": "in_progress"},
                        {"id": "3", "content": "Verify", "status": "pending"},
                    ]
                },
            }
        ),
        # Premature "done" while checklist open — must not end the run.
        json.dumps({"final": "All finished — the bug is fixed."}),
        # After checklist nudge: close remaining items.
        json.dumps(
            {
                "tool": "manage_todos",
                "args": {
                    "updates": [
                        {"id": "2", "status": "completed"},
                        {"id": "3", "status": "completed"},
                    ]
                },
            }
        ),
        json.dumps({"final": "Closed the remaining checklist items and finished."}),
    ]
    idx = {"n": 0}
    seen_nudge = {"ok": False}

    def fake_chat(msgs, **_kwargs):
        # Detect checklist continue nudge in prior user messages
        for m in msgs:
            if m.get("role") == "user" and "Checklist incomplete:" in str(m.get("content") or ""):
                seen_nudge["ok"] = True
        i = idx["n"]
        idx["n"] += 1
        return _Out(responses[min(i, len(responses) - 1)])

    monkeypatch.setenv("BUTLER_AGENT_MAX_ITERATIONS", "8")
    monkeypatch.setattr(ba, "agent_llm_chat", fake_chat)
    monkeypatch.setattr(ba, "peepee_chat", None)
    monkeypatch.setattr(ba, "write_agent_status", lambda *a, **k: None)
    monkeypatch.setattr(ba, "create_checkpoint", lambda *a, **k: {"checkpoint_id": "cp-test"})
    monkeypatch.setattr(ba, "_ingest_agent_learning", lambda *a, **k: 0)
    monkeypatch.setattr(ba, "_log_agent", lambda *a, **k: None)
    monkeypatch.setattr(ba, "_log_agent_session", lambda *a, **k: None)

    out = ba.run_agent_loop(
        "fix the crash in AgentWindow",
        str(tmp_path),
        force=True,
        provider="local",
        run_id="test-checklist-loop",
    )
    assert seen_nudge["ok"], "expected Checklist incomplete nudge to be injected"
    assert out.get("needs_continue") is not True
    assert any(s.get("type") == "continue" and "checklist" in str(s.get("activity") or "").lower() for s in (out.get("agent_steps") or []))
    # Only one user-facing final step type at end (plus continue steps), not spam finals mid-run
    finals = [s for s in (out.get("agent_steps") or []) if s.get("type") == "final"]
    assert len(finals) == 1
    todos = out.get("todos") or []
    assert todos and not ba.todos_have_open_items(todos)
    assert "finished" in str(out.get("reply") or "").lower() or "closed" in str(out.get("reply") or "").lower()
