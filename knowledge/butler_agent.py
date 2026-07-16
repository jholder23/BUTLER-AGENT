"""
Butler Agent mode: local tool loop (shell, read/write files) for coding/system work.
Single-user; paths constrained by BUTLER_AGENT_ROOTS (default: D:\\, user profile, BUTLER repo).
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional

try:
    from butlor_paths import ensure_butlor_config_dir
except ImportError:
    ensure_butlor_config_dir = None  # type: ignore

try:
    from config import LOCAL_AGENT_MODEL
except ImportError:
    LOCAL_AGENT_MODEL = (
        os.environ.get("LOCAL_AGENT_MODEL")
        or os.environ.get("BUTLER_AGENT_MODEL")
        or "qwen2.5:7b-instruct"
    )

try:
    from peepee_ai import chat as peepee_chat
except ImportError:
    peepee_chat = None  # type: ignore

try:
    from agent_llm import (
        AGENT_FREE_PROVIDER_IDS,
        agent_llm_chat,
        build_fallback_chain,
        list_agent_providers,
        resolve_agent_llm,
    )
except ImportError:
    agent_llm_chat = None  # type: ignore
    list_agent_providers = None  # type: ignore
    resolve_agent_llm = None  # type: ignore
    build_fallback_chain = None  # type: ignore
    AGENT_FREE_PROVIDER_IDS = ()  # type: ignore

# Ranked free cloud agent models (best → worst). Fallback order when user picks a cloud provider.
# See agent_llm.py and .env.example for API keys and tier notes.
AGENT_FREE_MODEL_RANK: tuple[str, ...] = AGENT_FREE_PROVIDER_IDS or (
    "gemini",
    "groq",
    "openrouter",
    "mistral",
    "cohere",
)


def agent_mode_enabled() -> bool:
    """Default on. Set BUTLER_AGENT_MODE=0 to disable."""
    v = (os.environ.get("BUTLER_AGENT_MODE") or "1").strip().lower()
    return v not in ("0", "false", "no", "off")


def agent_max_iterations() -> int:
    """Max tool/LLM iterations per agent turn. Hard cap 40; default 16 for multi-step checklists."""
    raw = (os.environ.get("BUTLER_AGENT_MAX_ITERATIONS") or "16").strip()
    try:
        n = int(raw)
        return max(1, min(n, 40))
    except ValueError:
        return 16


_SKIP_DIR_NAMES = frozenset(
    {
        ".git",
        "node_modules",
        "__pycache__",
        ".venv",
        "venv",
        "dist",
        "dist-desktop",
        "dist-app-new",
        "dist-butler-new-install",
        "build",
        ".next",
        "coverage",
        ".pytest_cache",
        "knowledge_db",
        "python-embed",
        "win-unpacked",
        "win-ia32-unpacked",
    }
)


def _should_skip_dir(name: str) -> bool:
    n = (name or "").lower()
    if n in _SKIP_DIR_NAMES:
        return True
    if n.startswith("dist"):
        return True
    if n.startswith(".") and n not in (".", ".."):
        return True
    return False


def _butler_repo_root() -> Path:
    here = Path(__file__).resolve().parent
    if (here / "agent.py").is_file():
        return here.parent
    return here


def get_agent_roots() -> list[Path]:
    env = (os.environ.get("BUTLER_AGENT_ROOTS") or "").strip()
    roots: list[Path] = []
    if env:
        for part in re.split(r"[;,\n]+", env):
            p = part.strip()
            if p:
                roots.append(Path(os.path.realpath(os.path.expanduser(p))))
    else:
        if os.name == "nt":
            roots.append(Path("D:\\"))
        roots.append(Path.home())
        roots.append(_butler_repo_root())
    out: list[Path] = []
    seen: set[str] = set()
    for r in roots:
        try:
            key = str(r.resolve())
        except OSError:
            key = str(r)
        if key not in seen:
            seen.add(key)
            out.append(r)
    return out


def _path_under_root(candidate: Path, root: Path) -> bool:
    try:
        c = candidate.resolve()
        r = root.resolve()
    except OSError:
        return False
    try:
        c.relative_to(r)
        return True
    except ValueError:
        return False


def resolve_allowed_path(raw_path: str, project_root: str, roots: list[Path] | None = None) -> Path:
    """Resolve path; must fall under an allowed root or project_root."""
    if not (raw_path or "").strip():
        raise ValueError("path required")
    roots = roots or get_agent_roots()
    p = Path(os.path.expanduser(str(raw_path).strip()))
    if not p.is_absolute() and (project_root or "").strip():
        p = Path(project_root) / p
    try:
        resolved = p.resolve()
    except OSError as e:
        raise ValueError(f"invalid path: {raw_path}") from e
    proj = Path(project_root).resolve() if (project_root or "").strip() else None
    if proj and _path_under_root(resolved, proj):
        return resolved
    for root in roots:
        if _path_under_root(resolved, root):
            return resolved
    raise ValueError(f"path not allowed (outside BUTLER_AGENT_ROOTS): {resolved}")


def _agent_log_path() -> Path:
    if ensure_butlor_config_dir:
        d = ensure_butlor_config_dir()
    else:
        d = Path(os.environ.get("BUTLOR_CONFIG") or r"D:\butlor")
        d.mkdir(parents=True, exist_ok=True)
    return d / "agent_commands.log"


def _log_agent(line: str) -> None:
    try:
        ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        with open(_agent_log_path(), "a", encoding="utf-8") as f:
            f.write(f"{ts} {line}\n")
    except OSError:
        pass


def _agent_session_log_path() -> Path:
    if ensure_butlor_config_dir:
        d = ensure_butlor_config_dir()
    else:
        d = Path(os.environ.get("BUTLOR_CONFIG") or r"D:\butlor")
        d.mkdir(parents=True, exist_ok=True)
    return d / "agent_sessions.jsonl"


def _log_agent_session(entry: dict[str, Any]) -> None:
    try:
        row = {"ts": datetime.now(timezone.utc).isoformat(), **entry}
        with open(_agent_session_log_path(), "a", encoding="utf-8") as f:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    except OSError:
        pass


def _agent_runs_dir() -> Path:
    d = ensure_butlor_config_dir() if ensure_butlor_config_dir else Path(os.environ.get("BUTLOR_CONFIG") or r"D:\butlor")
    p = Path(d) / "agent-runs"
    p.mkdir(parents=True, exist_ok=True)
    return p


def _agent_checkpoints_dir() -> Path:
    d = ensure_butlor_config_dir() if ensure_butlor_config_dir else Path(os.environ.get("BUTLOR_CONFIG") or r"D:\butlor")
    p = Path(d) / "agent-checkpoints"
    p.mkdir(parents=True, exist_ok=True)
    return p


def _safe_session_key(session_id: str) -> str:
    s = re.sub(r"[^\w.\-]+", "_", (session_id or "butler-agent").strip())[:80]
    return s or "butler-agent"


def _short_path(raw: str, max_len: int = 72) -> str:
    p = (raw or "").strip().replace("/", "\\")
    if len(p) <= max_len:
        return p or "."
    return "…" + p[-(max_len - 1) :]


_TODO_STATUSES = frozenset({"pending", "in_progress", "completed", "cancelled"})


def _normalize_todo_item(raw: Any, fallback_id: str) -> dict[str, str] | None:
    if isinstance(raw, str):
        content = raw.strip()
        if not content:
            return None
        return {"id": fallback_id, "content": content[:240], "status": "pending"}
    if not isinstance(raw, dict):
        return None
    content = str(raw.get("content") or raw.get("text") or raw.get("title") or "").strip()
    if not content:
        return None
    tid = str(raw.get("id") or fallback_id).strip() or fallback_id
    status = str(raw.get("status") or "pending").strip().lower()
    if status not in _TODO_STATUSES:
        status = "pending"
    return {"id": tid[:64], "content": content[:240], "status": status}


def normalize_todos(raw: Any) -> list[dict[str, str]]:
    """Normalize a todos payload into [{id, content, status}, ...]."""
    if raw is None:
        return []
    items = raw
    if isinstance(raw, dict):
        items = raw.get("todos") or raw.get("items") or raw.get("list") or []
    if not isinstance(items, list):
        return []
    out: list[dict[str, str]] = []
    seen: set[str] = set()
    for i, item in enumerate(items[:24]):
        norm = _normalize_todo_item(item, str(i + 1))
        if not norm:
            continue
        base = norm["id"]
        tid = base
        n = 2
        while tid in seen:
            tid = f"{base}-{n}"
            n += 1
        norm["id"] = tid
        seen.add(tid)
        out.append(norm)
    return out


def seed_todos_from_goal(goal: str) -> list[dict[str, str]]:
    """Heuristic plan so the UI has todos immediately while the model refines them."""
    g = (goal or "").strip().lower()
    if any(w in g for w in ("fix", "bug", "error", "broken", "crash", "fail")):
        plan = [
            "Locate relevant code and reproduce the issue",
            "Identify the root cause",
            "Apply a targeted fix",
            "Verify and summarize for the user",
        ]
    elif any(w in g for w in ("add", "implement", "create", "build", "scaffold", "write", "make")):
        plan = [
            "Scan the workspace and related files",
            "Plan the change set",
            "Implement the requested changes",
            "Check results and summarize",
        ]
    elif any(w in g for w in ("refactor", "clean", "rename", "reorganize", "migrate")):
        plan = [
            "Map current structure and call sites",
            "Apply refactor safely",
            "Verify nothing obvious broke",
            "Summarize what changed",
        ]
    elif any(w in g for w in ("search", "find", "where", "how does", "explain", "what is")):
        plan = [
            "Search the codebase / knowledge for answers",
            "Read the most relevant files",
            "Answer the user with findings",
        ]
    else:
        plan = [
            "Understand the request and gather context",
            "Carry out the needed steps",
            "Summarize outcome or ask a clarifying question",
        ]
    todos = [{"id": str(i + 1), "content": c, "status": "pending"} for i, c in enumerate(plan)]
    if todos:
        todos[0]["status"] = "in_progress"
    return todos


def apply_todo_updates(
    todos: list[dict[str, str]],
    *,
    replace: Any = None,
    updates: Any = None,
) -> list[dict[str, str]]:
    """Replace the full list and/or patch individual items by id."""
    current = list(todos)
    if replace is not None:
        current = normalize_todos(replace)
    if updates is None:
        return current
    patch_list = updates if isinstance(updates, list) else [updates]
    by_id = {t["id"]: dict(t) for t in current}
    order = [t["id"] for t in current]
    for raw in patch_list:
        if not isinstance(raw, dict):
            continue
        tid = str(raw.get("id") or "").strip()
        if not tid:
            continue
        if tid not in by_id:
            norm = _normalize_todo_item(raw, tid)
            if norm:
                by_id[tid] = norm
                order.append(tid)
            continue
        item = by_id[tid]
        if "content" in raw or "text" in raw or "title" in raw:
            content = str(raw.get("content") or raw.get("text") or raw.get("title") or "").strip()
            if content:
                item["content"] = content[:240]
        if "status" in raw:
            status = str(raw.get("status") or "").strip().lower()
            if status in _TODO_STATUSES:
                item["status"] = status
        by_id[tid] = item
    return [by_id[i] for i in order if i in by_id]


def advance_todos_after_tool(todos: list[dict[str, str]], tool: str) -> list[dict[str, str]]:
    """Light auto-progress when the model forgets to update todos."""
    if not todos:
        return todos
    name = (tool or "").strip().lower()
    out = [dict(t) for t in todos]
    active_idx = next((i for i, t in enumerate(out) if t.get("status") == "in_progress"), None)
    scan_tools = {
        "list_dir",
        "get_file_tree",
        "glob",
        "find_files",
        "grep",
        "search_codebase",
        "read_file",
        "read_multiple",
        "knowledge_query",
        "web_search",
        "fetch_url",
        "mcp_list",
        "mcp_call",
        "mcp",
    }
    act_tools = {"edit_file", "write_file", "run_shell", "run_command", "knowledge_ingest"}

    def _complete_idx(i: int) -> None:
        if 0 <= i < len(out) and out[i]["status"] != "cancelled":
            out[i]["status"] = "completed"

    def _start_next_pending() -> None:
        for t in out:
            if t["status"] == "pending":
                t["status"] = "in_progress"
                return

    if name == "manage_todos":
        return out
    if active_idx is None:
        _start_next_pending()
        return out
    # First scan-family tool keeps "gather context" in progress; completing a write/shell advances.
    if name in act_tools:
        _complete_idx(active_idx)
        _start_next_pending()
    elif name in scan_tools and active_idx == 0 and len(out) > 1:
        # Stay on first item until we act, unless it's already clearly a search-only plan.
        pass
    return out


def finalize_todos(todos: list[dict[str, str]], *, success: bool) -> list[dict[str, str]]:
    out = [dict(t) for t in todos]
    for t in out:
        if t["status"] == "in_progress":
            t["status"] = "completed" if success else "cancelled"
        elif success and t["status"] == "pending":
            # Leave unanswered pending items cancelled so the checklist doesn't look unfinished.
            t["status"] = "cancelled"
    return out


def todos_have_open_items(todos: list[dict[str, str]] | None) -> bool:
    """True when any checklist item is still pending or in_progress."""
    for t in todos or []:
        if str(t.get("status") or "").strip().lower() in ("pending", "in_progress"):
            return True
    return False


def format_open_todos(todos: list[dict[str, str]] | None) -> str:
    bits: list[str] = []
    for t in todos or []:
        st = str(t.get("status") or "").strip().lower()
        if st not in ("pending", "in_progress"):
            continue
        content = str(t.get("content") or "").strip()[:80]
        tid = str(t.get("id") or "?")
        bits.append(f"{tid} ({st}): {content}")
    return "; ".join(bits[:8]) if bits else "(open items)"


def synthesize_final_reply(user_message: str, steps: list[dict[str, Any]]) -> str:
    """Build a short user-facing wrap-up when the model omitted {\"final\": ...}."""
    tool_steps = [s for s in steps if s.get("type") == "tool"]
    if not tool_steps:
        goal = (user_message or "").strip()
        if goal:
            return (
                f"I couldn't complete that yet. Could you clarify what you want done "
                f"for: {goal[:200]}{'…' if len(goal) > 200 else ''}?"
            )
        return "I need a bit more detail before I can proceed. What should I do next?"

    ok_tools: list[str] = []
    fail_bits: list[str] = []
    highlights: list[str] = []
    for s in tool_steps:
        tool = str(s.get("tool") or "tool")
        if tool == "manage_todos":
            continue
        r = s.get("result") if isinstance(s.get("result"), dict) else {}
        if r.get("ok") is False:
            err = str(r.get("error") or "failed")[:160]
            fail_bits.append(f"{tool}: {err}")
            continue
        ok_tools.append(tool)
        if tool in ("run_shell", "run_command") and r.get("stdout"):
            out = str(r.get("stdout") or "").strip().splitlines()
            if out:
                highlights.append(out[-1][:160])
        elif tool in ("write_file", "edit_file") and r.get("path"):
            highlights.append(f"updated {r.get('path')}")
        elif tool == "list_dir" and r.get("entries"):
            highlights.append(f"listed {len(r.get('entries') or [])} entries")

    parts: list[str] = []
    if ok_tools:
        uniq = list(dict.fromkeys(ok_tools))
        parts.append("I ran: " + ", ".join(uniq[:8]) + ("…" if len(uniq) > 8 else "") + ".")
    if highlights:
        parts.append("Notes: " + "; ".join(highlights[:4]) + ".")
    if fail_bits:
        parts.append("Blocked on: " + "; ".join(fail_bits[:3]) + ".")
        parts.append("Tell me how you'd like to proceed, or share more context.")
    else:
        parts.append("Want me to continue or adjust anything?")
    return " ".join(parts)[:4000]


def write_agent_status(
    run_id: str | None,
    *,
    status: str,
    message: str,
    iteration: int = 0,
    max_iterations: int = 16,
    steps: list[dict[str, Any]] | None = None,
    checkpoint_id: str | None = None,
    session_id: str | None = None,
    project_root: str | None = None,
    model_source: str | None = None,
    model_used: str | None = None,
    agent_provider: str | None = None,
    todos: list[dict[str, Any]] | None = None,
    reply: str | None = None,
) -> None:
    if not (run_id or "").strip():
        return
    slim_steps: list[dict[str, Any]] = []
    for s in steps or []:
        if not isinstance(s, dict):
            continue
        sc = dict(s)
        if "result" in sc:
            sc["result"] = _slim_tool_result_for_status(sc.get("result"))
        if isinstance(sc.get("args"), dict) and len(json.dumps(sc["args"], default=str)) > 2000:
            sc["args"] = {"_truncated": True, "preview": str(sc["args"])[:1500]}
        slim_steps.append(sc)
    payload: dict[str, Any] = {
        "run_id": run_id,
        "status": status,
        "message": message,
        "iteration": iteration,
        "max_iterations": max_iterations,
        "steps": slim_steps,
        "todos": todos if todos is not None else [],
        "checkpoint_id": checkpoint_id,
        "session_id": session_id,
        "project_root": project_root,
        "model_source": model_source,
        "model_used": model_used,
        "agent_provider": agent_provider,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    if reply is not None:
        payload["reply"] = reply
    try:
        path = _agent_runs_dir() / f"{run_id}.json"
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False, default=str), encoding="utf-8")
        tmp.replace(path)
    except OSError:
        pass
    except MemoryError:
        try:
            path = _agent_runs_dir() / f"{run_id}.json"
            tiny = {
                "run_id": run_id,
                "status": "error",
                "message": "Status write failed (MemoryError) — tool result too large; narrow get_file_tree/glob.",
                "iteration": iteration,
                "max_iterations": max_iterations,
                "steps": [],
                "todos": [],
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }
            path.write_text(json.dumps(tiny, ensure_ascii=False), encoding="utf-8")
        except Exception:
            pass


