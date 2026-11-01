from __future__ import annotations

from app.infrastructure.qcc import map_qcc_row, qcc_token


def test_qcc_signature_is_uppercase_md5_of_key_timestamp_secret() -> None:
    assert qcc_token("key", "1700000000", "secret") == "F82D2EC0DA9D602FB2F633CEBEBDE66E"


def test_qcc_field_mapping_accepts_varied_provider_keys() -> None:
    hit = map_qcc_row(
        {
            "EntName": "临安烘焙食品有限公司",
            "CreditNo": "91330100TEST000001",
            "province": "浙江省",
            "city": "杭州市",
            "IndustryName": "烘焙食品制造",
            "operName": "张三",
            "EsDate": "2012-06-15",
            "RegistCapi": "5000万元人民币",
            "PhoneNumber": "0571-88886666,13800138000",
            "OperScope": "烘焙食品生产与销售",
            "EntStatus": "存续",
        }
    )

    assert hit is not None
    assert hit.name == "临安烘焙食品有限公司"
    assert hit.credit_code == "91330100TEST000001"
    assert hit.region == "浙江省 杭州市"
    assert hit.phones == ["0571-88886666", "13800138000"]
    assert hit.legal_person == "张三"


def test_qcc_row_without_name_is_rejected() -> None:
    assert map_qcc_row({"CreditCode": "91330100TEST000001"}) is None
