"""
Agent boundary contracts (framework-agnostic).

Defines the type contracts shared by all agent framework drivers:
- Host service protocols (`AgentHost*`) used by `AgentBase`
- The input object passed into drivers (`AgentInput`)
- The JSON answer payload shape written to the answers lane (`AgentAnswer`)
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, List, Optional, Protocol, TypedDict

from ai.common.schema import Question


AGENT_TOOL_CALLS_TYPE = 'RocketRide.agent.tool_calls.v1'
"""Stack entry kind for tool-call traces recorded by `AgentBase`."""


class AgentHostLLM(Protocol):
    """Minimal host interface for invoking an LLM control-plane operation."""

    def invoke(self, param: Any) -> Any: ...


class AgentHostTools(Protocol):
    """Minimal host interface for tool discovery/validation/invocation."""

    def query(self) -> Any: ...

    def validate(self, tool_name: str, input: Any) -> Any: ...

    def invoke(self, tool_name: str, input: Any) -> Any: ...


class AgentHost(Protocol):
    """Host services provided to framework drivers during a run."""

    llm: AgentHostLLM
    tools: AgentHostTools


class AgentMeta(TypedDict, total=False):
    """Metadata attached to an agent answer JSON payload."""

    framework: str
    agent_id: str
    run_id: str
    state_ref: str
    started_at: str
    ended_at: str
    task_id: str


class AgentStackEntry(TypedDict, total=False):
    """Trace entry attached to `AgentAnswer.stack`."""

    kind: str
    name: str
    payload: Any


class AgentAnswer(TypedDict, total=False):
    """
    Define the JSON payload written to the answers lane by agents.

    Fields:
        content: Final user-facing answer text.
        meta: Run metadata.
        stack: Trace entries (tool calls, raw framework output, errors).
    """

    content: str
    meta: AgentMeta
    stack: List[AgentStackEntry]


@dataclass(frozen=True)
class AgentInput:
    """
    Run input passed from `AgentBase` into framework drivers.

    Attributes:
        prompt: Fully composed prompt text for the driver to run.
        question: Original `Question` object received from the engine.
        run_id: Unique run identifier.
        task_id: Optional task identifier propagated from the engine.
        started_at: UTC timestamp in ISO-8601 format.
    """

    question: Question
    run_id: str
    task_id: Optional[str]
    started_at: str


AgentRunResult = tuple[str, Any]
