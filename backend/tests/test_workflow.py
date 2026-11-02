from __future__ import annotations

from app.domain.prospect.models import (
    CompanyAssessment,
    CompanyHit,
    Lookup,
    ProductIntent,
    QualifierResult,
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


def intent(
    *,
    search_terms: list[str] | None = None,
    exclude_terms: list[str] | None = None,
) -> ProductIntent:
    return ProductIntent(
        query="面包丝",
        category="烘焙原料 / 裹粉类",
        segment="distributor",
        buyer_description="烘焙食品厂、油炸食品加工厂",
        search_terms=search_terms or ["面包丝", "烘焙食品", "食品加工"],
        exclude_terms=exclude_terms or [],
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
    assert "换词重搜失败，已保留第一轮结果。" in result.warnings


async def test_exclude_terms_filter_search_terms_and_company_hits() -> None:
    searched: list[str] = []

    async def search(term: str, _: int) -> SearchResult:
        searched.append(term)
        return SearchResult(
            source="local",
            total=2,
            hits=[
                hit("临安烘焙食品有限公司"),
                hit("原料贸易有限公司", score_bias="原料贸易"),
            ],
            notice=None,
        )

    async def filtered_interpret(_: str) -> ProductIntent:
        return intent(
            search_terms=["面包丝", "烘焙食品", "食品加工"],
            exclude_terms=["面包丝", "原料"],
        )

    result = await run_prospect_workflow(
        product="面包丝",
        organization_id=ORG_ID,
        trace_id="11111111-1111-4111-8111-111111111111",
        deps=dependencies(interpret=filtered_interpret, search=search),
    )

    assert searched == ["烘焙食品", "食品加工"]
    assert [company.hit.name for company in result.companies] == ["临安烘焙食品有限公司"]


async def test_all_excluded_terms_skips_search_with_a_visible_warning() -> None:
    calls = 0

    async def search(_: str, __: int) -> SearchResult:
        nonlocal calls
        calls += 1
        return SearchResult(source="local", total=1, hits=[hit("不应出现")], notice=None)

    async def excluded_interpret(_: str) -> ProductIntent:
        return intent(
            search_terms=["面包丝", "烘焙食品"],
            exclude_terms=["面包丝", "烘焙食品"],
        )

    result = await run_prospect_workflow(
        product="面包丝",
        organization_id=ORG_ID,
        trace_id="11111111-1111-4111-8111-111111111111",
        deps=dependencies(interpret=excluded_interpret, search=search),
    )

    assert calls == 0
    assert result.companies == []
    assert result.warnings == ["所有搜索词都命中了排除项，已跳过搜索，请检查产品画像。"]


async def test_search_degradation_and_failure_become_visible_warnings() -> None:
    async def search(term: str, _: int) -> SearchResult:
        if term == "面包丝":
            return SearchResult(
                source="local",
                total=1,
                hits=[hit("临安烘焙食品有限公司")],
                notice="企查查调用失败，已退回本地结果",
            )
        raise RuntimeError("搜索结果不可用")

    result = await run_prospect_workflow(
        product="面包丝",
        organization_id=ORG_ID,
        trace_id="11111111-1111-4111-8111-111111111111",
        deps=dependencies(search=search),
    )

    assert any("搜索降级" in warning for warning in result.warnings)
    assert any("搜索结果不可用" in warning for warning in result.warnings)
    assert result.stats.found == 1


async def test_artifacts_keep_the_ts_payload_contract_in_pipeline_order() -> None:
    artifacts: list[tuple[str, dict[str, object]]] = []

    async def record(role: str, payload: dict[str, object]) -> None:
        artifacts.append((role, payload))

    async def search(_: str, __: int) -> SearchResult:
        return SearchResult(
            source="local",
            total=1,
            hits=[hit("临安烘焙食品有限公司", "0571-88886666")],
            notice=None,
        )

    await run_prospect_workflow(
        product="面包丝",
        organization_id=ORG_ID,
        trace_id="11111111-1111-4111-8111-111111111111",
        deps=dependencies(search=search, record_artifact=record),
    )

    assert [role for role, _ in artifacts] == ["planner", "sourcer", "qualifier", "contact"]
    plan = artifacts[0][1]
    assert "searchTerms" in plan and "search_terms" not in plan
    sourcing = artifacts[1][1]
    assert sourcing["companies"][0]["inLibrary"] is False  # type: ignore[index]
    qualification = artifacts[2][1]
    assert qualification["companies"][0]["caveats"]  # type: ignore[index]
    assert "deepCheck" not in qualification["companies"][0]  # type: ignore[index]
    contact = artifacts[3][1]
    assert contact == {
        "companies": [
            {"name": "临安烘焙食品有限公司", "phones": ["0571-88886666"], "reachable": True}
        ]
    }


async def test_gray_zone_deep_check_is_an_audited_attachment_not_a_score_change() -> None:
    artifacts: list[tuple[str, dict[str, object]]] = []

    async def search(_: str, __: int) -> SearchResult:
        return SearchResult(
            source="local",
            total=1,
            hits=[hit("临安烘焙食品有限公司")],
            notice=None,
        )

    def gray_assessment(_: object, __: object) -> CompanyAssessment:
        return CompanyAssessment(
            company_name="临安烘焙食品有限公司",
            score=58,
            tier="workable",
            dimensions=[],
            verdict="可以联系，先探需求",
            caveats=["测试用附加判断"],
        )

    async def qualify(_: object) -> QualifierResult:
        return QualifierResult(
            verdict="pursue",
            reasoning="在招渠道岗位，且有食品经营许可",
            lookups=[
                Lookup(tool="lookup_recruitment", ok=True),
                Lookup(tool="lookup_qualifications", ok=False),
            ],
        )

    async def record(role: str, payload: dict[str, object]) -> None:
        artifacts.append((role, payload))

    result = await run_prospect_workflow(
        product="面包丝",
        organization_id=ORG_ID,
        trace_id="11111111-1111-4111-8111-111111111111",
        deps=dependencies(
            search=search,
            assess=gray_assessment,
            qualify=qualify,
            record_artifact=record,
        ),
    )

    company = result.companies[0]
    assert company.score == 58
    assert company.deep_check is not None
    assert company.deep_check.lookups == ["lookup_recruitment", "lookup_qualifications"]
    qualification = next(payload for role, payload in artifacts if role == "qualifier")
    artifact_check = qualification["companies"][0]["deepCheck"]  # type: ignore[index]
    assert artifact_check["lookups"] == ["lookup_recruitment", "lookup_qualifications"]
