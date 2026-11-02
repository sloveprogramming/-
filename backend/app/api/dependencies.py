from __future__ import annotations

import secrets
from dataclasses import dataclass
from typing import Annotated
from urllib.parse import unquote
from uuid import UUID

from fastapi import Header

from app.config import get_settings
from app.errors import ApiError


@dataclass(frozen=True, slots=True)
class RequestContext:
    organization_id: UUID
    user_name: str | None


async def require_request_context(
    authorization: Annotated[str | None, Header()] = None,
    organization_id: Annotated[str | None, Header(alias="X-Organization-Id")] = None,
    user_name: Annotated[str | None, Header(alias="X-User-Name")] = None,
    user_name_encoded: Annotated[str | None, Header(alias="X-User-Name-Encoded")] = None,
) -> RequestContext:
    """Authenticate the internal caller and bind it to exactly one tenant."""

    settings = get_settings()
    if not settings.backend_token:
        raise ApiError(
            status_code=503,
            code="BACKEND_NOT_CONFIGURED",
            message="Python 后端未配置 AGENT_BACKEND_TOKEN",
        )
    scheme, _, token = (authorization or "").partition(" ")
    if (
        scheme.lower() != "bearer"
        or not token
        or not secrets.compare_digest(token, settings.backend_token)
    ):
        raise ApiError(
            status_code=401,
            code="UNAUTHENTICATED",
            message="Unauthorized",
        )
    try:
        parsed_organization_id = UUID(str(organization_id))
    except (TypeError, ValueError, AttributeError) as error:
        raise ApiError(
            status_code=400,
            code="INVALID_ORGANIZATION",
            message="X-Organization-Id 必须是有效的组织 UUID",
        ) from error
    return RequestContext(
        organization_id=parsed_organization_id,
        user_name=(unquote(user_name_encoded) if user_name_encoded else user_name or "").strip()
        or None,
    )
