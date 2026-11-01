from __future__ import annotations

import logging
import operator
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from typing import Annotated, Any, TypedDict

from langgraph.graph import END, START, StateGraph

from app.domain.prospect.intent import fallback_intent
from app.domain.prospect.models import (
    AssessedCompany,
    CompanyAssessment,
    CompanyHit,
    DeepCheck,
    ProductIntent,
    ProspectResult,
    ProspectStats,
    QualifierInput,
    QualifierResult,
    ReplanDecision,
    ReplanInput,
    SearchResult,
    SourcingReplan,
    TermHit,
)
from app.domain.prospect.scoring import (
    CompanyFacts,
    assess_company,
    buyer_terms_for,
    clean_phones,
    sort_assessed_companies,
)

logger = logging.getLogger(__name__)

SEARCH_LIMIT_PER_TERM = 20
MAX_COMPANIES = 60
MIN_COMPANIES_BEFORE_REPLAN = 5
GRAY_ZONE_MIN = 45
GRAY_ZONE_MAX = 65
MAX_DEEP_CHECK = 2

InterpretProduct = Callable[[str], Awaitable[ProductIntent]]
SearchCompanies = Callable[[str, int], Awaitable[SearchResult]]
ReplanSearch = Callable[[ReplanInput], Awaitable[ReplanDecision]]
QualifyCompany = Callable[[QualifierInput], Awaitable[QualifierResult | None]]
AssessCompany = Callable[[CompanyFacts, Sequence[str]], CompanyAssessment]
RecordArtifact = Callable[[str, dict[str, Any]], Awaitable[None]]


class ProspectState(TypedDict, total=False):
    """Structured data passed between agents; no natural-language summaries."""

    product: str
    organization_id: str
    trace_id: str
    intent: ProductIntent | None
    term_hits: list[TermHit]
    hits: list[CompanyHit]
    replan: SourcingReplan | None
    assessed: list[AssessedCompany]
    reachable: int
    priority: int
    error: str | None
    trail: Annotated[list[str], operator.add]


@dataclass(slots=True)
class ProspectWorkflowDependencies:
    interpret: InterpretProduct
    search: SearchCompanies
    replan: ReplanSearch | None = None
    qualify: QualifyCompany | None = None
    assess: AssessCompany = field(default=assess_company)
    record_artifact: RecordArtifact | None = None


async def _emit(
    dependencies: ProspectWorkflowDependencies,
    role: str,
    payload: dict[str, Any],
) -> None:
    if dependencies.record_artifact is None:
        return
    try:
        await dependencies.record_artifact(role, payload)
    except Exception:
        logger.exception("Agent 产物落库失败，不改变业务结果")


class ProductIntentAgent:
    def __init__(self, dependencies: ProspectWorkflowDependencies) -> None:
        self._dependencies = dependencies

    async def run(self, state: ProspectState) -> dict[str, Any]:
        product = state["product"]
        try:
            intent = await self._dependencies.interpret(product)
        except Exception:
            logger.exception("产品画像失败，退回兜底画像")
            intent = fallback_intent(product)
        detail = intent.category or "未识别品类"
        await _emit(self._dependencies, "planner", intent.model_dump(mode="python"))
        return {
            "intent": intent,
            "trail": [f"product_intent: {detail}，{len(intent.search_terms)} 个搜索词"],
        }


class SourcingAgent:
    def __init__(self, dependencies: ProspectWorkflowDependencies) -> None:
        self._dependencies = dependencies

    async def run(self, state: ProspectState) -> dict[str, Any]:
        intent = state.get("intent")
        if intent is None:
            return {"error": "产品画像缺失", "trail": ["sourcing: 缺少产品画像"]}

        by_name: dict[str, CompanyHit] = {}
        term_hits: list[TermHit] = []

        async def run_terms(terms: Sequence[str]) -> None:
            for term in terms:
                try:
                    result = await self._dependencies.search(term, SEARCH_LIMIT_PER_TERM)
                    term_hits.append(TermHit(term=term, hits=result.total))
                    for hit in result.hits:
                        by_name.setdefault(hit.name, hit)
                except Exception as error:
                    term_hits.append(TermHit(term=term, hits=0, error=str(error)))

        await run_terms(intent.search_terms)
        replan_info: SourcingReplan | None = None

        if self._dependencies.replan is not None and len(by_name) < MIN_COMPANIES_BEFORE_REPLAN:
            try:
                decision = await self._dependencies.replan(
                    ReplanInput(
                        product=state["product"],
                        buyer_description=intent.buyer_description,
                        tried_terms=term_hits,
                    )
                )
                before = len(by_name)
                if decision.new_terms:
                    await run_terms(decision.new_terms)
                replan_info = SourcingReplan(
                    triggered=True,
                    new_terms=decision.new_terms,
                    reasoning=decision.reasoning,
                    added_companies=len(by_name) - before,
                )
            except Exception:
                logger.exception("拓客重规划失败，保持第一轮搜索结果")
                replan_info = SourcingReplan(
                    triggered=False,
                    new_terms=[],
                    reasoning="重规划失败，已保持第一轮结果",
                    added_companies=0,
                )

        hits = list(by_name.values())[:MAX_COMPANIES]
        await _emit(
            self._dependencies,
            "sourcer",
            {
                "terms": [item.model_dump(mode="python") for item in term_hits],
                "total": len(hits),
                "companies": [hit.name for hit in hits],
                "replan": replan_info.model_dump(mode="python") if replan_info else None,
            },
        )
        return {
            "hits": hits,
            "term_hits": term_hits,
            "replan": replan_info,
            "trail": [f"sourcing: {len(term_hits)} 个词，去重后 {len(hits)} 家"],
        }


