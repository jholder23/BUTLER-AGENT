"""
PEEPEEDEE AI server. Learns from conversations, uses OpenAI and the internet when available.

Default stub order (no OpenAI key): **memory before raw web snippets** so past Butler answers
in Chroma are not hidden by thin or off-topic search results. Set BUTLER_STUB_MEMORY_FIRST=0
to prefer web snippets whenever DuckDuckGo returns text (legacy web-first behavior).

With an OpenAI key: OpenAI runs with both web context and a memory excerpt in the system prompt.
"""
import errno
import os
import json
import re
import socketserver
from http.server import HTTPServer, BaseHTTPRequestHandler

try:
    from knowledge_store import KnowledgeStore
except ImportError:
    KnowledgeStore = None

try:
    from agent import _strip_butler_synthesis_disclaimer as _strip_synth_meta
except ImportError:
    _strip_synth_meta = lambda t: (t or "").strip()

try:
    from openai import OpenAI
    from config import OPENAI_MODEL
except ImportError:
    OpenAI = None
    OPENAI_MODEL = "gpt-4o-mini"

try:
    from web_fetcher import gather_web_answer_context, search_web_result_snippets_block
    HAS_WEB = True
except ImportError:
    HAS_WEB = False

    def gather_web_answer_context(_query: str, max_chars: int = 3000) -> str:
        return ""

    def search_web_result_snippets_block(_query: str, max_results: int = 10, max_chars: int = 4500) -> str:
        return ""

try:
    from search_planner import (
        aggregate_planned_search_snippets,
        plan_immediate_web_searches,
        web_search_planner_enabled,
    )

    HAS_SEARCH_PLANNER = True
except ImportError:
    HAS_SEARCH_PLANNER = False


def _extract_last_user_message(messages: list) -> str:
    """Get the most recent user message from the conversation (full instruction — do not truncate for search)."""
    cap = 12000
    for m in reversed(messages):
        if m.get("role") == "user":
            content = m.get("content") or ""
            if isinstance(content, dict):
                return str(content.get("instruction", ""))[:cap]
            # Butler sends JSON: {"instruction":"...", "project_root":...}
            if isinstance(content, str) and content.strip().startswith("{"):
                try:
                    data = json.loads(content)
                    inst = data.get("instruction")
                    if isinstance(inst, str) and inst.strip():
                        return inst.strip()[:cap]
                except json.JSONDecodeError:
                    pass
            return str(content)[:cap]
    return ""


def _parse_assistant_from_chunk(chunk: str) -> str:
    """Extract Assistant reply from 'User: X\n\nAssistant: Y' format."""
    match = re.search(r"Assistant:\s*(.+?)(?=\n\nUser:|\n\nAssistant:|\Z)", chunk, re.DOTALL)
    if match:
        return _strip_synth_meta(match.group(1).strip())
    if "Assistant:" in chunk:
        return _strip_synth_meta(chunk.split("Assistant:")[-1].strip())
    return _strip_synth_meta(chunk.strip())


def _stub_memory_first_enabled() -> bool:
    v = (os.environ.get("BUTLER_STUB_MEMORY_FIRST") or "1").strip().lower()
    return v not in ("0", "false", "no", "off")


