from __future__ import annotations

import hashlib
import re
import time
from collections.abc import Mapping

import httpx

from app.domain.prospect.models import CompanyHit


class QccError(RuntimeError):
    """QCC did not return a usable result."""


def qcc_token(key: str, timestamp: str, secret: str) -> str:
    value = f"{key}{timestamp}{secret}".encode()
    return hashlib.md5(value).hexdigest().upper()  # noqa: S324 - required by QCC


def _normalize_key(value: str) -> str:
    return re.sub(r"[\s_-]", "", value).lower()


def _pick(row: Mapping[str, object], keys: tuple[str, ...]) -> object | None:
    normalized = {_normalize_key(key): value for key, value in row.items()}
    for key in keys:
        value = normalized.get(_normalize_key(key))
        if value is not None and str(value).strip():
            return value
    return None


def _text(value: object | None) -> str | None:
    if value is None:
        return None
    trimmed = str(value).strip()
    return trimmed or None


def map_qcc_row(row: Mapping[str, object]) -> CompanyHit | None:
    name = _text(_pick(row, ("Name", "CompanyName", "EntName")))
    if not name:
        return None
    credit_code = _text(_pick(row, ("CreditCode", "CreditNo", "RegNo")))
    region_parts = [
        _text(_pick(row, ("Province",))),
        _text(_pick(row, ("City",))),
        _text(_pick(row, ("District",))),
    ]
    raw_phones = _pick(row, ("Phone", "PhoneNumber", "Tel"))
    if isinstance(raw_phones, list):
        phones = [phone for item in raw_phones if (phone := _text(item))]
    else:
        phones = [
            phone.strip() for phone in re.split(r"[;,，；]", str(raw_phones or "")) if phone.strip()
        ]
    region = " ".join(part for part in region_parts if part)
    return CompanyHit(
        key=credit_code or name,
        name=name,
        credit_code=credit_code,
        region=region or _text(_pick(row, ("Address",))),
        industry=_text(_pick(row, ("Industry", "IndustryName", "Category"))),
        legal_person=_text(_pick(row, ("OperName", "LegalPerson", "LegalPersonName"))),
        founded_at=_text(_pick(row, ("StartDate", "EstablishDate", "EsDate"))),
        registered_capital=_text(_pick(row, ("RegistCapi", "RegisteredCapital", "RegCapital"))),
        phones=phones,
        scope=_text(_pick(row, ("Scope", "BusinessScope", "OperScope"))),
        status=_text(_pick(row, ("Status", "EntStatus"))),
        in_library=False,
    )


class QccClient:
    """Small adapter around the QCC company-search endpoint."""

    def __init__(
        self,
        *,
        app_key: str,
        secret_key: str,
        base_url: str = "https://api.qichacha.com",
        timeout_seconds: float = 20,
    ) -> None:
        self._app_key = app_key
        self._secret_key = secret_key
        self._base_url = base_url.rstrip("/")
        self._timeout_seconds = timeout_seconds

    async def search(self, query: str, *, limit: int = 20) -> list[CompanyHit]:
        timestamp = str(int(time.time()))
        params = {
            "key": self._app_key,
            "timestamp": timestamp,
            "keyword": query.strip(),
            "pageIndex": "1",
            "pageSize": str(min(50, max(1, limit))),
        }
        headers = {
            "Token": qcc_token(self._app_key, timestamp, self._secret_key),
            "Accept": "application/json",
        }
        try:
            async with httpx.AsyncClient(timeout=self._timeout_seconds) as client:
                response = await client.get(
                    f"{self._base_url}/ECIV4/Search",
                    params=params,
                    headers=headers,
                )
        except httpx.RequestError as error:
            raise QccError(f"企查查网络请求失败（时间戳 {timestamp}）") from error
        if response.is_error:
            raise QccError(f"企查查返回 HTTP {response.status_code}（时间戳 {timestamp}）")

        try:
            payload = response.json()
        except ValueError as error:
            raise QccError("企查查返回的不是 JSON") from error
        status = str(payload.get("Status") or "200")
        if status != "200":
            message = payload.get("Message") or "无说明"
            raise QccError(f"企查查错误 {status}：{message}（时间戳 {timestamp}）")

        result = payload.get("Result")
        rows = result.get("Data") if isinstance(result, Mapping) else None
        if not isinstance(rows, list):
            return []
        hits: list[CompanyHit] = []
        for row in rows:
            if isinstance(row, Mapping):
                mapped = map_qcc_row(row)
                if mapped is not None:
                    hits.append(mapped)
        return hits


def qcc_configured(app_key: str | None, secret_key: str | None) -> bool:
    return bool(app_key and secret_key)
