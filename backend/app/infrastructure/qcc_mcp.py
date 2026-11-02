from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Literal

import httpx
from langsmith import traceable

QccMcpDomain = Literal["company", "risk", "ipr", "operation", "executive"]

_DOMAIN_PATHS: dict[QccMcpDomain, str] = {
    "company": "company",
    "risk": "risk",
    "ipr": "ipr",
    "operation": "operation",
    "executive": "executive",
}


@dataclass(frozen=True, slots=True)
class McpToolResult:
    ok: bool
    data: Any = None
    error: str | None = None


def _trace_mcp_inputs(inputs: dict[str, Any]) -> dict[str, Any]:
    return {
        "domain": inputs.get("domain"),
        "tool": inputs.get("tool"),
        "args": inputs.get("args"),
    }


def _trace_mcp_outputs(result: McpToolResult) -> dict[str, Any]:
    return {
        "ok": result.ok,
        "error": result.error,
        "has_data": result.data is not None,
    }


def qcc_mcp_configured(token: str | None) -> bool:
    """Treat common placeholder values as "not configured"."""

    normalized = (token or "").strip().lower()
    return normalized not in {"", "undefined", "null", "none", "change-me"}


class QccMcpClient:
    """Minimal read-only client for QCC's ``tools/call`` endpoint."""

    def __init__(
        self,
        *,
        token: str | None,
        base_url: str = "https://agent.qcc.com/mcp",
        timeout_seconds: float = 20,
    ) -> None:
        self._token = (token or "").strip()
        self._base_url = base_url.rstrip("/")
        self._timeout_seconds = timeout_seconds

    @property
    def configured(self) -> bool:
        return qcc_mcp_configured(self._token)

    @traceable(
        run_type="tool",
        name="QCC MCP read-only lookup",
        tags=["tool", "qcc", "mcp"],
        process_inputs=_trace_mcp_inputs,
        process_outputs=_trace_mcp_outputs,
    )
    async def call_tool(
        self,
        *,
        domain: QccMcpDomain,
        tool: str,
        args: Mapping[str, Any],
    ) -> McpToolResult:
        if not self.configured:
            return McpToolResult(
                ok=False,
                error="企查查 MCP 未配置（缺少 QCC_MCP_TOKEN）",
            )

        url = f"{self._base_url}/{_DOMAIN_PATHS[domain]}/stream"
        try:
            async with httpx.AsyncClient(timeout=self._timeout_seconds) as client:
                response = await client.post(
                    url,
                    headers={
                        "Authorization": f"Bearer {self._token}",
                        "Content-Type": "application/json",
                        "Accept": "application/json, text/event-stream",
                    },
                    json={
                        "jsonrpc": "2.0",
                        "id": 1,
                        "method": "tools/call",
                        "params": {"name": tool, "arguments": dict(args)},
                    },
                )
        except httpx.RequestError as error:
            return McpToolResult(ok=False, error=f"企查查 MCP 请求失败：{error}")

        if response.is_error:
            hint = ""
            if response.status_code in {401, 403}:
                hint = "（token 失效或该数据域未授权）"
            elif response.status_code == 429:
                hint = "（调用频率超限）"
            return McpToolResult(
                ok=False,
                error=f"企查查 MCP 返回 HTTP {response.status_code}{hint}",
            )

        body = response.text
        if not body.strip():
            return McpToolResult(ok=False, error="企查查 MCP 返回空响应")
        envelope = extract_json_rpc(body)
        if envelope is None:
            return McpToolResult(ok=False, error="企查查 MCP 返回无法解析的响应")
        if envelope.get("error"):
            error = envelope["error"]
            message = error.get("message") if isinstance(error, Mapping) else None
            return McpToolResult(
                ok=False,
                error=f"企查查 MCP 错误：{message or '未知错误'}",
            )

        result = envelope.get("result")
        content = result.get("content") if isinstance(result, Mapping) else None
        if not isinstance(content, list):
            return McpToolResult(ok=False, error="企查查 MCP 没有返回内容")
        texts = [
            item.get("text", "")
            for item in content
            if isinstance(item, Mapping) and item.get("type") == "text"
        ]
        text = "\n".join(value for value in texts if isinstance(value, str)).strip()
        if not text:
            return McpToolResult(ok=False, error="企查查 MCP 没有返回内容")
        try:
            return McpToolResult(ok=True, data=json.loads(text))
        except json.JSONDecodeError:
            return McpToolResult(ok=True, data={"text": text})


def extract_json_rpc(body: str) -> dict[str, Any] | None:
    """Find the final JSON-RPC message in an SSE or plain JSON response."""

    for data in reversed(sse_data_lines(body)):
        parsed = _json_object(data)
        if parsed is not None and ("result" in parsed or "error" in parsed):
            return parsed
    parsed = _json_object(body)
    if parsed is not None and ("result" in parsed or "error" in parsed):
        return parsed
    return None


def sse_data_lines(body: str) -> list[str]:
    """Collect SSE ``data`` fields, joining multi-line values per event."""

    events: list[str] = []
    buffer: list[str] = []

    def flush() -> None:
        if buffer:
            events.append("\n".join(buffer))
            buffer.clear()

    for raw_line in body.splitlines():
        if not raw_line:
            flush()
            continue
        if raw_line.startswith(":"):
            continue
        field, separator, value = raw_line.partition(":")
        if separator and field == "data":
            buffer.append(value[1:] if value.startswith(" ") else value)
    flush()
    return events


def _json_object(value: str) -> dict[str, Any] | None:
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None
