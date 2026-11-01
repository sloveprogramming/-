from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Protocol

from pydantic import ValidationError

from app.domain.prospect.models import (
    IcpSegmentKey,
    IntentDraft,
    ProductIntent,
)

logger = logging.getLogger(__name__)

SEGMENT_KEYS: tuple[IcpSegmentKey, ...] = (
    "distributor",
    "retail_chain",
    "ecommerce_reseller",
    "corporate_gifting",
    "live_commerce",
    "special_channel",
)


class StructuredModel(Protocol):
    async def complete_json(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        schema_name: str,
        max_output_tokens: int = 800,
    ) -> dict[str, object]: ...


@dataclass(frozen=True, slots=True)
class DictionaryEntry:
    aliases: tuple[str, ...]
    category: str
    segment: IcpSegmentKey
    buyer_description: str
    buyer_terms: tuple[str, ...]


DICTIONARY: tuple[DictionaryEntry, ...] = (
    DictionaryEntry(
        aliases=("面包丝", "面包糠", "面包屑", "panko", "裹粉"),
        category="烘焙原料 / 裹粉类",
        segment="distributor",
        buyer_description="烘焙食品厂、油炸食品加工厂、餐饮供应链、汉堡炸鸡连锁的采购",
        buyer_terms=(
            "烘焙食品",
            "食品加工",
            "速冻食品",
            "餐饮供应链",
            "裹粉",
            "油炸食品",
            "西式快餐",
        ),
    ),
    DictionaryEntry(
        aliases=(
            "山核桃",
            "碧根果",
            "夏威夷果",
            "腰果",
            "开心果",
            "板栗",
            "每日坚果",
            "坚果",
            "炒货",
        ),
        category="坚果炒货",
        segment="distributor",
        buyer_description="休闲食品经销商、商超采购、零食连锁、电商分销商",
        buyer_terms=("休闲食品", "食品批发", "预包装食品", "商超配送", "零食连锁", "食品供应链"),
    ),
    DictionaryEntry(
        aliases=("果干", "蜜饯", "芒果干", "葡萄干", "蔓越莓干", "红枣"),
        category="果干蜜饯",
        segment="distributor",
        buyer_description="休闲食品经销商、零食连锁、电商分销商",
        buyer_terms=("休闲食品", "食品批发", "蜜饯", "果干", "食品供应链"),
    ),
    DictionaryEntry(
        aliases=("调味料", "复合调味", "酱料", "火锅底料", "香辛料"),
        category="调味品",
        segment="distributor",
        buyer_description="调味品经销商、餐饮供应链、火锅连锁、食品加工厂",
        buyer_terms=("调味品", "食品配料", "餐饮供应链", "调味料", "食品加工"),
    ),
    DictionaryEntry(
        aliases=("预制菜", "速冻食品", "冷冻食品", "半成品菜"),
        category="预制菜 / 速冻食品",
        segment="retail_chain",
        buyer_description="商超冷冻区采购、餐饮连锁、社区团购、电商生鲜",
        buyer_terms=("速冻食品", "预制菜", "食品供应链", "生鲜电商", "餐饮连锁"),
    ),
    DictionaryEntry(
        aliases=("礼盒", "年货", "伴手礼", "节日礼品"),
        category="礼盒 / 礼品",
        segment="corporate_gifting",
        buyer_description="企业工会与行政采购、礼品公司、福利平台",
        buyer_terms=("礼品", "企业福利", "团购", "商贸", "文化礼品"),
    ),
)


def _build_search_terms(buyer_terms: tuple[str, ...], product: str) -> list[str]:
    terms = dict.fromkeys((product, *buyer_terms))
    return [term for term in terms if term][:8]


