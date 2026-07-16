"""
HTTP bridge from Knowledge agent → ui-server MCP host.

Node (`agent-mcp-host.mjs`) owns stdio/HTTP MCP sessions.
The Python agent lists/calls tools via BUTLER_MCP_BRIDGE_URL (default :4001).
"""
from __future__ import annotations

import json
import os
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


def mcp_bridge_base() -> str:
    raw = (
        os.environ.get("BUTLER_MCP_BRIDGE_URL")
        or os.environ.get("BUTLER_UI_API_URL")
        or os.environ.get("BUTLER_API_URL")
        or "http://127.0.0.1:4001"
    ).strip().rstrip("/")
    return raw or "http://127.0.0.1:4001"


def _request(method: str, path: str, body: dict | None = None, timeout: float = 60.0) -> dict[str, Any]:
    url = f"{mcp_bridge_base()}{path}"
    data = None
    headers = {"Accept": "application/json"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = Request(url, data=data, headers=headers, method=method.upper())
    try:
        with urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            if not raw.strip():
                return {"ok": True}
            parsed = json.loads(raw)
            return parsed if isinstance(parsed, dict) else {"ok": True, "data": parsed}
    except HTTPError as e:
        err_body = ""
        try:
            err_body = e.read().decode("utf-8", errors="replace")[:400]
        except Exception:
            pass
        return {"ok": False, "error": f"MCP bridge HTTP {e.code}: {err_body or e.reason}"}
    except URLError as e:
        return {
            "ok": False,
            "error": f"MCP bridge unreachable at {url}: {e.reason}. Is ui-server running on 4001?",
        }
    except Exception as e:
        return {"ok": False, "error": str(e)}


def list_mcp_tools() -> dict[str, Any]:
    out = _request("GET", "/api/agent/mcp/tools", timeout=15.0)
    if not out.get("ok", True) and "error" in out:
        return out
    tools = out.get("tools") if isinstance(out.get("tools"), list) else []
    compact = []
    for t in tools:
        if not isinstance(t, dict):
            continue
        compact.append(
            {
                "serverId": t.get("serverId") or t.get("server_id"),
                "serverName": t.get("serverName") or t.get("server_name"),
                "name": t.get("name"),
                "description": (t.get("description") or "")[:300],
            }
        )
    return {"ok": True, "tools": compact, "count": len(compact), "bridge": mcp_bridge_base()}


def call_mcp_tool(server_id: str, tool: str, args: dict | None = None) -> dict[str, Any]:
    sid = (server_id or "").strip()
    name = (tool or "").strip()
    if not sid or not name:
        return {"ok": False, "error": "server_id and tool are required"}
    payload = {
        "serverId": sid,
        "tool": name,
        "args": args if isinstance(args, dict) else {},
    }
    out = _request("POST", "/api/agent/mcp/call", body=payload, timeout=90.0)
    # Flatten text content for the LLM
    content = out.get("content")
    if isinstance(content, list):
        texts = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                texts.append(str(block.get("text") or ""))
            elif isinstance(block, dict):
                texts.append(json.dumps(block)[:2000])
        if texts:
            joined = "\n".join(texts)
            if len(joined) > 12000:
                joined = joined[:12000] + "\n…[truncated]"
            out = {**out, "text": joined}
    return out


def mcp_tools_prompt_block() -> str:
    """Short catalog injected into the agent system prompt when tools are live."""
    listed = list_mcp_tools()
    tools = listed.get("tools") if listed.get("ok") else None
    if not tools:
        return (
            "MCP: no servers connected yet. Operator can Connect from Agent → MCP. "
            "You may still call mcp_list to refresh; if empty, prefer knowledge_query / web_search / fetch_url."
        )
    lines = [
        "MCP tools (prefer for library docs / persistent memory; do NOT use for Slack/Notion social):",
        'List: {"tool":"mcp_list","args":{}}',
        'Call: {"tool":"mcp_call","args":{"server_id":"<id>","tool":"<name>","args":{...}}}',
        "Connected:",
    ]
    for t in tools[:40]:
        desc = (t.get("description") or "").replace("\n", " ").strip()
        if len(desc) > 120:
            desc = desc[:117] + "…"
        lines.append(
            f"- server_id={t.get('serverId')} tool={t.get('name')}"
            + (f" — {desc}" if desc else "")
        )
    return "\n".join(lines)