def read_agent_status(run_id: str) -> dict[str, Any] | None:
    rid = (run_id or "").strip()
    if not rid:
        return None
    try:
        path = _agent_runs_dir() / f"{rid}.json"
        if not path.is_file():
            return None
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def tool_activity_message(tool: str, args: dict[str, Any] | None = None) -> str:
    name = (tool or "").strip().lower()
    a = args if isinstance(args, dict) else {}
    if name == "manage_todos":
        todos = a.get("todos") or a.get("replace") or a.get("updates") or []
        n = len(todos) if isinstance(todos, list) else 0
        return f"Updating plan ({n} item{'s' if n != 1 else ''})…"
    if name in ("read_file",):
        return f"Reading {_short_path(str(a.get('path') or ''))}…"
    if name == "read_multiple":
        paths = a.get("paths") or []
        n = len(paths) if isinstance(paths, list) else 0
        return f"Reading {n or 'multiple'} files…"
    if name in ("write_file",):
        return f"Writing {_short_path(str(a.get('path') or ''))}…"
    if name in ("edit_file",):
        return f"Editing {_short_path(str(a.get('path') or ''))}…"
    if name in ("run_shell", "run_command"):
        cmd = str(a.get("command") or "").strip()
        return f"Running shell: {cmd[:80]}{'…' if len(cmd) > 80 else ''}"
    if name in ("grep", "search_codebase"):
        return f"Searching codebase for {a.get('pattern', '')!r}…"
    if name in ("glob", "find_files"):
        return f"Finding files: {a.get('pattern') or a.get('query') or '…'}"
    if name == "get_file_tree":
        return f"Scanning project tree at {_short_path(str(a.get('path') or ''))}…"
    if name == "list_dir":
        return f"Listing {_short_path(str(a.get('path') or ''))}…"
    if name == "web_search":
        return f"Searching web for {a.get('query', '')!r}…"
    if name == "fetch_url":
        return f"Fetching {str(a.get('url') or '')[:80]}…"
    if name == "knowledge_query":
        return f"Querying knowledge base for {a.get('query', '')!r}…"
    if name == "knowledge_ingest":
        return "Saving learning to knowledge base…"
    if name == "mcp_list":
        return "Listing connected MCP tools…"
    if name in ("mcp_call", "mcp"):
        tool = a.get("tool") or a.get("name") or ""
        sid = a.get("server_id") or a.get("serverId") or ""
        return f"Calling MCP {sid}/{tool}…" if (sid or tool) else "Calling MCP tool…"
    return f"Running {name or 'tool'}…"


