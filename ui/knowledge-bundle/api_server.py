"""
Bundled Knowledge API for Code Helper Studio.
Uses KNOWLEDGE_DB_PATH env for database location (set by Electron).
"""
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:
    from flask import Flask, request, jsonify
    HAS_FLASK = True
except ImportError:
    HAS_FLASK = False

try:
    from knowledge_store import KnowledgeStore
except ImportError:
    KnowledgeStore = None

app = Flask(__name__) if HAS_FLASK else None


def get_knowledge(q: str, n: int = 5) -> list[dict]:
    if not KnowledgeStore:
        return []
    store = KnowledgeStore()
    if store.count() == 0:
        return []
    return store.search(q, n_results=n)


if HAS_FLASK:
    @app.route("/knowledge")
    def knowledge():
        q = request.args.get("q", "").strip()
        n = min(20, max(1, int(request.args.get("n", 5))))
        if not q:
            return jsonify({"error": "Missing ?q=query"}), 400
        results = get_knowledge(q, n)
        return jsonify({"results": results})

    @app.route("/count")
    def count():
        if not KnowledgeStore:
            return jsonify({"count": 0})
        return jsonify({"count": KnowledgeStore().count()})
else:
    app = None


def main():
    if not HAS_FLASK:
        return
    if not KnowledgeStore:
        return
    port = 8765
    app.run(host="127.0.0.1", port=port, debug=False, use_reloader=False)


if __name__ == "__main__":
    main()
