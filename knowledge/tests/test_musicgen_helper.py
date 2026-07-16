"""MusicGen duration / one-shot heuristics (no torch)."""

from __future__ import annotations

import pytest


@pytest.fixture(scope="module")
def mg():
    from musicgen_helper import (
        _parse_seconds_from_prompt,
        _prompt_suggests_one_shot_or_sparse_mix,
        _resolve_duration_sec,
    )

    return _parse_seconds_from_prompt, _prompt_suggests_one_shot_or_sparse_mix, _resolve_duration_sec


def test_parse_seconds(mg):
    parse, _, _ = mg
    assert parse("hold for 3 seconds") == 3.0
    assert parse("1.5s clip") == 1.5
    assert parse("no timing here") is None


def test_one_shot_heuristic_dubstep_wub(mg):
    _, shot, _ = mg
    assert shot("classic deep dubstep wub just the bass sample no drums or any other layers")


def test_resolve_duration_api_wins(mg):
    _, _, resolve = mg
    assert resolve("anything", 6.0) == 6.0
    assert resolve("anything", 0.25) == 0.5  # clamp min


def test_resolve_duration_from_text_before_heuristic(mg):
    _, _, resolve = mg
    assert resolve("bass only no drums for 5 seconds", None) == 5.0


def test_resolve_duration_one_shot_default(mg):
    _, _, resolve = mg
    assert resolve("just the bass no drums", None) == 2.0


def test_resolve_duration_env_default(monkeypatch, mg):
    _, _, resolve = mg
    monkeypatch.setenv("BUTLER_MUSICGEN_DURATION", "10")
    assert resolve("full orchestral cinematic score epic", None) == 10.0
