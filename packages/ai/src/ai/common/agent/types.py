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


class AgentControl(TypedDict, total=False):
    signal: str  # continue|halt|request_input
    reason: str
    requested_input: Dict[str, Any]  # {kind, schema}


class AgentError(TypedDict, total=False):
    message: str
    type: str
    details: Dict[str, Any]


class AgentResult(TypedDict, total=False):
    type: str
    data: Any


class AgentArtifact(TypedDict, total=False):
    kind: str
    name: str
    payload: Any


class AgentMeta(TypedDict, total=False):
    framework: str
    agent_id: str
    run_id: str
    state_ref: str
    started_at: str
    ended_at: str
    task_id: str


class AgentEnvelope(TypedDict, total=False):
    status: str  # completed|paused|failed
    error: Optional[AgentError]
    control: AgentControl
    result: AgentResult
    artifacts: List[AgentArtifact]
    meta: AgentMeta


@dataclass(frozen=True)
class AgentInput:
    prompt: str
    question: Question
    continuation: Optional[Dict[str, Any]]
    run_id: str
    task_id: Optional[str]
    started_at: str


class AgentRunResult(TypedDict, total=False):
    status: str
    error: Optional[AgentError]
    control: AgentControl
    result: AgentResult
    artifacts: List[AgentArtifact]
    meta: Dict[str, Any]
