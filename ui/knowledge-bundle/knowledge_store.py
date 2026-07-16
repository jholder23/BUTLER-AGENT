"""
Vector store for ingested knowledge. Uses ChromaDB for semantic search.
KNOWLEDGE_DB_PATH env sets database location (used by Code Helper Studio).
"""
import os
import uuid
import chromadb

KNOWLEDGE_DIR = os.getenv("KNOWLEDGE_DB_PATH") or os.path.join(os.path.dirname(__file__), "knowledge_db")
CHUNK_SIZE = 500
CHUNK_OVERLAP = 100


def _chunk_text(text: str, size: int = CHUNK_SIZE, overlap: int = CHUNK_OVERLAP) -> list:
    if len(text) <= size:
        return [text] if text.strip() else []
    chunks = []
    start = 0
    while start < len(text):
        end = start + size
        chunk = text[start:end]
        if chunk.strip():
            chunks.append(chunk.strip())
        start = end - overlap
    return chunks


class KnowledgeStore:
    def __init__(self):
        os.makedirs(KNOWLEDGE_DIR, exist_ok=True)
        self.client = chromadb.PersistentClient(path=KNOWLEDGE_DIR)
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

    def search(self, query: str, n_results: int = 5) -> list:
        results = self.collection.query(query_texts=[query], n_results=n_results)
        out = []
        if results and results.get("documents") and results["documents"][0]:
            for i, doc in enumerate(results["documents"][0]):
                meta = (results.get("metadatas") or [{}])[0][i] if results.get("metadatas") else {}
                out.append({
                    "content": doc,
                    "source": meta.get("source", ""),
                    "topic": meta.get("topic", ""),
                })
        return out

    def count(self) -> int:
        return self.collection.count()
