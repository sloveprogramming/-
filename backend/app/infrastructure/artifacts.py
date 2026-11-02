from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any, Protocol
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from app.domain.prospect.workflow import RecordArtifact
from app.infrastructure.database import _async_url

ROLE_ARTIFACT_KIND: dict[str, str] = {
    "planner": "plan",
    "sourcer": "sourcing",
    "qualifier": "qualification",
    "contact": "contact",
    "composer": "draft",
    "reviewer": "review",
    "researcher": "plan",
}


class ArtifactWriter(Protocol):
    async def write(
        self,
        *,
        organization_id: UUID,
        trace_id: str,
        role: str,
        kind: str,
        seq: int,
        payload: Mapping[str, Any],
    ) -> None: ...

    async def close(self) -> None: ...


class PostgresArtifactWriter:
    """Insert structured agent artifacts into the shared Postgres table."""

    def __init__(self, database_url: str) -> None:
        self._engine: AsyncEngine = create_async_engine(
            _async_url(database_url),
            pool_pre_ping=True,
        )

    async def write(
        self,
        *,
        organization_id: UUID,
        trace_id: str,
        role: str,
        kind: str,
        seq: int,
        payload: Mapping[str, Any],
    ) -> None:
        statement = text(
            """
            INSERT INTO agent_artifacts
              (organization_id, trace_id, role, kind, seq, payload)
            VALUES
              (
                CAST(:organization_id AS uuid),
                CAST(:trace_id AS uuid),
                :role,
                :kind,
                :seq,
                CAST(:payload AS jsonb)
              )
            """
        )
        params = {
            "organization_id": str(organization_id),
            "trace_id": trace_id,
            "role": role,
            "kind": kind,
            "seq": seq,
            "payload": json.dumps(payload, ensure_ascii=False, default=str),
        }
        async with self._engine.begin() as connection:
            await connection.execute(statement, params)

    async def close(self) -> None:
        await self._engine.dispose()


class AgentArtifactRecorder:
    """Bind artifacts to one tenant trace and assign their replay order."""

    def __init__(
        self,
        *,
        writer: ArtifactWriter,
        organization_id: UUID,
        trace_id: str,
    ) -> None:
        self._writer = writer
        self._organization_id = organization_id
        self._trace_id = trace_id
        self._seq = 0

    async def __call__(self, role: str, payload: dict[str, Any]) -> None:
        kind = ROLE_ARTIFACT_KIND.get(role)
        if kind is None:
            raise ValueError(f"未知的 Agent 角色：{role}")
        self._seq += 1
        await self._writer.write(
            organization_id=self._organization_id,
            trace_id=self._trace_id,
            role=role,
            kind=kind,
            seq=self._seq,
            payload=payload,
        )


def artifact_recorder(
    *,
    writer: ArtifactWriter,
    organization_id: UUID,
    trace_id: str,
) -> RecordArtifact:
    return AgentArtifactRecorder(
        writer=writer,
        organization_id=organization_id,
        trace_id=trace_id,
    )
