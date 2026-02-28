"""
Agent boundary contracts (framework-agnostic).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Protocol, TypedDict

from ai.common.schema import Question


CONTINUATION_TYPE = 'aparavi.agent.continuation.v1'
AGENT_TOOL_CALLS_TYPE = 'aparavi.agent.tool_calls.v1'


class AgentHostLLM(Protocol):
    def invoke(self, param: Any) -> Any: ...


class AgentHostTools(Protocol):
    def query(self) -> Any: ...

    def validate(self, tool_name: str, input: Any) -> Any: ...

    def invoke(self, tool_name: str, input: Any) -> Any: ...


class AgentHost(Protocol):
    llm: AgentHostLLM
    tools: AgentHostTools


class AgentMeta(TypedDict, total=False):
    framework: str
    agent_id: str
    run_id: str
    state_ref: str
    started_at: str
    ended_at: str
    task_id: str


class AgentStackEntry(TypedDict, total=False):
    kind: str
    name: str
    payload: Any


class AgentAnswer(TypedDict, total=False):
    """Define the JSON payload written to the answers lane by agents."""

    content: str
    meta: AgentMeta
    stack: List[AgentStackEntry]


@dataclass(frozen=True)
class AgentInput:
    prompt: str
    question: Question
    continuation: Optional[Dict[str, Any]]
    run_id: str
    task_id: Optional[str]
    started_at: str


AgentRunResult = tuple[str, Any]
