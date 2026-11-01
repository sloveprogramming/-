from __future__ import annotations

import pytest
from langsmith import configure, run_helpers

from app.config import Settings
from app.domain.prospect.models import CompanyHit
from app.infrastructure import tracing
from app.infrastructure.llm import _trace_llm_inputs
from app.infrastructure.qcc import _trace_qcc_outputs
from app.infrastructure.tracing import build_trace_anonymizer, configure_tracing


def settings(**overrides: object) -> Settings:
    values: dict[str, object] = {
        "app_env": "test",
        "database_url": None,
        "backend_token": "test-token",
        "deepseek_api_key": None,
        "deepseek_base_url": "https://api.deepseek.com",
        "deepseek_model": "deepseek-chat",
        "qcc_app_key": None,
        "qcc_secret_key": None,
        "qcc_base_url": "https://api.qichacha.com",
        "langsmith_tracing": False,
        "langsmith_api_key": None,
        "langsmith_project": "agentsdr-test",
        "langsmith_endpoint": "http://127.0.0.1:1",
        "cors_origins": (),
    }
    values.update(overrides)
    return Settings(**values)  # type: ignore[arg-type]


@pytest.fixture(autouse=True)
def reset_langsmith_state():
    configure(
        client=None,
        enabled=False,
        project_name=None,
        tags=None,
        metadata=None,
    )
    yield
    configure(
        client=None,
        enabled=False,
        project_name=None,
        tags=None,
        metadata=None,
    )


def test_trace_anonymizer_masks_phone_email_and_api_key() -> None:
    redacted = build_trace_anonymizer()(
        {
            "phone": "13800138000",
            "landline": "0571-88886666",
            "email": "sales@example.com",
            "api_key": f"sk-{'a' * 32}",
        }
    )

    assert redacted["phone"] == "[PHONE]"
    assert redacted["landline"] == "[PHONE]"
    assert redacted["email"] == "[EMAIL]"
    assert redacted["api_key"] == "[SECRET_DETECTED]"


def test_llm_trace_inputs_exclude_instance_and_secret_fields() -> None:
    traced = _trace_llm_inputs(
        {
            "self": object(),
            "schema_name": "product_intent",
            "max_output_tokens": 800,
            "system_prompt": "只输出 JSON",
            "user_prompt": "产品：面包丝",
            "api_key": "must-not-be-traced",
        }
    )

    assert traced == {
        "schema_name": "product_intent",
        "max_output_tokens": 800,
        "system_prompt": "只输出 JSON",
        "user_prompt": "产品：面包丝",
    }


def test_qcc_trace_output_does_not_contain_phone_numbers() -> None:
    hit = CompanyHit(
        key="k1",
        name="临安烘焙食品有限公司",
        credit_code=None,
        region="浙江省 杭州市",
        industry="烘焙食品",
        legal_person="张三",
        founded_at="2012-06-15",
        registered_capital="5000万元人民币",
        phones=["13800138000"],
        scope="烘焙食品生产与销售",
        status="存续",
        in_library=False,
    )

    traced = _trace_qcc_outputs([hit])

    assert traced["count"] == 1
    assert traced["companies"][0]["has_phone"] is True
    assert "13800138000" not in str(traced)


def test_tracing_stays_disabled_without_api_key() -> None:
    configured = configure_tracing(settings(langsmith_tracing=True, langsmith_api_key=None))

    assert configured is False
    assert run_helpers.get_tracing_context()["enabled"] is False


def test_tracing_is_enabled_with_key_and_project(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_client = object()
    captured: dict[str, object] = {}

    def fake_client_factory(**kwargs: object) -> object:
        captured["client_kwargs"] = kwargs
        return fake_client

    def fake_configure(**kwargs: object) -> None:
        captured["configure_kwargs"] = kwargs

    monkeypatch.setattr(tracing, "Client", fake_client_factory)
    monkeypatch.setattr(tracing, "configure", fake_configure)

    configured = tracing.configure_tracing(
        settings(
            langsmith_tracing=True,
            langsmith_api_key="fake-key",
            langsmith_project="trace-test",
        )
    )

    assert configured is True
    client_kwargs = captured["client_kwargs"]
    configure_kwargs = captured["configure_kwargs"]
    assert isinstance(client_kwargs, dict)
    assert isinstance(configure_kwargs, dict)
    assert client_kwargs["api_key"] == "fake-key"
    assert callable(client_kwargs["anonymizer"])
    assert configure_kwargs["enabled"] is True
    assert configure_kwargs["project_name"] == "trace-test"
    assert configure_kwargs["client"] is fake_client
    assert configure_kwargs["metadata"]["environment"] == "test"
    assert configure_kwargs["metadata"]["llm_model"] == "deepseek-chat"