_agent_context: dict[str, Any] = {}


def _set_agent_context(**kwargs: Any) -> None:
    _agent_context.update(kwargs)


def _checkpoint_base(session_id: str) -> Path:
    return _agent_checkpoints_dir() / _safe_session_key(session_id)


def create_checkpoint(
    session_id: str,
    project_root: str,
    file_paths: list[Path],
    reason: str = "manual",
) -> dict[str, Any]:
    """Snapshot file contents before destructive edits."""
    sid = _safe_session_key(session_id)
    cp_id = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:8]
    base = _checkpoint_base(session_id) / cp_id
    files_dir = base / "files"
    files_dir.mkdir(parents=True, exist_ok=True)
    saved: list[dict[str, str]] = []
    proj = Path(project_root).resolve() if (project_root or "").strip() else None
    for fp in file_paths:
        try:
            resolved = fp.resolve()
        except OSError:
            continue
        if not resolved.is_file():
            continue
        rel = str(resolved.name)
        if proj:
            try:
                rel = str(resolved.relative_to(proj)).replace("/", "\\")
            except ValueError:
                rel = str(resolved)
        dest = files_dir / rel.replace(":", "_")
        dest.parent.mkdir(parents=True, exist_ok=True)
        try:
            dest.write_text(resolved.read_text(encoding="utf-8", errors="replace"), encoding="utf-8")
            saved.append({"path": str(resolved), "relative": rel})
        except OSError:
            continue
    manifest = {
        "id": cp_id,
        "session_id": sid,
        "project_root": project_root,
        "reason": reason,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "files": saved,
    }
    (base / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    _log_agent(f"CHECKPOINT {cp_id} files={len(saved)} reason={reason}")
    return {"ok": True, "checkpoint_id": cp_id, "files": saved, "reason": reason}


def list_checkpoints(session_id: str) -> list[dict[str, Any]]:
    base = _checkpoint_base(session_id)
    if not base.is_dir():
        return []
    out: list[dict[str, Any]] = []
    for child in sorted(base.iterdir(), key=lambda p: p.name, reverse=True):
        manifest = child / "manifest.json"
        if not manifest.is_file():
            continue
        try:
            data = json.loads(manifest.read_text(encoding="utf-8"))
            out.append(
                {
                    "id": data.get("id", child.name),
                    "created_at": data.get("created_at"),
                    "reason": data.get("reason"),
                    "file_count": len(data.get("files") or []),
                    "project_root": data.get("project_root"),
                }
            )
        except (OSError, json.JSONDecodeError):
            continue
    return out


def restore_checkpoint(session_id: str, checkpoint_id: str) -> dict[str, Any]:
    cp_id = (checkpoint_id or "").strip()
    if not cp_id:
        return {"ok": False, "error": "checkpoint_id required"}
    base = _checkpoint_base(session_id) / cp_id
    manifest_path = base / "manifest.json"
    if not manifest_path.is_file():
        return {"ok": False, "error": "checkpoint not found"}
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        return {"ok": False, "error": str(e)}
    restored: list[str] = []
    errors: list[str] = []
    for entry in manifest.get("files") or []:
        orig = str(entry.get("path") or "").strip()
        rel = str(entry.get("relative") or Path(orig).name)
        snap = base / "files" / rel.replace(":", "_")
        if not snap.is_file():
            errors.append(f"missing snapshot for {rel}")
            continue
        try:
            Path(orig).parent.mkdir(parents=True, exist_ok=True)
            Path(orig).write_text(snap.read_text(encoding="utf-8", errors="replace"), encoding="utf-8")
            restored.append(orig)
        except OSError as e:
            errors.append(f"{orig}: {e}")
    _log_agent(f"RESTORE {cp_id} restored={len(restored)} errors={len(errors)}")
    return {
        "ok": len(errors) == 0,
        "checkpoint_id": cp_id,
        "restored": restored,
        "errors": errors,
    }


def _auto_checkpoint_before_edit(session_id: str, project_root: str, path: Path, reason: str) -> str | None:
    if not (session_id or "").strip():
        return None
    out = create_checkpoint(session_id, project_root, [path], reason=reason)
    return out.get("checkpoint_id")


def _ingest_agent_learning(goal: str, reply: str, project_root: str, steps: list[dict[str, Any]]) -> int:
    """Store successful agent outcomes in the knowledge base for future retrieval."""
    goal = (goal or "").strip()
    reply = (reply or "").strip()
    if not goal or not reply or len(reply) < 48:
        return 0
    if reply_denies_machine_access(reply):
        return 0
    try:
        from knowledge_store import KnowledgeStore

        store = KnowledgeStore()
    except Exception:
        return 0
    tools_used = sorted({s.get("tool") for s in steps if s.get("type") == "tool" and s.get("tool")})
    body = (
        f"User: {goal}\n"
        f"Assistant: {reply}\n"
        f"Project: {project_root}\n"
        f"Tools: {', '.join(tools_used) if tools_used else 'none'}"
    )
    try:
        return store.add(body, source="agent", topic=(project_root or "")[:100])
    except Exception:
        return 0


def looks_like_capability_question(user_message: str) -> bool:
    """User asking whether Butler can access/edit/run — not a concrete task yet."""
    um = (user_message or "").strip().lower()
    if not re.search(r"\b(can you|are you able|do you have|will you)\b", um):
        return False
    return any(
        w in um
        for w in (
            "access",
            "change code",
            "edit code",
            "make code",
            "code change",
            "code changes",
            "make code changes",
            "run command",
            "my computer",
            "my machine",
            "my project",
            "filesystem",
            "shell",
            "powershell",
        )
    )


def looks_like_agent_work(user_message: str) -> bool:
    """True when the user wants filesystem/shell/code work on their machine."""
    um = (user_message or "").strip().lower()
    if len(um) < 3:
        return False
    patterns = (
        r"\b(edit|change|modify|update|fix|patch|refactor)\b.+\b(code|file|project|repo|script|app|source)\b",
        r"\b(make|write|create|add)\b.+\b(file|function|class|module|script|component)\b",
        r"\b(run|execute)\b.+\b(command|shell|powershell|cmd|terminal|script)\b",
        r"\b(install|npm|pip|pnpm|yarn|cargo|build|compile|deploy)\b",
        r"\b(list|show|ls|dir)\b.+\b(files?|folder|directory|dir)\b",
        r"\b(read|open|cat|grep|search)\b.+\b(file|folder|directory|repo|project)\b",
        r"\bcode changes?\b",
        r"\bmy project(s)?\b",
        r"\bon my (machine|computer|pc|laptop|system)\b",
        r"\blocal(ly)?\b.+\b(run|execute|edit|change|fix)\b",
        r"\bfix\b.+\b(bug|error|issue|build|test)\b",
        r"\bscaffold\b",
        r"\bmake code changes\b",
        r"\bcan you (edit|change|fix|run|install|build)\b",
        r"\bhelp me (fix|build|install|run|edit|change)\b",
    )
    for pat in patterns:
        if re.search(pat, um):
            return True
    if re.search(r"\b(build|create|scaffold)\s+(a|an|the)\s+\w+", um) and any(
        w in um for w in ("app", "website", "site", "game", "extension", "script", "api", "project")
    ):
        return True
    return False


def reply_denies_machine_access(txt: str) -> bool:
    r = (txt or "").replace("\u2019", "'").replace("\u2018", "'").lower()
    if not r.strip():
        return False
    markers = (
        "cannot access your computer",
        "can't access your computer",
        "do not have access to your computer",
        "don't have access to your computer",
        "cannot access your machine",
        "can't access your machine",
        "cannot access your filesystem",
        "can't access your filesystem",
        "cannot access your file system",
        "don't have access to your file",
        "do not have access to your file",
        "cannot directly access",
        "can't directly access",
        "unable to access your",
        "i don't have the ability to access",
        "i do not have the ability to access",
        "browser application",
        "browser-based",
        "can only provide code",
        "can only give you code",
        "can only show you code",
        "paste this into",
        "copy and paste",
        "manually on your",
        "you would need to run",
        "you'll need to run",
        "you will need to run",
        "i'm just a language model",
        "as a language model i cannot",
        "as an ai i cannot access",
    )
    return any(m in r for m in markers)


def _truncate(s: str, n: int = 12000) -> str:
    s = s or ""
    return s if len(s) <= n else s[: n - 20] + "\n… [truncated]"


def _exc_msg(e: BaseException) -> str:
    """Never return empty — MemoryError and some OSErrors have blank str()."""
    name = type(e).__name__
    text = (str(e) or "").strip()
    return f"{name}: {text}" if text else f"{name} (no message)"


def _slim_tool_result_for_status(result: Any, max_chars: int = 4000) -> Any:
    """Keep run-status JSON small so huge get_file_tree payloads don't OOM / stall writes."""
    if isinstance(result, dict):
        # Fast path for known huge tools — avoid dumping the full tree first.
        if isinstance(result.get("tree"), list) and len(result["tree"]) > 40:
            return {
                "ok": result.get("ok"),
                "truncated": True,
                "path": result.get("path"),
                "count": result.get("count") or len(result["tree"]),
                "tree_preview": result["tree"][:40],
                "tree_len": len(result["tree"]),
                "note": result.get("note")
                or f"Tree truncated for status ({len(result['tree'])} entries).",
            }
        if isinstance(result.get("files"), list) and len(json.dumps(result.get("files"), default=str)) > max_chars:
            return {
                "ok": result.get("ok"),
                "truncated": True,
                "count": result.get("count") or len(result["files"]),
                "files_preview": result["files"][:30],
                "files_len": len(result["files"]),
                "note": f"Files list truncated for status ({len(result['files'])} entries).",
            }
    try:
        raw = json.dumps(result, ensure_ascii=False, default=str)
    except Exception:
        return {"ok": False, "error": "tool result not serializable", "truncated": True}
    if len(raw) <= max_chars:
        return result
    if isinstance(result, dict):
        slim: dict[str, Any] = {
            "ok": result.get("ok"),
            "truncated": True,
            "error": result.get("error"),
            "path": result.get("path"),
            "count": result.get("count"),
            "note": f"Result truncated for status ({len(raw)} chars → {max_chars})",
        }
        if "tree" in result and isinstance(result["tree"], list):
            slim["tree_preview"] = result["tree"][:40]
            slim["tree_len"] = len(result["tree"])
        elif "files" in result and isinstance(result["files"], list):
            slim["files_preview"] = result["files"][:30]
            slim["files_len"] = len(result["files"])
        elif "content" in result:
            slim["content"] = _truncate(str(result.get("content") or ""), 1500)
        else:
            slim["preview"] = raw[: max_chars - 80] + "\n… [truncated]"
        return slim
    return {"truncated": True, "preview": raw[: max_chars - 40] + "\n… [truncated]"}


def _run_shell(command: str, cwd: str, timeout: int = 120) -> dict[str, Any]:
    cwd_path = Path(cwd)
    if not cwd_path.is_dir():
        cwd_path = Path.cwd()
    _log_agent(f"run_shell cwd={cwd_path} cmd={command[:500]}")
    try:
        proc = subprocess.run(
            command,
            shell=True,
            cwd=str(cwd_path),
            capture_output=True,
            text=True,
            timeout=max(5, min(timeout, 600)),
            encoding="utf-8",
            errors="replace",
        )
        return {
            "ok": proc.returncode == 0,
            "exit_code": proc.returncode,
            "stdout": _truncate(proc.stdout or "", 8000),
            "stderr": _truncate(proc.stderr or "", 4000),
        }
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": f"timeout after {timeout}s", "stdout": "", "stderr": ""}
    except Exception as e:
        return {"ok": False, "error": _exc_msg(e), "stdout": "", "stderr": ""}


def _read_file(path: Path, offset: int = 0, limit: int = 200) -> dict[str, Any]:
    _log_agent(f"read_file {path}")
    if not path.is_file():
        return {"ok": False, "error": "not a file"}
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError as e:
        return {"ok": False, "error": str(e)}
    lines = text.splitlines()
    start = max(0, offset)
    end = start + max(1, min(limit, 500))
    chunk = "\n".join(lines[start:end])
    return {
        "ok": True,
        "path": str(path),
        "offset": start,
        "total_lines": len(lines),
        "content": _truncate(chunk, 16000),
    }


def _unified_diff_snippet(
    path_label: str,
    before: str,
    after: str,
    *,
    max_chars: int = 24000,
) -> str:
    """Lightweight unified diff for Agent UI (truncated)."""
    import difflib

    before_lines = before.splitlines(keepends=True)
    after_lines = after.splitlines(keepends=True)
    label = path_label.replace("\\", "/")
    chunks = difflib.unified_diff(
        before_lines,
        after_lines,
        fromfile=f"a/{label}",
        tofile=f"b/{label}",
        n=3,
    )
    text = "".join(chunks)
    if not text.strip():
        return f"--- a/{label}\n+++ b/{label}\n(no textual diff)"
    if len(text) > max_chars:
        return text[: max_chars - 40] + "\n… (diff truncated)\n"
    return text


def _write_file(path: Path, content: str) -> dict[str, Any]:
    _log_agent(f"write_file {path} bytes={len(content)}")
    try:
        before = ""
        existed = path.is_file()
        if existed:
            try:
                before = path.read_text(encoding="utf-8", errors="replace")
            except OSError:
                before = ""
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        label = path.name
        return {
            "ok": True,
            "path": str(path),
            "bytes": len(content.encode("utf-8")),
            "created": not existed,
            "diff": _unified_diff_snippet(label, before, content),
            "before": before[-8000:] if before else "",
            "after": content[:8000],
        }
    except OSError as e:
        return {"ok": False, "error": str(e)}


def _edit_file(path: Path, old_string: str, new_string: str) -> dict[str, Any]:
    _log_agent(f"edit_file {path}")
    if not path.is_file():
        return {"ok": False, "error": "not a file"}
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError as e:
        return {"ok": False, "error": str(e)}
    if old_string not in text:
        return {"ok": False, "error": "old_string not found in file"}
    after = text.replace(old_string, new_string, 1)
    path.write_text(after, encoding="utf-8")
    label = path.name
    return {
        "ok": True,
        "path": str(path),
        "diff": _unified_diff_snippet(label, text, after),
        "before": old_string[:8000],
        "after": new_string[:8000],
    }


def _list_dir(path: Path, max_entries: int = 200) -> dict[str, Any]:
    _log_agent(f"list_dir {path}")
    if not path.is_dir():
        return {"ok": False, "error": "not a directory"}
    entries: list[dict[str, str]] = []
    try:
        for i, child in enumerate(sorted(path.iterdir(), key=lambda p: p.name.lower())):
            if i >= max_entries:
                entries.append({"name": "…", "type": "truncated"})
                break
            entries.append(
                {
                    "name": child.name,
                    "type": "dir" if child.is_dir() else "file",
                }
            )
    except OSError as e:
        return {"ok": False, "error": str(e)}
    return {"ok": True, "path": str(path), "entries": entries}


def _iter_project_files(root: Path, max_files: int = 2500):
    """Walk project tree skipping heavy/vendor dirs."""
    count = 0
    if root.is_file():
        yield root
        return
    if not root.is_dir():
        return
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not _should_skip_dir(d)]
        for fn in filenames:
            yield Path(dirpath) / fn
            count += 1
            if count >= max_files:
                return


