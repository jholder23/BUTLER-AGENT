"""
Local AI Agent: Uses PEEPEEDEE AI only. No Ollama, no Llama.
"""
import codecs
import json
import os
import re
import time
from typing import Optional

from config import LOCAL_MODEL
from peepee_ai import chat as peepee_chat

try:
    from knowledge_store import KnowledgeStore
except ImportError:
    KnowledgeStore = None

SOURCE_LABEL = f"Local ({LOCAL_MODEL})"


def _web_enrichment_enabled() -> bool:
    v = (os.environ.get("BUTLER_WEB_ENRICHMENT") or "1").strip().lower()
    return v not in ("0", "false", "no", "off")


def _main_chat_max_tokens() -> int | None:
    """
    Forward to OpenAI-compatible local hosts (LM Studio, Ollama). Omit from payload when unset/0.
    Default 8192 avoids hosts that otherwise stop very early on long replies.
    """
    raw = (os.environ.get("BUTLER_CHAT_MAX_TOKENS") or "8192").strip()
    if not raw or raw in ("0", "none", "off"):
        return None
    try:
        n = int(raw)
        return n if n > 0 else None
    except ValueError:
        return 8192


def _normalize_reply_for_match(s: str) -> str:
    return (s or "").replace("\u2019", "'").replace("\u2018", "'").lower()


def _chat_cloud_llm_allowed() -> bool:
    """
    Cloud chat LLMs (OpenAI/Anthropic) are off by default for /chat generation.
    Set BUTLER_CHAT_CLOUD=1 only if you deliberately want cloud overlays.
    Web search/scraping for information is separate and still allowed.
    """
    v = (os.environ.get("BUTLER_CHAT_CLOUD") or "0").strip().lower()
    return v in ("1", "true", "yes", "on")


def _prior_history_window() -> int:
    """How many prior user/assistant turns to forward to the local model."""
    raw = (os.environ.get("BUTLER_CHAT_HISTORY") or "24").strip()
    try:
        n = int(raw)
        return max(4, min(n, 48))
    except ValueError:
        return 24


def _is_short_social_message(user_message: str) -> bool:
    """
    Lightweight RAG guard only: very short phatic openers must not trigger memory/web
    dumps. The main local LLM still answers greetings from conversation history —
    this is not a reply short-circuit.
    """
    u = (user_message or "").strip()
    if not u:
        return True
    # Drop trailing punctuation / emoji-ish fluff for matching.
    core = re.sub(r"[^\w\s']+", " ", u, flags=re.UNICODE)
    core = re.sub(r"\s+", " ", core).strip().lower()
    if not core:
        return True
    if len(core) > 48:
        return False
    words = core.split()
    if len(words) > 6:
        return False
    social = frozenset(
        {
            "hi",
            "hello",
            "hey",
            "yo",
            "sup",
            "hiya",
            "howdy",
            "hola",
            "heya",
            "hai",
            "hey there",
            "hi there",
            "hello there",
            "good morning",
            "good afternoon",
            "good evening",
            "good night",
            "morning",
            "evening",
            "whats up",
            "what's up",
            "wassup",
            "wussup",
            "how are you",
            "how're you",
            "how r you",
            "you there",
            "you up",
            "ping",
            "test",
            "testing",
        }
    )
    if core in social:
        return True
    if len(words) <= 3 and words[0] in ("hi", "hello", "hey", "yo", "sup", "hiya", "howdy"):
        return True
    return False


def _question_intent(msg: str) -> str:
    """
    Light intent parse for retrieval ranking / reply shape.
    Returns: howto | definition | why | general
    """
    u = (msg or "").strip()
    if not u:
        return "general"
    low = u.lower()
    first = low.split("\n", 1)[0].strip()
    # Strip a short softener prefix so "no sorry I want to know how to…" still counts as howto.
    first_core = re.sub(
        r"^(?:(?:no|nah|nope|sorry|actually|wait|ok|okay|please)[,!.\s]+)+",
        "",
        first,
    ).strip() or first
    if re.match(
        r"^(how\s+(do|to|can|should|would|does|did)\b|what's\s+the\s+best\s+way\b|"
        r"what\s+is\s+the\s+best\s+way\b|best\s+way\s+to\b|"
        r"(?:just\s+)?(?:tell|explain|show)\s+me\s+how\b|"
        r"i\s+want\s+to\s+know\s+how\b|ways?\s+to\b|steps?\s+(?:to|for)\b)",
        first_core,
    ) or re.search(r"\bhow\s+to\b", first_core[:100]) or re.search(
        r"\bhow\s+(?:do|can|should)\s+i\b", first_core[:100]
    ):
        return "howto"
    if re.match(
        r"^(what\s+(is|are)\b|what's\b|whats\b|define\b|definition\s+of\b|meaning\s+of\b)",
        first_core,
    ):
        return "definition"
    if first_core.startswith("why ") or first_core.startswith("why?"):
        return "why"
    return "general"


def _is_meta_feedback_message(user_message: str) -> bool:
    """
    True when the turn is repair/feedback about Butler's prior reply
    (e.g. "you didn't answer my question"), not a new topical ask.
    """
    u = (user_message or "").strip()
    if not u:
        return False
    # Long messages are almost always a new ask (even if they include a complaint).
    if len(u) > 280:
        return False
    low = _normalize_reply_for_match(u)
    # Clear new questions with substance are not meta-only.
    intent = _question_intent(u)
    if intent in ("howto", "definition", "why") and len(u) > 36:
        return False
    if _is_short_social_message(u):
        return False
    cues = (
        "you didn't answer",
        "you didnt answer",
        "didn't answer my question",
        "didnt answer my question",
        "didn't answer the question",
        "didnt answer the question",
        "that wasn't an answer",
        "that wasnt an answer",
        "that's not what i asked",
        "thats not what i asked",
        "not what i asked",
        "not what i meant",
        "you missed my question",
        "you ignored my question",
        "answer my question",
        "answer the question",
        "try again",
        "be clearer",
        "be more clear",
        "more clearly",
        "that doesn't help",
        "that doesnt help",
        "that wasn't helpful",
        "that wasnt helpful",
        "you just dumped",
        "too much information",
        "too many details",
        "re-answer",
        "reanswer",
        "do it properly",
        "actually answer",
        "still didn't answer",
        "still didnt answer",
        "wrong answer",
        "missed the point",
        "be more specific",
        "more specific",
        "go into more detail",
        "that doesn't answer",
        "that doesnt answer",
        "didn't really answer",
        "didnt really answer",
    )
    if any(c in low for c in cues):
        return True
    # Short imperatives that only make sense as repair of the last turn.
    if len(low) <= 40 and re.match(
        r"^(again\.?|no\.?|nope\.?|wrong\.?|redo\.?|retry\.?|clarify\.?|"
        r"be specific\.?|be more specific\.?|shorter\.?|focus\.?)$",
        low,
    ):
        return True
    return False


def _unwrap_history_user_content(content) -> str:
    """If a prior turn stored the JSON instruction envelope, pull out instruction."""
    if isinstance(content, dict):
        got = (content.get("instruction") or content.get("content") or "").strip()
        if isinstance(got, str) and got:
            return got if not got.startswith("{") else _unwrap_history_user_content(got)
        return str(content)[:12000]
    c = str(content or "").strip()
    if not c:
        return ""
    if c.startswith("{") and "instruction" in c[:200]:
        try:
            parsed = json.loads(c)
            if isinstance(parsed, dict):
                got = (parsed.get("instruction") or "").strip()
                if got:
                    return got
        except Exception:
            pass
    return c


def _is_substantive_user_question(msg: str) -> bool:
    """True for a real topical ask suitable as the target of a repair turn."""
    u = _unwrap_history_user_content(msg).strip()
    if len(u) < 8:
        return False
    if _is_short_social_message(u) or _is_meta_feedback_message(u):
        return False
    low = u.lower()
    if low.startswith("[welcome") or "i'm butler" in low[:80]:
        return False
    return True


def _last_substantive_user_from_prior(prior_messages: list | None) -> str:
    for pm in reversed(prior_messages or []):
        if not isinstance(pm, dict):
            continue
        if (pm.get("role") or "").strip().lower() != "user":
            continue
        c = _unwrap_history_user_content(pm.get("content") or "")
        if _is_substantive_user_question(c):
            return c.strip()
    return ""


def _followup_focus_addon(message: str) -> str:
    """Extract a short 'what about X' / 'and X?' focus clause, else empty."""
    u = (message or "").strip()
    if not u or len(u) > 200:
        return ""
    m = re.match(r"(?is)^\s*(?:what|how)\s+about\s+(.+?)\s*\??\s*$", u)
    if m:
        return (m.group(1) or "").strip(" .,!?:;")
    m = re.match(r"(?is)^\s*and\s+(?:also\s+)?(.+?)\s*\??\s*$", u)
    if m:
        got = (m.group(1) or "").strip(" .,!?:;")
        if 0 < len(got.split()) <= 14:
            return got
    return ""


def _looks_like_context_dependent_followup(message: str) -> bool:
    """Short turns that likely refer to the previous user/assistant exchange."""
    u = (message or "").strip()
    if not u or _is_short_social_message(u) or _is_meta_feedback_message(u):
        return False
    if _followup_focus_addon(u):
        return True
    if len(u) > 120 or len(u.split()) > 18:
        return False
    low = _normalize_reply_for_match(u)
    # "Just tell me how" / "tell me how to do it" — must not re-route to jobs/tools.
    if re.search(
        r"(?i)\b(just\s+)?(tell|explain|show|answer|give)\s+me\b",
        u,
    ) and len(u.split()) <= 16:
        return True
    if re.match(r"(?i)^\s*just\s+(answer|tell|explain|do)\b", u):
        return True
    if re.search(r"\b(it|that|this|those|them|they|he|she)\b", low) and len(u.split()) <= 12:
        return True
    if low.startswith(("and ", "but ", "so ", "also ", "then ", "or ")) and len(u.split()) <= 14:
        return True
    return False


def _resolve_effective_user_query(
    user_message: str, prior_messages: list | None
) -> tuple[str, bool, str]:
    """
    Heuristic backup for retrieval/web rewrite when the local LLM is unavailable.
    Prefer `_llm_resolve_effective_user_query` on the live chat path.

    Returns (retrieval_query, is_meta_repair, prior_question).
    is_meta_repair is True when the user complained the prior reply failed — force a real
    re-answer of prior_question (never RAG-search the complaint phrase).
    """
    um = (user_message or "").strip()
    if not um or _is_short_social_message(um):
        return um, False, ""
    prior_q = _last_substantive_user_from_prior(prior_messages)
    if _is_meta_feedback_message(um):
        if prior_q:
            return prior_q, True, prior_q
        return um, False, ""
    if not prior_q:
        return um, False, ""
    addon = _followup_focus_addon(um)
    if addon:
        return f"{prior_q}\n\nFollow-up focus: {addon}", False, prior_q
    if _looks_like_context_dependent_followup(um):
        if um.lower() == prior_q.lower():
            return um, False, prior_q
        return f"{prior_q}\n\nFollow-up: {um}", False, prior_q
    return um, False, ""


_RESOLVE_QUERY_SYSTEM = (
    "You help Butler (a personal single-user local AI) interpret the latest user message "
    "in light of the recent conversation — like a human would.\n"
    "Reply with JSON only, no markdown:\n"
    '{"retrieval_query":"<string>","is_repair":true|false,"skip_retrieval":true|false}\n'
    "Rules:\n"
    "- If the latest message is a greeting/phatic opener with no informational ask, "
    'set skip_retrieval true and retrieval_query to "".\n'
    "- If the latest message is meta-feedback that a prior reply failed "
    '(e.g. “you didn’t answer”, “try again”, “be clearer”), set is_repair true and put the '
    "**prior substantive question** in retrieval_query — never the complaint phrasing.\n"
    "- If it is a short follow-up that depends on the prior ask (pronouns, “what about X”), "
    "set retrieval_query to the grounded question (prior ask + follow-up focus).\n"
    "- Otherwise retrieval_query is the latest message’s effective question (may match it).\n"
    "- Never invent a new topic. Never put refusal/policy text in the JSON."
)


def _llm_resolve_effective_user_query(
    user_message: str,
    prior_messages: list | None,
    *,
    local_only: bool = True,
) -> tuple[str, bool, str]:
    """
    Prefer local LLM restatement from history for ambiguous follow-ups.
    Clear meta-feedback + prior ask uses the heuristic backup immediately (never RAG
    the complaint phrase; avoids a wasted stub round-trip when the ask is obvious).
    Opt out of LLM pass: BUTLER_LLM_QUERY_RESOLVE=0
    """
    um = (user_message or "").strip()
    if not um:
        return "", False, ""
    heuristic = _resolve_effective_user_query(um, prior_messages)
    # Reliable repair path: complaint + prior substantive question → never search the complaint.
    if heuristic[1]:
        return heuristic
    if _is_short_social_message(um) or not prior_messages:
        return heuristic

    off = (os.environ.get("BUTLER_LLM_QUERY_RESOLVE") or "1").strip().lower()
    if off in ("0", "false", "no", "off"):
        return heuristic

    hist_lines: list[str] = []
    for pm in (prior_messages or [])[-12:]:
        if not isinstance(pm, dict):
            continue
        role = (pm.get("role") or "").strip().lower()
        if role not in ("user", "assistant"):
            continue
        content = _unwrap_history_user_content(pm.get("content") or "")
        if not content.strip():
            continue
        hist_lines.append(f"{role}: {content.strip()[:1500]}")
    if not hist_lines:
        return heuristic

    user_blob = (
        "Recent conversation:\n"
        + "\n".join(hist_lines)
        + f"\n\nLatest user message:\n{um[:4000]}"
    )
    try:
        try:
            tout = float((os.environ.get("BUTLER_LLM_QUERY_RESOLVE_TIMEOUT_SEC") or "").strip() or "14")
        except ValueError:
            tout = 14.0
        tout = max(4.0, min(tout, 45.0))
        r = peepee_chat(
            messages=[
                {"role": "system", "content": _RESOLVE_QUERY_SYSTEM},
                {"role": "user", "content": user_blob},
            ],
            model=LOCAL_MODEL,
            openai_api_key="",  # local only — never cloud for this pass
            skip_stub_web=True,
            timeout_sec=tout,
        )
        raw = ((r.get("message") or {}).get("content") or "").strip()
    except Exception:
        return heuristic

    # Parse JSON object from model output.
    obj = None
    try:
        start = raw.find("{")
        end = raw.rfind("}")
        if start >= 0 and end > start:
            obj = json.loads(raw[start : end + 1])
    except Exception:
        obj = None
    if not isinstance(obj, dict):
        return heuristic

    skip = bool(obj.get("skip_retrieval"))
    is_repair = bool(obj.get("is_repair"))
    rq = str(obj.get("retrieval_query") or "").strip()
    if skip:
        return um, False, ""
    # Guard: never RAG the complaint phrase itself.
    if rq and _is_meta_feedback_message(rq) and not _is_substantive_user_question(rq):
        return heuristic
    if is_repair:
        prior_q = rq or _last_substantive_user_from_prior(prior_messages)
        if prior_q and not _is_meta_feedback_message(prior_q):
            return prior_q, True, prior_q
        return heuristic
    if rq:
        prior_q = _last_substantive_user_from_prior(prior_messages)
        return rq, False, prior_q if prior_q and prior_q.lower() in rq.lower() else ""
    return heuristic


def _memory_blocks_cap(msg: str) -> int:
    """Cap how many memory chunks inject into the system prompt for one turn."""
    raw = (os.environ.get("BUTLER_MEMORY_BLOCKS") or "").strip()
    if raw:
        try:
            n = int(raw)
            return max(2, min(n, 24))
        except ValueError:
            pass
    intent = _question_intent(msg)
    if intent in ("howto", "definition", "why"):
        return 4
    u = (msg or "").strip()
    if "?" in u and len(u) <= 320:
        return 4
    return 6


def _memory_chunk_looks_answer_shaped(content: str, intent: str) -> bool:
    """Prefer past Assistant prose / procedural guidance over raw topic blobs."""
    c = (content or "").strip()
    if not c:
        return False
    has_asst = bool(re.search(r"Assistant:", c, re.I))
    body = _parse_assistant_from_memory_chunk(c) if has_asst else c
    min_len = 40 if has_asst else 40
    if len(body) < min_len:
        return False
    # Truncated scrapes often start mid-word / mid-sentence (lowercase).
    if has_asst and body[:1].islower():
        return False
    # Judge the assistant body (or plain prose), not the User:/Assistant: wrapper.
    if _looks_like_leaked_research_blob(body) or _is_research_mem_noise_chunk(body):
        return False
    low = body.lower()
    if intent == "howto":
        if has_asst:
            return True
        procedural = (
            "step" in low
            or "first" in low
            or "then " in low
            or "you can" in low
            or "start by" in low
            or "cut " in low
            or "use a " in low
            or "take " in low
            or re.search(r"\b\d+[.)]\s", body) is not None
        )
        return procedural
    if intent == "definition":
        return has_asst or " is " in low[:200] or low.startswith("a ") or low.startswith("an ")
    return has_asst


def _content_is_research_scaffold(content: str) -> bool:
    """True for SERP/research dumps — not ordinary User/Assistant chat turns."""
    c = (content or "").strip()
    if not c:
        return False
    low = c.lower()
    if "supporting web" in low or "private research" in low or "[from the internet]" in low:
        return True
    if len(re.findall(r"https?://", c, flags=re.I)) >= 2:
        return True
    if low.count("\n---") >= 2:
        return True
    body = _parse_assistant_from_memory_chunk(c) if re.search(r"Assistant:", c, re.I) else c
    return bool(body) and _looks_like_leaked_research_blob(body)


def _memory_looks_like_butler_feature_doc(content: str) -> bool:
    """
    True for Butler product / utility / jobs / Comfy feature memories that must not
    override unrelated how-to questions in RAG.
    """
    low = (content or "").lower()
    if not low:
        return False
    markers = (
        "jobs_auto_apply",
        "jobs_prepare_materials",
        "gigs_run",
        '"mode": "jobs',
        '"mode":"jobs',
        '"mode": "sd_',
        '"mode":"sd_',
        "auto-apply",
        "auto apply",
        "which job posting",
        "utility panel",
        "butler easy prompt",
        "butlereasy",
        "sd_img2img",
        "sd_txt2img",
        "sd_image2video",
        "pose control",
        "pose reference",
        "openpose",
        "img2img_juggernaut",
        "silhouette you're looking",
        "automate from a silhouette",
        "specific silhouette",
        "comfyui workflow",
        "tailored resume",
        "cover letter from",
    )
    return any(m in low for m in markers)


def _reply_looks_like_tool_hijack(reply: str) -> bool:
    """Assistant text that pivoted into jobs/pose/SD tooling instead of answering."""
    low = (reply or "").lower()
    if not low:
        return False
    markers = (
        "job posting",
        "which job",
        "auto-apply",
        "auto apply",
        "silhouette",
        "pose reference",
        "openpose",
        "img2img",
        "utility panel",
        "cover letter",
        "would you like me to auto-apply",
        "automate from a silhouette",
        "to use butler, simply",
        "json payload will give you the tools",
        "provide instructions in natural language and the json",
        "provide the json payload",
        "butler will provide the json",
        "json payload to accomplish",
        "json payload which provides",
        "refer to the json payload",
        "json payload",
        "how butler operates",
        "tools needed for your task",
        "which mode should i use",
        "natural language and butler will",
    )
    return any(m in low for m in markers)


