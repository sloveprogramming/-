from __future__ import annotations

from functools import lru_cache
from typing import Annotated
from uuid import uuid4

from fastapi import APIRouter, Depends

from app.api.dependencies import RequestContext, require_request_context
from app.config import get_settings
from app.domain.prospect.models import ProspectRunRequest, ProspectRunResponse
from app.errors import ApiError
from app.services.prospect import ProspectService

router = APIRouter(prefix="/api/prospect", tags=["prospect"])


@lru_cache(maxsize=1)
def get_prospect_service() -> ProspectService:
    return ProspectService.from_settings(get_settings())


@router.post("/run", response_model=ProspectRunResponse)
async def run_prospect(
    body: ProspectRunRequest,
    context: Annotated[RequestContext, Depends(require_request_context)],
    service: Annotated[ProspectService, Depends(get_prospect_service)],
) -> ProspectRunResponse:
    product = body.product.strip()
    if not product:
        raise ApiError(
            status_code=400,
            code="INVALID_PRODUCT",
            message="请填写产品名",
        )
    return await service.run(
        product=product,
        organization_id=context.organization_id,
        trace_id=str(uuid4()),
        user_name=context.user_name,
    )
