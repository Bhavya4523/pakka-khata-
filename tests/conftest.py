from __future__ import annotations

import os
import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("DEMO_MODE", "true")
    monkeypatch.setenv("RATE_LIMIT_PER_HOUR", "20")
    monkeypatch.setenv("LLM_PROVIDER", "ollama")
    from backend.main import app, limiter
    limiter.clear()
    with TestClient(app) as test_client:
        yield test_client
    limiter.clear()
