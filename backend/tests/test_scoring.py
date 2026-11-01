from __future__ import annotations

from datetime import date

from app.domain.prospect.scoring import (
    CompanyFacts,
    assess_company,
    buyer_terms_for,
    clean_phones,
    sort_assessed_companies,
)


def test_company_score_combines_public_company_facts() -> None:
    assessment = assess_company(
        CompanyFacts(
            name="临安烘焙食品有限公司",
            registered_capital="5000万元人民币",
            founded_at="2012-06-15",
            industry="烘焙食品",
            scope="烘焙食品生产、销售与供应链配送",
            status="存续",
            region="浙江省 杭州市",
        ),
        ["烘焙食品", "食品生产", "供应链配送"],
        now=date(2026, 11, 1),
    )

    assert assessment.score == 100
    assert assessment.tier == "priority"
    assert len(assessment.dimensions) == 5
    assert assessment.dimensions[0].nature == "measured"


def test_deregistered_company_is_skipped_even_with_good_score() -> None:
    assessment = assess_company(
        CompanyFacts(
            name="已注销食品有限公司",
            registered_capital="1亿元",
            founded_at="2000-01-01",
            industry="食品加工",
            scope="食品批发与销售",
            status="注销",
            region="上海市",
        ),
        ["食品加工", "食品批发", "销售"],
        now=date(2026, 11, 1),
    )

    assert assessment.tier == "skip"


def test_missing_company_data_is_marked_unknown() -> None:
    assessment = assess_company(
        CompanyFacts(
            name="资料缺失有限公司",
            registered_capital=None,
            founded_at=None,
            industry=None,
            scope=None,
            status=None,
            region=None,
        ),
        ["食品加工"],
        now=date(2026, 11, 1),
    )

    assert assessment.score == 0
    assert assessment.tier == "skip"
    assert {dimension.nature for dimension in assessment.dimensions} == {"unknown"}


def test_phones_are_split_deduplicated_and_filtered() -> None:
    assert clean_phones(["0571-88886666, 13800138000", "0571-88886666", "123"]) == [
        "0571-88886666",
        "13800138000",
    ]


def test_contactable_companies_sort_before_uncontactable_ones() -> None:
    def company(name: str, score: int, reachable: bool) -> dict[str, object]:
        return {"company_name": name, "score": score, "reachable": reachable}

    rows = sort_assessed_companies(
        [
            company("低分可联系", 30, True),
            company("高分无电话", 90, False),
            company("高分可联系", 80, True),
        ]
    )

    assert [row["company_name"] for row in rows] == ["高分可联系", "低分可联系", "高分无电话"]


def test_buyer_terms_exclude_the_product_itself() -> None:
    from app.domain.prospect.models import ProductIntent

    intent = ProductIntent(
        query="面包丝",
        category="烘焙原料",
        segment="distributor",
        buyer_description="烘焙食品厂",
        search_terms=["面包丝", "烘焙食品", "食品加工"],
        exclude_terms=[],
        source="dictionary",
        confidence=1,
        uncertainties=[],
    )

    assert buyer_terms_for(intent) == ["烘焙食品", "食品加工"]
