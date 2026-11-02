from __future__ import annotations

from uuid import UUID

import pytest
from fastapi.testclient import TestClient

from app.api.routes.prospect import get_prospect_service
from app.config import get_settings
from app.domain.prospect.models import (
    CompanyAssessment,
    CompanyHit,
    ProductIntent,
    ProspectCompanyResult,
    ProspectRunResponse,
    ProspectStats,
)
from app.main import create_app

ORG_ID = "00000000-0000-4000-8000-000000000001"


class StubProspectService:
    async def run(
        self,
        *,
        product: str,
        organization_id: UUID,
        trace_id: str,
        user_name: str | None,
    ) -> ProspectRunResponse:
        assert organization_id == UUID(ORG_ID)
        assert trace_id
        assert user_name is None
        company_hit = CompanyHit(
            key="k1",
            name="临安烘焙食品有限公司",
            credit_code=None,
            region="浙江省 杭州市",
            industry="烘焙食品",
            legal_person="张三",
            founded_at="2012-06-15",
            registered_capital="5000万元人民币",
            phones=["0571-88886666"],
            scope="烘焙食品生产与销售",
            status="存续",
            in_library=True,
        )
        assessment = CompanyAssessment(
            company_name=company_hit.name,
            score=100,
            tier="priority",
            dimensions=[],
            verdict="行业对得上，建议优先联系",
            caveats=[],
        )
        return ProspectRunResponse(
            ok=True,
            trace_id=trace_id,
            summary="搜到 1 家公司",
            product=product,
            intent=ProductIntent(
                query=product,
                category="烘焙原料",
                segment="distributor",
                buyer_description="烘焙食品厂",
                search_terms=[product],
                exclude_terms=[],
                source="dictionary",
                confidence=1,
                uncertainties=[],
            ),
            stats=ProspectStats(searched_terms=1, found=1, reachable=1, priority=1),
            replan=None,
            warnings=["搜索降级：当前只在本地线索库里搜索。"],
            companies=[
                ProspectCompanyResult(
                    **assessment.model_dump(),
                    hit=company_hit,
                    phones=["0571-88886666"],
                    reachable=True,
                    deep_check=None,
                    script_text="【电话】临安烘焙食品有限公司",
                )
            ],
        )


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("AGENT_BACKEND_TOKEN", "test-token")
    monkeypatch.setenv("APP_ENV", "test")
    get_settings.cache_clear()
    app = create_app()
    app.dependency_overrides[get_prospect_service] = lambda: StubProspectService()
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()
    get_settings.cache_clear()


def auth_headers() -> dict[str, str]:
    return {"Authorization": "Bearer test-token", "X-Organization-Id": ORG_ID}


def test_health_endpoint_is_public(client: TestClient) -> None:
    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "service": "agentsdr-python-backend"}


def test_prospect_requires_internal_token(client: TestClient) -> None:
    response = client.post("/api/prospect/run", json={"product": "面包丝"})

    assert response.status_code == 401
    assert response.json()["code"] == "UNAUTHENTICATED"


def test_prospect_requires_valid_organization_header(client: TestClient) -> None:
    response = client.post(
        "/api/prospect/run",
        json={"product": "面包丝"},
        headers={"Authorization": "Bearer test-token", "X-Organization-Id": "not-a-uuid"},
    )

    assert response.status_code == 400
    assert response.json()["code"] == "INVALID_ORGANIZATION"


def test_prospect_rejects_blank_product(client: TestClient) -> None:
    response = client.post(
        "/api/prospect/run",
        json={"product": "   "},
        headers=auth_headers(),
    )

    assert response.status_code == 400
    assert response.json() == {"error": "请填写产品名", "code": "INVALID_PRODUCT"}


def test_prospect_response_keeps_frontend_contract(client: TestClient) -> None:
    response = client.post(
        "/api/prospect/run",
        json={"product": "面包丝"},
        headers=auth_headers(),
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["ok"] is True
    assert payload["traceId"]
    assert payload["stats"] == {
        "searchedTerms": 1,
        "found": 1,
        "reachable": 1,
        "priority": 1,
    }
    assert payload["intent"]["buyerDescription"] == "烘焙食品厂"
    assert payload["companies"][0]["companyName"] == "临安烘焙食品有限公司"
    assert payload["companies"][0]["hit"]["creditCode"] is None
    assert payload["companies"][0]["scriptText"] == "【电话】临安烘焙食品有限公司"
    assert payload["warnings"] == ["搜索降级：当前只在本地线索库里搜索。"]
