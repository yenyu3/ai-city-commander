"""Pluggable LLM client used by the narrator layer (agent/narrator.py).

Concrete providers are imported lazily, inside their constructor, so this
module has zero hard dependencies at import time -- relevant right now
because this environment has neither a working AWS credential nor an
Anthropic API key configured yet. Until one of them is set, every caller
falls back to agent/templates.py's canned text (see get_configured_llm_client).
"""
from __future__ import annotations

import os
from abc import ABC, abstractmethod
from typing import Optional


class LLMClient(ABC):
    @abstractmethod
    def complete(self, system: str, prompt: str, *, max_tokens: int = 1024) -> str:
        """Return the model's text completion for the given prompt."""


class AnthropicLLMClient(LLMClient):
    """Direct Anthropic API access -- useful for local development before an
    AgentCore Runtime exists. Requires the `anthropic` package and
    ANTHROPIC_API_KEY.
    """

    def __init__(self, api_key: str, model: str = "claude-sonnet-4-5"):
        import anthropic  # optional dependency, only needed on this path

        self._client = anthropic.Anthropic(api_key=api_key)
        self._model = model

    def complete(self, system: str, prompt: str, *, max_tokens: int = 1024) -> str:
        response = self._client.messages.create(
            model=self._model,
            max_tokens=max_tokens,
            system=system,
            messages=[{"role": "user", "content": prompt}],
        )
        return "".join(
            block.text for block in response.content if block.type == "text"
        )


class BedrockAgentCoreLLMClient(LLMClient):
    """Placeholder for the eventual AWS Bedrock AgentCore Runtime call.

    Not implemented: there is no deployed AgentCore Runtime to call against
    yet (see BEDROCK_AGENTCORE_RUNTIME_ARN in backend/terraform/variables.tf).
    Wire the actual invoke call up once a runtime ARN exists.
    """

    def __init__(self, runtime_arn: str):
        self._runtime_arn = runtime_arn

    def complete(self, system: str, prompt: str, *, max_tokens: int = 1024) -> str:
        raise NotImplementedError(
            "Bedrock AgentCore Runtime integration is not implemented yet "
            f"(runtime_arn={self._runtime_arn!r})"
        )


def get_configured_llm_client() -> Optional[LLMClient]:
    """Returns a ready-to-use LLM client based on environment configuration,
    or None if nothing is configured yet.

    Every caller in this package must have a canned-response fallback for
    the None case -- see agent/templates.py and agent/narrator.py.
    """
    agentcore_arn = os.environ.get("BEDROCK_AGENTCORE_RUNTIME_ARN")
    if agentcore_arn:
        return BedrockAgentCoreLLMClient(agentcore_arn)

    anthropic_key = os.environ.get("ANTHROPIC_API_KEY")
    if anthropic_key:
        return AnthropicLLMClient(anthropic_key)

    return None