class ScoringAgent:
    def __init__(self, dependencies: ProspectWorkflowDependencies) -> None:
        self._dependencies = dependencies

    async def run(self, state: ProspectState) -> dict[str, Any]:
        intent = state.get("intent")
        if intent is None:
            return {"error": "产品画像缺失", "trail": ["scoring: 缺少产品画像"]}

        buyer_terms = buyer_terms_for(intent)
        assessed: list[AssessedCompany] = []
        for hit in state.get("hits", []):
            facts = CompanyFacts(
                name=hit.name,
                registered_capital=hit.registered_capital,
                founded_at=hit.founded_at,
                industry=hit.industry,
                scope=hit.scope,
                status=hit.status,
                region=hit.region,
            )
            assessment = self._dependencies.assess(facts, buyer_terms)
            phones = clean_phones(hit.phones)
            assessed.append(
                AssessedCompany(
                    **assessment.model_dump(mode="python"),
                    hit=hit,
                    phones=phones,
                    reachable=bool(phones),
                    deep_check=None,
                )
            )

        assessed = sort_assessed_companies(assessed)
        priority = sum(company.tier == "priority" for company in assessed)
        deep_checks = await self._run_deep_checks(state, intent, assessed)
        if deep_checks:
            assessed = [
                company.model_copy(update={"deep_check": deep_checks.get(company.company_name)})
                for company in assessed
            ]
        await _emit(
            self._dependencies,
            "qualifier",
            {
                "companies": [
                    {
                        "name": company.company_name,
                        "score": company.score,
                        "tier": company.tier,
                        "verdict": company.verdict,
                        "dimensions": [
                            dimension.model_dump(mode="python") for dimension in company.dimensions
                        ],
                    }
                    for company in assessed
                ]
            },
        )
        return {
            "assessed": assessed,
            "priority": priority,
            "trail": [f"scoring: {len(assessed)} 家，{priority} 家优先"],
        }

    async def _run_deep_checks(
        self,
        state: ProspectState,
        intent: ProductIntent,
        assessed: Sequence[AssessedCompany],
    ) -> dict[str, DeepCheck]:
        if self._dependencies.qualify is None:
            return {}
        candidates = [
            company for company in assessed if GRAY_ZONE_MIN <= company.score <= GRAY_ZONE_MAX
        ][:MAX_DEEP_CHECK]
        results: dict[str, DeepCheck] = {}
        for company in candidates:
            try:
                outcome = await self._dependencies.qualify(
                    QualifierInput(
                        company_name=company.company_name,
                        score=company.score,
                        tier=company.tier,
                        buyer_description=intent.buyer_description,
                        product=state["product"],
                    )
                )
            except Exception:
                logger.exception("灰色带公司深查失败：%s", company.company_name)
                continue
            if outcome is not None:
                results[company.company_name] = DeepCheck(
                    verdict=outcome.verdict,
                    reasoning=outcome.reasoning,
                    lookups=outcome.lookups,
                )
        return results


class ContactAgent:
    async def run(self, state: ProspectState) -> dict[str, Any]:
        reachable = sum(company.reachable for company in state.get("assessed", []))
        return {"reachable": reachable, "trail": [f"contact: {reachable} 家可联系"]}


async def finish_prospect(state: ProspectState) -> dict[str, Any]:
    if state.get("hits"):
        detail = f"{len(state.get('assessed', []))} 家完成判断"
    else:
        detail = "没有可用企业"
    return {"trail": [f"finish: {detail}"]}


def route_after_sourcing(state: ProspectState) -> str:
    return "scoring" if not state.get("error") and state.get("hits") else "finish"


def build_prospect_graph(dependencies: ProspectWorkflowDependencies):
    """Build the prospecting graph; there is deliberately no global supervisor."""

    graph = StateGraph(ProspectState)
    graph.add_node("product_intent", ProductIntentAgent(dependencies).run)
    graph.add_node("sourcing", SourcingAgent(dependencies).run)
    graph.add_node("scoring", ScoringAgent(dependencies).run)
    graph.add_node("contact", ContactAgent().run)
    graph.add_node("finish", finish_prospect)
    graph.add_edge(START, "product_intent")
    graph.add_edge("product_intent", "sourcing")
    graph.add_conditional_edges(
        "sourcing",
        route_after_sourcing,
        {"scoring": "scoring", "finish": "finish"},
    )
    graph.add_edge("scoring", "contact")
    graph.add_edge("contact", "finish")
    graph.add_edge("finish", END)
    return graph.compile()


async def run_prospect_workflow(
    *,
    product: str,
    organization_id: str,
    trace_id: str,
    deps: ProspectWorkflowDependencies,
) -> ProspectResult:
    normalized_product = product.strip()
    compiled = build_prospect_graph(deps)
    state = await compiled.ainvoke(
        {
            "product": normalized_product,
            "organization_id": organization_id,
            "trace_id": trace_id,
            "intent": None,
            "term_hits": [],
            "hits": [],
            "replan": None,
            "assessed": [],
            "reachable": 0,
            "priority": 0,
            "error": None,
            "trail": [],
        }
    )
    intent = state.get("intent") or fallback_intent(normalized_product)
    companies = state.get("assessed", [])
    return ProspectResult(
        product=normalized_product,
        trace_id=trace_id,
        intent=intent,
        companies=companies,
        stats=ProspectStats(
            searched_terms=len(intent.search_terms),
            found=len(state.get("hits", [])),
            reachable=state.get("reachable", 0),
            priority=state.get("priority", 0),
        ),
        replan=state.get("replan"),
    )
