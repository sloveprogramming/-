from __future__ import annotations

from typing import Protocol

from app.domain.prospect.models import CompanyHit, SearchResult
from app.infrastructure.database import CompanyRepository


class CompanySearchProvider(Protocol):
    async def search(self, query: str, *, limit: int = 20) -> list[CompanyHit]: ...


class CompanySearchService:
    """Use QCC when configured, otherwise search the tenant's local library."""

    def __init__(
        self,
        *,
        local: CompanyRepository,
        qcc: CompanySearchProvider | None,
        organization_id: str,
        local_limit: int = 20,
    ) -> None:
        self._local = local
        self._qcc = qcc
        self._organization_id = organization_id
        self._local_limit = local_limit

    async def __call__(self, query: str, limit: int) -> SearchResult:
        if self._qcc is None:
            hits = (
                await self._local.search(
                    query,
                    organization_id=self._organization_id,
                    limit=self._local_limit,
                )
            )[:limit]
            return SearchResult(
                source="local",
                total=len(hits),
                hits=hits,
                notice=(
                    "当前只在本地线索库里搜索。接入企查查"
                    "（QCC_APP_KEY / QCC_SECRET_KEY）后可以搜全国企业。"
                ),
            )

        try:
            hits = await self._qcc.search(query, limit=limit)
            names, credits = await self._local.library_keys(organization_id=self._organization_id)
            marked = [
                hit.model_copy(
                    update={
                        "in_library": hit.name in names
                        or bool(hit.credit_code and hit.credit_code in credits)
                    }
                )
                for hit in hits
            ]
            return SearchResult(source="qcc", total=len(marked), hits=marked, notice=None)
        except Exception as error:
            local_hits = (
                await self._local.search(
                    query,
                    organization_id=self._organization_id,
                    limit=self._local_limit,
                )
            )[:limit]
            return SearchResult(
                source="local",
                total=len(local_hits),
                hits=local_hits,
                notice=f"企查查调用失败，已退回本地结果：{error}",
            )
