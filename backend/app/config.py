from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache


def _csv(value: str | None, default: tuple[str, ...] = ()) -> tuple[str, ...]:
    if not value:
        return default
    return tuple(item.strip() for item in value.split(",") if item.strip())


@dataclass(frozen=True, slots=True)
class Settings:
    app_env: str
    database_url: str | None
    backend_token: str | None
    deepseek_api_key: str | None
    deepseek_base_url: str
    deepseek_model: str
    qcc_app_key: str | None
    qcc_secret_key: str | None
    qcc_base_url: str
    cors_origins: tuple[str, ...]

    @property
    def is_production(self) -> bool:
        return self.app_env.lower() in {"production", "prod"}


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings(
        app_env=os.getenv("APP_ENV", "development").strip() or "development",
        database_url=os.getenv("DATABASE_URL", "").strip() or None,
        backend_token=os.getenv("AGENT_BACKEND_TOKEN", "").strip() or None,
        deepseek_api_key=os.getenv("DEEPSEEK_API_KEY", "").strip() or None,
        deepseek_base_url=os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com").rstrip("/"),
        deepseek_model=os.getenv("DEEPSEEK_MODEL", "deepseek-chat").strip() or "deepseek-chat",
        qcc_app_key=os.getenv("QCC_APP_KEY", "").strip() or None,
        qcc_secret_key=os.getenv("QCC_SECRET_KEY", "").strip() or None,
        qcc_base_url=os.getenv("QCC_BASE_URL", "https://api.qichacha.com").rstrip("/"),
        cors_origins=_csv(os.getenv("CORS_ORIGINS"), ("http://localhost:3000",)),
    )
