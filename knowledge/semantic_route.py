"""
LLM-only semantic routing for Butler /chat.

No host-side phrase tables that map loose tokens to tools — one compact model pass
classifies the turn. Host guards still force **chat** for clear how-to / definition /
follow-up Q&A so tool modes (jobs, silhouette/pose, SD) cannot hijack the turn.
Opt out: BUTLER_SEMANTIC_ROUTER=0|false|off|no
"""
from __future__ import annotations

import json
import os
import re
from typing import Any

from config import LOCAL_MODEL
from peepee_ai import chat as peepee_chat

ALLOWED_ROUTES = frozenset(
    {
        "chat",
        "actions",
        "jobs_auto_apply",
        "gigs_run",
        "jobs_prepare_materials",
        "jobs_add",
        "jobs_check_email",
        "jobs_upcoming_interviews",
        "apartments_setup",
        "apartments_show_config",
        "apartments_run",
        "open_cursor",
        "project_where",
        "questions",
        "sd_txt2img",
        "sd_img2img",
        "sd_image2video",
        "sd_txt2video",
        "print3d",
        "sound_musicgen",
    }
)

# Tool modes that must not stick onto unrelated informational asks.
TOOL_ROUTES = frozenset(
    {
        "actions",
        "jobs_auto_apply",
        "gigs_run",
        "jobs_prepare_materials",
        "jobs_add",
        "jobs_check_email",
        "jobs_upcoming_interviews",
        "apartments_setup",
        "apartments_show_config",
        "apartments_run",
        "open_cursor",
        "project_where",
        "sd_txt2img",
        "sd_img2img",
        "sd_image2video",
        "sd_txt2video",
        "print3d",
        "sound_musicgen",
    }
)

_FEATURE_HIJACK_MARKERS = (
    "silhouette",
    "pose reference",
    "openpose",
    "img2img",
    "txt2img",
    "utility panel",
    "job posting",
    "auto-apply",
    "auto apply",
    "cover letter",
    "which job",
    "gigs",
    "apartment search",
    "3d print",
    "musicgen",
)


def semantic_router_enabled() -> bool:
    v = (os.environ.get("BUTLER_SEMANTIC_ROUTER") or "1").strip().lower()
    return v not in ("0", "false", "no", "off")


def _extract_json_object(text: str) -> dict[str, Any] | None:
    raw = (text or "").strip()
    if not raw:
        return None
    raw = re.sub(r"^```(?:json)?\s*", "", raw, flags=re.I)
    raw = re.sub(r"\s*```\s*$", "", raw)
    start = raw.find("{")
    if start < 0:
        return None
    depth = 0
    for i, c in enumerate(raw[start:], start):
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(raw[start : i + 1])
                except json.JSONDecodeError:
                    return None
    return None


def _looks_like_explicit_tool_request(user_message: str, *, has_init_image: bool = False) -> bool:
    """True when the user clearly wants a Butler tool (jobs / Comfy / build), not Q&A."""
    um = (user_message or "").strip().lower()
    if not um:
        return False
    if has_init_image and any(
        t in um
        for t in (
            "edit",
            "restyle",
            "animate",
            "img2img",
            "image to video",
            "make this",
            "change this",
            "transform",
        )
    ):
        return True
    jobish = (
        "job application",
        "job applications",
        "apply to jobs",
        "auto-apply",
        "auto apply",
        "job search",
        "search for jobs",
        "find me a job",
        "find jobs",
        "cover letter",
        "tailor my resume",
        "job posting",
        "indeed.com",
        "linkedin.com/jobs",
    )
    if any(j in um for j in jobish):
        return True
    if re.search(r"\b(gigs?|upwork|freelance)\b", um) and any(
        w in um for w in ("find", "search", "run", "look", "apply")
    ):
        return True
    if any(
        t in um
        for t in (
            "generate an image",
            "generate a picture",
            "txt2img",
            "img2img",
            "stable diffusion",
            "comfyui",
            "render a video",
            "text to video",
            "image to video",
        )
    ):
        return True
    if re.search(r"\b(build|scaffold|create)\s+(a|an|the)\s+\w+", um) and any(
        w in um for w in ("app", "website", "site", "game", "extension", "script", "api", "project")
    ):
        return True
    agentish = (
        "code change",
        "make code",
        "edit my",
        "change my code",
        "fix my project",
        "run command",
        "run a command",
        "powershell",
        "my project",
        "my repo",
        "on my machine",
        "on my computer",
        "install npm",
        "npm install",
        "pip install",
    )
    if any(a in um for a in agentish):
        return True
    return False


