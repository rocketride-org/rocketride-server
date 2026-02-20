# =============================================================================
# MIT License
# Copyright (c) 2024 RocketRide Inc.
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OF OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""
Agent boundary contracts (framework-agnostic).

This module intentionally contains only type/shape declarations and constants.
It should not import engine runtime modules (e.g. `aparavi`) so it can be reused
freely by framework adapters.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Optional, TypedDict

from ai.common.schema import Question


CONTINUATION_TYPE = 'aparavi.agent.continuation.v1'
AGENT_TOOL_CALLS_TYPE = 'aparavi.agent.tool_calls.v1'


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


