"""In-memory scan/reminder services. All request content is discarded after the response."""
from __future__ import annotations

import json
import re
from datetime import date, datetime
from typing import Any, TypeVar

from pydantic import BaseModel, ValidationError

from backend.prompts import SCAN_STRICT_PROMPT, SCAN_SYSTEM_PROMPT, reminder_system_prompt
from backend.provider import ModelProvider, ProviderError, parse_json_object, repair_json
from backend.schemas import LedgerExtraction, LedgerRow, ReminderModelOutput, ReminderRequest, ReminderResponse, ScanResponse

T = TypeVar("T", bound=BaseModel)


class InvalidModelOutput(RuntimeError):
    pass


def _validate_response(raw: str, schema: type[T]) -> T:
    parsed = parse_json_object(raw)
    return schema.model_validate(parsed)


async def _generate_and_validate(
    provider: ModelProvider,
    *,
    system_prompt: str,
    user_prompt: str,
    schema_model: type[T],
    schema: dict[str, Any],
    image_bytes: bytes | None = None,
    mime_type: str | None = None,
) -> T:
    try:
        first = await provider.generate_json(
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            schema=schema,
            image_bytes=image_bytes,
            mime_type=mime_type,
            strict=False,
        )
    except ProviderError:
        raise
    try:
        return _validate_response(first, schema_model)
    except (ValueError, ValidationError, json.JSONDecodeError):
        # A lightweight JSON repair is attempted before spending another model call.
        try:
            return schema_model.model_validate(json.loads(repair_json(first)))
        except (ValueError, ValidationError, json.JSONDecodeError):
            pass
    try:
        second = await provider.generate_json(
            system_prompt=system_prompt,
            user_prompt=user_prompt + "\n\n" + SCAN_STRICT_PROMPT if schema_model is LedgerExtraction else user_prompt + "\n\nReturn valid JSON only. Follow the exact schema; do not include markdown.",
            schema=schema,
            image_bytes=image_bytes,
            mime_type=mime_type,
            strict=True,
        )
        return _validate_response(second, schema_model)
    except ProviderError:
        raise
    except (ValueError, ValidationError, json.JSONDecodeError) as exc:
        raise InvalidModelOutput("The model response could not be read safely. Please try another photo or enter the lines manually.") from exc


async def scan_ledger(
    provider: ModelProvider,
    image_bytes: bytes,
    mime_type: str,
    language_hint: str | None,
) -> ScanResponse:
    hint = f"The user's optional language hint is: {language_hint}. Use it as context, but read every visible script." if language_hint else "No language hint was given. Detect the scripts present in the page."
    extraction = await _generate_and_validate(
        provider,
        system_prompt=SCAN_SYSTEM_PROMPT,
        user_prompt=f"Read the ledger in the attached image. {hint} The current year is {date.today().year}.",
        schema_model=LedgerExtraction,
        schema=LedgerExtraction.model_json_schema(by_alias=True),
        image_bytes=image_bytes,
        mime_type=mime_type,
    )
    extraction = normalize_ledger_extraction(extraction)
    return ScanResponse(**extraction.model_dump())



_DATE_TOKEN_RE = re.compile(r"(?<!\d)(?:\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4})(?!\d)")
_AMOUNT_CELL_RE = re.compile(
    r"^(?:(?:₹|Rs\.?|INR)\s*)?[\d,]+(?:\.\d{1,2})?(?:\s*/-)?$",
    re.IGNORECASE,
)
_SUMMARY_LINE_RE = re.compile(
    r"(?:\b(?:grand\s+total|total\s+amount|net\s+balance\s+due|pending\s+balance|"
    r"net\s+due\s+amount|closing\s+balance|total\s+due)\b|"
    r"कुल\s*(?:योग|बिल|बाकी|बकाया|देय)|शेष\s*बकाया|नेट\s*बैलेंस)",
    re.IGNORECASE,
)


