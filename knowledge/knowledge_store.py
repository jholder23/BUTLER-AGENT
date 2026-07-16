"""
Vector store for ingested knowledge.

- Default backend is **auto**: on Python **3.13+** uses JSONL only (Chroma often access-violates).
  On older Pythons, tries Chroma first; on init failure falls back to JSONL.
- Force backend: BUTLER_KNOWLEDGE_BACKEND=chroma | json | auto

KNOWLEDGE_DB_PATH sets the directory (Chroma folder + jsonl file).
"""
from __future__ import annotations

import json
import os
import re
import sys
import threading
import uuid
from abc import ABC, abstractmethod
from typing import Any, Optional

def _knowledge_dir() -> str:
    return os.getenv("KNOWLEDGE_DB_PATH") or os.path.join(os.path.dirname(__file__), "knowledge_db")


CHUNK_SIZE = 500
CHUNK_OVERLAP = 100

_json_lock = threading.Lock()
_impl_singleton_lock = threading.Lock()
_impl_cache: dict[tuple[str, str], _KnowledgeStoreBase] = {}
# stderr should not spam on every backend decision — log once per process.
_PY313_JSONL_NOTICE_EMITTED = False
_CHROMA_FALLBACK_NOTICE_EMITTED = False


def _chunk_text(text: str, size: int = CHUNK_SIZE, overlap: int = CHUNK_OVERLAP) -> list[str]:
    if len(text) <= size:
        return [text] if text.strip() else []
    chunks: list[str] = []
    start = 0
    while start < len(text):
        end = start + size
        chunk = text[start:end]
        if chunk.strip():
            chunks.append(chunk.strip())
        start = end - overlap
    return chunks


def _backend_name() -> str:
    return (os.environ.get("BUTLER_KNOWLEDGE_BACKEND") or "auto").strip().lower()


def _tokens(s: str) -> set[str]:
    return {t for t in re.split(r"[^\w]+", (s or "").lower()) if len(t) > 1}


def _matches_where(meta: dict[str, Any], where: Optional[dict[str, Any]]) -> bool:
    if not where:
        return True
    # Support common Chroma pattern: {"source": {"$in": ["a","b"]}}
    for key, cond in where.items():
        val = meta.get(key, "")
        if isinstance(cond, dict) and "$in" in cond:
            allowed = cond["$in"]
            if val not in allowed:
                return False
        elif val != cond:
            return False
    return True


class _KnowledgeStoreBase(ABC):
    @abstractmethod
    def add(self, content: str, source: str = "", topic: str = "") -> int:
        pass

    @abstractmethod
    def search(self, query: str, n_results: int = 5, where: Optional[dict[str, Any]] = None) -> list:
        pass

    @abstractmethod
    def count(self) -> int:
        pass


class ChromaKnowledgeStore(_KnowledgeStoreBase):
    """Chroma persistent client — lazy-import so `import knowledge_store` never loads chromadb unless used."""

    def __init__(self) -> None:
        import chromadb  # noqa: PLC0415

        os.makedirs(_knowledge_dir(), exist_ok=True)
        self.client = chromadb.PersistentClient(path=_knowledge_dir())
        self.collection = self.client.get_or_create_collection(
            name="knowledge",
            metadata={"hnsw:space": "cosine"},
        )

    def add(self, content: str, source: str = "", topic: str = "") -> int:
        if not content or not content.strip():
            return 0
        chunks = _chunk_text(content)
        if not chunks:
            return 0
        ids = [str(uuid.uuid4()) for _ in chunks]
        metadatas = [{"source": source[:200], "topic": topic[:100]} for _ in chunks]
        self.collection.add(documents=chunks, ids=ids, metadatas=metadatas)
        return len(chunks)

    def search(self, query: str, n_results: int = 5, where: Optional[dict[str, Any]] = None) -> list:
        kwargs: dict[str, Any] = {"query_texts": [query], "n_results": n_results}
        if where:
            kwargs["where"] = where
        results = self.collection.query(**kwargs)
        out: list[dict[str, Any]] = []
        if results and results.get("documents") and results["documents"][0]:
            dist_row = (results.get("distances") or [[]])[0]
            for i, doc in enumerate(results["documents"][0]):
                meta = (results.get("metadatas") or [{}])[0][i] if results.get("metadatas") else {}
                row: dict[str, Any] = {
                    "content": doc,
                    "source": meta.get("source", ""),
                    "topic": meta.get("topic", ""),
                }
                if i < len(dist_row) and dist_row[i] is not None:
                    try:
                        row["distance"] = float(dist_row[i])
                    except (TypeError, ValueError):
                        pass
                out.append(row)
        return out

    def count(self) -> int:
        return self.collection.count()


