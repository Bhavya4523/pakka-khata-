from datetime import date

from backend.schemas import LedgerExtraction, LedgerRow
from backend.service import normalize_ledger_extraction


def make_row(
    raw_text: str, *, row_date=None, items=None, amount=230, kind="credit", name="Verma Ji"
):
    return LedgerRow(
        customer_name=name,
        date=row_date,
        items=items,
        amount=amount,
        type=kind,
        confidence=0.8,
        raw_text=raw_text,
    )


def test_canonical_due_column_corrects_date_item_amount_and_type():
    row = make_row(
        "10/10/26 | पुराना बकाया (Old Balance) |  | ₹2,150.00",
        row_date=date(2026, 10, 10), items="पुराना बकाया (Old Balance)", amount=1500, kind="payment"
    )
    result = normalize_ledger_extraction(LedgerExtraction(rows=[row])).rows[0]
    assert result.date == date(2026, 10, 10)
    assert result.items == "पुराना बकाया (Old Balance)"
    assert result.amount == 2150
    assert result.type == "credit"


def test_canonical_paid_column_corrects_payment_amount_and_type():
    row = make_row(
        "13/10/26 | UPI (PhonePe) से जमा | ₹1,500.00 | ",
        row_date=date(2026, 10, 13), items="UPI (PhonePe) से जमा", amount=290, kind="credit"
    )
    result = normalize_ledger_extraction(LedgerExtraction(rows=[row])).rows[0]
    assert result.date == date(2026, 10, 13)
    assert result.amount == 1500
    assert result.type == "payment"


def test_due_purchase_is_credit_even_if_model_calls_it_payment():
    row = make_row(
        "11/10/26 | 10kg फॉर्च्यून बेसन + 2L तेल |  | ₹540.00",
        row_date=date(2026, 10, 11), items="10kg फॉर्च्यून बेसन + 2L तेल", amount=540, kind="payment"
    )
    result = normalize_ledger_extraction(LedgerExtraction(rows=[row])).rows[0]
    assert result.amount == 540
    assert result.type == "credit"


def test_ignores_summary_lines_and_keeps_transaction_rows():
    rows = [
        make_row("10/10/26 | Old Balance |  | ₹2,150.00", items="Old Balance", amount=2150),
        make_row(" | कुल बिल (Total Amount) | ₹1,500.00 | ₹3,570.00", items="कुल बिल (Total Amount)", amount=1500),
        make_row(" | **Net Balance Due** | ₹2,070.00 | ", items="Net Balance Due", amount=2070),
    ]
    result = normalize_ledger_extraction(LedgerExtraction(rows=rows))
    assert len(result.rows) == 1
    assert result.rows[0].items == "Old Balance"
    assert any("Ignored 2" in warning for warning in result.warnings)


def test_uses_explicit_cells_for_missing_date_and_item():
    row = make_row(
        "03/10/2026 | 5kg Aashirvaad Atta |  | ₹230.00",
        row_date=None, items=None, amount=230
    )
    result = normalize_ledger_extraction(LedgerExtraction(rows=[row])).rows[0]
    assert result.date == date(2026, 10, 3)
    assert result.items == "5kg Aashirvaad Atta"


def test_does_not_guess_amount_type_from_free_form_text():
    row = make_row("some illegible text maybe 230", amount=230, kind="credit")
    result = normalize_ledger_extraction(LedgerExtraction(rows=[row])).rows[0]
    assert result.amount == 230
    assert result.type == "credit"
    assert result.date is None
    assert result.items is None
