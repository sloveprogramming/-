from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Mapping, Sequence
from typing import Any, Protocol

from app.domain.prospect.models import Lookup, QualifierInput, QualifierResult
from app.infrastructure.qcc_mcp import McpToolResult, QccMcpClient, QccMcpDomain

logger = logging.getLogger(__name__)

_CHANNEL_JOB_KEYWORDS = (
    "采购",
    "渠道",
    "销售",
    "商务",
    "招商",
    "经销",
    "大客户",
    "sales",
    "business development",
    "channel",
    "purchas",
    "sourcing",
    "account executive",
)

_SIGNAL_LOOKUPS: tuple[tuple[str, QccMcpDomain, str], ...] = (
    ("lookup_company_profile", "company", "get_company_profile"),
    ("lookup_recruitment", "operation", "get_recruitment_info"),
    ("lookup_bidding", "operation", "get_bidding_info"),
    ("lookup_qualifications", "operation", "get_qualifications"),
    ("lookup_food_safety", "operation", "get_food_safety"),
)

_SYSTEM_PROMPT = """你是客户资格审核员。销售准备打电话给一家公司，但确定性评分落在灰色带。

你会看到企查查只读工具查到的证据和工商登记字段。请判断这家公司值不值得优先打这个电话。

规则：
1. 行业是否对口最重要；然后看招聘、招投标、资质和食品安全风险。
2. 只陈述证据里出现的事实。没查到就写「未查到」，绝不推测。
3. lookups 里失败的工具不等于「没有记录」，要在理由里区分。
4. 不要改分数，不要报价，不要承诺政策，不要评价对方信誉。
5. 最后只输出 JSON：{"verdict":"pursue|hold|drop","reasoning":"不超过 80 字，说清最关键依据"}。

pursue = 值得优先打；hold = 可以打但优先级一般；drop = 不建议打（行业不符或有硬风险）。"""


class QualificationModel(Protocol):
    async def complete_json(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        schema_name: str,
        max_output_tokens: int = 500,
    ) -> dict[str, Any]: ...


class QualifierUnavailable(RuntimeError):
    """The optional qualifier cannot run because a dependency is missing."""


class ProspectQualifier:
    """Collect bounded read-only evidence, then ask the model for one verdict."""

    def __init__(
        self,
        *,
        model: QualificationModel | None,
        mcp: QccMcpClient | None,
        timeout_seconds: float = 45,
    ) -> None:
        self._model = model
        self._mcp = mcp
        self._timeout_seconds = timeout_seconds

    async def __call__(self, request: QualifierInput) -> QualifierResult | None:
        if self._model is None:
            raise QualifierUnavailable("未配置模型，无法执行灰色带深查")
        if self._mcp is None or not self._mcp.configured:
            raise QualifierUnavailable("企查查 MCP 未配置（缺少 QCC_MCP_TOKEN）")

        results = await asyncio.wait_for(
            asyncio.gather(
                *(
                    self._mcp.call_tool(
                        domain=domain,
                        tool=tool,
                        args={"searchKey": request.company_name},
                    )
                    for _, domain, tool in _SIGNAL_LOOKUPS
                ),
                return_exceptions=True,
            ),
            timeout=self._timeout_seconds,
        )
        lookups: list[Lookup] = []
        evidence: list[str] = []
        successful = 0
        for (lookup_name, _, tool), outcome in zip(_SIGNAL_LOOKUPS, results, strict=True):
            if isinstance(outcome, BaseException):
                result = McpToolResult(ok=False, error=str(outcome))
            else:
                result = outcome
            lookups.append(Lookup(tool=lookup_name, ok=result.ok))
            if result.ok:
                successful += 1
                evidence.append(
                    f"- {lookup_name} ({tool})："
                    f"{json.dumps(_compact_signal(result.data), ensure_ascii=False)}"
                )
            else:
                evidence.append(f"- {lookup_name} ({tool})：查询失败（{result.error}）")

        if successful == 0:
            logger.info("灰色带深查所有企查查工具均失败：%s", request.company_name)
            return None

        raw = await self._model.complete_json(
            system_prompt=_SYSTEM_PROMPT,
            user_prompt=self._user_prompt(request, evidence),
            schema_name="prospect_qualifier",
            max_output_tokens=500,
        )
        verdict = raw.get("verdict")
        if verdict not in {"pursue", "hold", "drop"}:
            return None
        reasoning = raw.get("reasoning")
        if not isinstance(reasoning, str) or not reasoning.strip():
            return None
        return QualifierResult(
            verdict=verdict,
            reasoning=reasoning.strip()[:200],
            lookups=lookups,
        )

    @staticmethod
    def _user_prompt(request: QualifierInput, evidence: Sequence[str]) -> str:
        facts = [
            ("产品", request.product),
            ("目标买家", request.buyer_description),
            ("公司", request.company_name),
            ("系统分数", f"{request.score}（{request.tier}）"),
            ("行业", request.industry),
            ("地区", request.region),
            ("注册资本", request.registered_capital),
            ("成立日期", request.founded_at),
            ("经营状态", request.status),
            ("经营范围", request.scope),
        ]
        lines = [
            f"{label}：{value if value not in (None, '') else '未提供'}" for label, value in facts
        ]
        lines.extend(("", "企查查只读证据：", *evidence))
        lines.extend(("", "请给出一句结论。"))
        return "\n".join(lines)


def _compact_signal(data: Any) -> dict[str, Any]:
    """Bound provider payloads so one large list cannot flood the model context."""

    if not isinstance(data, Mapping):
        return {"原始结果": _short(data)}

    compact: dict[str, Any] = {}
    for key, value in data.items():
        if isinstance(key, str) and (
            key in {"摘要", "提示", "说明", "搜索结果"} or key.endswith("条目数")
        ):
            compact[key] = _short(value)

    rows = _first_rows(data)
    if rows:
        compact["记录数"] = len(rows)
        compact["样本"] = [_shrink_row(row) for row in rows[:5]]

    titles = [str(row.get("招聘职位") or "") for row in rows if isinstance(row, Mapping)]
    channel_hits = [
        title
        for title in titles
        if title and any(keyword.lower() in title.lower() for keyword in _CHANNEL_JOB_KEYWORDS)
    ]
    if channel_hits:
        compact["渠道岗位"] = channel_hits[:5]

    if not compact:
        compact["原始结果"] = _short(data)
    return compact


def _first_rows(data: Mapping[str, Any]) -> list[Any]:
    for value in data.values():
        if isinstance(value, list) and value:
            return value
    return []


def _shrink_row(row: Any) -> Any:
    if not isinstance(row, Mapping):
        return _short(row)
    compact: dict[str, Any] = {}
    for key, value in list(row.items())[:15]:
        if isinstance(value, str) and value.strip():
            compact[str(key)] = value.strip()[:160]
        elif isinstance(value, (int, float, bool)):
            compact[str(key)] = value
        elif isinstance(value, list):
            values = [str(item).strip()[:80] for item in value if str(item).strip()]
            if values:
                compact[str(key)] = values[:5]
    return compact or {"原始结果": _short(row)}


def _short(value: Any, limit: int = 500) -> str:
    if isinstance(value, str):
        return value.strip()[:limit]
    text = json.dumps(value, ensure_ascii=False, default=str)
    return text[:limit]