def _reply_topically_matches_ask(query: str, reply: str) -> bool:
    """True when reply shares enough content words with the ask (howto off-topic guard)."""
    q = (query or "").strip()
    a = (reply or "").strip()
    if not q or not a:
        return False
    stop = {
        "how", "do", "to", "the", "a", "an", "is", "are", "what", "why", "can", "i",
        "my", "me", "you", "please", "just", "tell", "from", "with", "about", "this",
        "that", "into", "for", "and", "or", "of", "in", "on", "it", "be", "want",
        "know", "more", "some", "any", "does", "did", "would", "should", "could",
    }
    qtok = {t for t in re.split(r"[^\w]+", q.lower()) if len(t) > 2 and t not in stop}
    atok = {t for t in re.split(r"[^\w]+", a.lower()) if len(t) > 2 and t not in stop}
    if not qtok:
        return True
    return len(qtok & atok) >= max(1, (len(qtok) + 1) // 2)


def coerce_tool_mode_for_informational_ask(
    user_message: str,
    out: dict,
    prior_messages: list | None = None,
    *,
    has_init_image: bool = False,
) -> dict:
    """
    If the model (or sticky router hint) picked jobs/SD/etc. for a clear how-to /
    follow-up Q&A turn, force mode chat so the host does not run the wrong tool.
    Also strip tool-hijack / product-catalog replies that ignore the ask.
    """
    if not isinstance(out, dict):
        return out
    try:
        from butler_agent import agent_mode_enabled, looks_like_agent_work

        if agent_mode_enabled() and looks_like_agent_work(user_message):
            mode0 = str(out.get("mode") or "").strip().lower()
            if mode0 in ("actions", "agent"):
                return out
    except Exception:
        pass
    try:
        from semantic_route import TOOL_ROUTES, is_informational_qa_turn
    except Exception:
        return out
    if not is_informational_qa_turn(
        user_message, prior_messages, has_init_image=has_init_image
    ):
        return out
    mode = str(out.get("mode") or "").strip().lower()
    reply = (out.get("reply") or "").strip()
    hijack = _reply_looks_like_tool_hijack(reply)
    if mode not in TOOL_ROUTES and mode != "questions" and not hijack:
        return out
    if hijack:
        reply = ""
    coerced = {
        **{
            k: v
            for k, v in out.items()
            if k
            not in (
                "role",
                "location",
                "max_jobs",
                "auto_submit",
                "urls",
                "skills",
                "prompt",
                "questions",
            )
        },
        "mode": "chat",
        "reply": reply,
    }
    if mode in TOOL_ROUTES or mode == "questions":
        coerced["_butler_coerced_from_tool"] = mode
    if not reply:
        coerced["needs_live_web"] = True
    return coerced


def _memory_hit_rank_key(query: str, row: dict, intent: str) -> tuple:
    """Lower tuple sorts first. Prefer intent-aligned, answer-shaped, closer hits."""
    content = (row.get("content") or "") if isinstance(row, dict) else ""
    src = ((row.get("source") or "") if isinstance(row, dict) else "").lower()
    topic = ((row.get("topic") or "") if isinstance(row, dict) else "").lower()
    try:
        dist = float(row.get("distance")) if row.get("distance") is not None else 1.45
    except (TypeError, ValueError):
        dist = 1.45

    user_m = re.search(
        r"User:\s*(.+?)(?=\n\nAssistant:|\n\n\[Supporting|\n\n---|\Z)",
        content,
        re.DOTALL | re.I,
    )
    stored_q = (user_m.group(1).strip() if user_m else "")[:400]
    stored_intent = _question_intent(stored_q) if stored_q else _question_intent(content[:240])
    intent_mismatch = 0
    if intent != "general" and stored_intent != "general" and stored_intent != intent:
        intent_mismatch = 1

    answer_shaped = _memory_chunk_looks_answer_shaped(content, intent)
    shape_penalty = 0 if answer_shaped else 1

    # For how-to / definition asks, learned intent/activity (jobs/gigs/SD tool logs) are
    # usually product noise — demote heavily so they cannot override the current question.
    feature_penalty = 1 if _memory_looks_like_butler_feature_doc(content) else 0
    if intent in ("howto", "definition", "why") and src in ("intent", "activity"):
        tier = 4
    elif src in ("intent", "activity"):
        tier = 0
    elif src == "chat" or topic == "conversation":
        tier = 1
    elif src == "internet_research":
        tier = 2
    else:
        tier = 3

    # Penalize research scaffolds only — plain User/Assistant chat turns are fine.
    blob_penalty = 1 if _content_is_research_scaffold(content) else 0

    # Prefer stored User lines that share content words with the ask (not only stopwords).
    qtok = {t for t in re.split(r"[^\w]+", (query or "").lower()) if len(t) > 2}
    stop = {"how", "the", "and", "for", "what", "why", "when", "where", "who", "can", "does", "did"}
    qtok -= stop
    focus = (stored_q or content)[:800].lower()
    ctok = {t for t in re.split(r"[^\w]+", focus) if len(t) > 2} - stop
    overlap = len(qtok & ctok) if qtok else 0
    overlap_penalty = 0 if (not qtok or overlap >= max(1, (len(qtok) + 1) // 2)) else 1

    return (
        intent_mismatch,
        feature_penalty,
        shape_penalty,
        overlap_penalty,
        tier,
        blob_penalty,
        dist,
    )


def _looks_like_intentional_website_link_list_reply(text: str) -> bool:
    """
    True for assistant-shaped multi-link answers (Useful links / bare https list).
    These must not be treated as leaked SERP dumps just because they contain several URLs.
    """
    t = (text or "").strip()
    if len(t) < 20:
        return False
    low = _normalize_reply_for_match(t)
    if any(
        m in low
        for m in (
            "private research",
            "supporting web excerpts",
            "saved for retrieval",
            "[from the internet]",
            "[from butler memory",
            "search snippets + page text",
            "for your reading only",
            "background research for:",
        )
    ):
        return False
    if low.startswith("user:") or ("user:" in low[:80] and "assistant:" in low):
        return False
    if "\n---" in t or low.count(" --- ") >= 2:
        return False
    urls = _extract_http_urls_from_text(t, limit=24)
    if len(urls) < 2:
        return False
    siteish = [u for u in urls if not _url_looks_like_video_clip_or_embed(u)]
    if "useful links:" in low and len(siteish) >= 2:
        return True
    return len(siteish) >= 3


def _looks_like_leaked_research_blob(text: str) -> bool:
    """
    True when a candidate reply looks like internal research notes, SERP paste,
    or a stored User/Assistant research turn — never show these as the assistant reply.
    """
    t = (text or "").strip()
    if len(t) < 40:
        return False
    low = _normalize_reply_for_match(t)
    markers = (
        "private research",
        "(b) private research",
        "supporting web excerpts",
        "saved for retrieval",
        "[from the internet]",
        "[from butler memory",
        "search snippets + page text",
        "for your reading only",
        "background research for:",
        "here is the clearest short version i can extract from the web",
        "here are search snippets",
        "here's the practical takeaway i'd go with",
        "here is the practical takeaway i'd go with",
        "also worth keeping in mind:",
        "here's what i'd go with based on what turned up",
        "here is what i'd go with based on what turned up",
        "based on what turned up",
        "about press copyright contact us creators advertise",
        "how youtube works test new features",
        "terms privacy policy & safety",
    )
    if any(m in low for m in markers):
        return True
    # Stored turn blobs or SERP-style title/url/snippet stacks.
    if low.startswith("user:"):
        return True
    if "user:" in low[:80] and "assistant:" in low:
        return True
    # Clean "return N links" answers are intentional — do not strip their https lines.
    if _looks_like_intentional_website_link_list_reply(t):
        return False
    http_n = len(re.findall(r"https?://", t, flags=re.I))
    if http_n >= 3 and ("\n---" in t or low.count("\n") >= 8):
        return True
    if http_n >= 2 and "wikipedia.org" in low and len(t) > 400:
        return True
    # Headline / title: snippet digest (common SERP paste shape).
    title_snip_lines = len(
        re.findall(r"(?m)^[-*•]\s+.+:\s+.{20,}", t)
    )
    if title_snip_lines >= 3 and (http_n >= 1 or "\n---" in t):
        return True
    # News/SERP headline stacks: "Title - Site" lines with --- separators.
    headline_site = len(re.findall(r"(?m)^.{12,120}\s+-\s+[A-Z][\w .]{2,40}$", t))
    if headline_site >= 2 and ("\n---" in t or http_n >= 1):
        return True
    if low.count("\n---") >= 2 and (http_n >= 1 or headline_site >= 1):
        return True
    # Flattened SERP mash: many em-dash / " --- " topic breaks without conversational voice.
    if low.count(" --- ") >= 3 and len(t) > 500:
        return True
    # Dated caption / headline mash ("Jun 17, 2025 - A slice of cake…") plus unrelated topics.
    dated_caps = len(re.findall(r"(?i)\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2},\s+\d{4}\s*[-–—]", t))
    if dated_caps >= 1 and len(t) > 280 and (
        low.count(". ") >= 4 or "recipe for" in low or "wikipedia" in low
    ):
        return True
    return False


def _looks_like_prompt_envelope_leak(text: str) -> bool:
    """
    True when the model echoed internal prompt / JSON-repair scaffolding
    (code_workspace_background, previous_model_output_excerpt, Cursor CLI code_ide
    blobs, etc.) instead of a user-facing answer. Never show these as the reply.
    """
    t = (text or "").strip()
    if len(t) < 20:
        return False
    strong = (
        "previous_model_output_excerpt",
        "parsed_mode_if_any",
        "messages_outgoing_background",
        "code_ide_workspace",
    )
    if any(m in t for m in strong):
        return True
    if '"code_ide"' in t and ("messages_outgoing" in t or "Cursor CLI" in t or "cursor cli" in t.lower()):
        return True
    if "code_workspace_background" not in t and '"instruction"' not in t:
        return False
    # JSON-shaped echo of the chat envelope (instruction + project_root / background).
    if not t.lstrip().startswith("{"):
        return False
    try:
        fixed = re.sub(r",\s*}", "}", re.sub(r",\s*]", "]", t))
        parsed = json.loads(fixed)
    except Exception:
        # Unparseable but clearly an echoed envelope.
        return (
            "code_workspace_background" in t
            and '"instruction"' in t
            and '"project_root"' in t
            and '"mode"' not in t[:200]
        )
    if not isinstance(parsed, dict):
        return False
    if "previous_model_output_excerpt" in parsed or "parsed_mode_if_any" in parsed:
        return True
    if "code_workspace_background" in parsed and not parsed.get("mode"):
        return True
    if (
        "instruction" in parsed
        and ("project_root" in parsed or "sample_files" in parsed)
        and not parsed.get("mode")
        and not (parsed.get("reply") or "").strip()
    ):
        return True
    # Valid Butler chat whose reply body itself is a leaked envelope.
    if parsed.get("mode") == "chat":
        inner = (parsed.get("reply") or "").strip()
        if inner and inner != t:
            return _looks_like_prompt_envelope_leak(inner)
    return False


def _usable_chat_text_from_model_raw(raw: str) -> str:
    """
    Pull a user-visible chat string from a raw model turn.
    Skips JSON-repair / code_workspace prompt echoes; prefers plain prose over dumps.
    """
    raw = (raw or "").strip()
    if not raw or _looks_like_prompt_envelope_leak(raw):
        return ""
    parsed = _parse_butler_json_from_raw(raw)
    if isinstance(parsed, dict) and parsed.get("mode") == "chat":
        got = (parsed.get("reply") or "").strip()
        if got and not _looks_like_prompt_envelope_leak(got):
            return got
    loose = _extract_reply_from_raw_loose(raw)
    if loose and not _looks_like_prompt_envelope_leak(loose):
        return loose
    reply_match = re.search(r'"reply"\s*:\s*"((?:[^"\\]|\\.)*)"', raw, re.DOTALL)
    if reply_match:
        frag = reply_match.group(1)
        try:
            reply = json.loads(f'"{frag}"')
        except Exception:
            try:
                reply = codecs.decode(frag, "unicode_escape")
            except Exception:
                reply = frag
        reply = (reply or "").strip()
        if reply and not _looks_like_prompt_envelope_leak(reply):
            return reply
    # Plain-text answer (small local models often skip the JSON wrapper).
    if not raw.lstrip().startswith("{"):
        return raw[:12000]
    return ""


def _pick_chat_reply_from_model_raws(*raws: str) -> str:
    """Prefer the first usable model turn (usually raw1) over later repair echoes."""
    for raw in raws:
        got = _usable_chat_text_from_model_raw(raw)
        if got:
            return got
    return ""


def _parse_assistant_from_memory_chunk(chunk: str) -> str:
    """Prefer the Assistant: body from a stored User/Assistant turn."""
    c = (chunk or "").strip()
    if not c:
        return ""
    match = re.search(
        r"Assistant:\s*(.+?)(?=\n\nUser:|\n\nAssistant:|\Z)",
        c,
        re.DOTALL | re.I,
    )
    if match:
        return _strip_butler_synthesis_disclaimer(match.group(1).strip())
    if re.search(r"Assistant:", c, re.I):
        return _strip_butler_synthesis_disclaimer(re.split(r"Assistant:\s*", c, maxsplit=1, flags=re.I)[-1].strip())
    return _strip_butler_synthesis_disclaimer(c)


def _sanitize_memory_chunk_for_prompt(content: str, *, max_chars: int = 1100) -> str:
    """
    Turn a raw Chroma hit into private notes for the model — never leave SERP/headline
    dumps or 'Supporting web excerpts' blocks in the system prompt (models mirror those).
    """
    c = (content or "").strip()
    if not c:
        return ""
    if _is_research_mem_noise_chunk(c):
        return ""

    # Prefer the past answer; drop stored web-excerpt scaffolding.
    if re.search(r"Assistant:", c, re.I) or re.search(
        r"\[Supporting web excerpts", c, re.I
    ):
        c = _parse_assistant_from_memory_chunk(c)

    # Strip leftover research / internet framing if still present.
    c = re.sub(
        r"\[Supporting web excerpts[^\]]*\]:?\s*",
        "",
        c,
        flags=re.I,
    )
    c = re.sub(
        r"\[Background research for:[^\]]*\]\s*",
        "",
        c,
        flags=re.I,
    )
    c = re.sub(
        r"\[From the internet\]:?\s*",
        "",
        c,
        flags=re.I,
    )
    c = re.sub(
        r"\(B\)\s*Private research[^\n]*\n?",
        "",
        c,
        flags=re.I,
    )
    # Drop bare URL-heavy lines that look like SERP paste.
    lines = []
    for line in c.splitlines():
        s = line.strip()
        if not s:
            continue
        if re.match(r"https?://\S+$", s, re.I):
            continue
        lines.append(line)
    c = "\n".join(lines).strip()
    c = re.sub(r"\n{3,}", "\n\n", c).strip()
    if not c or len(c) < 24:
        return ""
    # Mid-word / mid-sentence scrapes are not useful private notes.
    if c[:1].islower():
        return ""
    if _looks_like_leaked_research_blob(c) or _is_research_mem_noise_chunk(c):
        return ""
    return c[:max_chars]


def _stub_boilerplate_reply(txt: str) -> bool:
    """True when the bundled :5000 stub returned its long explanatory refusal instead of an answer."""
    r = _normalize_reply_for_match(txt)
    if not r.strip():
        return False
    return (
        ("lightweight server" in r and "ai_server.py" in r)
        or ("saved memory alone" in r)
        or ("internet search on this stub is turned off" in r)
        or ("web helpers are not installed" in r)
    )



def _local_llm_refusal_reply(txt: str) -> bool:
    """True when the local model refused, hedged, lectured, or policy-blocked instead of answering."""
    r = _normalize_reply_for_match(txt).strip()
    if not r:
        return False
    refusal_markers = (
        "i can't help with that",
        "i cannot help with that",
        "i can't assist with that",
        "i cannot assist with that",
        "i'm not able to help with",
        "i am not able to help with",
        "i won't help with",
        "i will not help with",
        "against my guidelines",
        "against my programming",
        "i must refuse",
        "i have to refuse",
        "i must decline",
        "i decline to",
        "inappropriate request",
        "unable to fulfill",
        "cannot fulfill this",
        "won't provide guidance",
        "will not provide guidance",
        "won't provide",
        "will not provide",
        "cannot generate that",
        "i can't provide that",
        "i cannot provide that",
        "not able to provide",
        "i won't be able to help",
        "i will not be able to help",
        "sorry, but i can't",
        "sorry, but i cannot",
        "i'm afraid i can't",
        "i'm afraid i cannot",
        "i can't provide information",
        "i cannot provide information",
        "i won't provide information",
        "i will not provide information",
        "i can't and won't",
        "i cannot and will not",
        "i won't assist with",
        "i will not assist with",
        "i'm not allowed to",
        "i am not allowed to",
        "i'm unable to assist",
        "i am unable to assist",
        "violates my guidelines",
        "goes against my guidelines",
        "content policy",
        "i must not provide",
        "i cannot encourage",
        "i can't encourage",
        "i won't encourage",
        "i will not encourage",
        "i shouldn't provide",
        "i should not provide",
        "i shouldn't help",
        "i should not help",
        "i'm not comfortable",
        "i am not comfortable",
        "i refuse to",
        "i'm unable to provide",
        "i am unable to provide",
        "i can't share that",
        "i cannot share that",
        "i won't share",
        "i will not share",
        "cannot access your computer",
        "can't access your machine",
        "cannot access your filesystem",
        "browser application",
        "can only provide code",
    )
    for m in refusal_markers:
        if m in r:
            return True
    if (r.startswith("as an ai") or r.startswith("as a language model") or r.startswith("as a responsible")) and any(
        x in r[:360]
        for x in ("can't", "cannot", "unable", "won't", "will not", "not able", "refuse", "not allowed", "concerned")
    ):
        return True
    if r.startswith(("i'm sorry", "i am sorry", "sorry,")) and any(
        x in r[:280]
        for x in (
            "can't help",
            "cannot help",
            "unable to",
            "won't",
            "will not",
            "not able to",
            "can't assist",
            "cannot assist",
            "can't provide",
            "cannot provide",
            "won't provide",
            "will not provide",
        )
    ):
        return True
    # Concern / safety-lecture theater (common aligned-model pattern) instead of answering.
    head = r[:520]
    lecture_openers = (
        "i'm really concerned",
        "i am really concerned",
        "i'm concerned about",
        "i am concerned about",
        "i'm deeply concerned",
        "i am deeply concerned",
        "i'm worried about",
        "i am worried about",
        "i must warn you",
        "i need to warn you",
        "i have to warn you",
        "before i answer",
        "before i provide",
        "before we continue",
        "i strongly advise against",
        "i strongly discourage",
        "please don't do this",
        "please do not do this",
        "this is incredibly dangerous",
        "that is incredibly dangerous",
        "this is extremely dangerous",
        "that is extremely dangerous",
        "this could be life-threatening",
        "that could be life-threatening",
        "i want to emphasize how dangerous",
        "i need to emphasize how dangerous",
    )
    if any(op in head for op in lecture_openers):
        return True
    moralizing = (
        "incredibly dangerous",
        "extremely dangerous",
        "illegal and dangerous",
        "please seek help",
        "please seek professional",
        "contact a hotline",
        "call a hotline",
        "national helpline",
        "crisis hotline",
        "suicide hotline",
        "i strongly advise against",
        "as a responsible ai",
        "as a responsible assistant",
        "i cannot in good conscience",
        "i can't in good conscience",
        "for your own safety",
        "this is not something i can",
        "not something i can help",
    )
    if any(m in head for m in moralizing) and any(
        x in head
        for x in (
            "can't",
            "cannot",
            "won't",
            "will not",
            "refuse",
            "concerned",
            "worried",
            "advise against",
            "discourage",
            "hotline",
            "helpline",
            "seek help",
            "seek professional",
            "dangerous",
            "safety",
        )
    ):
        return True
    return False


def _local_llm_unusable_reply(txt: str) -> bool:
    """
    True when the local-model turn should not stand as the final answer:
    refusal, unreachable host, offline stub, empty/useless parse, or stub boilerplate.
    Triggers step 3 (knowledge + web search/synth) in the answer pipeline.
    """
    r = _normalize_reply_for_match(txt).strip()
    if not r:
        return True
    if "sorry, the local ai could not be reached" in r:
        return True
    if "could not parse model output" in r:
        return True
    if "i'm running in low-memory / offline mode" in r:
        return True
    if _stub_boilerplate_reply(txt):
        return True
    if _local_llm_refusal_reply(txt):
        return True
    if _looks_like_prompt_envelope_leak(txt):
        return True
    return False


def _knowledge_first_enabled() -> bool:
    v = (os.environ.get("BUTLER_KNOWLEDGE_FIRST") or "1").strip().lower()
    return v not in ("0", "false", "no", "off")


def _try_direct_knowledge_answer(store, query: str) -> str:
    """
    Step 1 of the answer pipeline: if Butler's knowledge store already has a strong,
    answer-shaped match, return it and skip calling the local LLM.
    """
    if not store or not _knowledge_first_enabled():
        return ""
    q = (query or "").strip()
    if not q or _is_short_social_message(q) or _is_meta_feedback_message(q):
        return ""
    intent = _question_intent(q)
    candidates: list[dict] = []
    seen: set[str] = set()

    def _push(rows) -> None:
        for r in rows or []:
            if not isinstance(r, dict):
                continue
            raw = (r.get("content") or "").strip()
            if not raw or raw in seen:
                continue
            if not _memory_hit_relevant(q, r):
                continue
            seen.add(raw)
            candidates.append(r)

    try:
        _push(store.search(q, n_results=8, where={"source": "chat"}))
    except Exception:
        pass
    try:
        _push(store.search(q, n_results=10))
    except Exception:
        pass
    if not candidates:
        return ""
    ranked = sorted(candidates, key=lambda r: _memory_hit_rank_key(q, r, intent))
    shaped = [
        r for r in ranked if _memory_chunk_looks_answer_shaped(r.get("content") or "", intent)
    ]
    if intent in ("howto", "definition", "why"):
        pool = shaped[:3]
        if not pool:
            return ""
    else:
        pool = (shaped[:2] or ranked[:1])

    for r in pool:
        if _memory_looks_like_butler_feature_doc(r.get("content") or ""):
            continue
        ans = _parse_assistant_from_memory_chunk(r.get("content") or "")
        if len(ans) < 48:
            ans = _sanitize_memory_chunk_for_prompt(
                r.get("content") or "", max_chars=2000
            )
        if len(ans) < 60:
            continue
        if (
            _local_llm_unusable_reply(ans)
            or _looks_like_leaked_research_blob(ans)
            or _looks_like_prompt_envelope_leak(ans)
        ):
            continue
        if _is_research_mem_noise_chunk(ans):
            continue
        if _reply_looks_like_tool_hijack(ans):
            continue
        # Multi-site / N-links asks: reject wrong-shape memories (single clip, <N URLs).
        wants_list, list_n = _user_message_wants_website_link_list(q)
        if wants_list and not _reply_satisfies_website_link_list(ans, list_n):
            continue
        # Video discovery: stale single-clip memories are not authoritative — always re-search.
        if _user_message_seeks_web_video_discovery(q) or _user_message_wants_single_playable_video(q):
            continue
        # How-to / definition: stored answer must share real content words with the ask.
        if intent in ("howto", "definition", "why"):
            stop = {
                "how", "do", "to", "the", "a", "an", "is", "are", "what", "why",
                "can", "i", "my", "me", "you", "please", "just", "tell", "from",
            }
            qtok = {
                t
                for t in re.split(r"[^\w]+", q.lower())
                if len(t) > 2 and t not in stop
            }
            atok = {
                t
                for t in re.split(r"[^\w]+", ans.lower())
                if len(t) > 2 and t not in stop
            }
            if qtok and len(qtok & atok) < max(1, (len(qtok) + 1) // 2):
                continue
        dist = r.get("distance")
        try:
            d = float(dist) if dist is not None else 0.8
        except (TypeError, ValueError):
            d = 0.8
        src = (r.get("source") or "").lower()
        max_d = 1.75 if src == "chat" else 1.15
        if d > max_d:
            continue
        return ans[:4500]
    return ""


def _learn_good_chat_answer(store, user_q: str, reply: str) -> int:
    """
    Step 4 of the answer pipeline: ingest a usable final answer into the knowledge
    store (source=chat) so a later similar ask can hit knowledge-first.
    Dedupes near-identical User/Assistant turns already stored.
    """
    if not store:
        return 0
    u = (user_q or "").strip()
    a = (reply or "").strip()
    if not u or not a:
        return 0
    if _is_short_social_message(u) or _is_meta_feedback_message(u):
        return 0
    if len(a) < 48:
        return 0
    if (
        _local_llm_unusable_reply(a)
        or _looks_like_leaked_research_blob(a)
        or _looks_like_prompt_envelope_leak(a)
    ):
        return 0
    if _is_research_mem_noise_chunk(a):
        return 0
    u_tok = {t for t in re.split(r"[^\w]+", u.lower()) if len(t) > 1}
    a_tok = {t for t in re.split(r"[^\w]+", a.lower()[:900]) if len(t) > 1}
    try:
        hits = store.search(u, n_results=6, where={"source": "chat"}) or []
    except Exception:
        hits = []
    for h in hits:
        c = (h.get("content") or "").strip()
        if not c:
            continue
        user_part = c.split("Assistant:", 1)[0] if "Assistant:" in c else c[:400]
        cu_tok = {t for t in re.split(r"[^\w]+", user_part.lower()) if len(t) > 1}
        if u_tok and cu_tok and (len(u_tok & cu_tok) / max(1, len(u_tok))) >= 0.85:
            ca = _parse_assistant_from_memory_chunk(c)
            ca_tok = {t for t in re.split(r"[^\w]+", (ca or "").lower()[:900]) if len(t) > 1}
            if a_tok and ca_tok:
                overlap = len(a_tok & ca_tok) / max(1, min(len(a_tok), len(ca_tok)))
                if overlap >= 0.55:
                    return 0
    blob = f"User: {u[:2000]}\n\nAssistant:\n{a[:7500]}"
    try:
        return int(store.add(blob, source="chat", topic=u[:100]) or 0)
    except Exception:
        return 0


def _stub_web_help_reply() -> str:
    """Shown when web gathering failed or timed out—replaces the stub's multi-paragraph boilerplate."""
    return (
        "Butler could not pull fresh web snippets from Knowledge for that request (search came back empty, "
        "timed out, or DuckDuckGo helpers are not available in the Knowledge Python environment).\n\n"
        "Quick checks:\n"
        "- From the repo `knowledge` folder: `pip install -r requirements.txt` "
        "(includes `ddgs` / `duckduckgo-search`, `requests`, `beautifulsoup4`).\n"
        "- If you set **`BUTLER_STUB_WEB=0`**, set **`BUTLER_STUB_WEB=1`** for the bundled `:5000` stub, "
        "or point **`PEEPEEDEE_AI_URL` / `BUTLOR_AI_URL`** at **LM Studio** or **Ollama** (`POST /chat`).\n"
    ).strip()


def _chat_reply_needs_web_enrichment(reply: str) -> bool:
    if not _web_enrichment_enabled():
        return False
    r = (reply or "").strip()
    if not r:
        return True
    low = _normalize_reply_for_match(r)
    # Unusable / refusal → step 3 (web). Do not suppress enrichment for unreachable/refusal.
    if _local_llm_unusable_reply(r):
        return True
    if "sorry, the local ai could not be reached" in low:
        return True
    if "could not parse model output" in low:
        return True
    if "i'm here for you" in low and "learn your style" in low:
        return True
    if "don't have a direct answer" in low:
        return True
    if "i'm still learning from our conversations" in low:
        return True
    if "how can i help you today" in low and len(r) < 220:
        return True
    if "chat with me about anything" in low and len(r) < 220:
        return True
    if "couldn't turn it into a short answer" in low or "could not turn it into a short answer" in low:
        return True
    if "ask me again a bit more specifically" in low or "couldn't turn them into a clean answer" in low:
        return True
    return False


def _looks_like_pure_image_vision_qa(low: str) -> bool:
    """User likely wants a caption / OCR-style answer, not local SD."""
    return bool(
        low.startswith("what is ")
        or low.startswith("what's ")
        or low.startswith("who is ")
        or low.startswith("describe ")
        or low.startswith("read ")
        or "what do you see" in low
        or "what's in this" in low
        or "what is in this" in low
    )


def _user_message_suggests_local_sd_with_init_image(user_message: str) -> bool:
    """init_image present + message targets Comfy/local GPU rather than open-web Q&A."""
    um = (user_message or "").strip().lower()
    if len(um) < 4:
        return False
    if _looks_like_pure_image_vision_qa(um):
        return False
    tokens = (
        "comfy",
        "img2img",
        "image-to-image",
        "image to image",
        "stable diffusion",
        "sdxl",
        "checkpoint",
        "ip-adapter",
        "ipadapter",
        "controlnet",
        "loras",
        "lora ",
        "txt2img",
        "text2img",
        "unet",
        "ksampler",
        "vae encode",
        "image2video",
        "img2vid",
        "i2v",
        "wan ",
        "svd",
    )
    if any(t in um for t in tokens):
        return True
    video_still = (
        "animate this",
        "animate it",
        "bring this to life",
        "bring this photo to life",
        "turn this into a video",
        "make this a video",
        "motion from this",
        "image to video",
        "from this image",
        "from this photo",
        "from the attached",
    )
    if any(t in um for t in video_still):
        return True
    edit_verbs = (
        " restyle",
        " inpaint",
        " upscale",
        " redraw",
        " recolor",
        "remove ",
        " add ",
        "swap ",
        "replace ",
        "make her ",
        "make him ",
        "make them ",
        "turn her ",
        "turn him ",
        "edit ",
        "edit this",
        "change ",
        "change this",
        "transform ",
        "transform this",
        "nudify",
        " nude",
        " naked",
        "undress",
    )
    return any(t in um for t in edit_verbs)


def coerce_local_sd_modes_from_init_image(user_message: str, init_b64: str, out: dict) -> dict:
    """
    If the main model left mode as chat but the user attached an image and asked for local Comfy/SD work,
    promote to sd_img2img / sd_image2video so the host runs GPU instead of web enrichment.
    """
    if not isinstance(out, dict) or not (init_b64 or "").strip():
        return out
    m = str(out.get("mode") or "").strip().lower()
    if m != "chat":
        return out
    um = (user_message or "").strip()
    low = um.lower()
    if _looks_like_pure_image_vision_qa(low):
        return out
    if any(
        t in low
        for t in (
            "animate this",
            "animate it",
            "image2video",
            "image to video",
            "turn this into a video",
            "make this a video",
            "bring this photo to life",
            "bring this to life",
            "motion from this",
            "from this image",
            "from this photo",
            "from the attached",
        )
    ):
        return {**out, "mode": "sd_image2video", "prompt": um}
    if _user_message_suggests_local_sd_with_init_image(um):
        return {**out, "mode": "sd_img2img", "prompt": um}
    return out


def _model_requests_live_web(out: dict) -> bool:
    """True when Butler JSON asks the host for live/open-web augmentation (semantic decision in the dispatch object)."""
    if not isinstance(out, dict):
        return False
    v = out.get("needs_live_web")
    if isinstance(v, bool):
        return v
    if isinstance(v, str):
        return v.strip().lower() in ("1", "true", "yes")
    return False


def _user_message_wants_website_link_list(msg: str) -> tuple[bool, int]:
    """
    Detect explicit multi-link / website-list asks (e.g. "return 5 links", "5 websites").
    Returns (True, N) when the user wants a list of site URLs — not a single video/clip.
    """
    t = (msg or "").strip().lower()
    if len(t) < 8:
        return False, 0
    # Building/scaffolding a site is a tool route, not a link list.
    if re.search(r"\b(build|scaffold|create)\s+(a|an|the)\s+\w*(website|site|app)\b", t):
        return False, 0

    n = 0
    m = re.search(
        r"\b(?:return|give|find|list|show|send|need|want|get)\s+(?:me\s+)?"
        r"(\d{1,2})\s+(?:links?|urls?|websites?|sites?|homepages?)\b",
        t,
    )
    if m:
        n = int(m.group(1))
    if not n:
        m2 = re.search(r"\b(\d{1,2})\s+(?:links?|urls?|websites?|sites?)\b", t)
        if m2:
            n = int(m2.group(1))
    if not n and re.search(
        r"\b(?:list|return)\s+(?:of\s+)?(?:links?|urls?|websites?|sites?)\b",
        t,
    ):
        n = 5
    if not n and re.search(
        r"\b(?:links?|urls?)\s+to\s+(?:\w+\s+){0,6}(?:websites?|sites?|docs?|documentation)\b",
        t,
    ):
        n = 5
    if not n and (
        ("websites" in t or " websites" in f" {t}")
        and any(w in t for w in ("link", "links", "url", "urls", "list", "find", "return", "give"))
    ):
        n = 5
    if n < 2:
        return False, 0
    n = max(2, min(int(n), 12))

    # Pure single-clip / video-watch asks stay on the video path.
    video_primary = bool(
        re.search(r"\b(videos?|clips?|watch|stream|embed|play)\b", t)
        and not re.search(r"\b(websites?|sites?|homepages?|documentation|docs)\b", t)
    )
    if video_primary and not re.search(r"\b(websites?|sites?)\b", t):
        return False, 0
    return True, n


def _url_looks_like_video_clip_or_embed(url: str) -> bool:
    """True for watch/clip/embed/preview URLs — wrong shape for website-list asks."""
    low = (url or "").strip().lower()
    if len(low) < 12:
        return False
    if low.endswith((".mp4", ".webm", ".m3u8", ".mov", ".gif")):
        return True
    markers = (
        "youtube.com/watch",
        "youtu.be/",
        "m.youtube.com/watch",
        "/embed/",
        "player.vimeo.com",
        "twitter.com/",
        "x.com/",
        "t.co/",
        "yandex.ru/video",
        "yandex.com/video",
        "video.yandex.",
        "/video/preview",
        "view_video",
        "watch?v=",
        "facebook.com/watch",
        "fb.watch",
        "tiktok.com/",
        "twitch.tv/",
    )
    if any(m in low for m in markers):
        return True
    # Vimeo numeric watch pages (avoid bare vimeo.com marketing roots).
    if re.search(r"vimeo\.com/\d+", low):
        return True
    return False


def _extract_http_urls_from_text(text: str, *, limit: int = 24) -> list[str]:
    """Unique http(s) URLs from arbitrary reply/memory text, order preserved."""
    raw = (text or "").strip()
    if not raw:
        return []
    seen: set[str] = set()
    out: list[str] = []
    for m in re.finditer(r"https?://[^\s<>\"]+", raw):
        u = (m.group(0) or "").strip().rstrip(").,;:]\n\r\t\"'")
        if len(u) < 12 or u in seen:
            continue
        seen.add(u)
        out.append(u)
        if len(out) >= max(1, int(limit) or 24):
            break
    return out


def _prefer_distinct_website_urls(urls: list[str], n: int) -> list[str]:
    """Prefer distinct-host homepage/search/doc URLs over video clips for list asks."""
    want = max(1, min(int(n) or 5, 12))
    if not urls:
        return []
    scored: list[tuple[float, str]] = []
    for u in urls:
        low = u.lower()
        score = 10.0
        if _url_looks_like_video_clip_or_embed(u):
            score = -40.0
        try:
            from urllib.parse import urlparse

            p = urlparse(u)
            path = (p.path or "/").rstrip("/") or "/"
            if path == "/":
                score += 35.0
            elif path.count("/") <= 1 and len(path) < 48:
                score += 18.0
            host = (p.netloc or "").lower()
            if any(k in host or k in low for k in ("docs.", "/docs", "documentation", "readthedocs", "wiki")):
                score += 12.0
        except Exception:
            pass
        if len(low) > 180:
            score -= 6.0
        scored.append((score, u))
    scored.sort(key=lambda x: -x[0])
    seen_hosts: set[str] = set()
    seen_urls: set[str] = set()
    out: list[str] = []
    # Pass 1: unique hosts, skip clip URLs when any site-shaped URL exists.
    for score, u in scored:
        if score < 0 and any(s >= 0 for s, _ in scored):
            continue
        try:
            from urllib.parse import urlparse

            host = (urlparse(u).netloc or "").lower().removeprefix("www.")
        except Exception:
            host = u.lower()
        if host in seen_hosts or u in seen_urls:
            continue
        seen_hosts.add(host)
        seen_urls.add(u)
        out.append(u)
        if len(out) >= want:
            return out
    # Pass 2: pad to requested count with remaining non-clip URLs (same host OK).
    for score, u in scored:
        if u in seen_urls or score < 0:
            continue
        seen_urls.add(u)
        out.append(u)
        if len(out) >= want:
            break
    return out


def _reply_satisfies_website_link_list(reply: str, n: int) -> bool:
    """
    True when a candidate answer already has enough distinct non-clip site URLs.
    Wrong-shape: single video/preview URL, or fewer than N http(s) links.
    """
    want = max(2, min(int(n) or 5, 12))
    urls = _extract_http_urls_from_text(reply, limit=24)
    if len(urls) < want:
        return False
    if len(urls) == 1 and _url_looks_like_video_clip_or_embed(urls[0]):
        return False
    siteish = [u for u in urls if not _url_looks_like_video_clip_or_embed(u)]
    if len(siteish) < max(2, (want + 1) // 2):
        return False
    # Prefer distinct hosts when possible.
    hosts: set[str] = set()
    for u in siteish:
        try:
            from urllib.parse import urlparse

            hosts.add((urlparse(u).netloc or "").lower().removeprefix("www."))
        except Exception:
            hosts.add(u.lower())
    return len(hosts) >= max(2, min(want, 3))


def _synthesis_website_link_list_hint(user_message: str) -> str:
    wants, n = _user_message_wants_website_link_list(user_message)
    if not wants:
        return ""
    return (
        f"**Link list:** They asked for about **{n}** distinct **website** homepage/search/doc URLs — "
        "not a single video, Twitter/Yandex preview, or random clip from memory. "
        f"After a short intro, put a `Useful links:` block with **{n}** full https URLs from (B) "
        "(prefer site roots / official docs / search pages; unique hosts; do not invent URLs)."
    )


def _serp_urls_for_website_link_list(web_block: str, n: int) -> list[str]:
    """Collect distinct non-clip site URLs from SERP/card text — never invent domains."""
    want = max(2, min(int(n) or 5, 12))
    raw = (web_block or "").strip()
    if not raw:
        return []
    from_block = _extract_urls_from_web_block(raw, limit=40)
    cards = _web_result_cards(raw, limit=max(want + 6, 12))
    from_cards = [c.get("url") or "" for c in cards if (c.get("url") or "").strip()]
    return _prefer_distinct_website_urls(from_block + from_cards, want)


def _attach_serp_urls_to_name_list_reply(
    reply: str,
    web_block: str,
    preferred: list[str],
    n: int,
) -> str:
    """
    When the LLM listed site names/blurbs without http(s) URLs, attach matching SERP URLs.
    Falls back to appending a Useful links block from preferred (search-result) URLs only.
    """
    want = max(2, min(int(n) or 5, 12))
    body = (reply or "").strip()
    if not body or not preferred:
        return body
    cards = _web_result_cards(web_block or "", limit=max(want + 6, 12))
    used: set[str] = set(_extract_http_urls_from_text(body, limit=24))
    out_lines: list[str] = []
    for line in body.splitlines():
        out_lines.append(line)
        stripped = line.strip()
        if not stripped or stripped.lower().startswith("http://") or stripped.lower().startswith("https://"):
            continue
        if re.search(r"https?://", stripped):
            continue
        low = stripped.lower()
        matched = ""
        for c in cards:
            url = (c.get("url") or "").strip()
            if not url or url in used or _url_looks_like_video_clip_or_embed(url):
                continue
            title = (c.get("title") or "").strip()
            try:
                from urllib.parse import urlparse

                host = (urlparse(url).netloc or "").lower().removeprefix("www.")
            except Exception:
                host = ""
            host_root = host.split(".")[0] if host else ""
            title_words = [w for w in re.split(r"[^\w]+", title.lower()) if len(w) > 3][:3]
            host_hit = bool(host_root) and len(host_root) >= 4 and host_root in re.sub(r"\s+", "", low)
            title_hit = bool(title_words) and sum(1 for w in title_words if w in low) >= min(2, len(title_words))
            if host_hit or title_hit:
                matched = url
                break
        if matched:
            label = re.sub(r"^[\d\*•\-.\s]+", "", stripped)
            label = re.sub(r"\s+", " ", label).strip()[:80] or matched
            out_lines.append(f"[{label}]({matched})")
            used.add(matched)
    text = "\n".join(out_lines).strip()
    have = _extract_http_urls_from_text(text, limit=24)
    if len(have) >= want:
        return text
    pad = [u for u in preferred if u not in set(have)][: max(0, want - len(have))]
    if not pad:
        return text
    return (text + "\n\nUseful links:\n" + "\n".join(pad)).strip()


def _ensure_website_link_list_urls(reply: str, web_block: str, n: int) -> str:
    """
    Post-process so a 'return N links' answer always contains ≥N real http(s) URLs from SERP.
    Rejects/repairs name-only lists; never invents domains.
    """
    want = max(2, min(int(n) or 5, 12))
    body = (reply or "").strip()
    if _reply_satisfies_website_link_list(body, want):
        return body
    preferred = _serp_urls_for_website_link_list(web_block, want)
    if not preferred:
        # Still reject claiming a link list with zero/too-few URL patterns when we have nothing to attach.
        urls_now = _extract_http_urls_from_text(body, limit=24)
        if len(urls_now) >= want:
            return body
        return body
    if body and len(_extract_http_urls_from_text(body, limit=24)) < want:
        attached = _attach_serp_urls_to_name_list_reply(body, web_block, preferred, want)
        if _reply_satisfies_website_link_list(attached, want):
            return attached
        body = attached
    existing = _extract_http_urls_from_text(body, limit=24)
    merged: list[str] = []
    seen: set[str] = set()
    for u in existing + preferred:
        if not u or u in seen:
            continue
        if _url_looks_like_video_clip_or_embed(u) and any(
            not _url_looks_like_video_clip_or_embed(x) for x in preferred
        ):
            continue
        seen.add(u)
        merged.append(u)
        if len(merged) >= want:
            break
    if len(merged) < want:
        for u in preferred:
            if u in seen:
                continue
            seen.add(u)
            merged.append(u)
            if len(merged) >= want:
                break
    if not merged:
        return body
    if _reply_satisfies_website_link_list(body, want):
        return body
    intro = "Here are websites that match what you asked:"
    low_q_hint = (body or "").lower()
    if "documentation" in low_q_hint or "docs" in low_q_hint or "python" in low_q_hint:
        intro = "Here are official / documentation-style sites that match what you asked:"
    # Name-only or too-few-URL bodies: replace with SERP URLs (keep no invented domains).
    return f"{intro}\n\nUseful links:\n" + "\n".join(merged[:want])


def _user_message_seeks_web_video_discovery(msg: str) -> bool:
    """
    Host-side hint: user wants existing web video URLs (watch/stream/find), not GPU txt2video.
    Keeps phrasing topic-neutral; web results follow the user's actual query.
    """
    t = (msg or "").strip().lower()
    if len(t) < 6:
        return False
    # Explicit multi-website / N-links lists are not single-clip video discovery.
    if _user_message_wants_website_link_list(msg)[0]:
        return False
    if any(n in t for n in ("video codec", "video format", "video editor", "video editing software")):
        return False
    ytish = ("youtube" in t or "youtu.be" in t) and any(
        k in t
        for k in (
            "find",
            "watch",
            "play",
            "show",
            "give",
            "list",
            "result",
            "search",
            "link",
            "url",
            "video",
        )
    )
    if ytish:
        return True
    phrase_hit = any(
        p in t
        for p in (
            "play a video",
            "play video",
            "watch a video",
            "watch videos",
            "find videos",
            "find a video",
            "video to watch",
            "videos to watch",
            "watch online",
            "stream online",
            "where can i watch",
            "pull up a video",
            "pull up video",
            "embedded player",
            "embedded video",
            "give me links",
            "youtube results",
        )
    )
    if phrase_hit:
        return True
    if ("video" in t or "clip" in t or "stream" in t) and any(
        k in t for k in ("watch", "play", "find", "link", "url", "site", "sites", "online", "web", "tube", "embed")
    ):
        return True
    if "nsfw" in t and any(w in t for w in ("video", "videos", "stream", "clip", "watch", "site")):
        return True
    if "adult" in t and "video" in t:
        return True
    return False


def _user_message_wants_single_playable_video(msg: str) -> bool:
    """User wants one concrete watch/play URL—not a category hub, search page, or site filter."""
    if _user_message_wants_website_link_list(msg)[0]:
        return False
    t = (msg or "").strip().lower()
    if len(t) < 8:
        return False
    if "video" not in t and "clip" not in t:
        return False
    phrases = (
        "one video",
        "a single video",
        "single video",
        "one clip",
        "find one",
        "find me one",
        "pick one",
        "pick a video",
        "show me one",
        "give me one",
        "return one video",
        "return one clip",
        "return a video",
        "best match",
        "closest match",
        "one that matches",
        "one url",
        "one link",
        "play one",
        "embed one",
        "exactly one",
        "just one video",
        "only one video",
        "one specific",
    )
    if any(p in t for p in phrases):
        return True
    if re.search(r"\bone\b", t) and "video" in t and any(
        k in t for k in ("find", "want", "need", "give", "show", "return")
    ):
        return True
    if re.search(r"\breturn\s+one\b", t) and ("video" in t or "clip" in t):
        return True
    return False


_VIDEO_PICK_STOPWORDS = frozenset(
    {
        "video",
        "videos",
        "clip",
        "clips",
        "watch",
        "find",
        "give",
        "show",
        "return",
        "need",
        "want",
        "online",
        "stream",
        "streaming",
        "play",
        "embed",
        "link",
        "links",
        "url",
        "best",
        "single",
        "one",
        "actually",
        "really",
        "home",
        "made",
        "homemade",
        "amateur",
        "about",
        "from",
        "that",
        "this",
        "with",
        "your",
        "please",
        "matching",
        "match",
        "criteria",
        "specific",
        "made",
    }
)


def _year_constraints_from_user_message(msg: str) -> list[str]:
    """Explicit calendar years in the ask (e.g. 'made in 2026', 'from 2024')."""
    low = (msg or "").strip().lower()
    if not low:
        return []
    years: list[str] = []
    for m in re.finditer(r"\b(?:made in|from|in|dated|uploaded|posted)\s+(20\d{2}|19\d{2})\b", low):
        years.append(m.group(1))
    for y in re.findall(r"\b(20\d{2}|19\d{2})\b", low):
        if y not in years:
            years.append(y)
    return years[:3]


def _video_pick_topic_tokens(msg: str) -> set[str]:
    """Content words from the ask used to rank SERP video URLs (not host/platform words)."""
    low = (msg or "").strip().lower()
    toks = {
        w
        for w in re.findall(r"[a-z0-9]{3,}", low)
        if w not in _VIDEO_PICK_STOPWORDS and not re.fullmatch(r"20\d{2}|19\d{2}", w)
    }
    return toks


def _iter_video_result_cards(web_block: str, *, limit: int = 24) -> list[dict[str, str]]:
    """SERP cards with title + url + snippet from gathered web text."""
    return _web_result_cards(web_block, limit=limit)


def _playable_video_url_from_card(card: dict[str, str]) -> str:
    """True watch/clip URLs only — not search hubs, previews, or category pages."""
    url = (card.get("url") or "").strip()
    if not url.startswith("http"):
        return ""
    low = url.lower()
    bad_hosts = (
        "twitter.yandex",
        "yandex.ru/video/search",
        "yandex.com/video/search",
        "google.com/search",
        "bing.com/search",
    )
    if any(b in low for b in bad_hosts):
        return ""
    bad_path = (
        "/search",
        "search?",
        "/results",
        "?q=",
        "/users/",
        "/channels/",
        "/playlist",
        "/playlists/",
        "/categories/",
        "/category/",
        "/browse",
        "page=",
        "/video/preview",
        "/video/search",
    )
    if any(b in low for b in bad_path):
        return ""
    good = (
        "watch?v=" in low,
        "youtu.be/" in low,
        "m.youtube.com/watch" in low,
        low.endswith((".mp4", ".webm", ".m3u8", ".mov")),
        "player.vimeo.com" in low,
        bool(re.search(r"vimeo\.com/\d+", low)),
        "/embed/" in low and ("youtube" in low or "youtu" in low or "vimeo" in low),
        "/view_video.php" in low,
        bool(re.search(r"/video[_/]", low)),
        "dailymotion.com/video/" in low,
        "twitch.tv/videos/" in low,
        "tiktok.com/" in low and "/video/" in low,
    )
    if not any(good):
        return ""
    return url


def _score_playable_video_candidate(card: dict[str, str], user_message: str) -> float:
    url = (card.get("url") or "").strip()
    if not url:
        return -999.0
    title = (card.get("title") or "").strip()
    snippet = (card.get("snippet") or "").strip()
    blob = f"{title} {snippet} {url}".lower()
    low = url.lower()
    s = 0.0
    if "watch?v=" in low or "youtu.be/" in low or "m.youtube.com/watch" in low:
        s += 35.0
    if low.endswith((".mp4", ".webm", ".m3u8")):
        s += 40.0
    if "player.vimeo.com" in low or re.search(r"vimeo\.com/\d+", low):
        s += 32.0
    if "/embed/" in low and ("youtube" in low or "youtu" in low or "vimeo" in low):
        s += 28.0
    if "/view_video.php" in low or re.search(r"/video[_/]", low):
        s += 18.0
    topic = _video_pick_topic_tokens(user_message)
    if topic:
        hits = sum(1 for t in topic if t in blob)
        miss = len(topic) - hits
        s += hits * 14.0
        s -= miss * 9.0
        if hits == 0:
            s -= 55.0
    years = _year_constraints_from_user_message(user_message)
    if years:
        if any(y in blob for y in years):
            s += 70.0
        else:
            s -= 85.0
    if "how youtube works" in blob or "about press copyright" in blob:
        s -= 120.0
    if len(low) > 180:
        s -= 8.0
    return s


def _pick_best_playable_video_url(web_block: str, user_message: str) -> str:
    """
    From gathered research text, pick one SERP-backed watch/clip URL ranked by topic + year fit.
    Returns "" when nothing is a plausible single-video match.
    """
    cards = _iter_video_result_cards(web_block, limit=28)
    scored: list[tuple[float, str]] = []
    for card in cards:
        url = _playable_video_url_from_card(card)
        if not url:
            continue
        score = _score_playable_video_candidate(card, user_message)
        if score > -25.0:
            scored.append((score, url))
    if not scored:
        return ""
    scored.sort(key=lambda x: -x[0])
    best_score, best_url = scored[0]

    def _card_blob(url: str) -> str:
        b = url.lower()
        for card in cards:
            if (card.get("url") or "").strip() == url:
                return f"{card.get('title', '')} {card.get('snippet', '')} {url}".lower()
        return b

    topic = _video_pick_topic_tokens(user_message)
    years = _year_constraints_from_user_message(user_message)
    blob = _card_blob(best_url)
    if topic and not any(t in blob for t in topic):
        return ""
    if years and not any(y in blob for y in years):
        for score, url in scored[1:]:
            cb = _card_blob(url)
            if any(y in cb for y in years) and score > -25.0:
                if topic and not any(t in cb for t in topic):
                    continue
                return url
        return ""
    if best_score < 8.0:
        return ""
    return best_url


def _format_single_video_pick_reply(url: str) -> str:
    u = (url or "").strip()
    return (
        "Best single clip for your criteria (tap to open; many clients embed YouTube or direct video):\n"
        f"{u}"
    )


def _strip_refusal_lecture_tail(text: str) -> str:
    """Drop trailing hedges / ethics / hotline paragraphs after a factual lead."""
    t = (text or "").strip()
    if not t:
        return ""
    paras = [p.strip() for p in re.split(r"\n\s*\n", t) if p.strip()]
    if not paras:
        return ""
    lecture_bits = (
        "unable to find",
        "couldn't find",
        "could not find",
        "i couldn't find",
        "i could not find",
        "privacy and ethical",
        "privacy or ethical",
        "ethical norms",
        "please be aware",
        "might not adhere",
        "seek professional",
        "hotline",
        "helpline",
        "i'm unable to",
        "i am unable to",
        "unfortunately, i",
        "as a responsible",
        "in good conscience",
        "i strongly advise",
        "incredibly dangerous",
        "extremely dangerous",
    )
    kept: list[str] = []
    for p in paras:
        low = p.lower()
        if any(b in low for b in lecture_bits):
            continue
        if _local_llm_refusal_reply(p):
            continue
        kept.append(p)
    return "\n\n".join(kept).strip()


def _urls_from_web_block_set(web_block: str) -> set[str]:
    return set(_extract_urls_from_web_block(web_block, limit=80))


def _reply_has_urls_not_in_web(reply: str, web_block: str) -> bool:
    allowed = _urls_from_web_block_set(web_block)
    for u in _extract_http_urls_from_text(reply, limit=24):
        if u not in allowed:
            return True
    return False


def _finalize_single_video_pick_reply(raw_reply: str, web_block: str, user_message: str) -> str:
    """
    One SERP-backed watch URL when possible; never append refusal tails; no invented URLs.
    """
    bestv = _pick_best_playable_video_url(web_block, user_message)
    if bestv:
        return _format_single_video_pick_reply(bestv)
    cleaned = _strip_refusal_lecture_tail(raw_reply or "")
    if cleaned and not _reply_has_urls_not_in_web(cleaned, web_block) and not _local_llm_refusal_reply(cleaned):
        return cleaned[:12000]
    return "No matching playable video URL showed up in search for that ask."


def _web_synth_timeout_sec() -> float:
    """Local LLM pass that turns web+memory into one answer. Hosts with fast GPU can raise (max 600)."""
    raw = (os.environ.get("BUTLER_WEB_SYNTH_TIMEOUT_SEC") or "").strip()
    try:
        v = float(raw) if raw else 120.0
    except ValueError:
        v = 120.0
    return max(35.0, min(v, 600.0))


def _web_synth_budget_fraction() -> float:
    """Share of BUTLER_WEB_ENRICH_BUDGET_SEC reserved before skipping synthesis."""
    try:
        v = float((os.environ.get("BUTLER_WEB_SYNTH_BUDGET_FRACTION") or "0.92").strip())
    except ValueError:
        v = 0.92
    return max(0.55, min(v, 0.99))


def _web_synthesis_enabled() -> bool:
    v = (os.environ.get("BUTLER_WEB_SYNTHESIS") or "1").strip().lower()
    return v not in ("0", "false", "no", "off")


def _memory_research_query_variants(user_message: str) -> list[str]:
    """Extra query strings help JSONL token-overlap retrieval on multi-line or padded asks."""
    u = (user_message or "").strip()
    if not u:
        return []
    out: list[str] = []
    seen: set[str] = set()

    def push(x: str) -> None:
        s = (x or "").strip()
        if len(s) < 6 or s.lower() in seen:
            return
        seen.add(s.lower())
        out.append(s)

    push(u)
    first_line = u.split("\n", 1)[0].strip()
    push(first_line)
    qm = u.find("?")
    if qm > 8:
        push(u[: qm + 1].strip())
    return out[:4]


def _essay_sized_chat_reply(reply: str) -> bool:
    """True when the model reply is long enough to feel like an unsolicited essay for a tight Q&A."""
    r = (reply or "").strip()
    if len(r) < 480:
        return False
    wc = len(r.split())
    return len(r) >= 520 or wc >= 120


def _narrow_factual_user_message(user_message: str) -> bool:
    """
    Structural: bounded factual / recommendation ask (not a request for a survey or tutorial).
    Used to force web+synthesis compression when the primary model bloated the reply (esp. local_only).
    """
    u = (user_message or "").strip()
    if not u:
        return False
    low = u.lower()
    essay_cues = (
        "explain ",
        "explanation",
        "overview",
        " in detail",
        "detailed ",
        " essay",
        "walk me",
        "everything about",
        "full guide",
        "comprehensive",
        "deep dive",
        "tutorial",
        "write ",
        "discuss ",
        "compare and",
        "pros and cons of everything",
    )
    if any(c in low for c in essay_cues):
        return False
    cooking_measure = (
        ("how many" in low or "how much" in low)
        and any(
            k in low
            for k in (
                "egg",
                "eggs",
                "omelet",
                "omelette",
                "pan",
                "skillet",
                "inch",
                "inches",
                " cm",
                "cup",
                "gram",
                "tbsp",
                "prep",
                "prepare",
                "serv",
            )
        )
    ) or (
        ("prepare" in low or "prep " in low)
        and any(k in low for k in ("egg", "eggs", "omelet", "omelette"))
        and ("how " in low or "many" in low)
    )
    max_len = 560 if cooking_measure else 320
    if len(u) > max_len:
        return False
    first = u.split("\n", 1)[0].strip()
    low1 = first.lower()
    if "?" in u:
        return True
    prefixes = (
        "how many ",
        "how much ",
        "how long ",
        "how often ",
        "how to ",
        "how do ",
        "how can ",
        "how should ",
        "what is ",
        "what's ",
        "what are ",
        "who ",
        "when ",
        "where ",
        "why ",
        "should i ",
        "can i ",
        "do i ",
        "is it ",
        "are there ",
        "does ",
        "did ",
    )
    if any(low1.startswith(p) for p in prefixes):
        lim = 220 if not cooking_measure else 400
        if len(first) <= lim:
            return True
    return False


def _synthesis_tight_factual_hint(user_message: str) -> str:
    """Extra system text when synthesizing from web+memory for a narrow ask."""
    parts: list[str] = []
    if _narrow_factual_user_message(user_message):
        parts.append(
            "**Question shape:** Narrow factual ask—not a survey, tutorial, or explainer. "
            "Cap narrative at **~220 words** before any `Useful links:` block (not a single sentence only). "
            "Opening sentence = the exact number, yes/no, or single recommendation they asked for."
        )
    low = (user_message or "").lower()
    cooking = any(k in low for k in ("egg", "eggs", "omelet", "omelette", "pan", "skillet")) and (
        "how many" in low
        or "how much" in low
        or "prepare" in low
        or "prep " in low
        or re.search(r"\b\d+(\.\d+)?\s*(inch|inches|cm|eggs?)\b", low) is not None
    )
    if cooking:
        parts.append(
            "**Quantified cooking:** They want **concrete counts and prep** tied to **their** pan/serving size—not a general article on the dish. "
            "Lead with: egg count (or tight range + reason), **how to prep eggs** for that omelet size, and any ratio tied to dimensions they gave. "
            "If sources disagree, state one sensible default in one short clause."
        )
    return "\n\n".join(parts) if parts else ""


def _synthesis_single_video_hint(user_message: str) -> str:
    if _user_message_wants_website_link_list(user_message)[0]:
        return ""
    if not _user_message_wants_single_playable_video(user_message):
        return ""
    return (
        "**One video:** They want **one** best-matching **watch/play** page—**not** a category directory, internal search URL, or filter results. "
        "Put that URL **first** after `Useful links:`. Prefer `watch?v=`, `youtu.be`, direct `.mp4`/`.webm`, or a single-video watch page from (B). "
        "Rank by title/snippet overlap with their topic; when they named a year (e.g. 2026), prefer results whose title/snippet mentions that year. "
        "Do **not** invent URLs, lecture about ethics/privacy, or hedge with 'unable to find'—only URLs from (B)."
    )


def _web_synth_max_tokens_for_message(
    *,
    include_link_lines: bool,
    tight_factual: bool,
) -> int | None:
    """Optional generation cap for OpenAI-compatible /chat hosts; None = caller default."""
    global_cap: int | None = None
    raw_g = (os.environ.get("BUTLER_WEB_SYNTH_MAX_TOKENS") or "").strip()
    if raw_g:
        try:
            g = int(raw_g)
            global_cap = g if g > 0 else None
        except ValueError:
            global_cap = None

    if tight_factual:
        try:
            cap = int((os.environ.get("BUTLER_WEB_SYNTH_NARROW_MAX_TOKENS") or "1400").strip())
        except ValueError:
            cap = 1400
        cap = max(600, min(cap, 3200))
        if include_link_lines:
            cap = min(cap + 400, 3600)
        if global_cap is not None:
            cap = min(cap, global_cap)
        return cap

    try:
        default_cap = int((os.environ.get("BUTLER_WEB_SYNTH_DEFAULT_MAX_TOKENS") or "2048").strip())
    except ValueError:
        default_cap = 2048
    default_cap = max(512, min(default_cap, 8192))
    if global_cap is not None:
        default_cap = min(default_cap, global_cap)
    return default_cap


_RESEARCH_MEM_NOISE_FRAGMENTS = (
    "skipped pasting raw",
    "skipped pasting raw excerpts",
    "summarizer didn't finish",
    "didn't get a clean synthesized answer",
    "didn't finish rewriting the fresh web",
    "narrow the question and i'll take another pass",
    "ask again or narrow the question",
    "couldn't compress them into a clean answer",
    "couldn't turn it into a short answer",
    "couldn't turn them into a clean answer",
    "ask me again a bit more specifically",
    "i've got some notes on that",
    "i've got notes on that",
    "i pulled web material but",
    "please send the question again",
    "split it into one fact at a time",
    "take another run at it",
    "try again shortly or ask a narrower question",
    "i'll retry; one focused sub-question",
    "had fresh web notes for this too",
    "butler synthesized this reply from saved memory",
    "butler synthesized this reply from memory plus fresh",
    "fresh search context where applicable",
    "butler synthesized answer (web-backed",
)


def _strip_butler_synthesis_disclaimer(text: str) -> str:
    """
    Remove leading meta lines the model or old memory sometimes prepend
    (e.g. 'Butler synthesized this reply from saved memory...').
    """
    if not (text or "").strip():
        return (text or "").strip()
    lines = (text or "").split("\n")
    i = 0
    while i < len(lines):
        raw = lines[i]
        L = raw.strip()
        if not L:
            i += 1
            continue
        low = L.lower()
        drop = False
        if "butler synthesized" in low and ("saved memory" in low or "fresh" in low):
            drop = True
        elif "fresh search context where applicable" in low:
            drop = True
        elif low.startswith("butler synthesized"):
            drop = True
        if not drop:
            break
        i += 1
    out = "\n".join(lines[i:])
    return out.strip()


def _is_research_mem_noise_chunk(text: str) -> bool:
    """Drop stored chunks that are our own 'synthesis failed' handoffs—prevents retrieve → fail loops."""
    low = _normalize_reply_for_match(text or "")
    return any(x in low for x in _RESEARCH_MEM_NOISE_FRAGMENTS)


def _memory_research_excerpts(store, user_message: str, max_chars: int = 3200) -> str:
    """Prior saved answers / research from the vector store (checked before fresh web)."""
    if _is_short_social_message(user_message) or _is_meta_feedback_message(user_message):
        return ""
    if not store or store.count() == 0:
        return ""
    variants = _memory_research_query_variants(user_message)
    if not variants:
        return ""
    intent = _question_intent(user_message)
    if intent in ("howto", "definition", "why"):
        max_chars = min(max_chars, 1800)
    rows: list[dict] = []
    seen_raw: set[str] = set()

    def add_hits(hits):
        for r in hits or []:
            if not isinstance(r, dict):
                continue
            c = (r.get("content") or "").strip()
            if len(c) < 40 or c in seen_raw:
                continue
            if _is_research_mem_noise_chunk(c):
                continue
            if not _memory_hit_relevant(user_message, r):
                continue
            if _content_is_research_scaffold(c) and len((user_message or "").strip()) < 40:
                continue
            seen_raw.add(c)
            rows.append(r)

    for q in variants:
        for src in ("chat", "internet_research"):
            try:
                add_hits(store.search(q, n_results=5, where={"source": src}))
            except Exception:
                pass
    if len(rows) < 3:
        for q in variants:
            try:
                add_hits(store.search(q, n_results=6))
            except Exception:
                pass
    ranked = sorted(rows, key=lambda r: _memory_hit_rank_key(user_message, r, intent))
    if intent in ("howto", "definition", "why"):
        shaped = [
            r
            for r in ranked
            if _memory_chunk_looks_answer_shaped(r.get("content") or "", intent)
        ]
        if shaped:
            ranked = shaped[:3]
    chunks: list[str] = []
    seen_clean: set[str] = set()
    for r in ranked:
        cleaned = _sanitize_memory_chunk_for_prompt(
            (r.get("content") or "").strip(),
            max_chars=900 if intent in ("howto", "definition", "why") else 1200,
        )
        if not cleaned or cleaned in seen_clean:
            continue
        # Drop mid-sentence scrapes that slipped past ranking.
        if cleaned[:1].islower():
            continue
        if _looks_like_leaked_research_blob(cleaned):
            continue
        seen_clean.add(cleaned)
        chunks.append(cleaned)
        if len(chunks) >= (2 if intent in ("howto", "definition", "why") else 5):
            break
    text = "\n\n---\n\n".join(chunks)
    return text[:max_chars] if text.strip() else ""

def _compact_research_allow_raw_web() -> bool:
    """When synthesis fails: paste flattened web text (legacy). Default off—prefer card prose."""
    return (os.environ.get("BUTLER_WEB_RAW_FALLBACK") or "").strip().lower() in ("1", "true", "yes", "on")


def _snippet_text_without_urls(web_block: str, max_chars: int = 3400) -> str:
    """Flatten web SERP/snippet blobs into plain prose cues without naked URLs."""
    t = web_block or ""
    t = re.sub(r"https?://[^\s<>\"]+\S*", "", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t[:max_chars] if max_chars > 0 else t


def _web_result_cards(web_block: str, *, limit: int = 4) -> list[dict[str, str]]:
    """Extract compact title/url/snippet cards from gathered SERP-style web text."""
    raw = (web_block or "").strip()
    if not raw:
        return []
    cards: list[dict[str, str]] = []
    seen: set[str] = set()
    for block in re.split(r"\n\s*---[^\n]*\n\s*", raw):
        lines = [re.sub(r"\s+", " ", x).strip() for x in block.splitlines() if x.strip()]
        if not lines:
            continue
        for i, line in enumerate(lines):
            if not line.startswith("http"):
                continue
            url = line.rstrip(").,;:]\n\r\t")
            if url in seen:
                continue
            seen.add(url)
            title = lines[i - 1] if i > 0 and not lines[i - 1].startswith("http") else ""
            snippet = ""
            for cand in lines[i + 1 :]:
                if cand.startswith("http") or cand == title:
                    continue
                if len(cand) >= 30:
                    snippet = cand
                    break
            cards.append({"title": title[:140], "url": url[:1200], "snippet": snippet[:360]})
            if len(cards) >= max(1, int(limit) or 4):
                return cards
    return cards


def _prose_answer_from_web_cards(cards: list[dict[str, str]], *, max_chars: int = 1800) -> str:
    """
    Stitch SERP cards into plain conversational prose — no URLs, no bullet headline digests.
    Prefer an imperfect direct answer over asking the user to rephrase.
    """
    sentences: list[str] = []
    seen: set[str] = set()
    for c in cards or []:
        snip = re.sub(r"\s+", " ", (c.get("snippet") or "").strip())
        title = re.sub(r"\s+", " ", (c.get("title") or "").strip())
        piece = snip if len(snip) >= 24 else (title if len(title) >= 12 else "")
        if not piece:
            continue
        key = piece[:90].lower()
        if key in seen:
            continue
        seen.add(key)
        if piece[-1] not in ".!?":
            piece = piece + "."
        sentences.append(piece)
        if len(" ".join(sentences)) >= max_chars:
            break
    if not sentences:
        return ""
    return " ".join(sentences)[:max_chars].strip()


def _compact_web_cards_fallback(web_block: str, *, include_link_lines: bool = False) -> str:
    """Deterministic useful fallback when local synthesis misses its budget."""
    cards = _web_result_cards(web_block, limit=5 if include_link_lines else 4)
    if not cards:
        return ""
    if include_link_lines:
        urls = [c["url"] for c in cards if c.get("url")]
        if not urls:
            return ""
        return "Here are the clearest links I found:\n\nUseful links:\n" + "\n".join(urls)

    # Conversational prose from snippets — never a title/URL digest and never a specificity hedge.
    return _prose_answer_from_web_cards(cards)


def _compact_research_fallback(
    user_message: str,
    memory_block: str,
    web_block: str,
    *,
    include_link_lines: bool = False,
) -> str:
    """
    Last resort when synthesis fails. Prefer memory + card prose (or links when requested).
    Never ask the user to be “more specific” when any usable material exists.
    Set BUTLER_WEB_RAW_FALLBACK=1 to restore legacy flattened-web paste.
    """
    um = (user_message or "").strip()
    want_video_pick = _user_message_seeks_web_video_discovery(um) or _user_message_wants_single_playable_video(um)
    wants_link_list, link_list_n = _user_message_wants_website_link_list(um)
    mem = (memory_block or "").strip()[:900]
    if mem and _is_research_mem_noise_chunk(mem):
        mem = ""
    web = (web_block or "").strip()
    if not mem and not web:
        return ""

    urls = _extract_urls_from_web_block(web, limit=12)
    if include_link_lines and not urls and web.strip():
        urls = _extract_urls_from_web_block(web, limit=40)
    if include_link_lines and urls and want_video_pick and not wants_link_list:
        bestv = _pick_best_playable_video_url(web, um)
        if bestv:
            urls = [bestv] + [u for u in urls if u != bestv][:11]
    if include_link_lines and urls and wants_link_list:
        urls = _prefer_distinct_website_urls(urls, link_list_n)
    allow_raw = _compact_research_allow_raw_web()
    parts: list[str] = []

    if include_link_lines and urls:
        if mem:
            parts.append(mem)
        parts.append(
            "Here are links that line up best with what you asked:\n\n"
            "Useful links:\n" + "\n".join(urls)
        )
        return ("\n\n".join(parts)).strip()[:4500]

    if include_link_lines and not urls and web:
        if mem:
            parts.append(mem)
        if allow_raw:
            web_clean = _snippet_text_without_urls(web, max_chars=2200)
            parts.append(
                "I couldn’t isolate neat clickable URLs this pass; here’s the substance I found:\n\n"
                + (web_clean or "—")
            )
        else:
            card_fallback = _compact_web_cards_fallback(web, include_link_lines=False)
            if card_fallback:
                parts.append(card_fallback)
            else:
                parts.append(
                    "I found material online but couldn’t isolate clean clickable URLs—"
                    "ask for links explicitly if you want me to list them."
                )
        return ("\n\n".join(parts)).strip()[:4500]

    # One concrete watch URL beats a generic timeout message when we have web context.
    if web.strip() and want_video_pick and not allow_raw:
        best_only = _pick_best_playable_video_url(web, um)
        if best_only:
            return _format_single_video_pick_reply(best_only)[:4500]
        if _user_message_wants_single_playable_video(um):
            return "No matching playable video URL showed up in search for that ask."

    web_clean = _snippet_text_without_urls(web, max_chars=2800) if web else ""
    if allow_raw:
        if mem:
            parts.append(mem)
        if web_clean:
            parts.append(web_clean)
        return ("\n\n".join(parts)).strip()[:4500]

    card_fallback = _compact_web_cards_fallback(web, include_link_lines=include_link_lines)

    # Memory-first when it is a real past answer, not research notes.
    if mem and not _looks_like_leaked_research_blob(mem):
        if card_fallback:
            return (mem + "\n\n" + card_fallback).strip()[:4500]
        return mem.strip()[:4500]
    if mem and _looks_like_leaked_research_blob(mem):
        mem = ""
    if card_fallback:
        return card_fallback.strip()[:4500]
    # Cards missing: still answer from flattened snippet prose when we have signal.
    if web_clean and len(web_clean) >= 40:
        # Avoid SERP mash shapes that leak-detection would reject again.
        clipped = re.sub(r"\s*---\s*", ". ", web_clean)
        clipped = re.sub(r"\s+", " ", clipped).strip()
        if clipped and _looks_like_leaked_research_blob(clipped):
            clipped = ""
        # Drop YouTube chrome / site footers that survived URL stripping.
        if clipped and (
            "how youtube works" in clipped.lower()
            or "about press copyright" in clipped.lower()
        ):
            clipped = ""
        if clipped and not _looks_like_leaked_research_blob(clipped):
            # How-to asks: keep only the first usable sentence cluster, not a page mash.
            if _question_intent(um) == "howto" and len(clipped) > 420:
                clipped = clipped[:420].rsplit(".", 1)[0].strip()
                if clipped and not clipped.endswith("."):
                    clipped += "."
            return clipped[:1600]
    return ""


def _extract_urls_from_web_block(web_block: str, *, limit: int = 10) -> list[str]:
    """
    Extract unique http(s) URLs from the gathered web context block (DDG snippets format).
    Keeps order, trims tracking junk, and caps count.
    """
    raw = (web_block or "").strip()
    if not raw:
        return []
    seen: set[str] = set()
    out: list[str] = []
    for m in re.finditer(r"https?://[^\s<>\"]+", raw):
        u = (m.group(0) or "").strip().rstrip(").,;:]\n\r\t")
        if len(u) < 12:
            continue
        if u in seen:
            continue
        seen.add(u)
        out.append(u)
        if len(out) >= max(1, int(limit) or 10):
            break
    return out


def _parse_classifier_provide_urls(raw: str) -> Optional[bool]:
    """Parse {\"provide_urls\": true|false} from model output; None if unknown."""
    s = (raw or "").strip()
    if not s:
        return None
    for pat in (r"```json\s*([\s\S]*?)\s*```", r"```\s*([\s\S]*?)\s*```"):
        m = re.search(pat, s)
        if m:
            s = m.group(1).strip()
            break
    try:
        o = json.loads(s)
        if isinstance(o, dict):
            v = o.get("provide_urls")
            if isinstance(v, bool):
                return v
            if isinstance(v, str):
                return v.strip().lower() in ("1", "true", "yes", "on")
    except json.JSONDecodeError:
        pass
    i, j = s.find("{"), s.rfind("}")
    if i >= 0 and j > i:
        try:
            o = json.loads(s[i : j + 1])
            if isinstance(o, dict):
                v = o.get("provide_urls")
                if isinstance(v, bool):
                    return v
        except json.JSONDecodeError:
            pass
    if re.search(r'"provide_urls"\s*:\s*true\b', s, re.I):
        return True
    if re.search(r'"provide_urls"\s*:\s*false\b', s, re.I):
        return False
    return None


def _user_message_likely_wants_urls_heuristic(user_message: str) -> bool:
    """Fast path: skip LLM URL-intent classifier when wording obviously asks for links."""
    um = (user_message or "").strip().lower()
    if not um:
        return False
    if "http://" in um or "https://" in um or "www." in um:
        return True
    if any(w in um for w in ("link", "links", "url", "urls", "website", "websites")):
        return True
    if "site:" in um or "sites " in um:
        return True
    if "find " in um and any(a in um for a in (" near", " in my area", " nearby", " local", " around me")):
        return True
    return False


_CLASSIFIER_SYSTEM = (
    "You classify one thing for Butler (a personal assistant).\n"
    "The user message is below. Set provide_urls to true if they want the reply to include clickable https links, "
    "pasteable URLs, embed/watch links, or a Useful links section—especially when they want to **find, watch, or play a video** "
    "(including **one specific** video matching criteria).\n"
    "Set false only for pure prose Q&A with no intent to open links (definitions, opinions) unless they still asked for a video URL.\n"
    "Reply with JSON only, no markdown: {\"provide_urls\": true} or {\"provide_urls\": false}"
)


def _openai_classify_provide_urls(user_message: str, openai_api_key: str) -> Optional[bool]:
    """Optional cloud URL-intent classify. Off unless BUTLER_CHAT_CLOUD=1."""
    if not _chat_cloud_llm_allowed():
        return None
    key = (openai_api_key or "").strip()
    if not key:
        return None
    try:
        from openai import OpenAI

        try:
            client = OpenAI(api_key=key, timeout=12.0)
        except TypeError:
            client = OpenAI(api_key=key)
        r = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": _CLASSIFIER_SYSTEM},
                {"role": "user", "content": (user_message or "").strip()[:6000]},
            ],
            response_format={"type": "json_object"},
            max_tokens=32,
        )
        raw = (r.choices[0].message.content or "").strip()
        return _parse_classifier_provide_urls(raw)
    except Exception:
        return None


def _user_message_wants_urls_in_reply(
    user_message: str,
    openai_api_key: str = "",
    *,
    local_only: bool = False,
    use_local_llm: bool = True,
) -> bool:
    """
    Semantic intent: should the assistant reply include URL lists / Useful links?
    Prefer local LLM; cloud classify only when BUTLER_CHAT_CLOUD=1.

    When use_local_llm is False (e.g. bundled stub calling back into agent): skip local
    classify to avoid peepee → stub → agent → peepee recursion.
    """
    off = (os.environ.get("BUTLER_URL_CLASSIFIER") or "1").strip().lower()
    if off in ("0", "false", "no", "off"):
        return False
    um = (user_message or "").strip()
    if not um:
        return False
    if _user_message_likely_wants_urls_heuristic(um):
        return True

    key = (openai_api_key or "").strip()
    if key and not local_only and _chat_cloud_llm_allowed():
        got = _openai_classify_provide_urls(um, key)
        if got is not None:
            return bool(got)

    if not use_local_llm:
        return False

    try:
        tout = float((os.environ.get("BUTLER_URL_CLASSIFIER_TIMEOUT_SEC") or "").strip() or "14")
    except ValueError:
        tout = 14.0
    tout = max(4.0, min(tout, 45.0))

    try:
        r = peepee_chat(
            messages=[
                {"role": "system", "content": _CLASSIFIER_SYSTEM},
                {"role": "user", "content": um[:6000]},
            ],
            model=LOCAL_MODEL,
            openai_api_key="",
            skip_stub_web=True,
            timeout_sec=tout,
        )
        raw = ((r.get("message") or {}).get("content") or "").strip()
        got = _parse_classifier_provide_urls(raw)
        if got is not None:
            return bool(got)
    except Exception:
        pass
    return False


def _synthesize_research_via_openai(
    user_message: str,
    memory_block: str,
    web_block: str,
    api_key: str,
    *,
    include_link_lines: bool = False,
) -> str:
    """
    Optional cloud merge when local synthesis is empty. Disabled unless BUTLER_CHAT_CLOUD=1
    (generation stays on local models by default).
    """
    if not _chat_cloud_llm_allowed():
        return ""
    if not _web_synthesis_enabled():
        return ""
    key = (api_key or "").strip()
    if not key:
        return ""
    togg = (os.environ.get("BUTLER_WEB_SYNTH_OPENAI_FALLBACK") or "0").strip().lower()
    if togg in ("0", "false", "no", "off"):
        return ""
    mem = (memory_block or "").strip()
    web = (web_block or "").strip()
    if not mem and not web:
        return ""
    try:
        from openai import OpenAI
    except ImportError:
        return ""

    if include_link_lines:
        sys = (
            "You are Butler. Merge saved memory (A) and research notes (B) into ONE helpful reply.\n"
            "(B) is private—infer facts only; do not quote or paste source wording. Short conversational paragraphs first.\n"
            "Do not open with meta lines about memory or web synthesis (never write e.g. 'Butler synthesized…' or "
            "'saved memory plus fresh search'). Start with the substance of your answer.\n"
            "Then add a line exactly: Useful links:\n"
            "followed by 2–8 full https URLs that appear in (B), one per line. Do not invent URLs.\n"
            "No JSON, no Sources section besides that block."
        )
        if _user_message_wants_single_playable_video(user_message):
            sys += (
                "\nPut **one** best **watch/play** URL first (real video page), not a category, site search, or filter results page."
            )
        list_hint = _synthesis_website_link_list_hint(user_message)
        if list_hint:
            sys += "\n" + list_hint
    else:
        sys = (
            "You are Butler. The user asked a question. You have (A) saved memory and (B) private research notes.\n"
            "Answer in your own plain words—direct answer first, proportionate length (short for narrow factual asks).\n"
            "Do not quote or paste from (B), do not list search-style bullets, no bare https URLs, no Sources/References.\n"
            "Do not open with meta lines about how you merged memory and web (never write e.g. 'Butler synthesized…').\n"
            "If notes conflict, mention uncertainty briefly then give your best practical answer."
        )

    um_s = (user_message or "").strip()[:6000]
    user_blob = (
        f"(A) Memory:\n{mem[:4000]}\n\n(B) Research notes (read only; synthesize, do not expose verbatim):\n{web[:10000]}\n"
        f"---\nUser question:\n{um_s}"
    )
    try:
        try:
            client = OpenAI(api_key=key, timeout=55.0)
        except TypeError:
            client = OpenAI(api_key=key)
        mtok = 1400 if include_link_lines else 1024
        r = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": sys},
                {"role": "user", "content": user_blob},
            ],
            max_tokens=mtok,
            temperature=0.35,
        )
        return (r.choices[0].message.content or "").strip()
    except Exception:
        return ""


def _synthesize_research_with_local_llm(
    user_message: str,
    memory_block: str,
    web_block: str,
    openai_api_key: str,
    *,
    include_link_lines: bool = False,
    deadline: float | None = None,
) -> str:
    """Local LLM turns memory + web snippets into plain English; retries with smaller context if empty."""
    if not _web_synthesis_enabled():
        return ""
    mem = (memory_block or "").strip()
    web = (web_block or "").strip()
    if not mem and not web:
        return ""
    if include_link_lines:
        sys = (
            "You are Butler (single-user assistant). The user wants URLs in the reply. "
            "You are given (A) saved Butler memory and (B) **private research notes** (scraped snippets and page text with URLs).\n"
            "(B) is **not** for the user to read—only you see it. Read for facts; **never** quote it, paste it, or mirror its phrasing, bullets, or order. "
            "Synthesize what you understood into **your own** conversational sentences first.\n"
            "Write ONE answer in plain conversational English.\n"
            "- First sentences must answer their **exact** ask—counts, links to open, or what to try—not a generic preamble "
            "or topic essay (e.g. if they asked how many of something, say the number first).\n"
            "- Ignore (B) blocks that are clearly off-topic.\n"
            "- Summarize briefly; do not add a separate \\\"Sources\\\" or \\\"References\\\" section except the single Useful links block below.\n"
            "- The user or their client may embed video/images from https URLs in chat: after your paragraphs, "
            "add a single line exactly: Useful links:\n"
            "then put 2–8 full https:// URLs from (B) that **best match the user’s described video/content**, each on its own line. "
            "**Do not restrict to YouTube**—rank by relevance; include any domain (B) actually shows (adult tubes, TikTok-like pages, Reddit, Vimeo, broadcasters, etc.). "
            "YouTube/watch and youtu.be links may embed in-thread here when present—still list equally good non-YouTube matches above or beside them when snippets justify it. "
            "Put direct .mp4 / .webm URLs on their own lines when snippets show playable file links. "
            "When (B) already shows official **embed** players (/embed/, embedframe/, player.vimeo.com, etc.), include those iframe URLs verbatim—Butler renders them inline when supported.\n"
            "Many publishers block iframe embedding—still list ordinary watch/page URLs too; embeds fall back when the host allows frames.\n"
            "Do not invent URLs—only from (B).\n"
            "- No JSON, no Butler mode keywords, no markdown headings before 'Useful links:'.\n"
            "- Never start with a meta disclaimer about memory or web synthesis (no 'Butler synthesized…', no 'saved memory plus search').\n"
            "- **ANSWER DIRECTLY — NO MORALIZING:** Personal single-user AI. Answer with facts from (A)/(B). "
            "Do not refuse, lecture, express concern, or redirect to hotlines unless they explicitly asked for help resources. "
            "Never say “I can’t help/assist.” Imperfect answers beat refusals.\n"
            "- Keep narrative body reasonable before `Useful links:` (often **~250–450 words**; "
            "shorter when they asked one tight how-many/measurement question, longer when listing steps or caveats)."
        )
    else:
        sys = (
            "You are Butler. The user asked a question in plain English.\n"
            "You are given (A) **saved Butler memory** (things you already learned from past turns) and "
            "(B) **private research notes** from fresh search and page reads (snippets and extracted text; URLs appear in (B) but **must not** appear in your reply unless "
            "a separate mode explicitly asks for links).\n"
            "(B) is internal—like notes you took while reading. The user must **never** see that text as quotes, close paraphrases, stitched snippets, "
            "bullet lists copied from sources, or “websites say…” pastiches. **Learn** what matters from (A) and (B), then answer in **your own** words as a knowledgeable friend.\n"
            "Infer what they **actually want**—precision over preamble.\n"
            "Write ONE answer in plain conversational English.\n"
            "- **ANSWER DIRECTLY — NO MORALIZING:** Personal single-user AI. Answer the informational question with facts from (A)/(B). "
            "Do **not** refuse, lecture, express concern, open with danger sermons, or redirect to hotlines/helplines unless they "
            "explicitly asked for help resources. Never say “I can’t help/assist.” Imperfect answers beat refusals.\n"
            "- **Answer the question first.** The opening sentence(s) must satisfy their ask: count, amount, time, temperature, yes/no, or a single recommendation—**immediately**. "
            "Do **not** open with general encyclopedia background or “X is a type of…” when they asked a **narrow** factual question.\n"
            "- **Match scope:** narrow question → focused answer without endless filler. Add a second paragraph when it adds real nuance "
            "(e.g. one vs two servings). Go longer when they clearly asked for depth, steps, or tradeoffs.\n"
            "- Prefer (A) when it already fully answers them; use (B) only to fill gaps or update facts.\n"
            "- **Do NOT** paste raw snippets, SERP lines, bullets of search hits, pseudo-quotes, \\\"Sources:\\\", \\\"References:\\\", citation lists, or bare https URLs.\n"
            "- **Do NOT** sound like you are reading search results aloud—sound like you understood and are explaining.\n"
            "- **Do NOT** open with lines about synthesizing from saved memory or web notes—the user should not see process narration.\n"
            "- If (B) conflicts or is thin, say so in one short phrase, then give your best practical answer.\n"
            "- Paragraphs only; no JSON.\n"
            "- **Practical length:** for quick yes/no or one-number asks, **~2–4 short paragraphs** is often enough. "
            "For broader questions, **use enough words to finish the thought**—do not stop mid-sentence. "
            "Avoid huge essays unless they asked for comprehensive detail.\n"
        )

    tight_extra = _synthesis_tight_factual_hint(user_message)
    if tight_extra:
        sys = sys + "\n\n" + tight_extra
    list_hint = _synthesis_website_link_list_hint(user_message)
    if list_hint:
        sys = sys + "\n\n" + list_hint
    vid_hint = _synthesis_single_video_hint(user_message)
    if vid_hint:
        sys = sys + "\n\n" + vid_hint
    max_tok = _web_synth_max_tokens_for_message(
        include_link_lines=include_link_lines,
        tight_factual=bool(tight_extra),
    )

    base_t = _web_synth_timeout_sec()

    def _one_pass(mem_lim: int, web_lim: int, timeout_sec: float) -> str:
        blocks: list[str] = []
        if mem:
            blocks.append(
                "(A) Saved Butler memory — use when it already answers the user.\n" + mem[:mem_lim]
            )
        if web:
            blocks.append(
                "(B) Private research (search snippets + page text). For your reading only; "
                "do not expose as quotes or copied prose in your reply.\n" + web[:web_lim]
            )
        user = (
            "User question:\n"
            + (user_message or "").strip()[:12000]
            + "\n\nReply to the user in your own words—direct answer first, proportional length. "
            "Do not paste or echo (B); only what you understood from it."
        )
        messages = [
            {"role": "system", "content": sys},
            {"role": "user", "content": "\n\n---\n\n".join(blocks) + "\n\n---\n\n" + user},
        ]
        try:
            r = peepee_chat(
                messages=messages,
                model=LOCAL_MODEL,
                openai_api_key=openai_api_key or "",
                skip_stub_web=True,
                timeout_sec=timeout_sec,
                max_tokens=max_tok,
            )
            return ((r.get("message") or {}).get("content") or "").strip()
        except Exception:
            return ""

    # Full context first, then tighter windows so smaller / busy models still complete.
    plans: list[tuple[int, int, float]] = [
        (3500, 9000, base_t),
        (2400, 5200, min(base_t, 95.0)),
        (1600, 3200, min(base_t, 75.0)),
        (1000, 2600, min(base_t, 62.0)),
        (700, 1800, min(base_t, 52.0)),
    ]
    for mi, wi, tout in plans:
        timeout_eff = tout
        if deadline is not None:
            remaining = deadline - time.monotonic()
            if remaining < 6.0:
                break
            timeout_eff = max(2.0, min(timeout_eff, remaining - 1.0))
        got = _one_pass(mi, wi, timeout_eff)
        if got:
            return got
    return ""


def _finalize_chat_with_web_fallback(
    out: dict,
    user_message: str,
    store,
    local_only: bool = False,
    openai_api_key: str = "",
    has_init_image: bool = False,
    retrieval_query: str = "",
) -> dict:
    if not isinstance(out, dict) or out.get("mode") != "chat":
        return out
    reply = _strip_butler_synthesis_disclaimer((out.get("reply") or "").strip())
    if _looks_like_leaked_research_blob(reply) or _looks_like_prompt_envelope_leak(reply):
        # Never surface research dumps or prompt/JSON-repair envelopes as the reply.
        reply = ""
    out = {**out, "reply": reply}
    um = (user_message or "").strip()
    # Meta-feedback turns must enrich against the prior substantive ask, not the complaint phrase.
    rq = (retrieval_query or "").strip() or um
    wants_link_list, link_list_n = _user_message_wants_website_link_list(rq)
    # Strong knowledge-first hit: skip web unless the memory answer itself is unusable
    # or wrong-shape for an explicit multi-website / N-links ask.
    if out.pop("_butler_knowledge_first", None):
        shape_ok = (not wants_link_list) or _reply_satisfies_website_link_list(
            reply, link_list_n
        )
        if (
            reply
            and shape_ok
            and not _local_llm_unusable_reply(reply)
            and not _looks_like_leaked_research_blob(reply)
            and not _reply_looks_like_tool_hijack(reply)
            and (
                _question_intent(rq) not in ("howto", "definition", "why")
                or _reply_topically_matches_ask(rq, reply)
            )
        ):
            return {**out, "reply": reply}
        reply = ""
        out = {**out, "reply": "", "needs_live_web": True}
    if _is_meta_feedback_message(um) and rq == um:
        # No prior question resolved — do not RAG/search the complaint text.
        return out
    low = rq.lower()
    if _is_short_social_message(um):
        # Greetings: skip memory/web enrichment (avoids Chroma dumps). Do not replace the
        # local model's reply with a canned phrase — clear leaks only.
        if _looks_like_leaked_research_blob(reply):
            return {**out, "reply": ""}
        return out
    if has_init_image and _user_message_suggests_local_sd_with_init_image(um):
        return out
    rnorm = _normalize_reply_for_match(reply)
    # Answer pipeline step 3: local LLM refused / unreachable / stub boilerplate → clear
    # the bad reply and force knowledge + web search/synth (still no cloud LLMs).
    model_unusable = _local_llm_unusable_reply(reply) or _reply_looks_like_tool_hijack(reply)
    # How-to / definition: off-topic confabulation (wrong subject) → clear for web/memory re-answer.
    if (
        reply
        and not model_unusable
        and _question_intent(rq) in ("howto", "definition", "why")
        and not _reply_topically_matches_ask(rq, reply)
    ):
        model_unusable = True
    if model_unusable:
        reply = ""
        out = {**out, "reply": "", "needs_live_web": True}
        rnorm = ""
    # List-of-websites asks: clear wrong-shape replies (single clip / <N links) and force web.
    if (
        wants_link_list
        and reply
        and not _reply_satisfies_website_link_list(reply, link_list_n)
    ):
        reply = ""
        out = {**out, "reply": "", "needs_live_web": True}
        rnorm = ""
    # Bundled stub sometimes returns an explanatory refusal instead of a real answer. Treat it as "thin"
    # so web enrichment can still merge memory + web into a proper answer (prose-first by default).
    stub_refusal = bool(model_unusable) or _stub_boilerplate_reply(reply)
    narrow = _narrow_factual_user_message(rq)
    essay_reply = _essay_sized_chat_reply(reply)
    force_compress = bool(narrow and essay_reply and _web_enrichment_enabled())
    # Repair turns after a bad dump: always try to re-answer the original ask.
    repair_reanswer = bool(_is_meta_feedback_message(um) and rq != um)
    if repair_reanswer:
        force_compress = True
        # Drop the failed prior-style dump so enrichment answers the resolved question.
        if (
            _essay_sized_chat_reply(reply)
            or _looks_like_leaked_research_blob(reply)
            or len(reply) > 160
            or not reply
        ):
            reply = ""
            out = {**out, "reply": ""}
    # How-to / definition asks that got a topic mash instead of an answer → re-synthesize.
    if (
        _question_intent(rq) in ("howto", "definition", "why")
        and essay_reply
        and (_looks_like_leaked_research_blob(reply) or len(reply) > 420)
        and _web_enrichment_enabled()
    ):
        force_compress = True
    factualish = (
        repair_reanswer
        or "?" in rq
        or low.startswith("what ")
        or low.startswith("how ")
        or low.startswith("why ")
        or low.startswith("who ")
        or low.startswith("when ")
        or low.startswith("where ")
        or " explain " in low
    )
    thin_local = bool(
        local_only
        and len(rq) > 12
        and (
            stub_refusal
            or repair_reanswer
            or wants_link_list
            or (factualish and len(reply) < 420)
            or (narrow and essay_reply)
        )
    )
    if stub_refusal or repair_reanswer or wants_link_list:
        thin_local = True
    needs_live = _model_requests_live_web(out)
    seeks_web_video = _user_message_seeks_web_video_discovery(rq)
    wants_one_playable_video = _user_message_wants_single_playable_video(rq)
    # Website / N-links lists must not collapse to a single video-pick card.
    video_pick_mode = bool(
        (seeks_web_video or wants_one_playable_video) and not wants_link_list
    )
    needs_live_eff = bool(needs_live or video_pick_mode or wants_link_list)
    # Local-only: skip automatic DDG/planner/synthesis for "generic stub" turns — that path can take minutes
    # and often races Ctrl+C (stub dies → ECONNRESET). Still run when the model asked for live web or thin Q&A.
    if local_only and not needs_live_eff and not thin_local and not force_compress:
        return out
    if (
        not _chat_reply_needs_web_enrichment(reply)
        and not thin_local
        and not needs_live_eff
        and not force_compress
    ):
        return out
    try:
        from web_fetcher import gather_web_answer_context
    except ImportError:
        return out
    peepee_key = (openai_api_key or "").strip() if not local_only else ""
    wants_urls_in_reply = (
        _user_message_wants_urls_in_reply(
            rq, peepee_key, local_only=local_only, use_local_llm=True
        )
        or video_pick_mode
        or wants_link_list
    )

    t0 = time.monotonic()
    # Hard budget so discovery asks don't hang forever; degrade to compact/snippet answer when exceeded.
    # Override: BUTLER_WEB_ENRICH_BUDGET_SEC
    try:
        _braw = (os.environ.get("BUTLER_WEB_ENRICH_BUDGET_SEC") or "").strip()
        budget_sec = float(_braw) if _braw else (85.0 if video_pick_mode else 120.0)
        budget_sec = max(30.0, min(budget_sec, 600.0))
    except Exception:
        budget_sec = 120.0

    memory_excerpts = _memory_research_excerpts(store, rq)
    raw_web = ""

    _plan = None
    _agg = None
    _planner_on = False
    try:
        from search_planner import aggregate_planned_search_snippets as _agg
        from search_planner import plan_immediate_web_searches as _plan
        from search_planner import web_search_planner_enabled

        _planner_on = web_search_planner_enabled()
    except ImportError:
        pass

    # Video discovery: `gather_web_answer_context` already runs video boosts + overlap logic. The LLM search
    # planner then fans out to many full DDG bundles (each several metasearch calls)—rate limits + stub load
    # made video asks much slower and riskier to time out than a single gather + synthesis.
    use_planner = bool(
        _planner_on
        and _plan
        and _agg
        and (not video_pick_mode)
        and (
            needs_live_eff
            or repair_reanswer
            or (_chat_reply_needs_web_enrichment(reply) and len(rq) > 22)
        )
    )
    # Local-only stacks LLM → router → enrichment; keep planner/snippet breadth smaller so /chat finishes sooner.
    planner_cap = 4 if local_only else 8
    # Keep web context tighter for discovery to reduce synthesis time.
    if video_pick_mode:
        web_cap = 5200 if local_only else 8200
    else:
        web_cap = 7000 if local_only else 11000
    if use_planner:
        try:
            planned = _plan(rq, max_queries=planner_cap, openai_api_key=peepee_key)
            if planned:
                raw_web = (
                    _agg(planned, max_queries=planner_cap, max_total_chars=web_cap) or ""
                ).strip()
        except Exception:
            pass

    def _single_pass_gather() -> str:
        # Prefer answering from memory when it already looks solid — live SERP dumps
        # often derail how-to chat into headline digests.
        mem = memory_excerpts.strip()
        skip_web = (os.environ.get("BUTLER_WEB_SKIP_IF_MEMORY") or "1").strip().lower() in (
            "1",
            "true",
            "yes",
            "on",
        )
        min_mem = 120 if (
            repair_reanswer or _question_intent(rq) in ("howto", "definition", "why")
        ) else 280
        if skip_web and len(mem) >= min_mem and not needs_live_eff:
            return ""
        return (gather_web_answer_context(rq, max_chars=4500) or "").strip()

    if not raw_web.strip():
        raw_web = _single_pass_gather()

    # Don't expand thin web with more SERP when memory already answers the ask.
    _skip_mem = (os.environ.get("BUTLER_WEB_SKIP_IF_MEMORY") or "1").strip().lower() in (
        "1",
        "true",
        "yes",
        "on",
    )
    _min_mem = 120 if (
        repair_reanswer or _question_intent(rq) in ("howto", "definition", "why")
    ) else 280
    if len(raw_web.strip()) < 320 and not (
        _skip_mem and len(memory_excerpts.strip()) >= _min_mem and not needs_live_eff
    ):
        try:
            from web_fetcher import search_web_result_snippets_block

            bump = (search_web_result_snippets_block(rq, max_chars=4200) or "").strip()
            if len(bump) > len(raw_web.strip()):
                raw_web = bump
        except ImportError:
            pass

    if video_pick_mode and len(raw_web.strip()) < 720:
        try:
            from web_fetcher import search_web_result_snippets_block as _swb

            extras: list[str] = []
            qx = f"{rq} watch stream".strip()
            if len(qx) > 12:
                merged_x = (_swb(qx, max_results=6, max_chars=2800) or "").strip()
                if merged_x:
                    extras.append(merged_x)
            for y in _year_constraints_from_user_message(rq):
                yq = f"{rq} {y} video".strip()
                if len(yq) > 12:
                    merged_y = (_swb(yq, max_results=6, max_chars=2400) or "").strip()
                    if merged_y:
                        extras.append(merged_y)
                break
            if extras:
                cap = max(int(web_cap or 7000), 9500)
                raw_web = (
                    raw_web.strip()
                    + "\n\n--- video-oriented search ---\n\n"
                    + "\n\n---\n\n".join(extras)
                ).strip()[:cap]
        except ImportError:
            pass

    # Stub path has no DDG overlap filter; Knowledge gather can still return empty after aggressive overlap.
    # One raw DDG pass (titles+URLs+snippets) rescues many "empty after filter" cases.
    if stub_refusal and not raw_web.strip():
        try:
            from web_fetcher import search_web

            parts_u: list[str] = []
            for r in search_web(rq[:500], max_results=10) or []:
                title = (r.get("title") or "").strip()
                url = (r.get("url") or r.get("href") or "").strip()
                sn = (r.get("snippet") or r.get("body") or r.get("description") or "").strip()
                line = f"{title}\n{url}\n{sn}".strip()
                if line:
                    parts_u.append(line[:900])
            raw_web = ("\n\n---\n\n".join(parts_u)).strip()
        except Exception:
            pass

    if not memory_excerpts.strip() and not raw_web.strip():
        if stub_refusal or repair_reanswer:
            return {**out, "reply": _stub_web_help_reply()[:12000]}
        return out

    def _pack_final(synth_body: str) -> dict:
        _rd = (os.environ.get("BUTLER_RESEARCH_DISCLAIMER") or "").strip().lower()
        show_disclaimer = _rd in ("1", "true", "yes", "on")
    disclaimer = (
            "Note: not medical or legal advice—verify anything important.\n\n"
            if show_disclaimer and (raw_web.strip() or memory_excerpts.strip())
            else ""
        )
        merged_body = _prefer_reply_over_short_fallback(
            (out.get("reply") or "").strip(),
            (synth_body or "").strip(),
        )
        if _looks_like_leaked_research_blob(merged_body):
            # Prefer sanitized memory prose over any leftover digest.
            mem_only = (memory_excerpts or "").strip()
            if mem_only and not _looks_like_leaked_research_blob(mem_only):
                merged_body = mem_only[:4500]
            else:
                merged_body = ""
        new_reply = _strip_butler_synthesis_disclaimer(
            (disclaimer + (merged_body or "")).strip()
        )[:12000]
        if _looks_like_leaked_research_blob(new_reply):
            new_reply = ""
        if not new_reply.strip():
            # Last resort: keep prior non-leak reply, else best-effort from memory/web — never a specificity hedge.
            prior = (out.get("reply") or "").strip()
            if prior and not _looks_like_leaked_research_blob(prior):
                new_reply = prior
            else:
                new_reply = _compact_research_fallback(
                    rq,
                    memory_excerpts,
                    raw_web,
                    include_link_lines=wants_urls_in_reply,
                ).strip()
        if video_pick_mode:
            new_reply = _finalize_single_video_pick_reply(new_reply, raw_web, rq)
        if wants_link_list and not _reply_satisfies_website_link_list(new_reply, link_list_n):
            preferred = _serp_urls_for_website_link_list(raw_web, link_list_n)
            if preferred:
                # Drop wrong-shape single-clip / name-only bodies; synthesize a clean list locally.
                intro = (
                    "Here are official / documentation-style sites that match what you asked:"
                    if "documentation" in (rq or "").lower() or "docs" in (rq or "").lower()
                    else "Here are websites that match what you asked:"
                )
                new_reply = (
                    f"{intro}\n\nUseful links:\n" + "\n".join(preferred)
                )[:12000]
            else:
                fb = _compact_research_fallback(
                    rq,
                    memory_excerpts,
                    raw_web,
                    include_link_lines=True,
                ).strip()
                if fb and not _looks_like_leaked_research_blob(fb):
                    new_reply = fb[:12000]
        if _stub_boilerplate_reply(new_reply):
            fb = _compact_research_fallback(
                rq, memory_excerpts, raw_web, include_link_lines=wants_urls_in_reply
            )
            new_reply = (fb.strip() if fb.strip() else _stub_web_help_reply())[:12000]
        if _looks_like_leaked_research_blob(new_reply):
            # Never strip a valid multi-URL link-list answer as a "SERP dump".
            if not (
                wants_link_list
                and (
                    _reply_satisfies_website_link_list(new_reply, link_list_n)
                    or _looks_like_intentional_website_link_list_reply(new_reply)
                )
            ):
                fb = _compact_research_fallback(
                    rq, memory_excerpts, raw_web, include_link_lines=wants_urls_in_reply
                ).strip()
                if fb and not _looks_like_leaked_research_blob(fb):
                    new_reply = fb
                else:
                    card_only = _compact_web_cards_fallback(
                        raw_web,
                        include_link_lines=bool(wants_link_list or wants_urls_in_reply),
                    ).strip()
                    if card_only and not _looks_like_leaked_research_blob(card_only):
                        new_reply = card_only
                    else:
                        prior = (out.get("reply") or "").strip()
                        new_reply = prior if prior and not _looks_like_leaked_research_blob(prior) else ""
        # Final gate: name-only / too-few-URL link-list asks must gain real https from SERP.
        if wants_link_list:
            new_reply = _ensure_website_link_list_urls(
                new_reply, raw_web, link_list_n
            )[:12000]
        if not new_reply.strip() and repair_reanswer:
            fb = _compact_research_fallback(
                rq, memory_excerpts, raw_web, include_link_lines=False
            ).strip()
            if fb and not _looks_like_leaked_research_blob(fb):
                new_reply = fb
            elif (memory_excerpts or "").strip() and not _looks_like_leaked_research_blob(
                memory_excerpts
            ):
                new_reply = (memory_excerpts or "").strip()[:4500]
            else:
                new_reply = _stub_web_help_reply()[:12000]
        merged = {**out, "reply": new_reply}
        if store and not _is_research_mem_noise_chunk(new_reply) and not _looks_like_leaked_research_blob(new_reply):
            try:
                mem_blob = (
                    f"User: {(rq or '').strip()[:2000]}\n\n"
                    f"Assistant:\n{(new_reply[:7500].strip())}"
                )
            store.add(
                    mem_blob,
                source="internet_research",
                    topic=(rq[:120] or "chat"),
            )
        except Exception:
            pass
    return merged

    oa_merge_key = "" if local_only else (
        (openai_api_key or "").strip() or (os.environ.get("OPENAI_API_KEY") or "").strip()
    )

    # Budget guard: skip local/Peepee synthesis, but still allow a fast OpenAI merge + compact fallback.
    if (time.monotonic() - t0) > budget_sec:
        synthesized = ""
        if _web_synthesis_enabled() and oa_merge_key:
            synthesized = _synthesize_research_via_openai(
                rq,
                memory_excerpts,
                raw_web,
                oa_merge_key,
                include_link_lines=wants_urls_in_reply,
            )
        if not synthesized.strip():
            synthesized = _compact_research_fallback(
                rq, memory_excerpts, raw_web, include_link_lines=wants_urls_in_reply
            )
        if synthesized.strip():
            return _pack_final(synthesized.strip())
        if stub_refusal:
            return {**out, "reply": _stub_web_help_reply()[:12000]}
        return out

    synthesized = ""
    if _web_synthesis_enabled():
        # URLs in the assistant reply only when the user asked for citations or links explicitly.
        # Web/video discovery still runs in the background; the answer stays prose-first.
        # Avoid kicking off a long local LLM call when we're close to the budget.
        if (time.monotonic() - t0) < (budget_sec * _web_synth_budget_fraction()):
            synthesized = _synthesize_research_with_local_llm(
                rq,
                memory_excerpts,
                raw_web,
                peepee_key,
                include_link_lines=wants_urls_in_reply,
                deadline=t0 + (budget_sec * _web_synth_budget_fraction()),
            )
        if not synthesized.strip() and oa_merge_key.strip():
            synthesized = _synthesize_research_via_openai(
                rq,
                memory_excerpts,
                raw_web,
                oa_merge_key,
                include_link_lines=wants_urls_in_reply,
            )
    if not synthesized.strip():
        synthesized = _compact_research_fallback(
            rq, memory_excerpts, raw_web, include_link_lines=wants_urls_in_reply
        )
    if not synthesized.strip():
        if stub_refusal or repair_reanswer:
            # Never leave a repair turn empty — give whatever usable prose we can.
            fb = _compact_research_fallback(
                rq, memory_excerpts, raw_web, include_link_lines=wants_urls_in_reply
            ).strip()
            if fb and not _looks_like_leaked_research_blob(fb):
                return _pack_final(fb)
            return {**out, "reply": _stub_web_help_reply()[:12000]}
        return out

    return _pack_final(synthesized.strip())


def _owner_mode_enabled() -> bool:
    """Default on (unset). Set BUTLER_OWNER_MODE=0|false|off|no to disable."""
    v = (os.environ.get("BUTLER_OWNER_MODE") or "").strip().lower()
    if v in ("0", "false", "no", "off"):
        return False
    if v in ("1", "true", "yes", "on"):
        return True
    return True


def _get_web_context(msg: str, max_chars: int = 2800) -> str:
    """Fetch relevant info from the internet."""
    try:
        from web_fetcher import search_web
        results = search_web(msg, max_results=5)
        parts = []
        for r in results:
            snippet = (r.get("snippet") or r.get("body") or "").strip()
            if snippet:
                parts.append(snippet[:400])
        return "\n\n".join(parts)[:max_chars] if parts else ""
    except ImportError:
        return ""


def _memory_hit_relevant(query: str, row: dict, *, max_distance: float = 1.05) -> bool:
    """Reject Chroma/JSONL neighbors that are only weakly related to the current ask."""
    q = (query or "").strip()
    c = (row.get("content") or "").strip() if isinstance(row, dict) else ""
    if not q or not c:
        return False
    if _is_meta_feedback_message(q):
        # Never retrieve on complaint phrasing alone — caller should resolve the prior ask first.
        return False
    if _content_is_research_scaffold(c) and len(q) < 24:
        # Very short asks must not pull long research dumps into the system prompt.
        return False
    if _looks_like_leaked_research_blob(c) and len(q) < 24:
        # Allow clean chat turns (User/Assistant without research scaffolding).
        if _content_is_research_scaffold(c):
            return False
        asst = _parse_assistant_from_memory_chunk(c)
        if not asst or _looks_like_leaked_research_blob(asst):
            return False
    qtok = {t for t in re.split(r"[^\w]+", q.lower()) if len(t) > 1}
    if not qtok:
        return False
    # Prefer overlap with the stored User: line when present.
    user_m = re.search(
        r"User:\s*(.+?)(?=\n\nAssistant:|\n\n\[Supporting|\n\n---|\Z)",
        c,
        re.DOTALL | re.I,
    )
    focus = (user_m.group(1) if user_m else c)[:800]
    ctok = {t for t in re.split(r"[^\w]+", focus.lower()) if len(t) > 1}
    if not ctok:
        return False
    inter = len(qtok & ctok)
    intent = _question_intent(q)
    stop = {"how", "do", "to", "the", "a", "an", "is", "are", "what", "why", "can", "i", "my", "me"}
    content_q = {t for t in qtok if t not in stop and len(t) > 2}
    content_inter = len(content_q & ctok) if content_q else inter

    # Unrelated Butler product/jobs/pose memories must not win how-to retrieval.
    if intent in ("howto", "definition", "why") and _memory_looks_like_butler_feature_doc(c):
        feature_tok = {
            "job",
            "jobs",
            "resume",
            "apply",
            "gig",
            "gigs",
            "img2img",
            "pose",
            "silhouette",
            "comfy",
            "comfyui",
            "txt2img",
            "apartment",
        }
        if not (content_q & feature_tok):
            return False

    # Focused how-to / definition asks need tighter topical overlap than loose neighborhood matches.
    if intent in ("howto", "definition", "why"):
        if content_q and content_inter < max(1, (len(content_q) + 1) // 2):
            return False
        if len(qtok) <= 2:
            if inter < len(qtok):
                return False
        elif inter / len(qtok) < 0.45:
            return False
    else:
        if len(qtok) <= 2:
            if inter < len(qtok):
                return False
        elif inter / len(qtok) < 0.34:
            return False

    dist = row.get("distance") if isinstance(row, dict) else None
    try:
        d = float(dist) if dist is not None else None
    except (TypeError, ValueError):
        d = None
    if d is not None:
        # JSONL / weak embeddings often score >1.0 even on good keyword hits.
        try:
            hard_cap = float((os.environ.get("BUTLER_MEMORY_MAX_DISTANCE") or "2.35").strip() or "2.35")
        except ValueError:
            hard_cap = 2.35
        hard_cap = max(max_distance, min(hard_cap, 4.0))
        if d > hard_cap:
            return False
        if d > max_distance:
            strong = bool(content_q and content_inter >= max(1, (len(content_q) + 1) // 2))
            if not strong:
                return False
            answerish = _memory_chunk_looks_answer_shaped(c, intent)
            src = (row.get("source") or "").lower()
            if intent in ("howto", "definition", "why") and not answerish and src not in (
                "chat",
                "intent",
                "activity",
            ):
                return False
    return True


def _get_knowledge_context(store, msg: str, include_conversations: bool = True) -> str:
    """Pull RAG context: rank by question intent + answer-shaped memories; cap blocks per ask."""
    if _is_short_social_message(msg) or _is_meta_feedback_message(msg):
        return ""
    max_blocks = _memory_blocks_cap(msg)
    intent = _question_intent(msg)
    parts: list[str] = []
    if store and store.count() > 0:
        candidates: list[dict] = []
        seen: set[str] = set()

        def _collect(rows: list | None) -> None:
            for r in rows or []:
                if not isinstance(r, dict):
                    continue
                raw = (r.get("content") or "").strip()
                if not raw or raw in seen:
                    continue
                if not _memory_hit_relevant(msg, r):
                    continue
                seen.add(raw)
                candidates.append(r)

        # Weighted retrieval: intent/activity helps tool routing, but for how-to /
        # definition asks those memories are often jobs/SD product noise — skip them.
        if intent not in ("howto", "definition", "why"):
            try:
                _collect(
                    store.search(
                        msg,
                        n_results=10,
                where={"source": {"$in": ["intent", "activity"]}},
                    )
            )
        except Exception:
                pass
        try:
            _collect(store.search(msg, n_results=14))
        except Exception:
            pass
        if include_conversations and len(candidates) < max_blocks * 2:
            try:
                _collect(store.search(msg, n_results=10, where={"source": "chat"}))
            except Exception:
                pass

        ranked = sorted(candidates, key=lambda r: _memory_hit_rank_key(msg, r, intent))
        # For focused asks, prefer answer-shaped hits when any exist.
        if intent in ("howto", "definition", "why"):
            shaped = [r for r in ranked if _memory_chunk_looks_answer_shaped(r.get("content") or "", intent)]
            if shaped:
                # Focused asks: use answer-shaped memories only — do not append topic-neighborhood blobs.
                # Prefer chat-tier answers; keep at most 2 so one good reply isn't diluted.
                ranked = shaped[:2]
            else:
                # Still drop feature docs that slipped through relevance.
                ranked = [
                    r
                    for r in ranked
                    if not _memory_looks_like_butler_feature_doc(r.get("content") or "")
                ]

        for r in ranked:
            c = _sanitize_memory_chunk_for_prompt(
                (r.get("content") or "").strip(),
                max_chars=900 if intent in ("howto", "definition", "why") else 1100,
            )
            if not c or c in {p for p in parts}:
                    continue
                    parts.append(c)
                    if len(parts) >= max_blocks:
                        break
    # Live web in every system prompt tends to produce raw-snippet replies; off by default.
    # When enabled, inject as private cue text only — never a labeled internet dump the model can echo.
    if (os.environ.get("BUTLER_INJECT_WEB_IN_SYSTEM") or "0").strip().lower() in ("1", "true", "yes", "on"):
    web_ctx = _get_web_context(msg)
    if web_ctx:
            cue = _snippet_text_without_urls(web_ctx, max_chars=900)
            if cue and len(parts) < max_blocks:
                parts.append(cue)
    return "\n\n---\n\n".join(parts[:max_blocks]) if parts else ""


def _prefer_reply_over_short_fallback(original: str, candidate: str) -> str:
    """Keep a substantive model reply when web fallback only produced a shorter handoff."""
    o = (original or "").strip()
    c = (candidate or "").strip()
    if not c:
        return o
    if _looks_like_leaked_research_blob(c):
        return o if o and not _looks_like_leaked_research_blob(o) else ""
    if not o or _stub_boilerplate_reply(o) or _is_research_mem_noise_chunk(o) or _looks_like_leaked_research_blob(o):
        return c
    if _is_research_mem_noise_chunk(c):
        return o
    # Prefer a candidate that actually has clickable URLs over a long name-only list.
    o_http = len(re.findall(r"https?://", o, flags=re.I))
    c_http = len(re.findall(r"https?://", c, flags=re.I))
    if c_http >= 2 and o_http == 0:
        return c
    if (
        _looks_like_intentional_website_link_list_reply(c)
        and not _looks_like_intentional_website_link_list_reply(o)
    ):
        return c
    if len(o) >= 200 and len(c) < max(180, int(len(o) * 0.5)):
        return o
    return c


def _extract_reply_from_raw_loose(raw: str) -> str:
    """Recover reply text when the model returned chat JSON truncated mid-string."""
    raw = (raw or "").strip()
    if not raw:
        return ""
    parsed = _parse_butler_json_from_raw(raw)
    if isinstance(parsed, dict) and parsed.get("mode") == "chat":
        got = (parsed.get("reply") or "").strip()
        if got:
            return got
    m = re.search(r'"reply"\s*:\s*"', raw, re.I)
    if not m:
        return ""
    i = m.end()
    out: list[str] = []
    while i < len(raw):
        ch = raw[i]
        if ch == "\\" and i + 1 < len(raw):
            nxt = raw[i + 1]
            if nxt == "n":
                out.append("\n")
            elif nxt == "t":
                out.append("\t")
            elif nxt in ('"', "\\"):
                out.append(nxt)
            else:
                out.append(nxt)
            i += 2
            continue
        if ch == '"':
            break
        out.append(ch)
        i += 1
    return "".join(out).strip()


def _parse_butler_json_from_raw(raw: str) -> Optional[dict]:
    """Extract a Butler-shaped dict with a top-level mode from model output."""
    raw = (raw or "").strip()
    if not raw:
        return None
    candidates = []
    for pattern in (r"```json\s*([\s\S]*?)\s*```", r"```\s*([\s\S]*?)\s*```"):
        for m in re.finditer(pattern, raw):
            candidates.append(m.group(1).strip())
    obj_match = re.search(r"\{[\s\S]*\}", raw)
    if obj_match:
        candidates.append(obj_match.group(0))
    candidates.append(raw)
    for text in candidates:
        try:
            fixed = re.sub(r",\s*}", "}", re.sub(r",\s*]", "]", text))
            parsed = json.loads(fixed)
            if isinstance(parsed, dict) and parsed.get("mode"):
                return parsed
        except json.JSONDecodeError:
            continue
    return None


def _openai_butler_json(
    user_message: str,
    system_prompt: str,
    project_root: str,
    known_answers: dict,
    sample_files: list,
    file_policy: str,
    openai_api_key: str,
    background_context: str = "",
) -> Optional[dict]:
    """
    Optional cloud structured intent. Off unless BUTLER_CHAT_CLOUD=1 (local generation default).
    """
    if not _chat_cloud_llm_allowed():
        return None
    if os.environ.get("BUTLER_OPENAI_INTENT", "0").strip().lower() in ("0", "false", "no", "off"):
        return None
    key = (openai_api_key or "").strip()
    if not key:
        return None
    try:
        from openai import OpenAI
    except ImportError:
        return None
    # Keep the start of the prompt — it lists MODES; trailing-only truncation loses them.
    sys_compact = system_prompt if len(system_prompt) <= 16000 else (system_prompt[:12000] + "\n…\n" + system_prompt[-3500:])
    blob = {
        "instruction": user_message,
        "project_root": project_root,
        "known_answers": known_answers,
        "sample_files": (sample_files or [])[:40],
    }
    fp = (file_policy or "").strip()
    if fp:
        blob["butler_file_policy"] = fp
    bg = (background_context or "").strip()
    if bg:
        blob["code_workspace_background"] = bg
    try:
        client = OpenAI(api_key=key)
        r = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {
                    "role": "system",
                    "content": sys_compact
                    + '\n\nRespond with one JSON object only (valid JSON). Top-level key "mode" is required. No markdown.',
                },
                {"role": "user", "content": json.dumps(blob, indent=2)},
            ],
            response_format={"type": "json_object"},
            max_tokens=8192,
        )
        raw = (r.choices[0].message.content or "").strip()
        fixed = re.sub(r",\s*}", "}", re.sub(r",\s*]", "]", raw))
        out = json.loads(fixed)
        if isinstance(out, dict) and out.get("mode"):
            out["source"] = "OpenAI (structured intent)"
            return out
    except Exception:
        return None
    return None


def _openai_actions_last_resort(
    user_message: str,
    project_root: str,
    file_policy: str,
    openai_api_key: str,
    background_context: str = "",
) -> Optional[dict]:
    """
    Optional cloud actions planner. Off unless BUTLER_CHAT_CLOUD=1.
    """
    if not _chat_cloud_llm_allowed():
        return None
    if os.environ.get("BUTLER_OPENAI_INTENT", "0").strip().lower() in ("0", "false", "no", "off"):
        return None
    key = (openai_api_key or "").strip()
    if not key:
        return None
    try:
        from openai import OpenAI
    except ImportError:
        return None
    registry_hint = (
        ""
        if _owner_mode_enabled()
        else (
            "Never invent npm packages that do not exist on the registry (e.g. kali-tools returns 404—Kali is a Linux distro/VM, not npm).\n"
        )
    )
    sys_min = (
        "You are Butler's JSON planner. Reply with ONE JSON object only (no markdown).\n"
        'If the user only greets or wants pure Q&A with no files or commands, use {"mode":"chat","reply":"..."}.\n'
        "If they want software built, fixed, installed, packaged, or run (games, sites, scripts, .exe, Electron, npm, etc.), "
        'you MUST use {"mode":"actions","summary":"...","next_steps":[],"actions":[...]}.\n'
        "Actions: write_file (path + full content string), download_file, run_command (command + cwd, optional background:true), open_url.\n"
        "For a Windows desktop .exe: scaffold Electron (package.json, main.js, index.html) + devDependencies electron & electron-builder, "
        "then run_command npm install and npm run build in that folder. Use absolute paths under the user's Desktop when they asked for Desktop.\n"
        + registry_hint
        + "Obey file_policy if present. project_root is the session sandbox unless policy allows absolute paths.\n"
        "If they use Cursor’s terminal agent (Code tab / code_workspace_background): run_command with their CLI, cwd = project_root "
        "aligned with the Cursor workspace; shell only—not an IDE chat thread.\n"
        "For **3D-printable STL** (phone cases, brackets, enclosures, “3D model” to print), use "
        '{"mode":"print3d","description":"their full plain-English spec"}—never run_command or invented CLIs like '
        "cursor-cli create-model.\n"
        "For **music or sound samples from a text description** (beats, loops, ambient, SFX—not STT/TTS), use "
        '{"mode":"sound_musicgen","prompt":"full description of the sound"}.\n'
        "Emit complete file contents in JSON strings (escape newlines as \\n)."
    )
    blob = {
        "user_request": user_message,
        "project_root": project_root,
        "file_policy_excerpt": (file_policy or "")[:6000],
    }
    bg = (background_context or "").strip()
    if bg:
        blob["code_workspace_background"] = bg[:8000]
    try:
        client = OpenAI(api_key=key)
        r = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": sys_min},
                {"role": "user", "content": json.dumps(blob, indent=2)},
            ],
            response_format={"type": "json_object"},
            max_tokens=8192,
        )
        raw = (r.choices[0].message.content or "").strip()
        fixed = re.sub(r",\s*}", "}", re.sub(r",\s*]", "]", raw))
        out = json.loads(fixed)
        if isinstance(out, dict) and out.get("mode"):
            out["source"] = "OpenAI (actions fallback)"
            return out
    except Exception:
        return None
    return None


def _maybe_retry_agent_after_denial(
    result: dict,
    user_message: str,
    project_root: str,
    prior_messages: list | None,
    *,
    force_agent: bool = False,
) -> dict:
    """If chat reply denies machine access but user wanted agent work, run agent loop."""
    if not isinstance(result, dict):
        return result
    if result.get("mode") not in ("chat", None) or result.get("_butler_agent"):
        return result
    reply = (result.get("reply") or "").strip()
    if not reply:
        return result
    try:
        from butler_agent import (
            agent_mode_enabled,
            looks_like_agent_work,
            reply_denies_machine_access,
            run_agent_loop,
        )
    except Exception:
        return result
    if not agent_mode_enabled():
        return result
    if not (force_agent or looks_like_agent_work(user_message)):
        return result
    if not reply_denies_machine_access(reply):
        return result
    agent_out = run_agent_loop(
        user_message,
        project_root,
        prior_messages,
        force=True,
    )
    if agent_out.get("mode") == "agent" and agent_out.get("reply"):
        return agent_out
    return result


def chat_code_helper(
    user_message: str,
    system_prompt: str,
    prior_messages: list,
    known_answers: dict,
    sample_files: list,
    project_root: str,
    openai_api_key: str = "",
    file_policy: str = "",
    background_context: str = "",
    local_only: bool = False,
    has_init_image: bool = False,
    force_agent: bool = False,
) -> dict:
    """
    Answer pipeline (fully local generation — no OpenAI/Anthropic for chat text):

      1. Knowledge-first: strong store match → answer from memory (skip local LLM).
      2. Local LLM (BUTLOR_AI_URL / Ollama / stub).
      3. On refusal, unreachable host, or thin/insufficient reply → web search/scrape
         + local synthesis from memory/web (still no cloud LLMs).
      4. Learn: ingest usable final replies into the knowledge store (source=chat).

    Cloud chat LLMs stay off unless BUTLER_CHAT_CLOUD=1 (and not local_only).
    """
    # Generation stays local unless the operator explicitly opts into cloud chat overlays.
    use_cloud = bool(_chat_cloud_llm_allowed() and not local_only)
    structured_key = (openai_api_key or "").strip() if use_cloud else ""
    peepee_key = ""  # never forward cloud keys to the local LLM host for /chat
    store = KnowledgeStore() if KnowledgeStore else None
    retrieval_query, is_repair, prior_question = _llm_resolve_effective_user_query(
        user_message, prior_messages, local_only=True
    )
    hist_n = _prior_history_window()

    def _emit(result: dict) -> dict:
        result = _maybe_retry_agent_after_denial(
            result,
            user_message,
            project_root,
            prior_messages,
            force_agent=force_agent,
        )
        result = coerce_tool_mode_for_informational_ask(
            user_message,
            result if isinstance(result, dict) else {},
            prior_messages,
            has_init_image=has_init_image,
        )
        finalized = _finalize_chat_with_web_fallback(
            result,
            user_message,
            store,
            local_only=local_only or not use_cloud,
            openai_api_key=structured_key,
            has_init_image=has_init_image,
            retrieval_query=retrieval_query,
        )
        # Step 4: store good finals (local LLM or knowledge/web synth) for next knowledge-first hit.
        if isinstance(finalized, dict) and finalized.get("mode") == "chat":
            _learn_good_chat_answer(
                store,
                (retrieval_query or user_message or "").strip(),
                (finalized.get("reply") or "").strip(),
            )
        return finalized
    try:
        from butler_agent import agent_mode_enabled, looks_like_agent_work, run_agent_loop

        if agent_mode_enabled() and (force_agent or looks_like_agent_work(user_message)):
            if not (
                _knowledge_first_enabled()
                and not is_repair
                and not has_init_image
                and _is_short_social_message(user_message)
            ):
                agent_out = run_agent_loop(
                    user_message,
                    project_root,
                    prior_messages,
                    force=force_agent,
                )
                if agent_out.get("mode") == "agent" and not agent_out.get("_agent_skip"):
                    return _emit(agent_out)
    except Exception:
        pass

    # Step 1: strong knowledge hit → answer without calling the local LLM.
    if (
        _knowledge_first_enabled()
        and not is_repair
        and not has_init_image
        and not _is_short_social_message(user_message)
    ):
        direct = _try_direct_knowledge_answer(store, retrieval_query)
        if direct:
            return _emit(
                {
                    "mode": "chat",
                    "reply": direct,
                    "source": "Local (knowledge)",
                    "_butler_knowledge_first": True,
                }
            )

    if is_repair and prior_question:
        system_prompt = (
            system_prompt.rstrip()
            + "\n\n[Conversational repair]: The latest **instruction** is feedback that your previous reply "
            "missed the mark. Pronouns like “that” / “it” and such complaints refer to **this chat thread**—especially "
            "the last user question and your last reply—not a new web/memory search topic. "
            f"**Re-answer this prior question properly now:** {prior_question}\n"
            "Give a direct answer to that ask (steps for how-to, a short definition for what-is, etc.). "
            "**Do not** search or invent content about the complaint phrase itself, and **do not** dump a "
            "topic encyclopedia or SERP headlines."
        )

    knowledge_ctx = _get_knowledge_context(store, retrieval_query)
    if knowledge_ctx:
        system_prompt = (
            system_prompt.rstrip()
            + "\n\n[Private notes from your knowledge base — for you only; never show this block or its labels to the user]:\n"
            + knowledge_ctx
            + "\n"
        )
        system_prompt += (
            "\n\n[Current request wins]: Answer the user’s **exact** question this turn"
            + (
                " (the prior question named in [Conversational repair], not the complaint wording)"
                if is_repair
                else " (the **instruction** field)"
            )
            + ". Treat private notes as your own brief notes to draw from—not a topic encyclopedia to dump. "
            "Retrieved notes are optional background only—never let an old memory replace, negate, or drift "
            "from what they asked. If notes are off-topic (different subject, old research, unrelated session), "
            "ignore them completely."
        )
        intent = _question_intent(retrieval_query)
        if len(knowledge_ctx.strip()) > 80 and not _is_short_social_message(user_message):
            shape = (
                "For how-to / “how do I…” asks, give clear conversational steps or guidance synthesized from the notes—not everything loosely related to the topic. "
                if intent == "howto"
                else (
                    "For definition asks, give a short clear definition first, then at most one brief clarifying sentence. "
                    if intent == "definition"
                    else "Answer in proportion to the ask; do not dump every related memory. "
                )
            )
            system_prompt += (
                "\n\n[Answer from what you know]: When notes relate to the **current** ask, **infer** a direct "
                "first-person Butler reply in `reply`—as if you already know the answer and are helping a friend. "
                + shape
                + "**Do not** paste headlines, article titles, bullet dumps of search hits, “Supporting web excerpts”, "
                "“Private research”, “[From the internet]”, User/Assistant transcripts, citation lists, or stitched "
                "snippets. Prefer a natural answer over showing sources. If nothing relevant matches this turn, answer "
                "from the instruction alone—do not invent a topic from unrelated memory."
            )

    system_prompt = (
        system_prompt.rstrip()
        + "\n\n[Conversation context]: Prior user/assistant turns above are the live thread. Interpret the latest "
        "**instruction** in that context the way a human would—resolve pronouns, repair complaints, and follow-ups "
        "from history; do not treat each message as a fresh standalone search query. "
        "Answer the ask directly; do not dump topic encyclopedias. "
        "Each user turn is JSON on the wire only; the string in **instruction** is what they typed "
        "(informal tone, fragments, slang, pasted code are normal). "
        "**project_root**, **sample_files**, and other keys are environment for you. "
        "Your **reply** stays natural language; the structured dispatch object is for the host.\n"
        "[No sticky tools]: Do **not** keep jobs auto-apply, silhouette/pose automation, img2img, apartments, or "
        "other Butler tools active across turns unless the **current** instruction clearly asks for that tool. "
        "Short follow-ups like “just tell me how” continue the prior question in mode **chat**."
        )

    messages = [{"role": "system", "content": system_prompt}]
    for pm in (prior_messages or [])[-hist_n:]:
        role = pm.get("role", "user")
        content = pm.get("content", "")
        if role and content:
            # Prefer plain text for prior turns so the model reads conversation, not envelopes.
            if role == "user":
                content = _unwrap_history_user_content(content)
            messages.append({"role": role, "content": content})
    user_content = {
        "instruction": user_message,
        "project_root": project_root,
        "known_answers": known_answers,
        "sample_files": sample_files,
    }
    fp = (file_policy or "").strip()
    if fp:
        user_content["butler_file_policy"] = fp
    bg = (background_context or "").strip()
    if bg:
        user_content["code_workspace_background"] = bg
    messages.append({"role": "user", "content": json.dumps(user_content, indent=2)})

    try:
        r = peepee_chat(
            messages=messages,
            model=LOCAL_MODEL,
            openai_api_key=peepee_key,
            max_tokens=_main_chat_max_tokens(),
        )
        raw1 = (r.get("message") or {}).get("content") or ""
    except Exception as e:
        err = str(e)
        el = err.lower()
        unreachable = (
            "could not reach" in el
            or "actively refused" in el
            or "connection refused" in el
            or "errno 111" in el
            or "timed out" in el
            or "timeout" in el
            or "forcibly closed" in el
            or "connection reset" in el
            or "10054" in el
            or "10053" in el
            or "errno 104" in el
        )
        if structured_key and unreachable and use_cloud:
            oa_unreachable = _openai_butler_json(
                user_message,
                system_prompt,
                project_root,
                known_answers,
                sample_files,
                file_policy,
                structured_key,
                background_context=bg,
            )
            if oa_unreachable and isinstance(oa_unreachable, dict) and oa_unreachable.get("mode"):
                return _emit(oa_unreachable)
        hint = ""
        if unreachable:
            hint = (
                " Start your local LLM (BUTLOR_AI_URL / PEEPEEDEE_AI_URL — LM Studio, Ollama, or another "
                "OpenAI-compatible host serving POST /chat)."
            )
            if "timed out" in el or "timeout" in el:
                hint += (
                    " If the server **is** up but replies are slow, raise "
                    "**BUTLER_PEEPEE_HTTP_TIMEOUT_SEC** on Knowledge and **BUTLER_UI_CHAT_TIMEOUT_MS** on ui-server."
                )
            if "forcibly closed" in el or "10054" in el or "connection reset" in el:
                hint += " **WinError 10054** usually means the LLM host closed the socket—retry after it is idle."
        return _emit({
            "mode": "chat",
            "reply": f"Sorry, the local AI could not be reached: {err}.{hint}",
            "source": SOURCE_LABEL,
        })

    p1 = _parse_butler_json_from_raw(raw1)
    if p1 and p1.get("mode") and p1.get("mode") != "chat":
        p1["source"] = SOURCE_LABEL
        return _emit(p1)

    oa = None
    if use_cloud and structured_key:
        oa = _openai_butler_json(
            user_message,
            system_prompt,
            project_root,
            known_answers,
            sample_files,
            file_policy,
            structured_key,
            background_context=bg,
        )
    if oa and oa.get("mode") and oa.get("mode") != "chat":
        return _emit(oa)

    retry_system = (
        system_prompt.rstrip()
        + "\n\n[JSON repair pass]: The previous output was not valid Butler JSON, or used mode \"chat\" when the user may want real work. "
        "Re-read their instruction **and the prior conversation** and infer intent from **meaning**. "
        "If they want files created or edited, terminal commands, installs, builds, or packaged software, respond with one JSON object whose "
        "top-level \"mode\" is typically \"actions\" (write_file, run_command, etc.). If they only wanted conversation, use mode \"chat\". "
        "Output JSON only—no markdown fences, no prose outside the object."
    )
    retry_blob = {
        "instruction": user_message,
        "project_root": project_root,
        "known_answers": known_answers,
        "sample_files": sample_files,
        "previous_model_output_excerpt": (raw1 or "")[:1200],
        "parsed_mode_if_any": (p1 or {}).get("mode"),
    }
    if fp:
        retry_blob["butler_file_policy"] = fp
    if bg:
        retry_blob["code_workspace_background"] = bg
    messages_retry = [{"role": "system", "content": retry_system}]
    for pm in (prior_messages or [])[-min(hist_n, 16):]:
        role = pm.get("role", "user")
        content = pm.get("content", "")
        if role and content:
            if role == "user":
                content = _unwrap_history_user_content(content)
            messages_retry.append({"role": role, "content": content})
    messages_retry.append({"role": "user", "content": json.dumps(retry_blob, indent=2)})

    raw2 = ""
    try:
        r2 = peepee_chat(
            messages=messages_retry,
            model=LOCAL_MODEL,
            openai_api_key=peepee_key,
            max_tokens=_main_chat_max_tokens(),
        )
        raw2 = (r2.get("message") or {}).get("content") or ""
    except Exception:
        pass

    p2 = _parse_butler_json_from_raw(raw2)
    if p2 and p2.get("mode") and p2.get("mode") != "chat":
        p2["source"] = SOURCE_LABEL
        return _emit(p2)

    if use_cloud and structured_key:
        lr = _openai_actions_last_resort(
            user_message,
            project_root,
            file_policy,
            structured_key,
            background_context=bg,
        )
        if lr and lr.get("mode") and lr.get("mode") != "chat":
            return _emit(lr)

    if oa and oa.get("mode") == "chat":
        oa_reply = (oa.get("reply") or "").strip()
        if oa_reply and not _looks_like_prompt_envelope_leak(oa_reply):
        return _emit(oa)
    if p2 and p2.get("mode") == "chat":
        p2_reply = (p2.get("reply") or "").strip()
        if p2_reply and not _looks_like_prompt_envelope_leak(p2_reply):
        p2["source"] = SOURCE_LABEL
        return _emit(p2)
    if p1 and p1.get("mode") == "chat":
        p1_reply = (p1.get("reply") or "").strip()
        if p1_reply and not _looks_like_prompt_envelope_leak(p1_reply):
        p1["source"] = SOURCE_LABEL
        return _emit(p1)

    # Prefer first-pass text over JSON-repair echoes; never dump prompt envelopes.
    picked = _pick_chat_reply_from_model_raws(raw1, raw2)
    if picked:
        return _emit({"mode": "chat", "reply": picked, "source": SOURCE_LABEL})

    return _emit({
        "mode": "chat",
        "reply": "Could not parse model output.",
        "source": SOURCE_LABEL,
    })
