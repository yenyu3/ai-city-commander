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


class OmniRouteLLMClient(LLMClient):
    """Talks to a local OmniRoute instance (OpenAI-compatible
    /v1/chat/completions -- e.g. http://localhost:20128/v1), a multi-provider
    LLM router used here purely for local development/testing before real
    Bedrock/Anthropic credentials exist. Uses only the standard library
    (urllib) so it never adds a runtime dependency.

    Note: the generic `auto`/`auto/claude-sonnet` combos route mostly through
    OmniRoute's shared no-auth free tiers (theoldllm, opencode,
    duckduckgo-web), which were all found simultaneously broken/rate-limited
    (2026-07-31 -- confirmed via ~/.omniroute/logs/application/app.log:
    "Token rejected (403)" / "refresh failed" / "circuit breaker is open" for
    all three). Once the user connected their own free Kiro AI account
    (dashboard → Providers → Kiro AI, no card needed) and it showed up in
    /v1/models as `kiro/claude-sonnet-4.5`, requests succeeded reliably --
    that's why the default below targets it by name instead of `auto/*`. If
    `kiro/claude-sonnet-4.5` isn't connected in a given OmniRoute instance,
    override via OMNIROUTE_MODEL to whatever *is* actually connected (check
    `curl $OMNIROUTE_BASE_URL/models` and prefer a named provider connection
    over an `auto/*` alias, which silently falls through to the shared
    no-auth pool first).
    """

    def __init__(self, base_url: str, model: str = "kiro/claude-sonnet-4.5"):
        self._base_url = base_url.rstrip("/")
        self._model = model

    def complete(self, system: str, prompt: str, *, max_tokens: int = 1024) -> str:
        import json
        import urllib.error
        import urllib.request

        body = json.dumps(
            {
                "model": self._model,
                "stream": False,
                "max_tokens": max_tokens,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": prompt},
                ],
            }
        ).encode("utf-8")
        request = urllib.request.Request(
            f"{self._base_url}/chat/completions",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                payload = json.loads(response.read())
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"OmniRoute request failed ({exc.code}): {detail}") from exc

        if "error" in payload:
            raise RuntimeError(f"OmniRoute error: {payload['error'].get('message')}")
        return payload["choices"][0]["message"]["content"]


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

    Priority: AgentCore (prod path) > Anthropic direct (a real provider key)
    > OmniRoute (opt-in local dev/test router -- see OmniRouteLLMClient).
    OmniRoute is last and requires an explicit OMNIROUTE_BASE_URL so it never
    accidentally activates outside a dev machine (Lambda can't reach
    localhost anyway).

    Every caller in this package must have a canned-response fallback for
    the None case -- see agent/templates.py and agent/narrator.py.
    """
    agentcore_arn = os.environ.get("BEDROCK_AGENTCORE_RUNTIME_ARN")
    if agentcore_arn:
        return BedrockAgentCoreLLMClient(agentcore_arn)

    anthropic_key = os.environ.get("ANTHROPIC_API_KEY")
    if anthropic_key:
        return AnthropicLLMClient(anthropic_key)

    omniroute_base_url = os.environ.get("OMNIROUTE_BASE_URL")
    if omniroute_base_url:
        return OmniRouteLLMClient(
            omniroute_base_url,
            model=os.environ.get("OMNIROUTE_MODEL", "kiro/claude-sonnet-4.5"),
        )

    return None
