from __future__ import annotations

import logging
from uuid import UUID

from app.config import Settings
from app.domain.prospect.call_script import render_call_script
from app.domain.prospect.intent import interpret_product
from app.domain.prospect.models import (
    ProductIntent,
    ProspectCompanyResult,
    ProspectResult,
    ProspectRunResponse,
    ReplanDecision,
    ReplanInput,
)
from app.domain.prospect.qualification import ProspectQualifier
from app.domain.prospect.sourcing import CompanySearchService
from app.domain.prospect.workflow import (
    ProspectWorkflowDependencies,
    run_prospect_workflow,
)
from app.infrastructure.artifacts import (
    ArtifactWriter,
    PostgresArtifactWriter,
    artifact_recorder,
)
from app.infrastructure.database import (
    CompanyRepository,
    EmptyCompanyRepository,
    PostgresCompanyRepository,
)
from app.infrastructure.llm import DeepSeekModel
from app.infrastructure.qcc import QccClient, qcc_configured
from app.infrastructure.qcc_mcp import QccMcpClient

logger = logging.getLogger(__name__)


class ProspectService:
    """Compose one tenant-scoped prospecting run."""

    def __init__(
        self,
        *,
        repository: CompanyRepository,
        model: DeepSeekModel | None,
        qcc: QccClient | None,
        artifact_writer: ArtifactWriter | None = None,
        qcc_mcp: QccMcpClient | None = None,
        replan_enabled: bool = False,
        qualify_gray_zone: bool = False,
    ) -> None:
        self._repository = repository
        self._model = model
        self._qcc = qcc
        self._artifact_writer = artifact_writer
        self._qcc_mcp = qcc_mcp
        self._replan_enabled = replan_enabled
        self._qualify_gray_zone = qualify_gray_zone

    @classmethod
    def from_settings(cls, settings: Settings) -> ProspectService:
        repository: CompanyRepository = (
            PostgresCompanyRepository(settings.database_url)
            if settings.database_url
            else EmptyCompanyRepository()
        )
        model = (
            DeepSeekModel(
                api_key=settings.deepseek_api_key,
                base_url=settings.deepseek_base_url,
                model=settings.deepseek_model,
            )
            if settings.deepseek_api_key
            else None
        )
        qcc = (
            QccClient(
                app_key=settings.qcc_app_key or "",
                secret_key=settings.qcc_secret_key or "",
                base_url=settings.qcc_base_url,
            )
            if qcc_configured(settings.qcc_app_key, settings.qcc_secret_key)
            else None
        )
        artifact_writer = (
            PostgresArtifactWriter(settings.database_url) if settings.database_url else None
        )
        return cls(
            repository=repository,
            model=model,
            qcc=qcc,
            artifact_writer=artifact_writer,
            qcc_mcp=QccMcpClient(
                token=settings.qcc_mcp_token,
                base_url=settings.qcc_mcp_base_url,
            ),
            replan_enabled=settings.agent_replan_search,
            qualify_gray_zone=settings.agent_qualify_gray_zone,
        )

    async def close(self) -> None:
        await self._repository.close()
        if self._artifact_writer is not None:
            await self._artifact_writer.close()

    async def run(
        self,
        *,
        product: str,
        organization_id: UUID,
        trace_id: str,
        user_name: str | None,
    ) -> ProspectRunResponse:
        search = CompanySearchService(
            local=self._repository,
            qcc=self._qcc,
            organization_id=str(organization_id),
        )

        async def interpret(query: str) -> ProductIntent:
            return await interpret_product(query, model=self._model)

        recorder = (
            artifact_recorder(
                writer=self._artifact_writer,
                organization_id=organization_id,
                trace_id=trace_id,
            )
            if self._artifact_writer is not None
            else None
        )
        qualifier = (
            ProspectQualifier(model=self._model, mcp=self._qcc_mcp)
            if self._qualify_gray_zone
            else None
        )
        dependencies = ProspectWorkflowDependencies(
            interpret=interpret,
            search=search,
            replan=(self._replan if self._replan_enabled and self._model is not None else None),
            qualify=qualifier,
            record_artifact=recorder,
        )
        result = await run_prospect_workflow(
            product=product,
            organization_id=str(organization_id),
            trace_id=trace_id,
            deps=dependencies,
        )
        return self._to_response(result, user_name=user_name)

    async def _replan(self, request: ReplanInput) -> ReplanDecision:
        if self._model is None:
            return ReplanDecision(new_terms=[], reasoning="未配置模型，不换词")
        tried = {item.term for item in request.tried_terms}
        system_prompt = "\n".join(
            (
                "你在为一轮企业搜索做换词重规划。只输出 JSON。",
                "返回 newTerms（3-6 个新的企查查搜索词）和 reasoning（一句话说明为什么换）。",
                "不要重复已经搜过的词；关键词必须是公司名或经营范围里可能出现的行业词。",
            )
        )
        user_prompt = (
            f"产品：{request.product}\n买家画像：{request.buyer_description}\n"
            f"已经搜过：{'、'.join(item.term for item in request.tried_terms)}"
        )
        raw = await self._model.complete_json(
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            schema_name="prospect_replan",
            max_output_tokens=600,
        )
        terms = raw.get("newTerms")
        reasoning = raw.get("reasoning")
        if not isinstance(terms, list) or not isinstance(reasoning, str):
            return ReplanDecision(new_terms=[], reasoning="模型未返回可执行的换词结果")
        new_terms = [
            term.strip()
            for term in terms
            if isinstance(term, str) and term.strip() and term.strip() not in tried
        ][:6]
        return ReplanDecision(new_terms=new_terms, reasoning=reasoning.strip())

    def _to_response(
        self,
        result: ProspectResult,
        *,
        user_name: str | None,
    ) -> ProspectRunResponse:
        companies: list[ProspectCompanyResult] = []
        for company in result.companies:
            script_text = (
                render_call_script(
                    result.intent,
                    company_name=company.hit.name,
                    rep_name=user_name,
                )
                if company.reachable
                else None
            )
            companies.append(
                ProspectCompanyResult(
                    **company.model_dump(mode="python", by_alias=False),
                    script_text=script_text,
                )
            )
        return ProspectRunResponse(
            ok=True,
            trace_id=result.trace_id,
            summary=_summarize(result),
            product=result.product,
            intent=result.intent,
            stats=result.stats,
            replan=result.replan,
            companies=companies,
            warnings=result.warnings,
        )


def _summarize(result: ProspectResult) -> str:
    stats = result.stats
    intent = result.intent
    if not stats.found:
        return f"「{result.product}」没有搜到公司"
    category = intent.category or "未识别品类"
    return (
        f"「{result.product}」，判定为{category}，"
        f"搜 {stats.searched_terms} 个词得 {stats.found} 家，"
        f"其中 {stats.reachable} 家有电话，{stats.priority} 家建议优先联系"
    )
