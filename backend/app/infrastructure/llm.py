from __future__ import annotations

import json
import re
from typing import Any

import httpx
from langsmith import traceable


class ModelError(RuntimeError):
    """A language-model call did not produce a JSON object."""


def _trace_llm_inputs(inputs: dict[str, Any]) -> dict[str, Any]:
    return {
        "schema_name": inputs.get("schema_name"),
        "max_output_tokens": inputs.get("max_output_tokens"),
        "system_prompt": inputs.get("system_prompt"),
        "user_prompt": inputs.get("user_prompt"),
    }


class DeepSeekModel:
    """OpenAI-compatible JSON completion adapter used by the Python agents."""

    def __init__(
        self,
        *,
        api_key: str,
        base_url: str = "https://api.deepseek.com",
        model: str = "deepseek-chat",
        timeout_seconds: float = 20,
    ) -> None:
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._model = model
        self._timeout_seconds = timeout_seconds

    @traceable(
        run_type="llm",
        name="DeepSeek JSON completion",
        tags=["llm", "deepseek"],
        process_inputs=_trace_llm_inputs,
    )
    async def complete_json(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        schema_name: str,
        max_output_tokens: int = 800,
    ) -> dict[str, Any]:
        payload = {
            "model": self._model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            "response_format": {"type": "json_object"},
            "temperature": 0.1,
            "max_tokens": max_output_tokens,
        }
        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
        }
        try:
            async with httpx.AsyncClient(timeout=self._timeout_seconds) as client:
                response = await client.post(
                    f"{self._base_url}/chat/completions",
                    headers=headers,
                    json=payload,
                )
            response.raise_for_status()
        except httpx.HTTPError as error:
            raise ModelError(f"{schema_name} 模型调用失败：{error}") from error

        try:
            body = response.json()
            content = body["choices"][0]["message"]["content"]
        except (ValueError, KeyError, IndexError, TypeError) as error:
            raise ModelError(f"{schema_name} 返回结构不完整") from error
        if not isinstance(content, str) or not content.strip():
            raise ModelError(f"{schema_name} 返回了空内容")
        return _parse_json_object(content, schema_name)


def _parse_json_object(content: str, schema_name: str) -> dict[str, Any]:
    text = content.strip()
    text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\s*```$", "", text)
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as error:
        raise ModelError(f"{schema_name} 没有返回合法 JSON") from error
    if not isinstance(parsed, dict):
        raise ModelError(f"{schema_name} 必须返回 JSON 对象")
    return parsed
