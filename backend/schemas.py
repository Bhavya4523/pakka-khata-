"""Structured request and response contracts for the public API."""
from __future__ import annotations

from datetime import date as DateType
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True, validate_assignment=True)


class LedgerRow(StrictModel):
    customer_name: str = Field(min_length=1, max_length=160)
    date: DateType | None = None
    items: str | None = Field(default=None, max_length=500)
    amount: float = Field(gt=0, allow_inf_nan=False)
    type: Literal["credit", "payment"]
    confidence: float = Field(ge=0, le=1)
    raw_text: str = Field(min_length=1, max_length=1000)


class LedgerExtraction(StrictModel):
    page_title: str | None = Field(default=None, max_length=240)
    rows: list[LedgerRow] = Field(default_factory=list, max_length=500)
    warnings: list[str] = Field(default_factory=list, max_length=100)


class ScanResponse(LedgerExtraction):
    demo: bool = False


class ReminderRequest(StrictModel):
    shop_name: str = Field(min_length=1, max_length=160)
    customer_name: str = Field(min_length=1, max_length=160)
    amount_due: float = Field(ge=0, allow_inf_nan=False)
    language: Literal["hindi", "marathi", "english", "hinglish"]
    tone: Literal["gentle", "normal"] = "gentle"
    last_entry_date: DateType | None = None


class ReminderResponse(StrictModel):
    message: str = Field(min_length=1, max_length=1200)

    @field_validator("message")
    @classmethod
    def clean_message(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Reminder message cannot be empty")
        return value


class HealthResponse(StrictModel):
    status: Literal["ok", "degraded"]
    provider: str
    model: str
    model_reachable: bool
    demo_mode: bool


class ReminderModelOutput(StrictModel):
    message: str = Field(min_length=1, max_length=1200)
