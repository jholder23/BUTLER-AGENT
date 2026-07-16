"""
Autonomous ingester: consumes data from web + PEEPEEDEE AI. Runs continuously. No OpenAI, no Ollama.
"""
import time
from config import LOCAL_MODEL
from knowledge_store import KnowledgeStore
from peepee_ai import chat as peepee_chat
from web_fetcher import search_web, fetch_page

SEED_TOPICS = [
    "key concepts in machine learning",
    "world history summary",
    "science discoveries 2024",
    "programming best practices",
    "philosophy basics",
    "economics fundamentals",
    "geography facts",
    "human biology overview",
]


class AutonomousIngester:
    def __init__(self):
        self.store = KnowledgeStore()
        self.seen_urls = set()
        self.seen_topics = set()

    def _fetch_from_ai(self, query: str) -> str:
        try:
            r = peepee_chat(
                messages=[
                    {"role": "system", "content": "Provide concise, factual knowledge. No preamble."},
                    {"role": "user", "content": query},
                ],
                model=LOCAL_MODEL,
            )
            return ((r.get("message") or {}).get("content") or "").strip()
        except Exception as e:
            print(f"  [AI error: {e}]")
            return ""

    def _expand_topics(self, current_topic: str) -> list:
        try:
            r = peepee_chat(
                messages=[
                    {"role": "system", "content": "List 3 specific sub-topics. One per line, no numbers."},
                    {"role": "user", "content": f"Given '{current_topic}', suggest 3 related topics."},
                ],
                model=LOCAL_MODEL,
            )
            text = ((r.get("message") or {}).get("content") or "").strip()
            return [t.strip() for t in text.split("\n") if t.strip() and len(t.strip()) > 5][:3]
        except Exception:
            return []

    def ingest_topic(self, topic: str) -> int:
        added = 0
        results = search_web(topic, max_results=4)
        for r in results:
            url = r.get("url", "")
            if not url or url in self.seen_urls:
                continue
            self.seen_urls.add(url)
            title, snippet = r.get("title", ""), r.get("snippet", "")
            text = fetch_page(url)
            combined = f"{title}\n\n{snippet}\n\n{text}" if snippet else text
            if len(combined) > 100 and not combined.startswith("[Fetch error"):
                n = self.store.add(combined, source=url, topic=topic)
                added += n
                if n:
                    print(f"    + {n} chunks from {url[:50]}...")
        if topic not in self.seen_topics:
            self.seen_topics.add(topic)
            data = self._fetch_from_ai(f"Provide key factual information about: {topic}")
            if len(data) > 50:
                n = self.store.add(data, source="pepee_ai", topic=topic)
                added += n
                if n:
                    print(f"    + {n} chunks from PEEPEEDEE AI")
        return added

    def run(self, cycles: int = 999, delay_sec: float = 2.0):
        topics = list(SEED_TOPICS)
        cycle = 0
        print("Starting ingestion. Ctrl+C to stop.")
        print(f"Knowledge store: {self.store.count()} chunks")
        while cycle < cycles:
            if not topics:
                topics = list(SEED_TOPICS)
            topic = topics.pop(0)
            print(f"\n[{cycle + 1}] {topic[:60]}...")
            self.ingest_topic(topic)
            new_topics = self._expand_topics(topic)
            for t in new_topics:
                if t.lower() not in {x.lower() for x in topics}:
                    topics.append(t)
            cycle += 1
            print(f"    Total: {self.store.count()} chunks")
            time.sleep(delay_sec)
