from __future__ import annotations

import pytest
from pydantic import ValidationError

from backend.provider import parse_json_object, repair_json
from backend.schemas import LedgerExtraction, ReminderRequest


def test_scan_schema_accepts_devanagari_and_payment_rows():
    value = LedgerExtraction.model_validate({
        "page_title": "खाता",
        "rows": [{
            "customer_name": "रमेश पाटील", "date": "2026-10-12", "items": "किराणा",
            "amount": 850, "type": "payment", "confidence": 0.92, "raw_text": "रमेश जमा 850"
        }],
        "warnings": []
    })
    assert value.rows[0].customer_name == "रमेश पाटील"
    assert value.rows[0].type == "payment"


def test_schema_rejects_out_of_range_confidence_and_bad_type():
    base = {"customer_name": "Asha", "date": None, "items": None, "amount": 10,
            "type": "credit", "confidence": 1.2, "raw_text": "Asha 10"}
    with pytest.raises(ValidationError):
        LedgerExtraction.model_validate({"rows": [base], "warnings": []})


def test_lightweight_json_repair_removes_fence_and_trailing_comma():
    repaired = repair_json('```json\n{"rows": [], "warnings": [],}\n```')
    assert parse_json_object(repaired) == {"rows": [], "warnings": []}


def test_reminder_rejects_unknown_language():
    with pytest.raises(ValidationError):
        ReminderRequest(shop_name="Store", customer_name="Asha", amount_due=50,
                        language="gujarati", tone="gentle")
