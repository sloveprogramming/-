from __future__ import annotations

from collections.abc import Mapping
from typing import Any
from uuid import UUID

import pytest

from app.infrastructure.artifacts import AgentArtifactRecorder
from app.infrastructure.database import EmptyCompanyRepository
from app.services.prospect import ProspectService

ORG_ID = UUID("00000000-0000-4000-8000-000000000001")
TRACE_ID = "11111111-1111-4111-8111-111111111111"


class FakeArtifactWriter:
    def __init__(self) -> None:
        self.rows: list[dict[str, Any]] = []
        self.closed = False

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
        self.rows.append(
            {
                "organization_id": organization_id,
                "trace_id": trace_id,
                "role": role,
                "kind": kind,
                "seq": seq,
                "payload": dict(payload),
            }
        )

    async def close(self) -> None:
        self.closed = True


async def test_recorder_assigns_replay_order_and_role_kind_mapping() -> None:
    writer = FakeArtifactWriter()
    recorder = AgentArtifactRecorder(
        writer=writer,
        organization_id=ORG_ID,
        trace_id=TRACE_ID,
    )

    await recorder("planner", {"query": "面包丝"})
    await recorder("sourcer", {"total": 0})
    await recorder("contact", {"companies": []})

    assert [row["seq"] for row in writer.rows] == [1, 2, 3]
    assert [row["kind"] for row in writer.rows] == ["plan", "sourcing", "contact"]
    assert all(row["organization_id"] == ORG_ID for row in writer.rows)
    assert all(row["trace_id"] == TRACE_ID for row in writer.rows)


async def test_recorder_rejects_unknown_roles() -> None:
    recorder = AgentArtifactRecorder(
        writer=FakeArtifactWriter(),
        organization_id=ORG_ID,
        trace_id=TRACE_ID,
    )

    with pytest.raises(ValueError, match="未知的 Agent 角色"):
        await recorder("supervisor", {})


async def test_prospect_service_records_artifacts_and_returns_warnings() -> None:
    writer = FakeArtifactWriter()
    service = ProspectService(
        repository=EmptyCompanyRepository(),
        model=None,
        qcc=None,
        artifact_writer=writer,
    )

    response = await service.run(
        product="面包丝",
        organization_id=ORG_ID,
        trace_id=TRACE_ID,
        user_name=None,
    )
    await service.close()

    assert [row["role"] for row in writer.rows] == ["planner", "sourcer"]
    assert [row["seq"] for row in writer.rows] == [1, 2]
    assert "搜索降级" in response.warnings[0]
    assert writer.closed is True