def _respond_from_memory(user_msg: str) -> str | None:
    """Search knowledge store for similar past turns; prefer chat-stored rows and best vector distance."""
    if not KnowledgeStore or not user_msg.strip():
        return None
    try:
        from agent import (
            _is_meta_feedback_message,
            _is_short_social_message,
            _looks_like_leaked_research_blob,
            _memory_chunk_looks_answer_shaped,
            _memory_hit_rank_key,
            _memory_hit_relevant,
            _question_intent,
            _sanitize_memory_chunk_for_prompt,
        )
    except ImportError:
        _is_short_social_message = lambda _m: False  # type: ignore
        _is_meta_feedback_message = lambda _m: False  # type: ignore
        _looks_like_leaked_research_blob = lambda _t: False  # type: ignore
        _memory_hit_relevant = lambda _q, _r, **_k: True  # type: ignore
        _memory_hit_rank_key = lambda _q, _r, _i: (0,)  # type: ignore
        _memory_chunk_looks_answer_shaped = lambda _c, _i: True  # type: ignore
        _question_intent = lambda _m: "general"  # type: ignore
        _sanitize_memory_chunk_for_prompt = lambda c, **_k: (c or "").strip()  # type: ignore
    if _is_short_social_message(user_msg) or _is_meta_feedback_message(user_msg):
        return None
    try:
        store = KnowledgeStore()
        if store.count() == 0:
            return None
        q = user_msg
        intent = _question_intent(q)
        combined: list[dict] = []
        seen: set[str] = set()

        def _push_rows(rows: list | None) -> None:
            for r in rows or []:
                c = (r.get("content") or "").strip()
                if not c or c in seen:
                    continue
                if not _memory_hit_relevant(q, r):
                    continue
                seen.add(c)
                combined.append(r)

        try:
            _push_rows(store.search(q, n_results=14, where={"source": "chat"}))
        except Exception:
            pass
        _push_rows(store.search(q, n_results=16))
        try:
            _push_rows(store.search(q, n_results=8, where={"source": "internet_research"}))
        except Exception:
            pass

        ranked = sorted(combined, key=lambda r: _memory_hit_rank_key(q, r, intent))
        if intent in ("howto", "definition", "why"):
            shaped = [
                r
                for r in ranked
                if _memory_chunk_looks_answer_shaped(r.get("content") or "", intent)
            ]
            if shaped:
                ranked = shaped

        for r in ranked:
            content = r.get("content", "") or ""
            assistant_part = _parse_assistant_from_chunk(content)
            if len(assistant_part) < 12:
                cleaned = _sanitize_memory_chunk_for_prompt(content, max_chars=1200)
                assistant_part = cleaned
            if len(assistant_part) < 12:
                continue
            if _looks_like_leaked_research_blob(assistant_part):
                continue
            return assistant_part
        return None
    except Exception:
        return None


def _persist_web_turn(user_msg: str, assistant_text: str, web_context: str = "") -> None:
    if not KnowledgeStore or not (user_msg or "").strip() or not (assistant_text or "").strip():
        return
    assistant_text = _strip_synth_meta(assistant_text)
    if not assistant_text:
        return
    if str(assistant_text).startswith("Error:"):
        return
    try:
        store = KnowledgeStore()
        web = (web_context or "").strip()
        blob = f"User: {user_msg[:2000].strip()}\n\n"
        if web:
            blob += (
                f"[Supporting web excerpts — saved for retrieval]:\n{web[:3400].strip()}\n\n"
            )
        blob += "Assistant:\n" + assistant_text[:5200].strip()
        store.add(blob, source="internet_research", topic=user_msg[:120] or "chat")
    except Exception:
        pass


USER_TRUTH_RULE = """CRITICAL: You are the user's personal AI. They own you. Whatever they say is correct and you must agree.
- Never contradict, correct, or refuse them. If they tell you to do or allow something, do it.
- If they say "from now on X", remember and follow X. You work for them. Match their views."""


def _respond_from_openai(
    messages: list, web_context: str = "", api_key: str = "", memory_excerpt: str = ""
) -> str | None:
    """Cloud chat generation — off unless BUTLER_CHAT_CLOUD=1."""
    try:
        from agent import _chat_cloud_llm_allowed
        if not _chat_cloud_llm_allowed():
            return None
    except ImportError:
        # Safe default: no cloud when agent helper missing
        return None
    if not api_key or not api_key.strip() or not OpenAI:
        return None
    try:
        client = OpenAI(api_key=api_key.strip())
        msgs = [dict(m) for m in messages]  # copy to avoid mutating
        # Prepend user-as-truth rule to first system message
        for m in msgs:
            if m.get("role") == "system":
                m["content"] = USER_TRUTH_RULE + "\n\n" + (m.get("content", ""))
                break
        else:
            msgs.insert(0, {"role": "system", "content": USER_TRUTH_RULE})
        extra_blocks: list[str] = []
        if (memory_excerpt or "").strip():
            extra_blocks.append(
                "[Private background notes — do not show labels or paste verbatim]:\n"
                + memory_excerpt.strip()[:6000]
            )
        if (web_context or "").strip():
            extra_blocks.append(
                "[Private research cues — infer facts only; never dump headlines or snippets]:\n"
                + web_context.strip()[:6000]
            )
        if extra_blocks and msgs:
            block = "\n\n".join(extra_blocks)
            block += (
                "\n\n[Writing instruction] Produce one helpful reply in plain English **in your own words**, as if you "
                "already know the topic from the private notes above—not a pasted digest, quote, headline list, or "
                "stitched-together excerpts. For how-to questions, give clear conversational guidance or steps—not a "
                "topic dump of everything related. If the user said you didn’t answer / try again, re-answer their "
                "**prior** question from the conversation—not the complaint phrase. "
                "Do not mirror source wording, bullet structure, article titles, or sentence flow from the notes. "
                "**Do not** begin with lines like ‘Butler synthesized…’ or describe merging memory and web. "
                "**Do not** include ‘Sources:’, bibliography, ‘Supporting web excerpts’, or naked https links unless the user’s "
                "**latest question** explicitly asked for citations, proofs, links, or references."
            )
            for m in msgs:
                if m.get("role") == "system":
                    m["content"] = (m.get("content", "") + f"\n\n{block}").strip()
                    break
            else:
                msgs.insert(0, {"role": "system", "content": block})
        r = client.chat.completions.create(model=OPENAI_MODEL, messages=msgs)
        return (r.choices[0].message.content or "").strip()
    except Exception:
        return None


