from __future__ import annotations

import pytest

from app.domain.prospect.intent import interpret_product, match_dictionary


class ExplodingModel:
    async def complete_json(self, **_: object) -> dict[str, object]:
        raise AssertionError("dictionary hits must not call the model")


class FakeModel:
    def __init__(self, payload: dict[str, object]) -> None:
        self.payload = payload
        self.calls = 0

    async def complete_json(self, **_: object) -> dict[str, object]:
        self.calls += 1
        return self.payload


class FailingModel:
    async def complete_json(self, **_: object) -> dict[str, object]:
        raise RuntimeError("model unavailable")


@pytest.mark.asyncio
async def test_dictionary_hit_uses_no_model_call() -> None:
    intent = await interpret_product("面包丝", model=ExplodingModel())

    assert intent.source == "dictionary"
    assert intent.segment == "distributor"
    assert intent.category == "烘焙原料 / 裹粉类"
    assert intent.search_terms[0] == "面包丝"
    assert "烘焙食品" in intent.search_terms


def test_longest_dictionary_alias_wins() -> None:
    intent = match_dictionary("每日坚果礼盒")

    assert intent is not None
    assert intent.category == "坚果炒货"


@pytest.mark.asyncio
async def test_unknown_product_uses_model_and_validates_output() -> None:
    model = FakeModel(
        {
            "category": "工业润滑材料",
            "segment": None,
            "buyerDescription": "机械加工厂和汽车零部件厂的设备维护采购",
            "searchTerms": ["机械加工", "汽车零部件", "设备维护"],
            "excludeTerms": ["餐饮堂食"],
            "confidence": 0.82,
            "uncertainties": ["产品名称可能存在地区差异"],
        }
    )

    intent = await interpret_product("低温润滑脂", model=model)

    assert model.calls == 1
    assert intent.source == "ai"
    assert intent.confidence == 0.82
    assert intent.search_terms == ["机械加工", "汽车零部件", "设备维护"]


@pytest.mark.asyncio
async def test_model_failure_falls_back_to_searchable_intent() -> None:
    intent = await interpret_product("未知产品", model=FailingModel())

    assert intent.source == "dictionary"
    assert intent.confidence == 0
    assert intent.search_terms == ["未知产品"]
    assert intent.uncertainties


@pytest.mark.asyncio
async def test_invalid_model_shape_falls_back() -> None:
    model = FakeModel({"category": "", "buyerDescription": "", "searchTerms": []})

    intent = await interpret_product("未知产品", model=model)

    assert intent.source == "dictionary"
    assert intent.search_terms == ["未知产品"]
