from __future__ import annotations

import math
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date
from typing import Any, TypeVar

from app.domain.prospect.models import (
    AssessmentDimension,
    CompanyAssessment,
    ProductIntent,
)

WEIGHTS = {
    "capital": 25,
    "age": 20,
    "industry": 25,
    "status": 15,
    "scope": 15,
}

_CAPITAL_PATTERN = re.compile(r"([\d.]+)\s*(亿|万)?")
_FOOD_TRADING_PATTERN = re.compile(r"批发|销售|贸易|供应链|配送|经销|代理")
_DEAD_STATUS_PATTERN = re.compile(r"注销|吊销|撤销")
_PHONE_SPLIT_PATTERN = re.compile(r"[,，;；/、\s]+")


@dataclass(frozen=True, slots=True)
class CompanyFacts:
    """Public company facts used by the deterministic cooperation score."""

    name: str
    registered_capital: str | None
    founded_at: str | None
    industry: str | None
    scope: str | None
    status: str | None
    region: str | None


def capital_score(raw: str | None) -> tuple[int, float | None, str | None]:
    if not raw:
        return 0, None, None
    match = _CAPITAL_PATTERN.search(raw.replace(",", ""))
    if not match:
        return 0, None, None
    try:
        value = float(match.group(1))
    except ValueError:
        return 0, None, None
    if not math.isfinite(value):
        return 0, None, None
    unit = match.group(2)
    wan = value * 10_000 if unit == "亿" else value
    if wan >= 5_000:
        return WEIGHTS["capital"], value, unit
    if wan >= 1_000:
        return 18, value, unit
    if wan >= 100:
        return 12, value, unit
    if wan >= 10:
        return 5, value, unit
    return 2, value, unit


def age_score(founded_at: str | None, now: date) -> tuple[int, int | None]:
    if not founded_at:
        return 0, None
    try:
        founded = date.fromisoformat(founded_at[:10])
    except ValueError:
        return 0, None
    days = (now - founded).days
    if days < 0:
        return 0, None
    years = math.floor(days / 365.25)
    if years >= 10:
        return WEIGHTS["age"], years
    if years >= 5:
        return 15, years
    if years >= 3:
        return 10, years
    if years >= 1:
        return 5, years
    return 2, years


def status_score(status: str | None) -> tuple[int, bool]:
    if not status:
        return 0, False
    text = status.strip()
    if re.search(r"存续|在业|开业|正常", text):
        return WEIGHTS["status"], True
    if re.search(r"迁出|停业|清算", text):
        return 5, False
    if _DEAD_STATUS_PATTERN.search(text):
        return 0, False
    return 7, False


def industry_fit_score(facts: CompanyFacts, buyer_terms: Sequence[str]) -> tuple[int, list[str]]:
    haystack = f"{facts.industry or ''} {facts.scope or ''} {facts.name}".lower()
    hits = list(
        dict.fromkeys(
            term.strip()
            for term in buyer_terms
            if term.strip() and term.strip().lower() in haystack
        )
    )
    if len(hits) >= 3:
        return WEIGHTS["industry"], hits
    if len(hits) == 2:
        return 18, hits
    if len(hits) == 1:
        return 11, hits
    return 0, []


def scope_score(scope: str | None) -> tuple[int, bool]:
    if not scope:
        return 0, False
    trading = bool(_FOOD_TRADING_PATTERN.search(scope))
    return (WEIGHTS["scope"] if trading else 4), trading


