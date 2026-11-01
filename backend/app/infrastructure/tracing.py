from __future__ import annotations

import logging
import re
from collections.abc import Callable
from typing import Any

from langsmith import Client, configure
from langsmith.anonymizer import StringNodeRule, create_secret_anonymizer

from app.config import Settings

logger = logging.getLogger(__name__)

_SENSITIVE_TRACE_RULES: list[StringNodeRule] = [
    {
        "pattern": re.compile(r"(?<!\d)1[3-9]\d{9}(?!\d)"),
        "replace": "[PHONE]",
    },
    {
        "pattern": re.compile(r"(?<!\d)0\d{2,3}-?\d{7,8}(?!\d)"),
        "replace": "[PHONE]",
    },
    {
        "pattern": re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"),
        "replace": "[EMAIL]",
    },
]


def build_trace_anonymizer() -> Callable[[Any], Any]:
    """Mask credentials, phone numbers and email addresses before upload."""

    return create_secret_anonymizer(
        extra_rules=_SENSITIVE_TRACE_RULES,
        max_depth=24,
    )


def configure_tracing(settings: Settings) -> bool:
    """Configure process-wide tracing; observability stays optional at runtime."""

    if not settings.langsmith_tracing:
        configure(enabled=False)
        return False
    if settings.langsmith_api_key is None:
        logger.warning("LANGSMITH_TRACING=true，但缺少 LANGSMITH_API_KEY，已关闭追踪")
        configure(enabled=False)
        return False

    try:
        client = Client(
            api_key=settings.langsmith_api_key,
            api_url=settings.langsmith_endpoint,
            anonymizer=build_trace_anonymizer(),
        )
        configure(
            client=client,
            enabled=True,
            project_name=settings.langsmith_project,
            metadata={
                "environment": settings.app_env,
                "service": "agentsdr-python-backend",
                "llm_provider": "deepseek",
                "llm_model": settings.deepseek_model,
            },
        )
    except Exception:
        logger.exception("LangSmith 初始化失败，已关闭追踪")
        configure(enabled=False)
        return False

    logger.info("LangSmith 追踪已启用：project=%s", settings.langsmith_project)
    return True
