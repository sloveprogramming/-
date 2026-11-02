from __future__ import annotations

import pytest

from app.infrastructure.qcc_mcp import (
    QccMcpClient,
    extract_json_rpc,
    qcc_mcp_configured,
    sse_data_lines,
)


def test_placeholder_tokens_are_not_treated_as_configured() -> None:
    assert qcc_mcp_configured("undefined") is False
    assert qcc_mcp_configured("") is False
    assert qcc_mcp_configured(None) is False
    assert qcc_mcp_configured("real-token") is True


def test_sse_json_rpc_uses_the_final_data_event() -> None:
    body = "\n".join(
        (
            "event: message",
            'data: {"jsonrpc":"2.0","result":{"content":[]}}',
            "",
            "event: message",
            'data: {"jsonrpc":"2.0","result":{"content":[{"type":"text","text":"ok"}]}}',
            "",
        )
    )

    assert sse_data_lines(body)[-1].startswith('{"jsonrpc"')
    assert extract_json_rpc(body) == {
        "jsonrpc": "2.0",
        "result": {"content": [{"type": "text", "text": "ok"}]},
    }


def test_plain_json_rpc_response_is_supported() -> None:
    assert extract_json_rpc('{"result":{"content":[]}}') == {"result": {"content": []}}


async def test_missing_token_returns_a_readable_error_without_network() -> None:
    client = QccMcpClient(token="undefined")

    result = await client.call_tool(
        domain="company",
        tool="get_company_profile",
        args={"searchKey": "临安烘焙食品有限公司"},
    )

    assert result.ok is False
    assert "QCC_MCP_TOKEN" in (result.error or "")


@pytest.mark.parametrize("body", ["", "not-json", "data: not-json\n\n"])
def test_unparseable_mcp_bodies_are_rejected(body: str) -> None:
    assert extract_json_rpc(body) is None
