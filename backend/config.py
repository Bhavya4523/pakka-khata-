"""Environment-backed configuration. No persistent configuration or user data."""
from __future__ import annotations

import os
from dataclasses import dataclass


def _bool(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default


def _float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default


@dataclass(frozen=True)
class Settings:
    app_env: str = "production"
    llm_provider: str = "ollama"
    base_url: str = "http://localhost:11434"
    model_name: str = "gemma3:4b"
    api_key: str = ""
    demo_mode: bool = False
    rate_limit_per_hour: int = 20
    request_timeout_s: float = 120.0
    max_upload_mb: int = 8

    @classmethod
    def from_env(cls) -> "Settings":
        provider = os.getenv("LLM_PROVIDER", "ollama").strip().lower()
        if provider not in {"ollama", "openai_compat"}:
            provider = "ollama"
        return cls(
            app_env=os.getenv("APP_ENV", "production").strip().lower(),
            llm_provider=provider,
            base_url=os.getenv("BASE_URL", "http://localhost:11434").rstrip("/"),
            model_name=os.getenv("MODEL_NAME", "gemma3:4b").strip() or "gemma3:4b",
            api_key=os.getenv("API_KEY", ""),
            demo_mode=_bool("DEMO_MODE", False),
            rate_limit_per_hour=max(1, _int("RATE_LIMIT_PER_HOUR", 20)),
            request_timeout_s=max(1.0, _float("REQUEST_TIMEOUT_S", 120.0)),
            max_upload_mb=max(1, _int("MAX_UPLOAD_MB", 8)),
        )
