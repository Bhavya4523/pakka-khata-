from datetime import date

from backend.prompts import reminder_system_prompt
from backend.schemas import ReminderRequest


def test_reminder_prompt_never_turns_last_entry_date_into_a_deadline():
    request = ReminderRequest(
        shop_name="Madhukar kirana",
        customer_name="Verma Ji",
        amount_due=2070,
        language="marathi",
        tone="gentle",
        last_entry_date=date(2026, 10, 15),
    )
    prompt = reminder_system_prompt(request, "₹2,070")
    assert "not a payment deadline or due date" in prompt
    assert "Never invent a due date, deadline" in prompt
    assert "₹2,070" in prompt
    assert "Verma Ji" in prompt


def test_reminder_prompt_does_not_add_date_when_none_was_given():
    request = ReminderRequest(
        shop_name="Madhukar kirana",
        customer_name="Verma Ji",
        amount_due=2070,
        language="english",
        tone="gentle",
    )
    prompt = reminder_system_prompt(request, "₹2,070")
    assert "Latest ledger entry (context only)" not in prompt