def _prior_was_informational(prior_messages: list | None) -> bool:
    try:
        from agent import _last_substantive_user_from_prior, _question_intent
    except Exception:
        return False
    prior_q = _last_substantive_user_from_prior(prior_messages)
    if not prior_q:
        return False
    return _question_intent(prior_q) in ("howto", "definition", "why")


def is_informational_qa_turn(
    user_message: str,
    prior_messages: list | None = None,
    *,
    has_init_image: bool = False,
) -> bool:
    """
    Host guard: this turn should stay mode **chat** (answer the ask), not jobs/SD/etc.
    Conversation history + current message dominate over tool-feature memories.
    """
    um = (user_message or "").strip()
    if len(um) < 2:
        return False
    if _looks_like_explicit_tool_request(um, has_init_image=has_init_image):
        return False
    try:
        from agent import (
            _is_meta_feedback_message,
            _looks_like_context_dependent_followup,
            _question_intent,
        )
    except Exception:
        _question_intent = None  # type: ignore
        _looks_like_context_dependent_followup = None  # type: ignore
        _is_meta_feedback_message = None  # type: ignore

    if _question_intent:
        intent = _question_intent(um)
        if intent in ("howto", "definition", "why"):
            return True
    else:
        low = um.lower()
        if re.search(r"\bhow\s+(do|to|can|should)\b", low) or re.match(
            r"^(what\s+(is|are)\b|why\s+)", low
        ):
            return True

    # Explicit multi-link / website-list asks stay in chat (not jobs/SD/img2img).
    try:
        from agent import _user_message_wants_website_link_list

        if _user_message_wants_website_link_list(um)[0]:
            return True
    except Exception:
        if re.search(
            r"(?i)\b(?:return|give|find|list)\b.+\b(?:\d+\s+)?(?:links?|urls?|websites?)\b",
            um,
        ):
            return True

    # Short follow-ups / repair after a how-to or definition stay in chat.
    if _prior_was_informational(prior_messages):
        if _is_meta_feedback_message and _is_meta_feedback_message(um):
            return True
        if _looks_like_context_dependent_followup and _looks_like_context_dependent_followup(um):
            return True
        low = um.lower()
        if re.search(
            r"(?i)\b(just\s+)?(tell|explain|show|answer|give)\s+me\b",
            um,
        ) and len(um.split()) <= 18:
            return True
        if re.search(r"(?i)\bhow\s+(to|do|can)\b", um) and len(um.split()) <= 20:
            return True
        if low in ("yes", "yeah", "yep", "ok", "okay", "please", "go ahead", "do it"):
            return True
    return False


def _clarify_looks_like_feature_hijack(clarify: str, user_message: str) -> bool:
    """Reject clarifiers that invent Butler jobs/pose/SD topics the user never asked about."""
    c = (clarify or "").strip().lower()
    if not c:
        return False
    um = (user_message or "").strip().lower()
    for m in _FEATURE_HIJACK_MARKERS:
        if m in c and m not in um:
            return True
    return False


def _history_blob(prior_messages: list | None, *, max_turns: int = 8) -> str:
    if not prior_messages:
        return ""
    lines: list[str] = []
    for pm in (prior_messages or [])[-max_turns:]:
        if not isinstance(pm, dict):
            continue
        role = (pm.get("role") or "").strip().lower()
        if role not in ("user", "assistant"):
            continue
        content = str(pm.get("content") or "").strip()
        if not content:
            continue
        # Unwrap JSON instruction envelopes when present.
        if content.startswith("{") and "instruction" in content[:200]:
            try:
                from agent import _unwrap_history_user_content

                content = _unwrap_history_user_content(content)
            except Exception:
                pass
        lines.append(f"{role}: {content[:900]}")
    if not lines:
        return ""
    return "Recent conversation (for context only):\n" + "\n".join(lines) + "\n\n"