class JsonLineKnowledgeStore(_KnowledgeStoreBase):
    """
    Append-only JSONL fallback: one object per line {id, content, source, topic}.
    Search = token overlap ranking (no embeddings).
    """

    def __init__(self) -> None:
        os.makedirs(_knowledge_dir(), exist_ok=True)
        self._path = os.path.join(_knowledge_dir(), "knowledge_fallback.jsonl")

    def add(self, content: str, source: str = "", topic: str = "") -> int:
        if not content or not content.strip():
            return 0
        chunks = _chunk_text(content)
        if not chunks:
            return 0
        with _json_lock:
            with open(self._path, "a", encoding="utf-8") as f:
                for ch in chunks:
                    row = {
                        "id": str(uuid.uuid4()),
                        "content": ch,
                        "source": (source or "")[:200],
                        "topic": (topic or "")[:100],
                    }
                    f.write(json.dumps(row, ensure_ascii=False) + "\n")
        return len(chunks)

    def _load_rows(self) -> list[dict[str, Any]]:
        if not os.path.isfile(self._path):
            return []
        out: list[dict[str, Any]] = []
        with _json_lock:
            try:
                with open(self._path, encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            out.append(json.loads(line))
                        except json.JSONDecodeError:
                            continue
            except OSError:
                return []
        return out

    def search(self, query: str, n_results: int = 5, where: Optional[dict[str, Any]] = None) -> list:
        qtok = _tokens(query)
        if not qtok:
            return []
        scored: list[tuple[float, dict[str, Any]]] = []
        for row in self._load_rows():
            meta = {"source": row.get("source", ""), "topic": row.get("topic", "")}
            if not _matches_where(meta, where):
                continue
            doc = (row.get("content") or "").strip()
            if not doc:
                continue
            ctok = _tokens(doc)
            inter = len(qtok & ctok)
            if inter <= 0:
                continue
            score = inter / (1.0 + len(ctok) ** 0.5)
            scored.append((score, row))
        scored.sort(key=lambda x: -x[0])
        out: list[dict[str, Any]] = []
        for score, row in scored[: max(1, n_results)]:
            out.append(
                {
                    "content": row.get("content", ""),
                    "source": row.get("source", ""),
                    "topic": row.get("topic", ""),
                    "distance": 1.0 / (1e-6 + score),
                }
            )
        return out

    def count(self) -> int:
        return len(self._load_rows())


def _store_singleton_key() -> tuple[str, str]:
    """Stable per-process cache key (dir + explicit backend mode)."""
    path = os.path.normcase(os.path.abspath(_knowledge_dir()))
    return (path, _backend_name())


def _make_impl() -> _KnowledgeStoreBase:
    key = _store_singleton_key()
    with _impl_singleton_lock:
        cached = _impl_cache.get(key)
        if cached is not None:
            return cached
        inst = _create_impl_uncached()
        _impl_cache[key] = inst
        return inst


def _create_impl_uncached() -> _KnowledgeStoreBase:
    b = _backend_name()
    if b in ("json", "jsonl", "file"):
        return JsonLineKnowledgeStore()
    if b in ("chroma", "vector"):
        return ChromaKnowledgeStore()
    # auto — Chroma's native extension often access-violates on Python 3.13+; prefer JSONL unless forced.
    if sys.version_info >= (3, 13):
        global _PY313_JSONL_NOTICE_EMITTED
        if not _PY313_JSONL_NOTICE_EMITTED:
            print(
                "[knowledge_store] Python 3.13+: JSONL store (Chroma native layer is unreliable here). "
                "Use Python 3.11-3.12 + BUTLER_KNOWLEDGE_BACKEND=chroma for vectors, or force chroma at your risk.",
                file=sys.stderr,
            )
            _PY313_JSONL_NOTICE_EMITTED = True
        return JsonLineKnowledgeStore()
    try:
        return ChromaKnowledgeStore()
    except Exception as e:
        global _CHROMA_FALLBACK_NOTICE_EMITTED
        if not _CHROMA_FALLBACK_NOTICE_EMITTED:
            print(
                f"[knowledge_store] Chroma init failed ({e!r}); using JSONL fallback. "
                "Set BUTLER_KNOWLEDGE_BACKEND=json to skip Chroma.",
                file=sys.stderr,
            )
            _CHROMA_FALLBACK_NOTICE_EMITTED = True
        return JsonLineKnowledgeStore()


class KnowledgeStore:
    """
    Facade: BUTLER_KNOWLEDGE_BACKEND selects Chroma (vectors) or JSONL (token overlap).
    **auto** uses JSONL on Python 3.13+; on older runtimes tries Chroma then falls back.
    """

    def __init__(self) -> None:
        self._impl = _make_impl()

    def add(self, content: str, source: str = "", topic: str = "") -> int:
        return self._impl.add(content, source=source, topic=topic)

    def search(self, query: str, n_results: int = 5, where: Optional[dict[str, Any]] = None) -> list:
        return self._impl.search(query, n_results=n_results, where=where)

    def count(self) -> int:
        return self._impl.count()