def _parse_ledger_date(value: str) -> date | None:
    """Parse explicit dates using Indian day-first ordering."""
    token = value.strip()
    if not token:
        return None
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", token):
        try:
            return date.fromisoformat(token)
        except ValueError:
            return None
    for pattern in ("%d/%m/%Y", "%d-%m-%Y", "%d/%m/%y", "%d-%m-%y"):
        try:
            return datetime.strptime(token, pattern).date()
        except ValueError:
            continue
    return None


def _amount_from_cell(value: str) -> float | None:
    """Parse a whole money cell only; never extract a number from description text."""
    token = value.strip()
    if not token or not _AMOUNT_CELL_RE.fullmatch(token):
        return None
    cleaned = re.sub(r"^(?:₹|Rs\.?|INR)\s*", "", token, flags=re.IGNORECASE)
    cleaned = re.sub(r"\s*/-$", "", cleaned).replace(",", "").strip()
    try:
        amount = float(cleaned)
    except ValueError:
        return None
    return amount if amount > 0 else None


def _is_summary_row(row: LedgerRow) -> bool:
    """Totals and net-balance summaries are not individual customer transactions."""
    text = f"{row.items or ''} {row.raw_text or ''}"
    return bool(_SUMMARY_LINE_RE.search(text))


def _normalize_row_from_raw_text(row: LedgerRow) -> tuple[LedgerRow, bool, bool]:
    """Use explicit pipe-delimited cells to correct values that the model mismatched.

    Canonical table row: date | description | Paid/Cr | Due/Udhar.
    If exactly one of the two amount cells contains a valid amount, its column
    determines both the amount and whether this is a payment or an udhaar credit.
    Model fields are not overridden if the transcription is ambiguous.
    Returns (row, corrected_amount_or_type, corrected_date_or_items).
    """
    cells = [cell.strip() for cell in row.raw_text.split("|")]
    updates: dict[str, object] = {}
    corrected_amount_or_type = False
    corrected_date_or_items = False

    # The date is normally the first cell. Only recover/override when an explicit
    # date token exists in the transcription.
    date_match = _DATE_TOKEN_RE.search(cells[0]) if cells else None
    raw_date = _parse_ledger_date(date_match.group(0)) if date_match else None
    if raw_date is not None and row.date != raw_date:
        updates["date"] = raw_date
        corrected_date_or_items = True

    # The description is the second cell in the canonical four-column row.
    if len(cells) >= 2 and cells[1] and row.items != cells[1]:
        updates["items"] = cells[1][:500]
        corrected_date_or_items = True

    # Correct amount/type only when raw_text has a date, description, and exactly
    # the Paid and Due cells. This avoids guessing from free-form prose.
    if len(cells) == 4 and raw_date is not None and cells[1]:
        paid_amount = _amount_from_cell(cells[2])
        due_amount = _amount_from_cell(cells[3])
        paid_has_value = paid_amount is not None
        due_has_value = due_amount is not None

        if paid_has_value and not due_has_value:
            if abs(row.amount - paid_amount) >= 0.005 or row.type != "payment":
                updates["amount"] = paid_amount
                updates["type"] = "payment"
                corrected_amount_or_type = True
        elif due_has_value and not paid_has_value:
            if abs(row.amount - due_amount) >= 0.005 or row.type != "credit":
                updates["amount"] = due_amount
                updates["type"] = "credit"
                corrected_amount_or_type = True
        # Both money cells filled (or both blank) is ambiguous, so retain the
        # model values and let the review warning prompt the user to verify.

    if not updates:
        return row, False, False

    row_data = row.model_dump()
    row_data.update(updates)
    return LedgerRow.model_validate(row_data), corrected_amount_or_type, corrected_date_or_items


