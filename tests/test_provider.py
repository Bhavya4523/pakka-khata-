from __future__ import annotations

import httpx
import pytest

from backend.config import Settings
from backend.provider import ModelProvider, ProviderError


@pytest.mark.asyncio
async def test_openai_compatible_provider_retries_without_json_schema(monkeypatch):
    calls = []

    class FakeResponse:
        def __init__(self, status_code, payload=None):
            self.status_code = status_code
            self._payload = payload or {}
            self.text = "schema unsupported"

        def raise_for_status(self):
            if self.status_code >= 400:
                request = httpx.Request("POST", "http://model.test/v1/chat/completions")
                response = httpx.Response(self.status_code, request=request, text=self.text)
                raise httpx.HTTPStatusError("bad request", request=request, response=response)

        def json(self):
            return self._payload

    class FakeClient:
        def __init__(self, *args, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): return False
        async def post(self, url, json, headers):
            calls.append(json.copy())
            if len(calls) == 1:
                return FakeResponse(400)
            return FakeResponse(200, {"choices": [{"message": {"content": '{"message":"Thanks"}'}}]})

    monkeypatch.setattr("backend.provider.httpx.AsyncClient", FakeClient)
    settings = Settings(llm_provider="openai_compat", base_url="http://model.test/v1", model_name="test-open-model", api_key="key")
    provider = ModelProvider(settings)
    text = await provider.generate_json(system_prompt="sys", user_prompt="user", schema={"type": "object"})
    assert text == '{"message":"Thanks"}'
    assert len(calls) == 2
    assert "response_format" in calls[0]
    assert "response_format" not in calls[1]


@pytest.mark.asyncio
async def test_provider_error_is_safe_for_timeout(monkeypatch):
    class FakeClient:
        def __init__(self, *args, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): return False
        async def post(self, *args, **kwargs): raise httpx.TimeoutException("secret prompt contents")

    monkeypatch.setattr("backend.provider.httpx.AsyncClient", FakeClient)
    provider = ModelProvider(Settings(llm_provider="ollama", base_url="http://model.test", model_name="gemma3:4b"))
    with pytest.raises(ProviderError) as err:
        await provider.generate_json(system_prompt="no user data logged", user_prompt="test", schema={})
    assert "secret prompt contents" not in str(err.value)
    assert "too long" in str(err.value)
