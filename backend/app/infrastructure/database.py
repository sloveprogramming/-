from __future__ import annotations

import uuid
from collections.abc import Mapping
from typing import Any, Protocol

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from app.domain.prospect.models import CompanyHit


class CompanyRepository(Protocol):
    async def search(
        self,
        query: str,
        *,
        organization_id: str,
        limit: int = 20,
    ) -> list[CompanyHit]: ...

    async def library_keys(self, *, organization_id: str) -> tuple[set[str], set[str]]: ...

    async def close(self) -> None: ...


class EmptyCompanyRepository:
    async def search(
        self,
        query: str,
        *,
        organization_id: str,
        limit: int = 20,
    ) -> list[CompanyHit]:
        return []

    async def library_keys(self, *, organization_id: str) -> tuple[set[str], set[str]]:
        return set(), set()

    async def close(self) -> None:
        return None


class PostgresCompanyRepository:
    """Tenant-scoped reads from the existing companies table."""

    def __init__(self, database_url: str) -> None:
        self._engine: AsyncEngine = create_async_engine(
            _async_url(database_url),
            pool_pre_ping=True,
        )

    async def search(
        self,
        query: str,
        *,
        organization_id: str,
        limit: int = 20,
    ) -> list[CompanyHit]:
        if query.strip():
            statement = text(
                """
                SELECT id, name, domain, custom
                FROM companies
                WHERE organization_id = CAST(:organization_id AS uuid)
                  AND (name ILIKE :term OR domain ILIKE :term)
                ORDER BY updated_at DESC
                LIMIT :limit
                """
            )
            params: dict[str, Any] = {
                "organization_id": organization_id,
                "term": f"%{query.strip()}%",
                "limit": limit,
            }
        else:
            statement = text(
                """
                SELECT id, name, domain, custom
                FROM companies
                WHERE organization_id = CAST(:organization_id AS uuid)
                ORDER BY created_at DESC
                LIMIT :limit
                """
            )
            params = {"organization_id": organization_id, "limit": limit}
        async with self._engine.connect() as connection:
            rows = (await connection.execute(statement, params)).mappings().all()
        return [_row_to_hit(row) for row in rows]

    async def library_keys(self, *, organization_id: str) -> tuple[set[str], set[str]]:
        statement = text(
            """
            SELECT name, domain, custom
            FROM companies
            WHERE organization_id = CAST(:organization_id AS uuid)
            LIMIT 5000
            """
        )
        async with self._engine.connect() as connection:
            rows = (
                (await connection.execute(statement, {"organization_id": organization_id}))
                .mappings()
                .all()
            )
        names: set[str] = set()
        credits: set[str] = set()
        for row in rows:
            if row["name"]:
                names.add(str(row["name"]))
            if row["domain"]:
                names.add(str(row["domain"]))
            custom = _mapping(row["custom"])
            credit = custom.get("统一社会信用代码") or custom.get("creditCode")
            if isinstance(credit, str) and credit.strip():
                credits.add(credit.strip())
        return names, credits

    async def close(self) -> None:
        await self._engine.dispose()


def _async_url(database_url: str) -> str:
    if database_url.startswith("postgres://"):
        return database_url.replace("postgres://", "postgresql+psycopg://", 1)
    if database_url.startswith("postgresql://"):
        return database_url.replace("postgresql://", "postgresql+psycopg://", 1)
    return database_url


def _mapping(value: object) -> dict[str, object]:
    return dict(value) if isinstance(value, Mapping) else {}


def _text(value: object | None) -> str | None:
    if value is None:
        return None
    trimmed = str(value).strip()
    return trimmed or None


def _row_to_hit(row: Mapping[str, Any]) -> CompanyHit:
    custom = _mapping(row.get("custom"))
    name = _text(row.get("name")) or str(row.get("domain") or row.get("id"))
    company_id = str(row.get("id") or uuid.uuid4())
    phone = _text(custom.get("电话")) or _text(custom.get("phone"))
    return CompanyHit(
        key=company_id,
        name=name,
        credit_code=_text(custom.get("统一社会信用代码")) or _text(custom.get("creditCode")),
        region=_text(custom.get("地区")) or _text(custom.get("region")),
        industry=_text(custom.get("行业")) or _text(custom.get("industry")),
        legal_person=_text(custom.get("法定代表人")) or _text(custom.get("legalPerson")),
        founded_at=_text(custom.get("成立日期")) or _text(custom.get("foundedAt")),
        registered_capital=_text(custom.get("注册资本")) or _text(custom.get("registeredCapital")),
        phones=[phone] if phone else [],
        scope=_text(custom.get("经营范围")) or _text(custom.get("scope")),
        status=_text(custom.get("经营状态")) or _text(custom.get("status")),
        in_library=True,
    )
