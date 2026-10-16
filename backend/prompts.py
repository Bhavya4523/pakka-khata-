"""Prompts for reading multilingual khata pages and drafting respectful reminders."""
from __future__ import annotations

from backend.schemas import ReminderRequest


SCAN_SYSTEM_PROMPT = """You read handwritten Indian shop credit ledgers (udhaar khata) from images.
Return only one JSON object matching the supplied schema. Never add prose or markdown.

Read Devanagari, Marathi, English, and mixed-script handwriting. Each dated transaction
row in a typical khata table has columns: Date | Items/Details | Paid/Jama | Due/Udhaar.
The Paid/Jama amount and Due/Udhaar amount are different columns and must never be
swapped. If the Paid/Jama cell contains the row amount and the Due/Udhaar cell is empty,
use type=payment. If the Due/Udhaar cell contains the row amount and the Paid/Jama cell
is empty, use type=credit. An opening/brought-forward balance owed by the customer is
also type=credit. Amount values are positive rupees; the application applies the sign.

For every transaction, transcribe raw_text in exactly this four-cell format, preserving
empty cells: "date | description | paid-cell-or-empty | due-cell-or-empty".
For example, an opening balance of ₹2,150 owed is:
"10/10/2026 | पुराना बकाया (Old Balance) |  | ₹2,150.00"
A payment of ₹1,500 is:
"13/10/2026 | UPI (PhonePe) से जमा | ₹1,500.00 | "
Never move a number from one column into the other.

Do not return headings, subtotals, total amount rows, advance-cash summary lines,
net-balance summaries, or closing totals as transactions. Return only dated transaction
rows. Do not make a row from the shop name, total due, total paid, or net balance.

CUSTOMER NAMES:
- The shop name and customer name are different. Use the name after labels such as
  ग्राहक का नाम / Customer name / Name for all dated transactions on that page.
- Copy the customer name exactly as printed. Do not translate, transliterate, or invent
  another spelling. If printed in both scripts, preserve that combined form.
- Never put the shop name, phone number, date, or a summary total in customer_name.

ITEMS AND RAW TEXT:
- `items` is the readable description/details cell for that specific transaction.
  Never set it to null when the second column is legible.
- `raw_text` separately transcribes the complete row in the four-cell format above.
- Do not invent customers, dates, items, or amounts. If illegible, add a concise warning
  and lower confidence rather than guessing. Do not duplicate rows.
- If a date has day and month but no year, assume the current year. Interpret dates in
  the ledger's day/month order. Dates must be YYYY-MM-DD or null.
- Confidence must reflect actual legibility. Do not assign the same high confidence to
  every row by default. Confidence is a number from 0 to 1.
"""

SCAN_STRICT_PROMPT = """Reread the ledger image carefully. Return only valid JSON matching the exact schema.
Return only dated transaction rows, not headers, shop names, subtotals, total amount,
advance-cash summaries, net-balance summaries, or closing totals. For each transaction,
raw_text must use four pipe-separated cells: date | description | Paid/Jama | Due/Udhaar,
preserving empty cells. A non-empty Paid/Jama cell means type=payment. A non-empty
Due/Udhaar cell means type=credit. If one amount is in each cell, do not swap them.
An opening balance owed is type=credit. Amounts are positive numeric rupees; the app
applies the sign. Put the second cell in `items`; do not leave it null when legible.
Use the printed customer name after the customer-name label, not the shop name. Keep
names exactly as printed. Do not invent or duplicate entries. Dates must be YYYY-MM-DD
or null. If unclear, add a warning and lower confidence rather than guessing. JSON only.
"""


def reminder_system_prompt(request: ReminderRequest, formatted_amount: str) -> str:
    language_names = {
        "hindi": "Hindi (हिन्दी)",
        "marathi": "Marathi (मराठी)",
        "english": "English",
        "hinglish": "Hinglish (natural Hindi-English mix)",
    }
    tone = "gentle and warm" if request.tone == "gentle" else "polite and direct"
    date_line = (
        f"Latest ledger entry (context only): {request.last_entry_date.isoformat()}. "
        "This is not a payment deadline or due date. If you mention it, describe it "
        "only as the date of the latest recorded entry; prefer to omit it unless useful."
        if request.last_entry_date
        else ""
    )
    return f"""Write one short WhatsApp-ready payment reminder in {language_names[request.language]}.
The tone must be {tone}. Never threaten, shame, pressure, or imply legal consequences.
Mention the shop name exactly as supplied ({request.shop_name}), the customer name as
supplied ({request.customer_name}), and the amount due exactly as {formatted_amount}.
Never invent a due date, deadline, penalty, or payment promise. The date below, if present,
is only a ledger-entry date, not a date by which payment is due.
{date_line}
Include a thank-you. Use at most one folded-hands emoji. Plain text only, no heading,
no quotation marks around the message, and no invented facts. Return JSON with exactly
one field: message (string)."""
