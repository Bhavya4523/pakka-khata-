from __future__ import annotations

import io
import json
import os

from fastapi.testclient import TestClient

from backend.main import identify_image, app, limiter
from backend.rate_limit import InMemoryRateLimiter, RateLimitExceeded


# Minimal valid file signatures. Scan is in demo mode for these endpoint tests.
PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"demo image bytes"
JPEG_BYTES = b"\xff\xd8\xff" + b"demo image bytes"
WEBP_BYTES = b"RIFF" + (4).to_bytes(4, "little") + b"WEBP" + b"demo bytes"


def test_health_shape_in_demo_mode(client, monkeypatch):
    monkeypatch.setattr("backend.provider.ModelProvider.reachable", lambda self: _false())
    response = client.get("/api/health")
    assert response.status_code == 200
    data = response.json()
    assert set(data) == {"status", "provider", "model", "model_reachable", "demo_mode"}
    assert data["demo_mode"] is True
    assert data["model_reachable"] is False


async def _false():
    return False


def test_demo_scan_is_marked_and_does_not_claim_to_read_photo(client):
    response = client.post("/api/scan", files={"image": ("khata.png", PNG_BYTES, "image/png")}, data={"language_hint": "Marathi"})
    assert response.status_code == 200
    data = response.json()
    assert data["demo"] is True
    assert any("not a reading of your photo" in warning for warning in data["warnings"])
    assert len(data["rows"]) == 2


def test_scan_rejects_mismatched_content_type(client):
    response = client.post("/api/scan", files={"image": ("khata.png", JPEG_BYTES, "image/png")})
    assert response.status_code == 415


def test_scan_rejects_unknown_magic_bytes(client):
    response = client.post("/api/scan", files={"image": ("page.png", b"not really png", "image/png")})
    assert response.status_code == 415


def test_image_magic_byte_validation():
    assert identify_image(PNG_BYTES, "image/png")[0] == "image/png"
    assert identify_image(JPEG_BYTES, "image/jpeg")[0] == "image/jpeg"
    assert identify_image(WEBP_BYTES, "image/webp")[0] == "image/webp"


def test_scan_rejects_non_multipart(client):
    response = client.post("/api/scan", content=b"not a form", headers={"content-type": "text/plain"})
    assert response.status_code == 415


def test_reminder_demo_returns_respectful_message(client):
    response = client.post("/api/reminder", json={
        "shop_name": "Shree Stores", "customer_name": "Asha tai", "amount_due": 1234,
        "language": "english", "tone": "gentle", "last_entry_date": "2026-10-12"
    })
    assert response.status_code == 200
    message = response.json()["message"]
    assert "Asha tai" in message
    assert "Shree Stores" in message
    assert "₹1,234" in message
    assert "Thank you" in message


def test_reminder_endpoint_uses_mocked_provider_outside_demo_mode(client, monkeypatch):
    monkeypatch.setenv("DEMO_MODE", "false")

    class FakeProvider:
        async def generate_json(self, **kwargs):
            return json.dumps({"message": "Hello Asha, a gentle reminder that ₹500 is due. Thank you!"})

    monkeypatch.setattr("backend.main.get_provider", lambda settings=None: FakeProvider())
    response = client.post("/api/reminder", json={
        "shop_name": "Shree Stores", "customer_name": "Asha", "amount_due": 500,
        "language": "english", "tone": "gentle"
    })
    assert response.status_code == 200
    assert response.json()["message"].startswith("Hello Asha")
    assert "Thank you" in response.json()["message"]


def test_api_responses_include_security_headers_and_no_store(client):
    response = client.get("/api/health")
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["referrer-policy"] == "no-referrer"
    assert response.headers["x-frame-options"] == "DENY"
    assert "default-src 'self'" in response.headers["content-security-policy"]
    assert "no-store" in response.headers["cache-control"]


def test_two_simulated_clients_get_no_shared_ledger_data(client):
    """Phase 1 API is intentionally stateless; browser-owned Dexie stores arrive in Phase 2.

    Distinct client identifiers do not select server-side data because no ledger store or
    client/session identity endpoint exists on the backend. This test does not pretend to
    test browser IndexedDB; Phase 2 will test the actual client-side stores separately.
    """
    first = client.get("/api/health", headers={"X-Demo-Client": "shop-a"})
    second = client.get("/api/health", headers={"X-Demo-Client": "shop-b"})
    assert first.json() == second.json()
    assert "set-cookie" not in first.headers
    assert "set-cookie" not in second.headers
    assert client.get("/api/ledger").status_code == 404


def test_rate_limiter_blocks_after_limit():
    now = [100.0]
    limiter = InMemoryRateLimiter(limit=2, window_seconds=60, clock=lambda: now[0])
    limiter.check("127.0.0.1")
    limiter.check("127.0.0.1")
    try:
        limiter.check("127.0.0.1")
    except RateLimitExceeded as exc:
        assert exc.retry_after > 0
    else:
        raise AssertionError("Expected rate limiter to block the third request")
    now[0] += 61
    limiter.check("127.0.0.1")


def test_no_disk_writes_or_database_paths_during_demo_scan(client, monkeypatch):
    """Guard the request path against disk writes and database creation.

    The request uses only in-memory multipart parsing and sample response data. The test
    deliberately blocks Python file opens for writing and common Path write methods.
    """
    import builtins
    from pathlib import Path
    import sqlite3

    real_open = builtins.open

    def guarded_open(file, mode="r", *args, **kwargs):
        if any(flag in mode for flag in ("w", "a", "x", "+")):
            raise AssertionError("Unexpected file write during request")
        return real_open(file, mode, *args, **kwargs)

    def forbidden_write(*_args, **_kwargs):
        raise AssertionError("Unexpected pathlib disk write during request")

    monkeypatch.setattr(builtins, "open", guarded_open)
    monkeypatch.setattr(Path, "write_text", forbidden_write)
    monkeypatch.setattr(Path, "write_bytes", forbidden_write)
    monkeypatch.setattr(sqlite3, "connect", forbidden_write)
    response = client.post("/api/scan", files={"image": ("khata.png", PNG_BYTES, "image/png")})
    assert response.status_code == 200
    assert response.json()["demo"] is True
