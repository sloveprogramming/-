from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

IcpSegmentKey = Literal[
    "distributor",
    "retail_chain",
    "ecommerce_reseller",
    "corporate_gifting",
    "live_commerce",
    "special_channel",
]
CompanyTier = Literal["priority", "workable", "skip"]
AssessmentNature = Literal["measured", "inferred", "unknown"]


class ApiModel(BaseModel):
    """Shared JSON contract: Python names internally, camelCase on the wire."""

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        serialize_by_alias=True,
        extra="ignore",
    )


class ProductIntent(ApiModel):
    """Who buys this product, and which terms should be used to find them."""

    query: str
    category: str | None
    segment: IcpSegmentKey | None
    buyer_description: str
    search_terms: list[str] = Field(min_length=1, max_length=8)
    exclude_terms: list[str]
    source: Literal["dictionary", "ai"]
    confidence: float = Field(ge=0, le=1)
    uncertainties: list[str]


class IntentDraft(ApiModel):
    """Validated subset returned by the model before domain fallbacks are applied."""

    category: str
    buyer_description: str
    search_terms: list[str] = Field(min_length=1, max_length=8)
    exclude_terms: list[str] = Field(default_factory=list)
    confidence: float = Field(default=0.5, ge=0, le=1)
    uncertainties: list[str] = Field(default_factory=list)
    segment: str | None = None


class CompanyHit(ApiModel):
    """One company from the local lead library or QCC."""

    key: str
    name: str
    credit_code: str | None
    region: str | None
    industry: str | None
    legal_person: str | None
    founded_at: str | None
    registered_capital: str | None
    phones: list[str]
    scope: str | None
    status: str | None
    in_library: bool


class SearchResult(ApiModel):
    source: Literal["local", "qcc"]
    total: int
    hits: list[CompanyHit]
    notice: str | None


class TermHit(ApiModel):
    term: str
    hits: int
    error: str | None = None


class ReplanInput(ApiModel):
    product: str
    buyer_description: str
    tried_terms: list[TermHit]


class ReplanDecision(ApiModel):
    new_terms: list[str]
    reasoning: str


class SourcingReplan(ApiModel):
    triggered: bool
    new_terms: list[str]
    reasoning: str
    added_companies: int


class AssessmentDimension(ApiModel):
    key: str
    label: str
    score: int
    max: int
    basis: str
    nature: AssessmentNature


class CompanyAssessment(ApiModel):
    company_name: str
    score: int = Field(ge=0, le=100)
    tier: CompanyTier
    dimensions: list[AssessmentDimension]
    verdict: str
    caveats: list[str]


class DeepCheck(ApiModel):
    verdict: Literal["pursue", "hold", "drop"]
    reasoning: str
    lookups: list[str]


class QualifierInput(ApiModel):
    company_name: str
    score: int
    tier: CompanyTier
    buyer_description: str
    product: str


class QualifierResult(ApiModel):
    verdict: Literal["pursue", "hold", "drop"]
    reasoning: str
    lookups: list[str]


class AssessedCompany(CompanyAssessment):
    hit: CompanyHit
    phones: list[str]
    reachable: bool
    deep_check: DeepCheck | None = None


class ProspectStats(ApiModel):
    searched_terms: int
    found: int
    reachable: int
    priority: int


class ProspectResult(ApiModel):
    product: str
    trace_id: str
    intent: ProductIntent
    companies: list[AssessedCompany]
    stats: ProspectStats
    replan: SourcingReplan | None


class ProspectCompanyResult(AssessedCompany):
    script_text: str | None = None


class ProspectRunResponse(ApiModel):
    ok: bool = True
    trace_id: str
    summary: str
    product: str
    intent: ProductIntent
    stats: ProspectStats
    replan: SourcingReplan | None
    companies: list[ProspectCompanyResult]


class ProspectRunRequest(ApiModel):
    product: str