def _recover_missing_fields_without_canonical_columns(row: LedgerRow) -> tuple[LedgerRow, bool]:
    """Recover date/items from explicit cells for non-canonical pipe transcriptions."""
    cells = [cell.strip() for cell in row.raw_text.split("|")]
    if len(cells) < 3:
        return row, False
    updates: dict[str, object] = {}
    found_date: date | None = None
    date_index: int | None = None
    for index, cell in enumerate(cells):
        match = _DATE_TOKEN_RE.search(cell)
        if match:
            found_date = _parse_ledger_date(match.group(0))
            date_index = index
            break
    if row.date is None and found_date is not None:
        updates["date"] = found_date
    if (row.items is None or not row.items.strip()) and date_index is not None and date_index + 1 < len(cells):
        description = cells[date_index + 1]
        if description:
            updates["items"] = description[:500]
    if not updates:
        return row, False
    row_data = row.model_dump()
    row_data.update(updates)
    return LedgerRow.model_validate(row_data), True


def normalize_ledger_extraction(extraction: LedgerExtraction) -> LedgerExtraction:
    """Normalize explicit row cells and remove non-transaction summary lines."""
    normalized_rows: list[LedgerRow] = []
    correction_count = 0
    recovery_count = 0
    skipped_summary_count = 0
    ambiguity_count = 0

    for row in extraction.rows:
        if _is_summary_row(row):
            skipped_summary_count += 1
            continue

        cells = [cell.strip() for cell in row.raw_text.split("|")]
        date_in_first_cell = bool(cells and _DATE_TOKEN_RE.search(cells[0]))
        if len(cells) == 4 and date_in_first_cell:
            fixed, corrected_amount_or_type, corrected_date_or_items = _normalize_row_from_raw_text(row)
            correction_count += int(corrected_amount_or_type)
            recovery_count += int(corrected_date_or_items)
            paid = _amount_from_cell(cells[2])
            due = _amount_from_cell(cells[3])
            if (paid is not None) == (due is not None):
                ambiguity_count += 1
            normalized_rows.append(fixed)
        else:
            fixed, recovered = _recover_missing_fields_without_canonical_columns(row)
            recovery_count += int(recovered)
            normalized_rows.append(fixed)

    warnings = list(extraction.warnings)
    if correction_count:
        warnings.append(
            f"The Paid/Due columns corrected the amount or transaction type on {correction_count} row(s). Check these against the photo."
        )
    if skipped_summary_count:
        warnings.append(
            f"Ignored {skipped_summary_count} total or balance-summary line(s); they are not individual transactions."
        )
    if ambiguity_count:
        warnings.append(
            f"The Paid/Due columns were ambiguous on {ambiguity_count} row(s). Verify those rows carefully before saving."
        )
    return LedgerExtraction(
        page_title=extraction.page_title,
        rows=normalized_rows,
        warnings=warnings,
    )

def indian_rupees(value: float) -> str:
    negative = value < 0
    amount = abs(value)
    if amount.is_integer():
        whole = str(int(amount))
        decimals = ""
    else:
        formatted = f"{amount:.2f}"
        whole, decimals = formatted.split(".")
        decimals = "." + decimals
    if len(whole) > 3:
        last_three = whole[-3:]
        rest = whole[:-3]
        groups: list[str] = []
        while rest:
            groups.insert(0, rest[-2:])
            rest = rest[:-2]
        whole = ",".join(groups + [last_three])
    return f"{'-' if negative else ''}₹{whole}{decimals}"


async def draft_reminder(provider: ModelProvider, request: ReminderRequest) -> ReminderResponse:
    amount = indian_rupees(request.amount_due)
    system_prompt = reminder_system_prompt(request, amount)
    user_prompt = (
        f"Shop: {request.shop_name}\nCustomer: {request.customer_name}\nAmount due: {amount}\n"
        f"Language: {request.language}\nTone: {request.tone}\n"
        + (
            f"Latest ledger entry date (context only, NOT a payment deadline): {request.last_entry_date.isoformat()}\n"
            if request.last_entry_date else ""
        )
        + "Draft the message now."
    )
    schema = ReminderModelOutput.model_json_schema()
    response = await _generate_and_validate(
        provider,
        system_prompt=system_prompt,
        user_prompt=user_prompt,
        schema_model=ReminderModelOutput,
        schema=schema,
    )
    return ReminderResponse(message=response.message)