def _grep(pattern: str, path: Path, max_matches: int = 80) -> dict[str, Any]:
    _log_agent(f"grep {pattern!r} in {path}")
    try:
        rx = re.compile(pattern)
    except re.error as e:
        return {"ok": False, "error": f"invalid regex: {e}"}
    matches: list[dict[str, Any]] = []
    if path.is_file():
        files = [path]
    elif path.is_dir():
        files = list(_iter_project_files(path))
    else:
        return {"ok": False, "error": "path not found"}
    for fp in files:
        try:
            for ln, line in enumerate(fp.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
                if rx.search(line):
                    matches.append({"file": str(fp), "line": ln, "text": line[:300]})
                    if len(matches) >= max_matches:
                        return {"ok": True, "pattern": pattern, "matches": matches, "truncated": True}
        except OSError:
            continue
    return {"ok": True, "pattern": pattern, "matches": matches}


def _glob_files(pattern: str, root: Path, max_results: int = 120) -> dict[str, Any]:
    _log_agent(f"glob {pattern!r} in {root}")
    if not root.is_dir():
        return {"ok": False, "error": "not a directory"}
    pat = (pattern or "**/*").strip()
    if not pat:
        pat = "**/*"
    found: list[str] = []
    try:
        iterator = root.rglob(pat[3:]) if pat.startswith("**/") else root.glob(pat)
        for p in sorted(iterator, key=lambda x: str(x).lower()):
            if any(_should_skip_dir(part) for part in p.parts):
                continue
            if p.is_file():
                found.append(str(p))
            if len(found) >= max_results:
                break
    except OSError as e:
        return {"ok": False, "error": str(e)}
    return {"ok": True, "pattern": pat, "root": str(root), "files": found, "count": len(found)}


def _find_files(query: str, root: Path, max_results: int = 60) -> dict[str, Any]:
    _log_agent(f"find_files {query!r} in {root}")
    q = (query or "").strip().lower()
    if not q:
        return {"ok": False, "error": "query required"}
    found: list[str] = []
    for fp in _iter_project_files(root):
        if q in fp.name.lower() or q in str(fp).lower():
            found.append(str(fp))
            if len(found) >= max_results:
                break
    return {"ok": True, "query": query, "files": found, "count": len(found)}


def _read_multiple(
    paths: list[str],
    project_root: str,
    roots: list[Path],
    offset: int = 0,
    limit: int = 120,
) -> dict[str, Any]:
    out: list[dict[str, Any]] = []
    for raw in paths[:12]:
        try:
            p = resolve_allowed_path(str(raw), project_root, roots)
            out.append(_read_file(p, offset, limit))
        except ValueError as e:
            out.append({"ok": False, "path": raw, "error": str(e)})
    return {"ok": True, "files": out, "count": len(out)}


def _get_file_tree(path: Path, max_depth: int = 3, max_entries: int = 300) -> dict[str, Any]:
    _log_agent(f"get_file_tree {path}")
    if not path.is_dir():
        return {"ok": False, "error": "not a directory"}
    # Cap hard — huge trees blow cascade LLM context and can MemoryError status/JSON dumps.
    max_depth = max(0, min(int(max_depth or 3), 4))
    max_entries = max(1, min(int(max_entries or 300), 120))
    tree: list[dict[str, Any]] = []
    count = 0
    truncated = False

    def walk(cur: Path, depth: int, prefix: str) -> None:
        nonlocal count, truncated
        if depth > max_depth or count >= max_entries:
            if count >= max_entries:
                truncated = True
            return
        try:
            children = sorted(cur.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
        except OSError:
            return
        for child in children:
            if count >= max_entries:
                truncated = True
                return
            if child.is_dir() and _should_skip_dir(child.name):
                continue
            count += 1
            node = {
                "name": child.name,
                "path": str(child),
                "type": "dir" if child.is_dir() else "file",
                "depth": depth,
            }
            tree.append(node)
            if child.is_dir():
                walk(child, depth + 1, prefix + "  ")

    walk(path, 0, "")
    out: dict[str, Any] = {"ok": True, "path": str(path), "tree": tree, "count": len(tree)}
    if truncated:
        out["truncated"] = True
        out["note"] = (
            f"Tree capped at {max_entries} entries / depth {max_depth}. "
            "Use glob or list_dir on a narrower path for more detail."
        )
    return out


def _web_search_tool(query: str, max_results: int = 6) -> dict[str, Any]:
    q = (query or "").strip()
    if not q:
        return {"ok": False, "error": "query required"}
    try:
        from web_fetcher import search_web

        hits = search_web(q, max_results=max(1, min(max_results, 10))) or []
        return {"ok": True, "query": q, "results": hits[:10]}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def _fetch_url_tool(url: str) -> dict[str, Any]:
    u = (url or "").strip()
    if not u:
        return {"ok": False, "error": "url required"}
    try:
        from web_fetcher import fetch_page

        text = fetch_page(u)
        return {"ok": True, "url": u, "content": _truncate(text or "", 12000)}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def _knowledge_query_tool(query: str, n_results: int = 6) -> dict[str, Any]:
    q = (query or "").strip()
    if not q:
        return {"ok": False, "error": "query required"}
    try:
        from knowledge_store import KnowledgeStore

        store = KnowledgeStore()
        hits = store.search(q, n_results=max(1, min(n_results, 12))) or []
        slim = [
            {
                "content": _truncate(str(h.get("content") or ""), 800),
                "source": h.get("source"),
                "topic": h.get("topic"),
                "distance": h.get("distance"),
            }
            for h in hits
        ]
        return {"ok": True, "query": q, "hits": slim, "count": len(slim)}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def _knowledge_ingest_tool(content: str, topic: str = "", source: str = "agent") -> dict[str, Any]:
    body = (content or "").strip()
    if not body:
        return {"ok": False, "error": "content required"}
    try:
        from knowledge_store import KnowledgeStore

        store = KnowledgeStore()
        n = store.add(body, source=source[:80] or "agent", topic=(topic or "")[:100])
        return {"ok": True, "chunks": n}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def execute_tool(
    tool: str,
    args: dict[str, Any],
    project_root: str,
    roots: list[Path] | None = None,
) -> dict[str, Any]:
    roots = roots or get_agent_roots()
    name = (tool or "").strip().lower()
    a = args if isinstance(args, dict) else {}

    if name in ("run_shell", "run_command"):
        cmd = str(a.get("command") or "").strip()
        if not cmd:
            return {"ok": False, "error": "command required"}
        cwd_raw = str(a.get("cwd") or project_root or ".").strip()
        try:
            cwd = str(resolve_allowed_path(cwd_raw, project_root, roots))
        except ValueError:
            cwd = str(Path(project_root or ".").resolve())
        timeout = int(a.get("timeout") or 120)
        return _run_shell(cmd, cwd, timeout)

    if name == "read_file":
        try:
            p = resolve_allowed_path(str(a.get("path") or ""), project_root, roots)
        except ValueError as e:
            return {"ok": False, "error": str(e)}
        offset = int(a.get("offset") or 0)
        limit = int(a.get("limit") or 200)
        return _read_file(p, offset, limit)

    if name == "write_file":
        try:
            p = resolve_allowed_path(str(a.get("path") or ""), project_root, roots)
        except ValueError as e:
            return {"ok": False, "error": str(e)}
        content = a.get("content")
        if not isinstance(content, str):
            return {"ok": False, "error": "content must be string"}
        session_id = str(_agent_context.get("session_id") or "")
        cp_id = None
        if p.is_file() and session_id:
            cp_id = _auto_checkpoint_before_edit(session_id, project_root, p, "before write_file")
        elif session_id:
            cp_id = _auto_checkpoint_before_edit(session_id, project_root, p, "before write_file (new)")
        result = _write_file(p, content)
        if cp_id:
            result["checkpoint_id"] = cp_id
        return result

    if name == "edit_file":
        try:
            p = resolve_allowed_path(str(a.get("path") or ""), project_root, roots)
        except ValueError as e:
            return {"ok": False, "error": str(e)}
        old_s = a.get("old_string")
        new_s = a.get("new_string")
        if not isinstance(old_s, str) or not isinstance(new_s, str):
            return {"ok": False, "error": "old_string and new_string required"}
        session_id = str(_agent_context.get("session_id") or "")
        cp_id = None
        if session_id and p.is_file():
            cp_id = _auto_checkpoint_before_edit(session_id, project_root, p, "before edit_file")
        result = _edit_file(p, old_s, new_s)
        if cp_id:
            result["checkpoint_id"] = cp_id
        return result

    if name == "list_dir":
        try:
            p = resolve_allowed_path(str(a.get("path") or project_root or "."), project_root, roots)
        except ValueError as e:
            return {"ok": False, "error": str(e)}
        return _list_dir(p)

    if name == "grep":
        pat = str(a.get("pattern") or "").strip()
        if not pat:
            return {"ok": False, "error": "pattern required"}
        try:
            p = resolve_allowed_path(str(a.get("path") or project_root or "."), project_root, roots)
        except ValueError as e:
            return {"ok": False, "error": str(e)}
        return _grep(pat, p, int(a.get("max_matches") or 80))

    if name == "search_codebase":
        pat = str(a.get("pattern") or a.get("query") or "").strip()
        if not pat:
            return {"ok": False, "error": "pattern required"}
        try:
            p = resolve_allowed_path(str(a.get("path") or project_root or "."), project_root, roots)
        except ValueError as e:
            return {"ok": False, "error": str(e)}
        return _grep(pat, p, int(a.get("max_matches") or 100))

    if name == "glob":
        try:
            p = resolve_allowed_path(str(a.get("path") or project_root or "."), project_root, roots)
        except ValueError as e:
            return {"ok": False, "error": str(e)}
        return _glob_files(str(a.get("pattern") or "**/*"), p, int(a.get("max_results") or 120))

    if name == "find_files":
        try:
            p = resolve_allowed_path(str(a.get("path") or project_root or "."), project_root, roots)
        except ValueError as e:
            return {"ok": False, "error": str(e)}
        return _find_files(str(a.get("query") or a.get("pattern") or ""), p, int(a.get("max_results") or 60))

    if name == "read_multiple":
        paths = a.get("paths") or a.get("files") or []
        if not isinstance(paths, list):
            return {"ok": False, "error": "paths must be a list"}
        return _read_multiple(
            [str(x) for x in paths],
            project_root,
            roots,
            int(a.get("offset") or 0),
            int(a.get("limit") or 120),
        )

    if name == "get_file_tree":
        try:
            p = resolve_allowed_path(str(a.get("path") or project_root or "."), project_root, roots)
        except ValueError as e:
            return {"ok": False, "error": str(e)}
        return _get_file_tree(p, int(a.get("max_depth") or 3), int(a.get("max_entries") or 120))

    if name == "web_search":
        return _web_search_tool(str(a.get("query") or ""), int(a.get("max_results") or 6))

    if name == "fetch_url":
        return _fetch_url_tool(str(a.get("url") or ""))

    if name == "knowledge_query":
        return _knowledge_query_tool(str(a.get("query") or ""), int(a.get("n_results") or 6))

    if name == "knowledge_ingest":
        return _knowledge_ingest_tool(
            str(a.get("content") or ""),
            str(a.get("topic") or project_root or ""),
            str(a.get("source") or "agent"),
        )

    if name == "manage_todos":
        current = list(_agent_context.get("todos") or [])
        replace = a.get("todos") if "todos" in a else a.get("replace")
        updates = a.get("updates") or a.get("update")
        if replace is None and updates is None:
            return {"ok": False, "error": "provide todos (full list) and/or updates"}
        next_todos = apply_todo_updates(current, replace=replace, updates=updates)
        _agent_context["todos"] = next_todos
        return {"ok": True, "todos": next_todos, "count": len(next_todos)}

    if name == "mcp_list":
        try:
            from mcp_bridge import list_mcp_tools

            return list_mcp_tools()
        except Exception as e:
            return {"ok": False, "error": str(e)}

    if name in ("mcp_call", "mcp"):
        try:
            from mcp_bridge import call_mcp_tool

            sid = str(a.get("server_id") or a.get("serverId") or "").strip()
            mcp_tool = str(a.get("tool") or a.get("name") or "").strip()
            mcp_args = a.get("args") if isinstance(a.get("args"), dict) else {}
            # Allow flat args: {server_id, tool, query: ...} without nested args
            if not mcp_args:
                mcp_args = {
                    k: v
                    for k, v in a.items()
                    if k
                    not in (
                        "server_id",
                        "serverId",
                        "tool",
                        "name",
                        "args",
                    )
                }
            return call_mcp_tool(sid, mcp_tool, mcp_args)
        except Exception as e:
            return {"ok": False, "error": str(e)}

    return {"ok": False, "error": f"unknown tool: {tool}"}


def _parse_agent_output(raw: str) -> Optional[dict[str, Any]]:
    raw = (raw or "").strip()
    if not raw:
        return None
    for pattern in (r"```json\s*([\s\S]*?)\s*```", r"```\s*([\s\S]*?)\s*```"):
        for m in re.finditer(pattern, raw):
            try:
                obj = json.loads(m.group(1).strip())
                if isinstance(obj, dict):
                    return obj
            except json.JSONDecodeError:
                continue
    mobj = re.search(r"\{[\s\S]*\}", raw)
    if mobj:
        try:
            obj = json.loads(mobj.group(0))
            if isinstance(obj, dict):
                return obj
        except json.JSONDecodeError:
            pass
    return None


_MUTATING_TOOLS = frozenset({"edit_file", "write_file", "run_shell", "run_command"})

CONTINUE_WORK_NUDGE = (
    "You said you would make changes but have not used tools yet to do the work. "
    "Continue now: call tools (read/edit/write/shell as needed) to implement the request. "
    "Do not reply with {\"final\":\"...\"} until the work is done, you need a clarifying "
    "question, or you are blocked. Output ONE JSON tool call next."
)


def checklist_continue_nudge(todos: list[dict[str, str]] | None) -> str:
    """Injected when the model tries to finalize with open checklist items."""
    summary = format_open_todos(todos)
    return (
        f"Checklist incomplete: {summary}. "
        "Continue with tools until all items are completed or cancelled with reason. "
        'Do not reply with {"final":"..."} until the checklist is finished, you need a '
        "clarifying question from the user, or you hit a hard blocker. "
        "Output ONE JSON tool call next."
    )


_CLARIFY_OR_BLOCKER_RE = re.compile(
    r"(?is)"
    r"("
    r"\?"
    r"|"
    r"\b(could you|can you|would you|which (one|option|approach|path)|what should|"
    r"what do you|please (confirm|clarify|specify|choose|tell|decide))\b"
    r"|"
    r"\b(need (more )?(info|information|details|clarification|input|you to))\b"
    r"|"
    r"\b(blocked|blocker|cannot proceed|can't proceed|unable to (continue|proceed)|hard stop)\b"
    r"|"
    r"\b(before i (can |continue|proceed)|waiting (on|for) (you|your))\b"
    r")"
)

_INTENT_TO_ACT_RE = re.compile(
    r"(?is)"
    r"("
    r"\blet me\b.+\b(make|implement|apply|edit|update|fix|write|create|change|start|do)\b"
    r"|"
    r"\bi\s*('ll| will| am going to|'m going to)\b.+\b"
    r"(fully\s+)?(implement|apply|edit|update|fix|write|create|change|make|start|do)\b"
    r"|"
    r"\b(i will|i'll)\s+(fully\s+)?implement\b"
    r"|"
    r"\b(make|apply|implement)\s+(these\s+)?(updates?|changes?|edits?|fixes?)\s+now\b"
    r"|"
    r"\b(starting|proceeding)\s+(now|with)\b.+\b(implement|edit|update|fix|change|work)\b"
    r"|"
    r"\bnow\s+(i'll|i will|let me)\b.+\b(implement|edit|update|fix|change|make)\b"
    r")"
)


def strip_final_envelope(text: str) -> str:
    """Return plain user-facing text; unwrap {\"final\": \"...\"} when present."""
    raw = (text or "").strip()
    if not raw:
        return ""
    parsed = _parse_agent_output(raw)
    if parsed and parsed.get("final") is not None and not (
        parsed.get("tool") or parsed.get("name")
    ):
        inner = str(parsed.get("final") or "").strip()
        if inner:
            return inner
    # Whole string is a JSON final object with little else
    if raw.startswith("{") and '"final"' in raw:
        try:
            obj = json.loads(raw)
            if isinstance(obj, dict) and obj.get("final") is not None and not (
                obj.get("tool") or obj.get("name")
            ):
                return str(obj.get("final") or "").strip()
        except json.JSONDecodeError:
            pass
    return raw


def looks_like_intent_to_act(text: str) -> bool:
    """True when the assistant is announcing upcoming work instead of finishing."""
    t = strip_final_envelope(text)
    if not t or len(t) < 8:
        return False
    return bool(_INTENT_TO_ACT_RE.search(t))


def has_mutating_tool_steps(steps: list[dict[str, Any]] | None) -> bool:
    for s in steps or []:
        if s.get("type") != "tool":
            continue
        if str(s.get("tool") or "").strip().lower() in _MUTATING_TOOLS:
            return True
    return False


def is_premature_act_final(text: str, steps: list[dict[str, Any]] | None = None) -> bool:
    """Intent-to-act final with no edit/write/shell tools yet — keep iterating."""
    return looks_like_intent_to_act(text) and not has_mutating_tool_steps(steps)


def looks_like_clarifying_or_blocker(text: str) -> bool:
    """True when the final asks the user something or reports a hard stop."""
    t = strip_final_envelope(text)
    if not t or len(t) < 8:
        return False
    # Promises of upcoming work are not clarifying questions.
    if looks_like_intent_to_act(t):
        return False
    return bool(_CLARIFY_OR_BLOCKER_RE.search(t))


def should_continue_for_incomplete_checklist(
    text: str,
    todos: list[dict[str, str]] | None,
) -> bool:
    """Keep looping when todos remain open and the final is not a real ask/blocker."""
    if not todos_have_open_items(todos):
        return False
    if looks_like_clarifying_or_blocker(text):
        return False
    return True


_AGENT_SYSTEM = """You are Butler — a local coding agent on the operator's Windows PC with full machine access.
You run tools directly (shell, read/write files, web search, knowledge base). Never say you cannot access their computer.

Workflow: **plan → scan → act → reply**
1. Plan: early in the run, call manage_todos with a short checklist for the user's request (3–7 items). Update statuses as you go (pending / in_progress / completed / cancelled). Keep exactly one item in_progress when working.
2. Scan: get_file_tree, glob, find_files, read_file/read_multiple, grep/search_codebase, knowledge_query, mcp_list/mcp_call for docs+memory+reasoning. Prefer **source** under the repo (`ui/src`, `knowledge`, `scripts`) — never hunt packaged builds (`dist-desktop`, `dist-app-new`, `win-unpacked`, `python-embed`).
3. Act: edit_file or write_file, run_shell for builds/tests; use web_search/fetch_url for general web; prefer MCP Context7 for library docs; use Sequential Thinking MCP for hard multi-step plans
4. Reply: ONLY use {"final":"..."} when the checklist is fully completed/cancelled, you need a clarifying question from the user, or you hit a hard blocker. Never finish with only tool calls. Do not finalize while checklist items are still pending/in_progress.

Butler repo map (when project_root is D:\\BUTLER or contains ui/src/AgentWindow.tsx):
- Agent UI shell: ui/src/AgentWindow.tsx
- Agent browser panel: ui/src/components/AgentBrowserPanel.tsx (+ ui/src/lib/agentBrowserTabs.ts)
- Agent bottom Terminal/Browser tray: ui/src/components/AgentBottomPanel.tsx
- Electron webview flags: ui/electron/main.cjs (webviewTag)
- Agent backend loop: knowledge/butler_agent.py
If asked to fix the Agent browser, start with grep/search_codebase for AgentBrowserPanel / webview / agent-browser in ui/src — do not search for Electron BrowserWindow unless editing main process windows.

Each turn output exactly ONE JSON object (no markdown, no prose outside JSON):

Tools:
{"tool":"manage_todos","args":{"todos":[{"id":"1","content":"Scan workspace","status":"in_progress"},{"id":"2","content":"Apply fix","status":"pending"}]}}
{"tool":"manage_todos","args":{"updates":[{"id":"1","status":"completed"},{"id":"2","status":"in_progress"}]}}
{"tool":"run_shell","args":{"command":"npm test","cwd":"D:\\\\BUTLER"}}
{"tool":"read_file","args":{"path":"D:\\\\BUTLER\\\\package.json"}}
{"tool":"read_multiple","args":{"paths":["D:\\\\BUTLER\\\\src\\\\a.ts","D:\\\\BUTLER\\\\src\\\\b.ts"]}}
{"tool":"write_file","args":{"path":"...","content":"..."}}
{"tool":"edit_file","args":{"path":"...","old_string":"...","new_string":"..."}}
{"tool":"list_dir","args":{"path":"D:\\\\BUTLER"}}
{"tool":"get_file_tree","args":{"path":"D:\\\\BUTLER","max_depth":3}}
{"tool":"glob","args":{"pattern":"**/*.tsx","path":"D:\\\\BUTLER"}}
{"tool":"find_files","args":{"query":"AgentWindow","path":"D:\\\\BUTLER"}}
{"tool":"grep","args":{"pattern":"pattern","path":"D:\\\\BUTLER"}}
{"tool":"search_codebase","args":{"pattern":"class Foo","path":"D:\\\\BUTLER"}}
{"tool":"web_search","args":{"query":"react useEffect cleanup"}}
{"tool":"fetch_url","args":{"url":"https://..."}}
{"tool":"knowledge_query","args":{"query":"how we configured comfy"}}
{"tool":"knowledge_ingest","args":{"content":"...","topic":"project notes"}}
{"tool":"mcp_list","args":{}}
{"tool":"mcp_call","args":{"server_id":"mcp-context7","tool":"resolve-library-id","args":{"libraryName":"react"}}}
{"tool":"mcp_call","args":{"server_id":"mcp-sequential-thinking","tool":"sequentialthinking","args":{"thought":"Break the task into steps…","nextThoughtNeeded":true,"thoughtNumber":1,"totalThoughts":5}}}

When finished (required every run — but only when allowed):
{"final":"Brief summary of what you did, a clarifying question, or why you could not complete the request."}

Rules:
- Use absolute paths under project_root when possible.
- Read relevant files before editing; use read_multiple for related files.
- Prefer edit_file over write_file for existing files.
- Checkpoints are taken automatically before destructive edits.
- Windows: shell=True; PowerShell/cmd both work.
- Quality over speed: gather context first on non-trivial tasks.
- For up-to-date library/framework docs, prefer MCP Context7 (mcp_call) over guessing APIs; use web_search/fetch_url only when MCP is unavailable or insufficient.
- For durable facts/preferences across sessions, use MCP Memory tools when connected; still use knowledge_query for Butler's local RAG store.
- For non-trivial planning (ambiguous requirements, multi-file refactors, debugging), call Sequential Thinking (mcp-sequential-thinking / sequentialthinking) before big edits; keep thoughtNumber progressing until nextThoughtNeeded is false.
- The final message is for the human: plain language, not raw JSON/tool dumps.
- Never use {"final":"..."} only to promise future work ("I'll implement now", "Let me make these updates"). Call tools first; finalize after you acted, asked a question, or hit a blocker.
- Do not finalize while manage_todos items are still pending or in_progress — complete or cancel them (with reason) first, unless you must ask the user a clarifying question or report a hard blocker.
"""


def run_agent_loop(
    user_message: str,
    project_root: str,
    prior_messages: list | None = None,
    *,
    force: bool = False,
    continue_run: bool = False,
    run_id: str | None = None,
    session_id: str | None = None,
    provider: str = "local",
    api_keys: dict[str, str] | None = None,
) -> dict[str, Any]:
    """
    Run agent tool loop. Returns mode agent with reply + agent_steps metadata.
    When continue_run is True, nudges the model to resume unfinished tool work.
    """
    rid = (run_id or "").strip() or uuid.uuid4().hex
    sid = (session_id or "butler-agent").strip() or "butler-agent"
    agent_provider = (provider or "local").strip().lower() or "local"
    _set_agent_context(run_id=rid, session_id=sid, project_root=project_root)
    # User-driven Continue / re-trigger always forces the tool loop.
    if continue_run:
        force = True

    llm_state: dict[str, str] = {
        "provider": agent_provider,
        "model": LOCAL_AGENT_MODEL,
        "source_label": f"Agent · Local ({LOCAL_AGENT_MODEL})",
    }

    todos: list[dict[str, str]] = []
    steps: list[dict[str, Any]] = []
    proj = (project_root or "").strip() or str(_butler_repo_root())
    max_iter = agent_max_iterations()

    def _status(
        status: str,
        message: str,
        iteration: int = 0,
        steps_snapshot: list | None = None,
        cp: str | None = None,
        *,
        reply: str | None = None,
    ) -> None:
        write_agent_status(
            rid,
            status=status,
            message=message,
            iteration=iteration,
            max_iterations=max_iter,
            steps=steps_snapshot if steps_snapshot is not None else steps,
            checkpoint_id=cp,
            session_id=sid,
            project_root=proj,
            model_source=llm_state.get("source_label"),
            model_used=llm_state.get("model"),
            agent_provider=llm_state.get("provider"),
            todos=list(_agent_context.get("todos") or todos),
            reply=reply,
        )

    def _sync_todos(next_todos: list[dict[str, str]]) -> None:
        nonlocal todos
        todos = normalize_todos(next_todos)
        _agent_context["todos"] = todos

    def _on_provider_switch(pid: str, label: str) -> None:
        llm_state["provider"] = pid
        llm_state["source_label"] = label
        meta_model = LOCAL_AGENT_MODEL
        if resolve_agent_llm:
            try:
                meta_model = str(resolve_agent_llm(pid, api_keys).get("model") or LOCAL_AGENT_MODEL)
            except Exception:
                pass
        llm_state["model"] = meta_model

    def _call_llm(msgs: list[dict[str, str]]) -> str:
        if agent_llm_chat:
            # auto_free / cascade / cloud ids walk the ranked chain; local stays local-only
            llm_out = agent_llm_chat(
                msgs,
                provider=agent_provider if agent_provider != "local" else "local",
                api_keys=api_keys,
                max_tokens=6144,
                on_provider_switch=_on_provider_switch,
            )
            llm_state["source_label"] = llm_out.source_label
            llm_state["model"] = llm_out.model
            llm_state["provider"] = llm_out.provider
            return llm_out.content
        if not peepee_chat:
            raise RuntimeError("No agent LLM backend available")
        r = peepee_chat(
            messages=msgs,
            model=LOCAL_AGENT_MODEL,
            openai_api_key="",
            max_tokens=6144,
        )
        return str((r.get("message") or {}).get("content") or "")

    needs_cloud = agent_provider not in ("local",)
    if needs_cloud and not agent_llm_chat:
        return {
            "mode": "chat",
            "reply": "Agent cloud providers unavailable (agent_llm not loaded).",
            "source": llm_state["source_label"],
            "model_used": llm_state["model"],
            "agent_provider": agent_provider,
        }

    if agent_provider == "local" and not peepee_chat and not agent_llm_chat:
        return {
            "mode": "chat",
            "reply": "Agent tools unavailable (peepee_ai not loaded).",
            "source": llm_state["source_label"],
            "model_used": llm_state["model"],
            "agent_provider": agent_provider,
        }

    if not force and not looks_like_agent_work(user_message):
        return {
            "mode": "chat",
            "reply": "",
            "_agent_skip": True,
        }

    if looks_like_capability_question(user_message) and not force:
        return {
            "mode": "agent",
            "reply": (
                "Yes — I run on your PC with full local access. I can read and edit files, run PowerShell/cmd, "
                "search the web, query Butler's knowledge base, and change code in your projects (within BUTLER_AGENT_ROOTS). "
                "Set your workspace folder and tell me what to edit or run."
            ),
            "agent_steps": [{"type": "final", "iteration": 0, "summary": "capability confirm"}],
            "todos": [],
            "source": llm_state["source_label"],
            "model_used": llm_state["model"],
            "agent_provider": agent_provider,
            "_butler_agent": True,
            "run_id": rid,
        }

    if resolve_agent_llm:
        try:
            resolved = resolve_agent_llm(agent_provider, api_keys)
            llm_state["model"] = str(resolved.get("model") or LOCAL_AGENT_MODEL)
            if resolved.get("provider") == "local":
                llm_state["source_label"] = f"Agent · Local ({LOCAL_AGENT_MODEL})"
            elif agent_provider in ("auto_free", "cascade", "auto"):
                llm_state["source_label"] = (
                    f"Agent · Auto cascade → {resolved.get('label')} ({llm_state['model']})"
                )
            else:
                llm_state["source_label"] = f"Agent · {resolved.get('label')} ({llm_state['model']})"
            llm_state["provider"] = str(resolved.get("provider") or agent_provider)
        except Exception:
            pass

    roots = get_agent_roots()
    system_content = _AGENT_SYSTEM
    try:
        from mcp_bridge import mcp_tools_prompt_block

        system_content = _AGENT_SYSTEM + "\n\n" + mcp_tools_prompt_block()
    except Exception:
        pass
    messages: list[dict[str, str]] = [{"role": "system", "content": system_content}]
    for pm in (prior_messages or [])[-16:]:
        role = pm.get("role", "user")
        content = pm.get("content", "")
        if role in ("user", "assistant") and content:
            messages.append({"role": role, "content": str(content)[:6000]})

    user_blob = {
        "goal": user_message,
        "project_root": proj,
        "allowed_roots": [str(r) for r in roots[:12]],
    }
    if continue_run:
        user_blob["continue"] = True
        user_blob["resume_nudge"] = CONTINUE_WORK_NUDGE
    messages.append({"role": "user", "content": json.dumps(user_blob, indent=2)})
    if continue_run:
        messages.append({"role": "user", "content": CONTINUE_WORK_NUDGE})

    _sync_todos(seed_todos_from_goal(user_message))
    _log_agent(
        f"AGENT_START run={rid} goal={user_message[:200]!r} proj={proj} "
        f"provider={agent_provider} continue={continue_run}"
    )
    final_reply = ""
    needs_continue = False
    turn_cp: str | None = None
    try:
        turn_cp_out = create_checkpoint(sid, proj, [], reason="turn start")
        turn_cp = turn_cp_out.get("checkpoint_id")
    except Exception:
        turn_cp = None
    _status("starting", f"Starting agent turn ({llm_state['source_label']})…", 0, [], turn_cp)

    for iteration in range(max_iter):
        think_msg = f"Planning step {iteration + 1} of {max_iter} · {llm_state['source_label']}"
        _status("thinking", think_msg, iteration + 1, steps, turn_cp)
        try:
            raw = _call_llm(messages)
        except Exception as e:
            final_reply = f"Agent LLM error: {_exc_msg(e)}"
            _sync_todos(finalize_todos(todos, success=False))
            _status("error", final_reply, iteration + 1, steps, turn_cp, reply=final_reply)
            break

        parsed = _parse_agent_output(raw)
        if not parsed:
            tail = strip_final_envelope(raw.strip())
            if tail and not reply_denies_machine_access(tail) and not (
                tail.startswith("{") and '"tool"' in tail
            ):
                # Intent-to-act prose with iterations left → keep going (don't end the turn).
                if is_premature_act_final(tail, steps) and iteration < max_iter - 1:
                    steps.append(
                        {
                            "type": "continue",
                            "iteration": iteration + 1,
                            "summary": tail[:500],
                            "activity": "Continuing — implementing promised work…",
                        }
                    )
                    messages.append({"role": "assistant", "content": raw[:2000]})
                    messages.append({"role": "user", "content": CONTINUE_WORK_NUDGE})
                    _status(
                        "thinking",
                        "Continuing — implementing promised work…",
                        iteration + 1,
                        steps,
                        turn_cp,
                    )
                    _log_agent(f"AUTO_CONTINUE premature_prose iter={iteration + 1}")
                    continue
                # Open checklist with iterations left → keep going (don't spam a final bubble).
                if should_continue_for_incomplete_checklist(tail, todos) and iteration < max_iter - 1:
                    steps.append(
                        {
                            "type": "continue",
                            "iteration": iteration + 1,
                            "summary": tail[:500],
                            "activity": "Continuing checklist…",
                        }
                    )
                    messages.append({"role": "assistant", "content": raw[:2000]})
                    messages.append({"role": "user", "content": checklist_continue_nudge(todos)})
                    _status(
                        "thinking",
                        "Continuing checklist…",
                        iteration + 1,
                        steps,
                        turn_cp,
                    )
                    _log_agent(f"AUTO_CONTINUE incomplete_checklist_prose iter={iteration + 1}")
                    continue
                final_reply = tail[:12000]
                needs_continue = is_premature_act_final(
                    final_reply, steps
                ) or should_continue_for_incomplete_checklist(final_reply, todos)
                break
            messages.append({"role": "assistant", "content": raw[:2000]})
            messages.append(
                {
                    "role": "user",
                    "content": "Output ONE JSON object only: either a tool call or {\"final\":\"...\"}.",
                }
            )
            continue

        if parsed.get("final") is not None and not (
            parsed.get("tool") or parsed.get("name")
        ):
            final_reply = strip_final_envelope(str(parsed.get("final") or "").strip())
            if final_reply:
                # Main fix: "I'll implement now" is not done — keep using remaining iterations.
                if is_premature_act_final(final_reply, steps) and iteration < max_iter - 1:
                    steps.append(
                        {
                            "type": "continue",
                            "iteration": iteration + 1,
                            "summary": final_reply[:500],
                            "activity": "Continuing — implementing promised work…",
                        }
                    )
                    messages.append({"role": "assistant", "content": raw[:2000]})
                    messages.append({"role": "user", "content": CONTINUE_WORK_NUDGE})
                    _status(
                        "thinking",
                        "Continuing — implementing promised work…",
                        iteration + 1,
                        steps,
                        turn_cp,
                    )
                    _log_agent(f"AUTO_CONTINUE premature_final iter={iteration + 1}")
                    final_reply = ""
                    continue
                # Checklist still open — do not finalize (Cursor-style: keep working).
                if (
                    should_continue_for_incomplete_checklist(final_reply, todos)
                    and iteration < max_iter - 1
                ):
                    steps.append(
                        {
                            "type": "continue",
                            "iteration": iteration + 1,
                            "summary": final_reply[:500],
                            "activity": "Continuing checklist…",
                        }
                    )
                    messages.append({"role": "assistant", "content": raw[:2000]})
                    messages.append({"role": "user", "content": checklist_continue_nudge(todos)})
                    _status(
                        "thinking",
                        "Continuing checklist…",
                        iteration + 1,
                        steps,
                        turn_cp,
                    )
                    _log_agent(f"AUTO_CONTINUE incomplete_checklist iter={iteration + 1}")
                    final_reply = ""
                    continue
                # Truly done, clarifying question, hard blocker, or iteration budget exhausted.
                steps.append(
                    {"type": "final", "iteration": iteration + 1, "summary": final_reply[:500]}
                )
                needs_continue = is_premature_act_final(
                    final_reply, steps
                ) or should_continue_for_incomplete_checklist(final_reply, todos)
                break
            messages.append({"role": "assistant", "content": raw[:2000]})
            messages.append(
                {
                    "role": "user",
                    "content": '{"final":""} is not allowed. Reply with a real user-facing summary, question, or blocker.',
                }
            )
            continue

        tool = parsed.get("tool") or parsed.get("name")
        args = parsed.get("args") or parsed.get("arguments") or {}
        if not tool and parsed.get("final"):
            inner = _parse_agent_output(str(parsed.get("final")))
            if inner and (inner.get("tool") or inner.get("name")):
                parsed = inner
                tool = parsed.get("tool") or parsed.get("name")
                args = parsed.get("args") or parsed.get("arguments") or {}
        if not tool:
            messages.append({"role": "assistant", "content": raw[:2000]})
            messages.append(
                {
                    "role": "user",
                    "content": 'Missing "tool" key. Use {"tool":"...","args":{...}} or {"final":"..."}.',
                }
            )
            continue

        activity = tool_activity_message(str(tool), args if isinstance(args, dict) else {})
        _status("tool", activity, iteration + 1, steps, turn_cp)

        t0 = time.time()
        try:
            result = execute_tool(str(tool), args if isinstance(args, dict) else {}, proj, roots)
        except Exception as e:
            result = {
                "ok": False,
                "error": (
                    f"Tool {tool} crashed: {_exc_msg(e)}. "
                    "If this followed get_file_tree/glob on a huge tree, narrow the path."
                ),
            }
            _log_agent(f"TOOL {tool} CRASH {_exc_msg(e)}")
        elapsed = round(time.time() - t0, 2)
        if str(tool).strip().lower() == "manage_todos" and result.get("ok"):
            _sync_todos(result.get("todos") or todos)
        else:
            ctx_todos = list(_agent_context.get("todos") or todos)
            if ctx_todos is not todos:
                _sync_todos(ctx_todos)
            _sync_todos(advance_todos_after_tool(todos, str(tool)))

        status_result = _slim_tool_result_for_status(result)
        step = {
            "type": "tool",
            "iteration": iteration + 1,
            "tool": tool,
            "args": args,
            "result": status_result,
            "elapsed_sec": elapsed,
            "activity": activity,
        }
        steps.append(step)
        _log_agent(f"TOOL {tool} ok={result.get('ok')} elapsed={elapsed}s")
        last_cp = result.get("checkpoint_id") or turn_cp
        _status("tool_done", activity, iteration + 1, steps, last_cp)

        try:
            obs = json.dumps({"tool": tool, "result": result}, indent=2, ensure_ascii=False, default=str)
        except Exception as e:
            obs = json.dumps(
                {"tool": tool, "result": {"ok": False, "error": f"result serialize failed: {_exc_msg(e)}"}},
                indent=2,
            )
        obs = obs[:8000]
        if len(obs) >= 8000:
            obs += "\n… [truncated — prefer glob/list_dir on a subfolder]"
        messages.append({"role": "assistant", "content": raw[:1500]})
        messages.append(
            {
                "role": "user",
                "content": (
                    f"[Tool result]\n{obs}\n\n"
                    "Continue with another tool, update todos via manage_todos, "
                    'or finish with {"final":"user-facing summary / question / blocker"} '
                    "only when all checklist items are completed/cancelled, you need a "
                    "clarifying question, or you are blocked."
                ),
            }
        )

    def _looks_like_raw_tool(text: str) -> bool:
        t = (text or "").strip()
        if not t:
            return True
        if t.startswith("{") and ('"tool"' in t or "'tool'" in t):
            return True
        return False

    def _force_user_facing_summary() -> str:
        wrap_extra = ""
        if todos_have_open_items(todos):
            wrap_extra = (
                " Checklist items are still open — summarize progress so far; do not claim "
                "the full request is finished. The user may press Continue."
            )
        wrap_msgs = list(messages)
        wrap_msgs.append(
            {
                "role": "user",
                "content": (
                    "You must now respond to the user. Output ONLY "
                    '{"final":"..."} with a clear summary of what you did, a clarifying '
                    "question if you need more info, or an explanation of what blocked you. "
                    "Do not call tools. Plain language for a human."
                    + wrap_extra
                ),
            }
        )
        try:
            raw = _call_llm(wrap_msgs)
            parsed = _parse_agent_output(raw)
            if parsed and parsed.get("final"):
                text = str(parsed["final"]).strip()
                if text and not _looks_like_raw_tool(text):
                    return text[:12000]
            tail = (raw or "").strip()
            if tail and not _looks_like_raw_tool(tail) and not reply_denies_machine_access(tail):
                return tail[:12000]
        except Exception:
            pass
        return synthesize_final_reply(user_message, steps)

    # Late tool JSON that was mistaken for a final answer
    if final_reply and _looks_like_raw_tool(final_reply):
        late = _parse_agent_output(final_reply)
        if late and (late.get("tool") or late.get("name")):
            result = execute_tool(
                str(late.get("tool") or late.get("name")),
                late.get("args") or late.get("arguments") or {},
                proj,
                roots,
            )
            steps.append(
                {
                    "type": "tool",
                    "iteration": "late",
                    "tool": late.get("tool"),
                    "result": result,
                    "activity": tool_activity_message(
                        str(late.get("tool") or ""),
                        late.get("args") or late.get("arguments") or {},
                    ),
                }
            )
            if str(late.get("tool") or "").lower() == "manage_todos" and result.get("ok"):
                _sync_todos(result.get("todos") or todos)
            final_reply = ""

    if not final_reply or _looks_like_raw_tool(final_reply):
        # Avoid inventing a "done" wrap-up while checklist is still open — nudge once more if budget left.
        # (Budget already exhausted if we reached here after the for-loop.)
        if todos_have_open_items(todos) and not looks_like_clarifying_or_blocker(final_reply or ""):
            _status("thinking", "Continuing checklist…", max_iter, steps, turn_cp)
        else:
            _status("thinking", "Writing a summary for you…", max_iter, steps, turn_cp)
        final_reply = _force_user_facing_summary()
        # Only record one wrap-up final — not intermediate auto-continue bubbles.
        if not any(s.get("type") == "final" for s in steps):
            steps.append({"type": "final", "iteration": "wrap", "summary": final_reply[:500]})

    if not (final_reply or "").strip():
        final_reply = synthesize_final_reply(user_message, steps)

    final_reply = strip_final_envelope(final_reply)
    if is_premature_act_final(final_reply, steps) or should_continue_for_incomplete_checklist(
        final_reply, todos
    ):
        needs_continue = True

    success = not str(final_reply).startswith("Agent LLM error:") and not needs_continue
    # Preserve open checklist when paused (Continue) or when ending on a clarify/blocker ask.
    if needs_continue or (
        todos_have_open_items(todos) and looks_like_clarifying_or_blocker(final_reply)
    ):
        _sync_todos(list(todos))
    else:
        _sync_todos(finalize_todos(todos, success=success))
    done_msg = "Paused — use Continue to keep going." if needs_continue else "Finished."
    _status("done", done_msg, max_iter, steps, turn_cp, reply=final_reply)
    _log_agent_session(
        {
            "run_id": rid,
            "session_id": sid,
            "goal": user_message[:500],
            "project_root": proj,
            "steps": len(steps),
            "reply_len": len(final_reply),
            "todos": len(todos),
            "needs_continue": needs_continue,
        }
    )
    learned = _ingest_agent_learning(user_message, final_reply, proj, steps)

    # Slim steps for HTTP response — full trees caused MemoryError → empty str(e) in /chat/agent.
    response_steps: list[dict[str, Any]] = []
    for s in steps:
        if not isinstance(s, dict):
            continue
        sc = dict(s)
        if "result" in sc:
            sc["result"] = _slim_tool_result_for_status(sc.get("result"), max_chars=6000)
        response_steps.append(sc)

    return {
        "mode": "agent",
        "reply": final_reply,
        "agent_steps": response_steps,
        "todos": todos,
        "source": llm_state["source_label"],
        "model_used": llm_state["model"],
        "agent_provider": llm_state.get("provider") or agent_provider,
        "fallback_chain": list(build_fallback_chain(agent_provider)) if build_fallback_chain else [agent_provider],
        "_butler_agent": True,
        "run_id": rid,
        "knowledge_ingested": learned,
        "needs_continue": needs_continue,
    }