def apply_host_route_guards(
    result: dict[str, Any] | None,
    user_message: str,
    prior_messages: list | None = None,
    *,
    has_init_image: bool = False,
) -> dict[str, Any] | None:
    """
    Force chat + drop sticky tool routes / hallucinated feature clarifiers when the
    turn is clearly informational Q&A (including short follow-ups).
    """
    if not result or not isinstance(result, dict):
        return result
    out = dict(result)
    informational = is_informational_qa_turn(
        user_message, prior_messages, has_init_image=has_init_image
    )
    route = str(out.get("route") or "chat").strip().lower()
    clarify = str(out.get("clarify") or "").strip()

    if informational:
        out["route"] = "chat"
        out["confidence"] = max(float(out.get("confidence") or 0.5), 0.9)
        out["clarify"] = ""
        out["low_confidence"] = False
        if route in TOOL_ROUTES:
            out["rationale"] = (
                (out.get("rationale") or "").strip()
                + " [host: informational Q&A — forced chat, ignored tool route]"
            ).strip()
        return out

    if clarify and _clarify_looks_like_feature_hijack(clarify, user_message):
        out["clarify"] = ""
        out["route"] = "chat"
        out["low_confidence"] = True
        out["rationale"] = (
            (out.get("rationale") or "").strip()
            + " [host: dropped feature-hijack clarifier]"
        ).strip()
    return out


