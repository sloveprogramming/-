from __future__ import annotations

from app.domain.prospect.models import IcpSegmentKey, ProductIntent

COMPANY_PLACEHOLDER = "{company}"
NAME_PLACEHOLDER = "{name}"
REP_PLACEHOLDER = "{rep}"


def _opening_for_segment(segment: IcpSegmentKey | None, product: str) -> str:
    openings: dict[IcpSegmentKey, str] = {
        "distributor": (
            f"{NAME_PLACEHOLDER}您好，我是新农哥的{REP_PLACEHOLDER}，做食品原料/成品供应。"
            f"看到{COMPANY_PLACEHOLDER}在做食品分销，想跟您确认一下——{product}这条线，"
            "您现在是从哪家进的货？"
        ),
        "retail_chain": (
            f"{NAME_PLACEHOLDER}您好，我是新农哥的{REP_PLACEHOLDER}。"
            f"想找{COMPANY_PLACEHOLDER}负责{product}这一块的采购，方便帮我转一下，"
            "或者告诉我找哪位吗？"
        ),
        "ecommerce_reseller": (
            f"{NAME_PLACEHOLDER}您好，我是新农哥的{REP_PLACEHOLDER}，做{product}的厂家。"
            "看到您店里有卖这类产品，想问下现在是自己备货还是找代发？"
        ),
        "corporate_gifting": (
            f"{NAME_PLACEHOLDER}您好，我是新农哥的{REP_PLACEHOLDER}。"
            f"想问下{COMPANY_PLACEHOLDER}今年的节日福利在筹备吗？我们做{product}礼盒，"
            "可以直接对接工厂。"
        ),
        "live_commerce": (
            f"{NAME_PLACEHOLDER}您好，我是新农哥的{REP_PLACEHOLDER}，{product}的厂家。"
            "我们给达人做过食品类目的专场，想问下这类品您这边有没有在选？"
        ),
        "special_channel": (
            f"{NAME_PLACEHOLDER}您好，我是新农哥的{REP_PLACEHOLDER}。"
            f"我们有生产线，能按规格做{product}，想问下{COMPANY_PLACEHOLDER}这块现在有没有在找供应？"
        ),
    }
    return openings.get(
        segment,
        (
            f"{NAME_PLACEHOLDER}您好，我是新农哥的{REP_PLACEHOLDER}，做{product}的厂家。"
            f"请问{COMPANY_PLACEHOLDER}这边{product}相关的东西是哪位在负责？"
        ),
    )


def render_call_script(
    intent: ProductIntent,
    *,
    company_name: str,
    rep_name: str | None,
) -> str:
    """Render the four-part phone script sent to the frontend."""

    product = intent.query or "这个产品"
    opening = _opening_for_segment(intent.segment, product)
    lines = [
        f"【电话】{company_name}",
        f"产品：{intent.query}" + (f"（{intent.category}）" if intent.category else ""),
        "",
        "— 开场（约 15 秒）",
        opening,
        "",
        "— 探询（约 30 秒）",
        "顺着对方的回答问三件事：",
        "1. 现在这条线是谁在供？",
        "2. 采购上最在意什么——价格、账期，还是供货稳不稳？",
        "3. 一年大概走多少量？",
        "",
        "— 价值（约 30 秒）",
        "针对他刚说的顾虑，只讲一个对应的点，别把优势全倒一遍：",
        "- 嫌贵 → 讲产地直采和规格拆分；",
        "- 嫌不稳 → 讲自有生产线和供货周期；",
        "- 嫌不好卖 → 讲同区域已有客户的实际动销。",
        f"然后一句：「{intent.buyer_description}这块我们做得比较多，具体数据我发您看。」",
        "",
        "— 收尾（约 15 秒）",
        "要一个成本最低的动作，只选一个：",
        "- 「我加您个微信，把资料发您？」",
        "- 「我先寄个样品过来，您试了再说？」",
        "- 「方便的话约 15 分钟，我带样品过去？」",
        "",
        "— 对方可能会问",
        "「你们是哪家？」 → 新农哥，杭州临安做坚果和食品原料的厂家，做了快 20 年。",
        "「现在不需要 / 我们有固定的供应商。」 → 理解。那我先不下结论——您留个微信，"
        "我把价盘发过去，您对比一下，不合适就放着。",
        "「多少钱？」 → 价格要看规格和量，我现在报不准。您方便说下大概的量吗？"
        "我按您的量出一版正式的。",
        "「先发资料我看看。」 → 好，我加您微信发。顺便问一句：您现在最想解决的问题是价格"
        "还是供货？我按这个重点整理。",
        "",
        "— 这通电话必须拿到",
        "  □ 这条线现在谁在供",
        "  □ 一年大概多少量",
        "  □ 最在意的是价格、账期还是供货稳定",
        "  □ 负责人的微信或手机号",
        "",
        "— 不要说",
        "  × 不要在对方说需求之前先报价",
        "  × 不要承诺独家区域、账期、返点——这些要正式审批",
        "  × 不要一口气把产品线全念一遍",
        "  × 不要说「打扰您几分钟」这种把自己放低的开场",
    ]
    return (
        "\n".join(lines)
        .replace(COMPANY_PLACEHOLDER, company_name)
        .replace(NAME_PLACEHOLDER, "您")
        .replace(REP_PLACEHOLDER, rep_name.strip() if rep_name and rep_name.strip() else "我")
    )
