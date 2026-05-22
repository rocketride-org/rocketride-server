"""
Agent boundary contracts (framework-agnostic).

Defines the type contracts shared by all agent framework drivers:
- Host service protocols (`AgentHost*`) used by `AgentBase`
- The JSON answer payload shape written to the answers lane (`AgentAnswer`)
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Protocol, TypedDict


AGENT_TOOL_CALLS_TYPE = 'RocketRide.agent.tool_calls.v1'
"""Stack entry kind for tool-call traces recorded by `AgentBase`."""


class AgentHostLLM(Protocol):
    """Minimal host interface for invoking an LLM control-plane operation."""

    def invoke(self, param: Any) -> Any:
        pass


class AgentHostTools(Protocol):
    """Minimal host interface for tool discovery/validation/invocation."""

    def query(self) -> Any:
        pass

    def validate(self, tool_name: str, input: Any) -> Any:
        pass

    def invoke(self, tool_name: str, input: Any) -> Any:
        pass


class AgentHostMemory(Protocol):
    """Run-scoped object store. Simple interface — all smart logic is in the executor."""

    def put(self, key: str, value: Any) -> Dict[str, Any]:
        pass

    def get(self, key: str) -> Dict[str, Any]:
        pass

    def list(self) -> Dict[str, Any]:
        pass

    def clear(self, key: Optional[str] = None) -> Dict[str, Any]:
        pass


class AgentHost(Protocol):
    """Host services provided to framework drivers during a run."""

    llm: AgentHostLLM
    tools: AgentHostTools
    memory: Optional[AgentHostMemory]


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


AgentRunResult = tuple[str, Any]


# ────────────────────────────────────────────────────────────────────────────────
# AGENT-AS-TOOL SCHEMAS
# ────────────────────────────────────────────────────────────────────────────────
#
# Every agent IInstance that exposes itself as a tool to parent agents declares
# a `@tool_function def run_agent(self, input_obj)` method.  These two schemas
# describe the input and output contract for that method and are imported
# directly by each IInstance file.  They are intentionally identical across
# all agent frameworks so a parent agent calling `<agent_node>.run_agent`
# always sees the same surface.

AGENT_TOOL_INPUT_SCHEMA: Dict[str, Any] = {
    'type': 'object',
    'properties': {
        'query': {'type': 'string', 'description': 'Query string for the agent (required)'},
        'context': {'type': 'object', 'description': 'Optional caller-provided context'},
    },
    'required': ['query'],
}


AGENT_TOOL_OUTPUT_SCHEMA: Dict[str, Any] = {
    'type': 'object',
    'description': 'Agent answer JSON payload',
    'properties': {
        'content': {'type': 'string', 'description': 'Final user-facing answer text'},
        'meta': {
            'type': 'object',
            'description': 'Run metadata',
            'properties': {
                'framework': {'type': 'string'},
                'agent_id': {'type': 'string'},
                'run_id': {'type': 'string'},
                'task_id': {'type': 'string'},
                'started_at': {'type': 'string'},
                'ended_at': {'type': 'string'},
            },
            'required': ['framework', 'agent_id', 'run_id', 'started_at', 'ended_at'],
        },
        'stack': {'type': 'array', 'items': {'type': 'object'}, 'description': 'Run trace stack'},
    },
    'required': ['content', 'meta', 'stack'],
}
