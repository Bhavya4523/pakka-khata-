"""Open-weight model provider adapter. No content logging or persistence."""
from __future__ import annotations

import base64
import json
import re
from typing import Any

import httpx

from backend.config import Settings


class ProviderError(RuntimeError):
    """A safe-to-display inference error with no request content attached."""


def repair_json(text: str) -> str:
    """Perform intentionally light JSON repair; never invent missing field values."""
    value = text.strip().lstrip("\ufeff")
    value = re.sub(r"^```(?:json)?\s*", "", value, flags=re.IGNORECASE)
    value = re.sub(r"\s*```$", "", value)
    start = value.find("{")
    end = value.rfind("}")
    if start >= 0 and end > start:
        value = value[start : end + 1]
    value = re.sub(r",\s*([}\]])", r"\1", value)
    return value


def parse_json_object(text: str) -> dict[str, Any]:
    parsed = json.loads(repair_json(text))
    if not isinstance(parsed, dict):
        raise ValueError("The model response was not a JSON object.")
    return parsed


class ModelProvider:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    async def reachable(self) -> bool:
        try:
            timeout = httpx.Timeout(2.5, connect=1.0)
            async with httpx.AsyncClient(timeout=timeout) as client:
                if self.settings.llm_provider == "ollama":
                    response = await client.get(f"{self.settings.base_url}/api/tags")
                else:
                    headers = {"Authorization": f"Bearer {self.settings.api_key}"} if self.settings.api_key else {}
                    response = await client.get(f"{self.settings.base_url}/models", headers=headers)
            return response.status_code < 500
        except (httpx.HTTPError, ValueError):
            return False

    async def generate_json(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        schema: dict[str, Any],
        image_bytes: bytes | None = None,
        mime_type: str | None = None,
        strict: bool = False,
    ) -> str:
        if self.settings.llm_provider == "ollama":
            return await self._ollama_json(system_prompt, user_prompt, schema, image_bytes, strict)
        return await self._openai_compatible_json(
            system_prompt, user_prompt, schema, image_bytes, mime_type or "image/jpeg", strict
        )

    async def _ollama_json(
        self,
        system_prompt: str,
        user_prompt: str,
        schema: dict[str, Any],
        image_bytes: bytes | None,
        strict: bool,
    ) -> str:
        user_message: dict[str, Any] = {"role": "user", "content": user_prompt}
        if image_bytes is not None:
            user_message["images"] = [base64.b64encode(image_bytes).decode("ascii")]
        payload = {
            "model": self.settings.model_name,
            "stream": False,
            "format": schema,
            "options": {"temperature": 0 if strict else 0.1},
            "messages": [
                {"role": "system", "content": system_prompt},
                user_message,
            ],
        }
        try:
            async with httpx.AsyncClient(timeout=self.settings.request_timeout_s) as client:
                response = await client.post(f"{self.settings.base_url}/api/chat", json=payload)
                response.raise_for_status()
                result = response.json()
                content = result.get("message", {}).get("content")
                if not isinstance(content, str) or not content.strip():
                    raise ProviderError("The model returned an empty response. Please try again.")
                return content
        except ProviderError:
            raise
        except httpx.TimeoutException as exc:
            raise ProviderError("The model took too long to respond. Please try again.") from exc
        except httpx.HTTPStatusError as exc:
            raise ProviderError("The local model could not process this request. Check that the model is installed.") from exc
        except (httpx.HTTPError, ValueError, KeyError, TypeError) as exc:
            raise ProviderError("The local model is unavailable. Start Ollama and try again.") from exc

    async def _openai_compatible_json(
        self,
        system_prompt: str,
        user_prompt: str,
        schema: dict[str, Any],
        image_bytes: bytes | None,
        mime_type: str,
        strict: bool,
    ) -> str:
        content: Any = user_prompt
        if image_bytes is not None:
            data_uri = f"data:{mime_type};base64,{base64.b64encode(image_bytes).decode('ascii')}"
            content = [
                {"type": "text", "text": user_prompt},
                {"type": "image_url", "image_url": {"url": data_uri}},
            ]
        payload: dict[str, Any] = {
            "model": self.settings.model_name,
            "temperature": 0 if strict else 0.1,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": content},
            ],
        }
        if not strict:
            payload["response_format"] = {
                "type": "json_schema",
                "json_schema": {"name": "pakka_khata_response", "strict": True, "schema": schema},
            }
        headers = {"Content-Type": "application/json"}
        if self.settings.api_key:
            headers["Authorization"] = f"Bearer {self.settings.api_key}"
        try:
            async with httpx.AsyncClient(timeout=self.settings.request_timeout_s) as client:
                response = await client.post(f"{self.settings.base_url}/chat/completions", json=payload, headers=headers)
                # Some OpenAI-compatible open-weight servers do not support json_schema.
                # Retry once without response_format. Do not log error bodies or user content.
                if response.status_code == 400 and "response_format" in payload:
                    payload.pop("response_format", None)
                    response = await client.post(
                        f"{self.settings.base_url}/chat/completions", json=payload, headers=headers
                    )
                response.raise_for_status()
                result = response.json()
                text = result["choices"][0]["message"]["content"]
                if isinstance(text, list):
                    text = "".join(item.get("text", "") for item in text if isinstance(item, dict))
                if not isinstance(text, str) or not text.strip():
                    raise ProviderError("The model returned an empty response. Please try again.")
                return text
        except ProviderError:
            raise
        except httpx.TimeoutException as exc:
            raise ProviderError("The model took too long to respond. Please try again.") from exc
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code in (401, 403):
                message = "The model service rejected its credentials. Check the API key in server settings."
            elif exc.response.status_code == 429:
                message = "The model service is busy. Please try again shortly."
            else:
                message = "The model service could not process this request. Check the provider settings."
            raise ProviderError(message) from exc
        except (httpx.HTTPError, ValueError, KeyError, IndexError, TypeError) as exc:
            raise ProviderError("The configured model service is unavailable. Check its URL and settings.") from exc


def get_provider(settings: Settings | None = None) -> ModelProvider:
    from backend.config import Settings as SettingsClass
    return ModelProvider(settings or SettingsClass.from_env())
