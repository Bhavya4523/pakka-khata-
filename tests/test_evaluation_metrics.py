from tools.evaluate_scans import amount_matches, field_matches, percentile, score_rows


def test_amount_tolerance_is_applied_in_rupees():
    assert amount_matches(2150, 2150.5, 1.0)
    assert not amount_matches(2150, 2152, 1.0)


def test_text_comparison_normalizes_case_and_whitespace():
    assert field_matches("items", "  Old   BALANCE ", "old balance", 1.0)


def test_percentile_uses_linear_interpolation():
    assert percentile([10, 20, 30, 40], 50) == 25
    assert percentile([10, 20, 30, 40], 90) == 37
    assert percentile([], 90) is None


def test_row_metrics_count_missing_extra_and_field_errors():
    metrics = score_rows(
        [
            {"date": "2026-10-10", "items": "Old Balance", "amount": 2150, "type": "credit"},
            {"date": "2026-10-13", "items": "UPI payment", "amount": 1500, "type": "payment"},
        ],
        [
            {"date": "2026-10-10", "items": "Old Balance", "amount": 2150, "type": "credit"},
            {"date": "2026-10-13", "items": "UPI payment", "amount": 1500, "type": "credit"},
            {"date": "2026-10-14", "items": "Total", "amount": 3650, "type": "credit"},
        ],
        amount_tolerance=1.0,
    )
    assert metrics["expected_rows"] == 2
    assert metrics["predicted_rows"] == 3
    assert metrics["extra_rows"] == 1
    assert metrics["row_count_exact"] is False
    assert metrics["field_accuracy"]["type"] == 0.5
    assert metrics["field_accuracy"]["amount"] == 1.0


def test_optional_fields_are_not_scored():
    metrics = score_rows([{"amount": 100}], [{"amount": 100}], amount_tolerance=0)
    assert metrics["field_total"]["amount"] == 1
    assert metrics["field_total"]["date"] == 0
    assert metrics["field_accuracy"]["overall"] == 1.0