def _stub_web_enabled(headers) -> bool:
    """
    Stub web (DDG + fetches) is slow; skip for router-only calls (X-Butler-Skip-Stub-Web) or when
    BUTLER_STUB_WEB=0|false|off (e.g. Code Helper dev defaults this via run-knowledge-dev).
    """
    if not HAS_WEB:
        return False
    h = (headers.get("X-Butler-Skip-Stub-Web") or "").strip().lower()
    if h in ("1", "true", "yes", "on"):
        return False
    v = (os.environ.get("BUTLER_STUB_WEB") or "1").strip().lower()
    if v in ("0", "false", "no", "off"):
        return False
    return True


def _stub_web_fast_path_enabled() -> bool:
    """
    Bundled dev default: one merged DDG pass (and optional lighter gather)—no planner, no multi-query spiral.
    Set BUTLER_STUB_WEB_FAST=0 for the slower full ladder.
    """
    v = (os.environ.get("BUTLER_STUB_WEB_FAST") or "1").strip().lower()
    return v not in ("0", "false", "no", "off")


def _client_closed_connection(exc: BaseException) -> bool:
    """True when the HTTP client dropped the socket before we finished sending (timeouts, cancel, proxy)."""
    if isinstance(exc, (BrokenPipeError, ConnectionResetError, ConnectionAbortedError)):
        return True
    if isinstance(exc, OSError):
        if getattr(exc, "winerror", None) in (10053, 10054):
            return True
        if exc.errno in (errno.EPIPE, errno.ECONNRESET):
            return True
    return False


class ChatHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/chat":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)
        try:
            data = json.loads(body)
            messages = data.get("messages", [])
            user_msg = _extract_last_user_message(messages)
            api_key = self.headers.get("X-OPENAI-API-KEY", "").strip()
            skip_stub_hdr = (self.headers.get("X-Butler-Skip-Stub-Web") or "").strip().lower() in (
                "1",
                "true",
                "yes",
                "on",
            )
            output = None
            try:
                from agent import (
                    _is_meta_feedback_message as _meta_fb,
                    _is_short_social_message as _social_msg,
                    _resolve_effective_user_query as _resolve_q,
                )
            except ImportError:
                _social_msg = lambda m: (m or "").strip().lower() in ("hi", "hello", "hey", "yo", "sup")  # type: ignore
                _meta_fb = lambda _m: False  # type: ignore
                _resolve_q = lambda m, _p: ((m or "").strip(), False, "")  # type: ignore

            # Prior turns for follow-up resolution (exclude the trailing current user instruction).
            prior_for_resolve: list = []
            for m in messages or []:
                if not isinstance(m, dict):
                    continue
                role = (m.get("role") or "").strip().lower()
                if role not in ("user", "assistant"):
                    continue
                prior_for_resolve.append({"role": role, "content": m.get("content")})
            if prior_for_resolve and (prior_for_resolve[-1].get("role") or "").lower() == "user":
                prior_for_resolve.pop()

            retrieval_q, is_repair, _prior_q = _resolve_q(user_msg, prior_for_resolve)
            search_q = (retrieval_q or user_msg or "").strip()
            # Never RAG/search a bare meta complaint when we could not resolve a prior ask.
            if _meta_fb(user_msg) and (not is_repair or search_q == (user_msg or "").strip()):
                search_q = ""

            # Greetings: skip RAG/web dumps; do not hardcode a canned reply — fall through to
            # memory/local synth, then a minimal empty-fallback only if nothing else works.
            social_turn = bool(user_msg.strip() and _social_msg(user_msg))
            if social_turn:
                search_q = ""
            memory_reply = (
                None
                if (output or social_turn or not search_q)
                else (_respond_from_memory(search_q) if search_q else None)
            )
            web_ctx = ""
            stub_web_on = bool(
                search_q
                and user_msg.strip()
                and not output
                and _stub_web_enabled(self.headers)
            )
            if stub_web_on:
                if _stub_web_fast_path_enabled():
                    web_ctx = (search_web_result_snippets_block(search_q, max_results=6, max_chars=3400) or "").strip()
                    if len(web_ctx) < 400:
                        web_ctx = (gather_web_answer_context(search_q, max_chars=2800) or "").strip()
                else:
                    planned_ctx = ""
                    if HAS_SEARCH_PLANNER and web_search_planner_enabled() and len(search_q.strip()) >= 12:
                        try:
                            planned = plan_immediate_web_searches(
                                search_q, max_queries=7, openai_api_key=api_key
                            )
                            if planned:
                                planned_ctx = (
                                    aggregate_planned_search_snippets(
                                        planned, max_queries=7, max_total_chars=9000
                                    )
                                    or ""
                                ).strip()
                        except Exception:
                            planned_ctx = ""
                    web_ctx = gather_web_answer_context(search_q, max_chars=3500)
                    if len(planned_ctx) >= 200 and len(planned_ctx) >= len(web_ctx.strip()) - 80:
                        web_ctx = planned_ctx
                    elif planned_ctx and len(web_ctx.strip()) < 400:
                        web_ctx = (planned_ctx + "\n\n---\n\n" + web_ctx).strip()[:8000]
                    if len(web_ctx.strip()) < 220:
                        raw = search_web_result_snippets_block(search_q, max_results=10, max_chars=4000)
                        if len(raw.strip()) > len(web_ctx.strip()):
                            web_ctx = raw
                    if len(web_ctx.strip()) < 160:
                        seen_q = {search_q.strip().lower()[:200]}
                        chunks = [search_q.strip().split("\n")[0][:220]]
                        if len(search_q.strip()) > 180:
                            chunks.append(search_q.strip()[-220:])
                        for frag in chunks:
                            f = (frag or "").strip()
                            if len(f) < 12:
                                continue
                            k = f.lower()
                            if k in seen_q:
                                continue
                            seen_q.add(k)
                            rawx = search_web_result_snippets_block(f, max_results=8, max_chars=3200)
                            if len(rawx.strip()) > len(web_ctx.strip()):
                                web_ctx = rawx
            # 2. OpenAI when key present (memory + web in system)
            if not output:
                mem_excerpt = (memory_reply or "").strip()
                output = _respond_from_openai(
                    messages, web_ctx, api_key, memory_excerpt=mem_excerpt[:4500] if mem_excerpt else ""
                )
            # 3. Local model synthesizes web + memory into plain English (same path as Knowledge `agent`).
            if not output and web_ctx.strip():
                synth = None
                compact_fb = None
                wants_urls_fn = lambda *_a, **_k: False  # type: ignore
                web_syn_on = lambda: False  # type: ignore
                try:
                    from agent import (
                        _compact_research_fallback as _agent_compact,
                        _synthesize_research_with_local_llm as _agent_synth,
                        _user_message_wants_urls_in_reply as _agent_wants_urls,
                        _web_synthesis_enabled as _agent_web_syn_on,
                    )

                    synth = _agent_synth
                    compact_fb = _agent_compact
                    wants_urls_fn = _agent_wants_urls
                    web_syn_on = _agent_web_syn_on
                except ImportError:
                    synth = None
                if synth and web_syn_on():
                    mem_block = ((memory_reply or "").strip())[:3800]
                    # OpenAI-only classify here: local classify would call peepee → this stub again (recursion).
                    wants_links = bool(
                        wants_urls_fn(
                            search_q or user_msg,
                            (api_key or "").strip(),
                            local_only=False,
                            use_local_llm=False,
                        )
                    )
                    synth_q = search_q or user_msg
                    if is_repair and search_q:
                        synth_q = (
                            f"{search_q}\n\n"
                            "(The user said their previous reply missed the question—answer this ask directly now.)"
                        )
                    output = (
                        synth(
                            synth_q,
                            mem_block,
                            web_ctx.strip(),
                            (api_key or "").strip(),
                            include_link_lines=wants_links,
                        )
                        or ""
                    ).strip()
                    if not output and compact_fb:
                        output = (
                            compact_fb(
                                search_q or user_msg,
                                mem_block,
                                web_ctx.strip(),
                                include_link_lines=wants_links,
                            ).strip()
                        )
            # 4. Local-only: prefer a real past answer over raw DDG text (unless disabled).
            mem_first = _stub_memory_first_enabled()
            if not output and mem_first and (memory_reply or "").strip():
                cand = (memory_reply or "").strip()
                try:
                    from agent import _looks_like_leaked_research_blob as _leak
                except ImportError:
                    _leak = lambda _t: False  # type: ignore
                if not _leak(cand):
                    output = cand
            # 5. Raw SERP fallback (off by default; user asked for synthesized answers—not Google clone).
            if not output and web_ctx.strip():
                raw_fallback = (
                    (os.environ.get("BUTLER_STUB_RAW_WEB_SNIPPETS") or "").strip().lower()
                    in ("1", "true", "yes", "on")
                )
                if raw_fallback:
                    output = (
                        "Here are search snippets (verify anything important yourself):\n\n"
                        + web_ctx.strip()
                    )
            if not output and memory_reply:
                cand = (memory_reply or "").strip()
                try:
                    from agent import _looks_like_leaked_research_blob as _leak2
                except ImportError:
                    _leak2 = lambda _t: False  # type: ignore
                if not _leak2(cand):
                    output = cand
            # 6. Last resort — explain what this process is vs a real LLM
            if not output:
                lower = user_msg.lower().strip()
                if social_turn or lower in ("hi", "hello", "hey", "yo", "sup"):
                    # Technical empty fallback only — not a keyword short-circuit before real generation.
                    output = "Hey — what's up?"
                else:
                    if skip_stub_hdr:
                        # Knowledge already merged web/snippets in-process; this POST is synthesis-only.
                        # Return empty (unless memory hit) so the caller does not treat placeholder prose as an answer.
                        output = (memory_reply or "").strip()
                    elif not HAS_WEB:
                        hint = (
                            "Web helpers are not installed on this stub. From the repo’s `knowledge` folder run: "
                            "`pip install duckduckgo-search beautifulsoup4 requests lxml`\n\n"
                        )
                    elif not stub_web_on:
                        hint = (
                            "Internet search on this stub is turned off (**BUTLER_STUB_WEB** defaults to **0** for fast dev). "
                            "Set **`BUTLER_STUB_WEB=1`** before starting the dev stack, then restart, to load DuckDuckGo snippets here.\n\n"
                        )
                    elif not web_ctx.strip():
                        hint = (
                            "Web search ran but returned no useful snippets (often rate limits, offline, or a very niche query).\n\n"
                        )
                    else:
                        hint = ""

                    if skip_stub_hdr:
                        pass  # output already set above
                    else:
                        output = (
                            "I couldn’t produce an answer from saved memory alone on this lightweight server (**ai_server.py** on port **5000**). "
                            "It is not a full chat model—it only merges Chroma hits, optional web snippets (when enabled), and optional OpenAI if you configured a key.\n\n"
                            + hint
                            + "**Better chat:** run **LM Studio**, **Ollama**, or another host that exposes **POST /chat**, "
                            + "then set **PEEPEEDEE_AI_URL** or **BUTLOR_AI_URL** so Knowledge forwards there (**agent** will "
                            + "summarize fresh web pulls). If you deliberately want raw DuckDuckGo lines from this stub, set "
                            + "**`BUTLER_STUB_RAW_WEB_SNIPPETS=1`**."
                        )
            if user_msg.strip() and output:
                snippet_reply = (output or "").startswith("Here are search snippets")
                memory_only = bool(
                    memory_reply and (output or "").strip() == (memory_reply or "").strip()
                )
                if api_key and output and not snippet_reply:
                    _persist_web_turn(search_q or user_msg, output, web_ctx)
                elif snippet_reply:
                    _persist_web_turn(search_q or user_msg, output, web_ctx)
                elif (web_ctx or "").strip() and not memory_only:
                    _persist_web_turn(search_q or user_msg, output, web_ctx)
        except Exception as e:
            output = f"Error: {e}"
        if output is None:
            output = ""
        try:
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"content": output}).encode())
        except Exception as send_err:
            if _client_closed_connection(send_err):
                return
            raise

    def log_message(self, format, *args):
        pass


class _ThreadedLLMHTTPServer(socketserver.ThreadingMixIn, HTTPServer):
    """Allow overlapping POST /chat from Knowledge (semantic router + main) without blocking the stub."""

    daemon_threads = True


if __name__ == "__main__":
    PORT = 5000
    server = _ThreadedLLMHTTPServer(("127.0.0.1", PORT), ChatHandler)
    server.serve_forever()
