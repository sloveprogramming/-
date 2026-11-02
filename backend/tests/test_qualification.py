from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import pytest

from app.domain.prospect.models import QualifierInput
from app.domain.prospect.qualification import ProspectQualifier, QualifierUnavailable
from app.infrastructure.qcc_mcp import McpToolResult


class FakeMcp:
    configured = True

    def __init__(self, *, all_fail: bool = False) -> None:
        self.calls: list[str] = []
        self.all_fail = all_fail

    async def call_tool(
        self,
        *,
        domain: str,
        tool: str,
        args: Mapping[str, Any],
    ) -> McpToolResult:
        self.calls.append(tool)
        if self.all_fail:
            return McpToolResult(ok=False, error="provider unavailable")
        if tool == "get_recruitment_info":
            return McpToolResult(
                ok=True,
                data={
                    "摘要": "共 2 条招聘",
                    "招聘信息": [
                        {"招聘职位": "渠道销售经理", "办公地点": "杭州"},
                        {"招聘职位": "会计", "办公地点": "杭州"},
                    ],
                },
            )
        if tool == "get_qualifications":
            return McpToolResult(
                ok=True,
                data={"食品经营许可证条目数": 1, "资质证书": []},
            )
        if tool == "get_food_safety":
            return McpToolResult(ok=False, error="该数据域未授权")
        return McpToolResult(ok=True, data={"企业名称": "临安烘焙食品有限公司"})


class FakeModel:
    def __init__(self) -> None:
        self.calls = 0
        self.last_user_prompt = ""

    async def complete_json(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        schema_name: str,
        max_output_tokens: int = 500,
    ) -> dict[str, Any]:
        self.calls += 1
        self.last_user_prompt = user_prompt
        return {"verdict": "pursue", "reasoning": "在招渠道岗位且有食品经营许可。"}


def request() -> QualifierInput:
    return QualifierInput(
        company_name="临安烘焙食品有限公司",
        score=58,
        tier="workable",
        buyer_description="烘焙食品厂、食品加工厂",
        product="面包丝",
        industry="烘焙食品制造",
        scope="食品生产与销售",
        region="浙江省 杭州市",
        registered_capital="500万元人民币",
        founded_at="2018-01-01",
        status="存续",
    )


async def test_qualifier_uses_actual_tool_results_in_its_audit_trail() -> None:
    mcp = FakeMcp()
    model = FakeModel()
    qualifier = ProspectQualifier(model=model, mcp=mcp)  # type: ignore[arg-type]

    result = await qualifier(request())

    assert result is not None
    assert result.verdict == "pursue"
    assert len(result.lookups) == 5
    assert {lookup.tool for lookup in result.lookups} == {
        "lookup_company_profile",
        "lookup_recruitment",
        "lookup_bidding",
        "lookup_qualifications",
        "lookup_food_safety",
    }
    assert [lookup.ok for lookup in result.lookups].count(False) == 1
    assert "渠道岗位" in model.last_user_prompt
    assert "该数据域未授权" in model.last_user_prompt


async def test_qualifier_does_not_invent_a_verdict_when_every_lookup_fails() -> None:
    model = FakeModel()
    qualifier = ProspectQualifier(
        model=model,
        mcp=FakeMcp(all_fail=True),  # type: ignore[arg-type]
    )

    assert await qualifier(request()) is None
    assert model.calls == 0


async def test_qualifier_reports_missing_mcp_configuration() -> None:
    qualifier = ProspectQualifier(model=FakeModel(), mcp=None)

    with pytest.raises(QualifierUnavailable, match="QCC_MCP_TOKEN"):
        await qualifier(request())
