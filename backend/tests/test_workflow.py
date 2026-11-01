from __future__ import annotations

from app.domain.prospect.models import (
    CompanyHit,
    ProductIntent,
    ReplanDecision,
    ReplanInput,
    SearchResult,
)
from app.domain.prospect.workflow import (
    ProspectWorkflowDependencies,
    build_prospect_graph,
    run_prospect_workflow,
)

ORG_ID = "00000000-0000-4000-8000-000000000001"


def intent() -> ProductIntent:
    return ProductIntent(
        query="面包丝",
        category="烘焙原料 / 裹粉类",
        segment="distributor",
        buyer_description="烘焙食品厂、油炸食品加工厂",
        search_terms=["面包丝", "烘焙食品", "食品加工"],
        exclude_terms=[],
        source="dictionary",
        confidence=1,
        uncertainties=[],
    )


def hit(name: str, phone: str | None = None, score_bias: str = "烘焙食品") -> CompanyHit:
    return CompanyHit(
        key=name,
        name=name,
        credit_code=None,
        region="浙江省 杭州市",
        industry=score_bias,
        legal_person="张三",
        founded_at="2012-06-15",
        registered_capital="5000万元人民币",
        phones=[phone] if phone else [],
        scope="烘焙食品生产与销售",
        status="存续",
        in_library=False,
    )


async def interpret(_: str) -> ProductIntent:
    return intent()


async def empty_search(_: str, __: int) -> SearchResult:
    return SearchResult(source="local", total=0, hits=[], notice=None)


def dependencies(**overrides: object) -> ProspectWorkflowDependencies:
    values: dict[str, object] = {
        "interpret": interpret,
        "search": empty_search,
        "replan": None,
        "qualify": None,
        "record_artifact": None,
    }
    values.update(overrides)
    return ProspectWorkflowDependencies(**values)


def test_graph_contains_agent_nodes_without_global_supervisor() -> None:
    compiled = build_prospect_graph(dependencies())
    nodes = set(compiled.get_graph().nodes)

    assert {"product_intent", "sourcing", "scoring", "contact", "finish"} <= nodes
    assert "supervisor" not in nodes


async def test_no_hits_skips_scoring_and_finishes() -> None:
    async def explode(*_: object) -> None:
        raise AssertionError("scoring must not run when there are no companies")

    result = await run_prospect_workflow(
        product="面包丝",
        organization_id=ORG_ID,
        trace_id="11111111-1111-4111-8111-111111111111",
        deps=dependencies(qualify=explode),
    )

    assert result.stats.found == 0
    assert result.companies == []
    assert result.stats.priority == 0


async def test_sourcing_deduplicates_and_contactable_companies_sort_first() -> None:
    calls = 0

    async def search(term: str, _: int) -> SearchResult:
        nonlocal calls
        calls += 1
        if term == "面包丝":
            return SearchResult(
                source="local",
                total=2,
                hits=[hit("无电话公司"), hit("有电话公司", "0571-88886666")],
                notice=None,
            )
        return SearchResult(
            source="local",
            total=1,
            hits=[hit("无电话公司")],
            notice=None,
        )

    result = await run_prospect_workflow(
        product="面包丝",
        organization_id=ORG_ID,
        trace_id="11111111-1111-4111-8111-111111111111",
        deps=dependencies(search=search),
    )

    assert calls == 3
    assert result.stats.found == 2
    assert result.stats.reachable == 1
    assert [company.hit.name for company in result.companies] == ["有电话公司", "无电话公司"]


async def test_replan_failure_keeps_first_round_results() -> None:
    async def search(_: str, __: int) -> SearchResult:
        return SearchResult(source="local", total=1, hits=[hit("第一轮公司")], notice=None)

    async def failing_replan(_: ReplanInput) -> ReplanDecision:
        raise RuntimeError("replanner unavailable")

    result = await run_prospect_workflow(
        product="面包丝",
        organization_id=ORG_ID,
        trace_id="11111111-1111-4111-8111-111111111111",
        deps=dependencies(search=search, replan=failing_replan),
    )

    assert result.stats.found == 1
    assert result.replan is not None
    assert result.replan.triggered is False
    assert result.replan.reasoning == "重规划失败，已保持第一轮结果"
