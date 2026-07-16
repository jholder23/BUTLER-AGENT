"""
Batch "Go learn" job: compact intent examples + web scrape into Chroma for richer offline RAG.
Started from Settings; runs in a daemon thread (safe to leave Butler open overnight).
"""
from __future__ import annotations

import os
import threading
import time
from pathlib import Path

_state_lock = threading.Lock()
_state: dict = {
    "running": False,
    "started_at": None,
    "finished_at": None,
    "topics_total": 0,
    "topics_done": 0,
    "chunks_added": 0,
    "current_topic": "",
    "last_error": "",
    "stage": "idle",
}


def get_overnight_learn_status() -> dict:
    with _state_lock:
        out = {**_state}
    try:
        from knowledge_store import KnowledgeStore

        out["chroma_chunks_total"] = KnowledgeStore().count()
    except Exception:
        out["chroma_chunks_total"] = None
    return out


def start_overnight_learn() -> tuple[bool, str]:
    with _state_lock:
        if _state["running"]:
            return False, "A learn run is already in progress."
        _state["running"] = True
        _state["started_at"] = time.time()
        _state["finished_at"] = None
        _state["topics_total"] = 0
        _state["topics_done"] = 0
        _state["chunks_added"] = 0
        _state["current_topic"] = ""
        _state["last_error"] = ""
        _state["stage"] = "starting"
    threading.Thread(target=_run_overnight_learn, daemon=True).start()
    return True, "Learn run started in the background. You can leave Butler open; check status below."


def _load_topic_list() -> list[str]:
    base = Path(__file__).resolve().parent
    topics: list[str] = []
    path = base / "learn_topics.txt"
    if path.is_file():
        try:
            for line in path.read_text(encoding="utf-8").splitlines():
                t = line.strip()
                if t and not t.startswith("#"):
                    topics.append(t)
        except OSError:
            pass
    try:
        from ingester import SEED_TOPICS

        for t in SEED_TOPICS:
            if t not in topics:
                topics.append(t)
    except ImportError:
        pass
    seen: set[str] = set()
    out: list[str] = []
    for t in topics:
        k = t.lower()
        if k in seen:
            continue
        seen.add(k)
        out.append(t)
    return out


def _run_overnight_learn() -> None:
    chunks_start = 0
    stage_failed = False
    try:
        from knowledge_store import KnowledgeStore

        store = KnowledgeStore()
        chunks_start = store.count()

        with _state_lock:
            _state["stage"] = "compacting"

        if os.environ.get("BUTLER_HEAVY_LEARNING", "1").strip().lower() not in ("0", "false", "no", "off"):
            try:
                from training_journal import compact_intents_to_auto_examples

                compact_intents_to_auto_examples(
                    max_examples=int(os.environ.get("BUTLER_AUTO_INTENT_MAX", "40").strip() or "40")
                )
            except Exception as e:
                with _state_lock:
                    _state["last_error"] = str(e)[:400]

        topics = _load_topic_list()
        max_topics = int(os.environ.get("BUTLER_LEARN_MAX_TOPICS", "120").strip() or "120")
        max_topics = max(1, min(max_topics, 500))
        topics = topics[:max_topics]

        with _state_lock:
            _state["topics_total"] = len(topics)
            _state["stage"] = "ingesting"

        from web_fetcher import fetch_page, search_web

        n_results = int(os.environ.get("BUTLER_LEARN_RESULTS_PER_TOPIC", "5").strip() or "5")
        n_results = max(1, min(n_results, 12))
        delay = float(os.environ.get("BUTLER_LEARN_DELAY_SEC", "3").strip() or "3")
        delay = max(0.5, min(delay, 120.0))

        use_llm = os.environ.get("BUTLER_LEARN_USE_LOCAL_LLM", "0").strip().lower() in ("1", "true", "yes", "on")
        llm_cap = int(os.environ.get("BUTLER_LEARN_LLM_TOPICS", "24").strip() or "24")
        llm_cap = max(0, min(llm_cap, 100))

        for i, topic in enumerate(topics):
            with _state_lock:
                _state["current_topic"] = topic[:200]

            try:
                header = f"[Go learn batch: {topic[:120]}]\n\n"
                results = search_web(topic, max_results=n_results)
                for r in results:
                    url = r.get("url") or r.get("href") or ""
                    if not url:
                        continue
                    title = r.get("title") or ""
                    snippet = r.get("snippet") or r.get("body") or r.get("description") or ""
                    text = fetch_page(url)
                    combined = f"{title}\n\n{snippet}\n\n{text}" if snippet else text
                    if len(combined) > 100 and not combined.startswith("[Fetch error"):
                        store.add(
                            header + combined[:4000],
                            source=(url[:180] if url else "web")[:200],
                            topic=topic[:100],
                        )
            except Exception as e:
                with _state_lock:
                    _state["last_error"] = str(e)[:400]

            with _state_lock:
                _state["chunks_added"] = store.count() - chunks_start
                _state["topics_done"] = i + 1

            time.sleep(delay)

        with _state_lock:
            _state["topics_done"] = len(topics)

        if use_llm and llm_cap > 0:
            with _state_lock:
                _state["stage"] = "local_llm"
            try:
                from config import LOCAL_MODEL
                from peepee_ai import chat as peepee_chat
            except ImportError:
                peepee_chat = None  # type: ignore
            if peepee_chat:
                for topic in topics[:llm_cap]:
                    with _state_lock:
                        _state["current_topic"] = f"(local LLM) {topic[:160]}"
                    try:
                        r = peepee_chat(
                            messages=[
                                {"role": "system", "content": "Provide concise, factual knowledge. No preamble."},
                                {"role": "user", "content": f"Provide key factual information about: {topic}"},
                            ],
                            model=LOCAL_MODEL,
                        )
                        data = ((r.get("message") or {}).get("content") or "").strip()
                        if len(data) > 50:
                            store.add(data, source="go_learn_llm", topic=topic[:100])
                    except Exception as e:
                        with _state_lock:
                            _state["last_error"] = str(e)[:400]
                    with _state_lock:
                        _state["chunks_added"] = store.count() - chunks_start
                    time.sleep(delay)

    except Exception as e:
        stage_failed = True
        with _state_lock:
            _state["last_error"] = str(e)[:500]
            _state["stage"] = "failed"
    finally:
        try:
            from knowledge_store import KnowledgeStore

            final_count = KnowledgeStore().count()
        except Exception:
            final_count = chunks_start
        with _state_lock:
            _state["running"] = False
            _state["finished_at"] = time.time()
            _state["current_topic"] = ""
            _state["chunks_added"] = max(0, final_count - chunks_start)
            if not stage_failed and _state.get("stage") != "failed":
                _state["stage"] = "idle"