def match_dictionary(query: str) -> ProductIntent | None:
    text = query.strip().lower()
    if not text:
        return None
    best: tuple[int, DictionaryEntry, str] | None = None
    for entry in DICTIONARY:
        for alias in entry.aliases:
            normalized = alias.lower()
            if normalized in text and (best is None or len(normalized) > best[0]):
                best = (len(normalized), entry, alias)
    if best is None:
        return None
    entry = best[1]
    return ProductIntent(
        query=query.strip(),
        category=entry.category,
        segment=entry.segment,
        buyer_description=entry.buyer_description,
        search_terms=_build_search_terms(entry.buyer_terms, query.strip()),
        exclude_terms=["种植合作社", "机械设备", "餐饮堂食"],
        source="dictionary",
        confidence=1,
        uncertainties=[],
    )


def fallback_intent(query: str) -> ProductIntent:
    trimmed = query.strip()
    return ProductIntent(
        query=trimmed,
        category=None,
        segment=None,
        buyer_description="暂未识别出买家画像，建议按产品词直接搜",
        search_terms=[trimmed] if trimmed else [""],
        exclude_terms=[],
        source="dictionary",
        confidence=0,
        uncertainties=["没有识别出这个产品的买家类型，结果可能不精准"],
    )


def build_intent_prompt(query: str) -> tuple[str, str]:
    system_prompt = "\n".join(
        (
            "你帮一个食品公司的销售判断：一个产品该卖给谁，以及该用什么关键词去找这些公司。",
            "只输出 JSON，不要任何解释文字。",
            "字段：category（品类）、segment（最匹配的客户类型，只能从给定列表选）、",
            "buyerDescription（谁需要它，一句话）、searchTerms（搜公司用的关键词数组，3-8 个）、",
            "excludeTerms（要排除的干扰项数组）、confidence（0-1，你对这个判断的把握）、",
            "uncertainties（数组：你不确定的地方，比如「这个词可能是地方性叫法」）。",
            "",
            "重要：宁可说不知道，也不要编。如果这个词有多种含义或你不认识，",
            "confidence 给低分，并在 uncertainties 里写清楚。",
            f"客户类型只能从这些选：{'、'.join(SEGMENT_KEYS)}",
        )
    )
    user_prompt = f"产品：「{query}」\n它该卖给谁？用哪些关键词去找这些公司？"
    return system_prompt, user_prompt


def parse_ai_intent(raw: dict[str, object], query: str) -> ProductIntent | None:
    try:
        draft = IntentDraft.model_validate(raw)
    except ValidationError:
        return None
    segment: IcpSegmentKey | None = (
        draft.segment if draft.segment in SEGMENT_KEYS else None  # type: ignore[assignment]
    )
    terms = [term.strip() for term in draft.search_terms if term.strip()][:8]
    if not draft.category.strip() or not draft.buyer_description.strip() or not terms:
        return None
    return ProductIntent(
        query=query.strip(),
        category=draft.category.strip(),
        segment=segment,
        buyer_description=draft.buyer_description.strip(),
        search_terms=terms or [query.strip()],
        exclude_terms=[term.strip() for term in draft.exclude_terms if term.strip()],
        source="ai",
        confidence=max(0, min(1, draft.confidence)),
        uncertainties=[term.strip() for term in draft.uncertainties if term.strip()],
    )


async def interpret_product(
    query: str,
    *,
    model: StructuredModel | None,
    allow_ai: bool = True,
) -> ProductIntent:
    """Resolve product buyer intent with a deterministic fast path first."""

    trimmed = query.strip()
    if not trimmed:
        return fallback_intent("")
    dictionary_hit = match_dictionary(trimmed)
    if dictionary_hit is not None:
        return dictionary_hit
    if not allow_ai or model is None:
        return fallback_intent(trimmed)

    system_prompt, user_prompt = build_intent_prompt(trimmed)
    try:
        raw = await model.complete_json(
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            schema_name="product_intent",
            max_output_tokens=800,
        )
    except Exception:
        logger.exception("产品意图解析失败，退回兜底画像")
        return fallback_intent(trimmed)
    return parse_ai_intent(raw, trimmed) or fallback_intent(trimmed)