def classify_semantic_route(
    user_message: str,
    *,
    has_init_image: bool,
    openai_api_key: str = "",
    prior_messages: list | None = None,
) -> dict[str, Any] | None:
    """
    Returns {route, confidence, clarify, rationale, low_confidence} or None if
    disabled / LLM unreachable / unparseable.
    """
    if not semantic_router_enabled():
        return None
    um = (user_message or "").strip()
    if len(um) < 2:
        return {
            "route": "chat",
            "confidence": 1.0,
            "clarify": "",
            "rationale": "empty message",
            "low_confidence": False,
        }

    # Fast path: never spend a router turn inventing jobs/pose for clear Q&A.
    if is_informational_qa_turn(um, prior_messages, has_init_image=has_init_image):
        return {
            "route": "chat",
            "confidence": 0.95,
            "clarify": "",
            "rationale": "informational Q&A / how-to (host guard)",
            "low_confidence": False,
        }

    ctx = ""
    if has_init_image:
        ctx = "\n[Context: the user attached an image this turn — image edit / vision-style requests are more likely.]\n"
    hist = _history_blob(prior_messages)
    sys = (
        "You are a semantic router for Butler (a local assistant with tools). "
        "Read the operator's **latest** message in light of the recent conversation — meaning, goals, and "
        "context — not by scanning for magic words.\n"
        f"{ctx}"
        "Respond with ONLY one valid JSON object (no markdown), exactly these keys:\n"
        '  {"route":"<string>","confidence":0.0-1.0,"clarify":"<string or empty>","rationale":"<one short sentence>"}\n'
        "Rules:\n"
        "- `route` must be exactly one of:\n  "
        + ", ".join(sorted(ALLOWED_ROUTES))
        + "\n"
        "- Prefer `chat` whenever they are asking a how-to, what-is, why, opinion, or general knowledge "
        "question — including sensitive or unconventional topics. Answerability is not a reason to pick a tool.\n"
        "- Short follow-ups (“just tell me how”, “how do I do it”, “go ahead”) continue the **prior user ask** — "
        "do not switch to jobs, gigs, apartments, or image tools unless they clearly change the subject.\n"
        "- Never invent Butler product features in `clarify` (no silhouette/pose automation, no job auto-apply, "
        "no utility panel, no img2img) unless their words already named that feature.\n"
        "- If unsure which **tool** fits, set route `chat`, confidence < 0.65, and leave `clarify` empty "
        "(the main assistant will answer or ask). Do **not** ask about jobs or images as a default.\n"
        "- Use `jobs_auto_apply` / `jobs_*` only for employment search, applications, resumes, interviews.\n"
        "- Use `actions` when they want files written, code built, repos changed, or shell commands run.\n"
        "- Use `jobs_prepare_materials` when they gave job posting URLs and want tailored resume/cover material.\n"
        "- Use `sd_txt2img` when they want a new **synthetic** still image rendered on their machine. "
        "Use `sd_img2img` when they refer to editing an attached or recent image.\n"
        "- Use `sd_txt2video` only when they want Butler to **locally synthesize/render** a new motion clip "
        "(Comfy/GPU), not when they mean watch/find/play existing videos — those are `chat`.\n"
        "- Use `sd_image2video` when they want to animate a **specific uploaded/last image** locally.\n"
        "- Use `print3d` only when they want a physical 3D-printable model (STL/mesh).\n"
        "- Use `sound_musicgen` for music/jingle/sfx they want generated as audio.\n"
        "- If they mix goals, prefer `chat` with empty clarify unless one tool goal clearly dominates.\n"
    )
    user_blob = hist + f"Latest user message:\n{um[:12000]}"
    try:
        r = peepee_chat(
            messages=[
                {"role": "system", "content": sys},
                {"role": "user", "content": user_blob},
            ],
            model=LOCAL_MODEL,
            openai_api_key=openai_api_key or "",
            skip_stub_web=True,
        )
        raw = ((r.get("message") or {}).get("content") or "").strip()
    except Exception:
        return None
    obj = _extract_json_object(raw)
    if not isinstance(obj, dict):
        return None
    route = str(obj.get("route") or "chat").strip().lower()
    if route not in ALLOWED_ROUTES:
        route = "chat"
    try:
        conf = float(obj.get("confidence", 0.5))
    except (TypeError, ValueError):
        conf = 0.5
    conf = max(0.0, min(1.0, conf))
    clarify = str(obj.get("clarify") or "").strip()
    rationale = str(obj.get("rationale") or "").strip()
    # Prefer empty clarify — host no longer uses clarify as the whole reply.
    if conf < 0.65:
        clarify = ""
    low_confidence = bool(conf < 0.65)
    result = {
        "route": route,
        "confidence": conf,
        "clarify": clarify,
        "rationale": rationale,
        "low_confidence": low_confidence,
    }
    return apply_host_route_guards(
        result, um, prior_messages, has_init_image=has_init_image
    )


def routing_system_hint(route: str, rationale: str = "", *, low_confidence: bool = False) -> str:
    """Appended to the main Butler system prompt after addenda."""
    r = (route or "chat").strip()
    tail = f" Context: {rationale}" if (rationale or "").strip() else ""
    if low_confidence or r == "chat":
        if low_confidence:
            return (
                "\n\n[Semantic router]: A first pass was **uncertain** which tool fits. "
                "Use mode **chat** and answer their question directly from the conversation. "
                "Do **not** ask about job postings, silhouette/pose automation, img2img, or other Butler "
                f'tools unless they clearly asked. (Weak guess was "{r}" — ignore it if it does not match.)'
            )
        if r == "chat":
            return (
                "\n\n[Semantic router]: This turn is **chat** (Q&A / how-to / conversation). "
                'Your JSON must set `"mode":"chat"` and put a direct answer in `reply`. '
                "Do not switch into jobs, gigs, apartments, or image-generation modes. "
                "Prior thread context wins over any unrelated tool memories in private notes."
                f"{tail}"
            )
    return (
        "\n\n[Semantic router — host does not use regex / keyword tables on the user message]: "
        f'A first pass judged this turn as **"{r}"** from English alone.'
        f"{tail} "
        f'Your JSON must set `"mode":"{r}"` unless that would clearly mis-serve what they said — then use '
        '`mode` `"chat"` and explain briefly in `reply`. Never ask the user to name modes or write JSON.'
    )
