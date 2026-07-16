"""BUTLER_KNOWLEDGE_BACKEND=json / JsonLineKnowledgeStore behavior."""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

import pytest

import knowledge_store as ks


@pytest.fixture
def json_store_dir(monkeypatch):
    with tempfile.TemporaryDirectory() as td:
        monkeypatch.setenv("KNOWLEDGE_DB_PATH", td)
        monkeypatch.setenv("BUTLER_KNOWLEDGE_BACKEND", "json")
        p = Path(td) / "knowledge_fallback.jsonl"
        yield td, p
        # temp dir removed by context


def test_json_backend_add_and_search(json_store_dir, monkeypatch):
    monkeypatch.setenv("BUTLER_KNOWLEDGE_BACKEND", "json")
    td, path = json_store_dir
    store = ks.KnowledgeStore()
    assert store.count() == 0
    n = store.add("Paris is the capital of France for geography tests.", source="test", topic="geo")
    assert n >= 1
    assert path.is_file()
    hits = store.search("capital France", n_results=3)
    assert hits, "expected token-overlap hit"
    assert "Paris" in hits[0]["content"]


def test_json_where_in_filter(json_store_dir, monkeypatch):
    monkeypatch.setenv("BUTLER_KNOWLEDGE_BACKEND", "json")
    store = ks.KnowledgeStore()
    store.add("alpha intent line", source="intent", topic="t1")
    store.add("beta chat line", source="chat", topic="t2")
    only_intent = store.search("alpha beta", n_results=5, where={"source": {"$in": ["intent"]}})
    assert len(only_intent) == 1
    assert "alpha" in only_intent[0]["content"]


def test_store_impl_is_singleton_per_path(json_store_dir, monkeypatch):
    monkeypatch.setenv("BUTLER_KNOWLEDGE_BACKEND", "json")
    td, _ = json_store_dir
    _ = td
    a = ks.KnowledgeStore()
    b = ks.KnowledgeStore()
    a.add("singleton share check paris france capital", source="test", topic="t")
    assert b.count() == a.count()


def test_auto_uses_json_on_python_313(monkeypatch):
    """On 3.13+, auto backend must not load Chroma (Rust layer often AVs on add)."""
    import sys

    if sys.version_info < (3, 13):
        pytest.skip("only relevant on Python 3.13+")
    monkeypatch.delenv("BUTLER_KNOWLEDGE_BACKEND", raising=False)
    with tempfile.TemporaryDirectory() as td:
        monkeypatch.setenv("KNOWLEDGE_DB_PATH", td)
        store = ks.KnowledgeStore()
        store.add("line for py313 auto path", source="chat", topic="t")
        jpath = Path(td) / "knowledge_fallback.jsonl"
        assert jpath.is_file(), "auto on 3.13 should use JSONL"