def assess_company(
    facts: CompanyFacts,
    buyer_terms: Sequence[str],
    *,
    now: date | None = None,
) -> CompanyAssessment:
    assessment_date = now or date.today()
    capital = capital_score(facts.registered_capital)
    age = age_score(facts.founded_at, assessment_date)
    status = status_score(facts.status)
    industry = industry_fit_score(facts, buyer_terms)
    scope = scope_score(facts.scope)
    score = capital[0] + age[0] + industry[0] + status[0] + scope[0]

    dimensions = [
        AssessmentDimension(
            key="capital",
            label="注册资本",
            score=capital[0],
            max=WEIGHTS["capital"],
            nature="unknown" if capital[1] is None else "measured",
            basis=(
                "没有拿到注册资本"
                if capital[1] is None
                else f"{facts.registered_capital}（认缴，不代表实缴或现金流）"
            ),
        ),
        AssessmentDimension(
            key="age",
            label="成立年限",
            score=age[0],
            max=WEIGHTS["age"],
            nature="unknown" if age[1] is None else "measured",
            basis="没有拿到成立日期" if age[1] is None else f"成立 {age[1]} 年",
        ),
        AssessmentDimension(
            key="industry",
            label="行业匹配",
            score=industry[0],
            max=WEIGHTS["industry"],
            nature="measured" if industry[1] else "unknown",
            basis=(
                f"命中买家关键词：{'、'.join(industry[1])}"
                if industry[1]
                else "行业与经营范围没有命中目标买家特征"
            ),
        ),
        AssessmentDimension(
            key="status",
            label="经营状态",
            score=status[0],
            max=WEIGHTS["status"],
            nature="measured" if facts.status else "unknown",
            basis=facts.status or "没有拿到经营状态",
        ),
        AssessmentDimension(
            key="scope",
            label="是否做贸易/分销",
            score=scope[0],
            max=WEIGHTS["scope"],
            nature="inferred" if facts.scope else "unknown",
            basis=("经营范围含批发/销售/供应链等字眼" if scope[1] else "经营范围看不出做分销"),
        ),
    ]

    if not status[1] and facts.status and _DEAD_STATUS_PATTERN.search(facts.status):
        tier = "skip"
    elif score >= 65:
        tier = "priority"
    elif score >= 40:
        tier = "workable"
    else:
        tier = "skip"

    return CompanyAssessment(
        company_name=facts.name,
        score=score,
        tier=tier,
        dimensions=dimensions,
        verdict=_verdict_line(tier, score, industry[1]),
        caveats=[
            "分数由公开工商数据推断，不含参保人数与实缴出资——那两项需要企查查付费接口",
            "注册资本是认缴金额，不代表实缴，也不代表现金流",
        ],
    )


def _verdict_line(tier: str, score: int, hits: Sequence[str]) -> str:
    fit = "行业对得上" if len(hits) >= 2 else "行业部分相关" if hits else "行业存疑"
    if tier == "priority":
        return f"{fit}，体量看起来够，建议优先联系"
    if tier == "workable":
        return f"{fit}，可以联系，先探需求"
    if score < 20:
        return "数据太少或明显不匹配，建议跳过"
    return "体量或行业偏弱，放到低优先级"


def buyer_terms_for(intent: ProductIntent) -> list[str]:
    product = intent.query.lower()
    return [term for term in intent.search_terms if term.strip() and term.lower() != product]


def clean_phones(raw: Sequence[str]) -> list[str]:
    seen: set[str] = set()
    phones: list[str] = []
    for entry in raw:
        for piece in _PHONE_SPLIT_PATTERN.split(entry):
            phone = re.sub(r"[^\d-]", "", piece).strip()
            digits = phone.replace("-", "")
            if not 7 <= len(digits) <= 13 or digits in seen:
                continue
            seen.add(digits)
            phones.append(phone)
    return phones


T = TypeVar("T")


def _value(item: Any, key: str) -> Any:
    if isinstance(item, Mapping):
        return item.get(key)
    return getattr(item, key)


def sort_assessed_companies(items: Sequence[T]) -> list[T]:
    """Contactable companies first, then higher cooperation score."""

    return sorted(
        items,
        key=lambda item: (
            not bool(_value(item, "reachable")),
            -int(_value(item, "score") or 0),
        ),
    )
