# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Agent definition dataclass for multi-agent orchestration.

Each agent in the orchestration is described by an AgentDefinition that
specifies its name, role, system instructions, available tools, and the
LLM model it should use.  Definitions are parsed from the ``agents_json``
configuration field — a JSON array of agent descriptors.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List


# Allowed keys when parsing an agent definition from JSON.
# Anything outside this set is rejected to prevent arbitrary data injection.
_ALLOWED_KEYS = frozenset({'name', 'role', 'instructions', 'tools', 'model'})


@dataclass
class AgentDefinition:
    """Describes a single agent participating in the orchestration.

    Attributes:
        name: Unique identifier for this agent (e.g. ``'researcher'``).
        role: Short role descriptor (e.g. ``'researcher'``, ``'writer'``).
        instructions: System prompt / behavioural guidelines for the agent.
        tools: Tool names available to this agent (resolved at runtime).
        model: LLM model identifier. Defaults to the pipeline-level model
            when left empty.
    """

    name: str
    role: str = ''
    instructions: str = ''
    tools: List[str] = field(default_factory=list)
    model: str = ''

    # ------------------------------------------------------------------
    # Validation
    # ------------------------------------------------------------------

    def __post_init__(self) -> None:  # noqa: D105
        if not self.name or not isinstance(self.name, str):
            raise ValueError('AgentDefinition.name must be a non-empty string')
        if not isinstance(self.role, str):
            raise TypeError('AgentDefinition.role must be a string')
        if not isinstance(self.instructions, str):
            raise TypeError('AgentDefinition.instructions must be a string')
        if not isinstance(self.tools, list) or not all(isinstance(t, str) for t in self.tools):
            raise TypeError('AgentDefinition.tools must be a list of strings')
        if not isinstance(self.model, str):
            raise TypeError('AgentDefinition.model must be a string')

    # ------------------------------------------------------------------
    # Factory
    # ------------------------------------------------------------------

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'AgentDefinition':
        """Create an AgentDefinition from a raw JSON-parsed dictionary.

        Validates that no unexpected keys are present to prevent
        arbitrary data injection.

        Raises:
            TypeError: If *data* is not a dict or field types are wrong.
            ValueError: If *data* contains unknown keys.
        """
        if not isinstance(data, dict):
            raise TypeError(f'Agent definition must be a dict, got {type(data).__name__}')
        unknown = set(data.keys()) - _ALLOWED_KEYS
        if unknown:
            raise ValueError(f'Unknown keys in agent definition: {unknown}')
        return cls(
            name=data.get('name', ''),
            role=data.get('role', ''),
            instructions=data.get('instructions', ''),
            tools=data.get('tools', []),
            model=data.get('model', ''),
        )


def parse_agent_definitions(raw: Any) -> List[AgentDefinition]:
    """Parse a JSON value into a list of :class:`AgentDefinition`.

    *raw* is typically the ``agents_json`` field from the node config,
    already parsed from JSON by the engine.  It may be:

    - A ``list`` of dicts (the normal case).
    - A JSON string (if the engine passes it un-parsed).
    - ``None`` or empty — returns an empty list.

    Raises:
        ValueError: On malformed input.
    """
    import json

    if raw is None:
        return []

    if isinstance(raw, str):
        raw = raw.strip()
        if not raw:
            return []
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ValueError(f'agents_json is not valid JSON: {exc}') from exc

    if not isinstance(raw, list):
        raise ValueError(f'agents_json must be a JSON array, got {type(raw).__name__}')

    return [AgentDefinition.from_dict(item) for item in raw]
