# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Planner for the RocketRide Wave execution loop.

Owns the single-phase planning cycle:

  **Wave planning** — present full tool descriptions (name, description,
  inputSchema, outputSchema) for all available tools.  The LLM replies
  with either concrete tool calls or a final answer in one shot:
    - ``{"thought": "...", "plan": "...", "wave": [{"tool": "...", "args": {...}}, ...]}``
    - ``{"thought": "...", "plan": "...", "done": true, "answer": "..."}``

Usage::

    from .planner import plan

    result = plan(
        agent_input=agent_input,
        host=host,
        waves=waves,
        instructions=instructions,
        current_plan=current_plan,
    )
"""

from __future__ import annotations

import json
from typing import Any, Dict, List

from rocketlib import debug
from rocketlib.types import IInvokeLLM

from ai.common.agent import safe_str
from ai.common.schema import Question
from ai.common.agent.types import AgentInput, AgentHost

# ---------------------------------------------------------------------------
# System role
# ---------------------------------------------------------------------------

SYSTEM_ROLE = (
    'You are RocketRide Wave, a planning agent that solves tasks step-by-step. '
)

# ---------------------------------------------------------------------------
# Response format template
# ---------------------------------------------------------------------------

_RESPONSE_SCHEMA_WAVE = """\
Respond with one of these shapes (valid fenced, JSON only):

Invoke tools (use the schemas above for correct args):
    ```json
    {"thought": "detailed reasoning: what you understand about the request, what you plan to do next and why, and what you expect to learn from the tool calls", "plan": "[x] done step\\n[ ] next step\\n[ ] future step", "wave": [{"tool": "<name>", "args": {...}}, ...]}
    ```

Every tool result is automatically stored in memory and a preview (up to 500 characters) is returned inline in the wave history. The preview includes the memory key and full data size so you can decide whether the preview is sufficient or whether to reference the full stored value later.

To reference a stored result in a later wave or in the final answer, use {{memory.get:<key>@format}}:
    {"tool": "chart.create", "args": {"data": "{{memory.get:wave-0.r0@csv}}"}}

Final answer (ends the loop — keep the answer SHORT, use {{memory.get:key@format}} to reference stored data):
    ```json
    {"thought": "detailed reasoning: summarize what was gathered and why the answer is now complete", "plan": "[x] step1\\n[x] step2\\n[x] step3", "done": true, "answer": "Here are the results:\\n\\n{{memory.get:my_data@markdown_table}}"}
    ```

The "plan" field is REQUIRED in every response. Track your progress as a checklist.
Update it each turn: mark completed steps with [x] and upcoming steps with [ ].

Available formats for {{memory.get:key@format}}:
  markdown_table, html_table, csv, json, text
  Or any custom description — the system will format it for you.

Rules:
- No-progress: If your wave produces no new information (all tools errored, returned empty results, or you are repeating the same tool calls with the same args), return done=true immediately with whatever answer you have so far.
- Only use the tools listed above. Do not invent or modify tool names.
- For the final answer, write natural prose. If the data fits in the preview, use it directly. For large datasets, reference the stored value with {{memory.get:key@format}} — the @format specifier is required (e.g. @markdown_table, @text, @csv).
- When all needed data is already stored in memory and no further tool calls are needed, return done immediately."""


# ---------------------------------------------------------------------------
# Private helpers — formatting
# ---------------------------------------------------------------------------

def _build_all_tool_descriptions(host: AgentHost) -> str:
    """
    Build full tool descriptor JSON for all available tools.

    Returns one compact JSON line per tool (json.dumps, no indentation).
    Hides memory.put and memory.get since those are handled automatically
    by store/peek directives and {{memory.get:key}} references.
    """
    _HIDDEN_TOOLS = {'memory.put', 'memory.get'}

    lines: List[str] = []
    for td in host.tools.query():
        name = td.get('name', '') if isinstance(td, dict) else safe_str(getattr(td, 'name', ''))
        if not name or name in _HIDDEN_TOOLS:
            continue
        lines.append(json.dumps(td, ensure_ascii=False))

    return '\n'.join(lines) if lines else '(none)'


def _json_default(obj: Any) -> Any:
    """Fallback serializer for types json.dumps doesn't handle natively."""
    if hasattr(obj, '__float__'):
        return float(obj)
    if hasattr(obj, 'isoformat'):
        return obj.isoformat()
    return str(obj)


def _format_waves(waves: List[Dict[str, Any]]) -> List[str]:
    """
    Serialize prior wave results as a list of JSON strings (one per wave).
    """
    return [json.dumps(w, ensure_ascii=False, default=_json_default) for w in waves]


# ---------------------------------------------------------------------------
# Private helpers — Question builder
# ---------------------------------------------------------------------------

def _build_wave_question(
    *,
    agent_input: AgentInput,
    host: AgentHost,
    waves: List[Dict[str, Any]],
    instructions: List[str],
    plan: str,
) -> Question:
    """
    Build the wave-planning Question.

    Deep-copies the user's original question (preserving documents, context,
    examples, etc.) and augments it with:
      - The user's original questions promoted to goals
      - Full tool descriptions and schemas for all available tools
      - The current plan checklist as context
      - Any user-specified instructions
      - Prior wave results as context
      - The wave response format
      - A final question asking the LLM to plan the next wave
    """
    # Deep copy preserves all user-provided context (documents, examples, etc.)
    q = agent_input.question.model_copy(deep=True)
    q.role = SYSTEM_ROLE
    q.expectJson = True

    # Move the user's original questions into goals
    for qt in q.questions:
        q.addGoal(qt.text)
    q.questions = []

    # Full tool descriptions for all available tools
    tools_block = _build_all_tool_descriptions(host)
    if tools_block:
        q.addInstruction('Available Tools', tools_block)

    # Append any additional user-specified instructions
    for inst in instructions:
        q.addInstruction('Instruction', inst)

    # Response format (includes plan field requirement and rules)
    q.addInstruction('Response Format', _RESPONSE_SCHEMA_WAVE)

    # Inject the current plan so the LLM knows where it is in the task
    if plan:
        q.addContext(f'Current plan:\n{plan}')

    # Include prior wave results so the LLM can build on previous work
    for entry in _format_waves(waves):
        q.addContext(entry)

    q.addQuestion('Plan the next wave of tool calls to advance towards the goal.')
    return q


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def plan(
    *,
    agent_input: AgentInput,
    host: AgentHost,
    waves: List[Dict[str, Any]],
    instructions: List[str],
    current_plan: str = '',
) -> Dict[str, Any]:
    """
    Run the single-phase planning cycle and return the plan dict.

    Presents full tool descriptions for all available tools in one LLM call.
    The LLM either plans a wave of tool calls or returns a final answer directly.

    Args:
        agent_input: The original user request (question, documents, context).
        host: The agent host providing tool query/get and LLM access.
        waves: History of prior waves (calls + results) for context.
        instructions: Additional user-specified instructions to include.
        current_plan: The current plan checklist from the previous iteration.

    Returns:
        One of three shapes:
          - ``{"done": true, "answer": "...", "plan": "..."}``
          - ``{"wave": [...], "thought": "...", "plan": "..."}``
          - ``{}`` — empty (LLM returned nothing useful).
    """
    wave_prompt = _build_wave_question(
        agent_input=agent_input,
        host=host,
        waves=waves,
        instructions=instructions,
        plan=current_plan,
    )
    result = host.llm.invoke(IInvokeLLM(op='ask', question=wave_prompt)).getJson()
    debug(f'plan: result={json.dumps(result, ensure_ascii=False, default=str)[:500]}')

    if not result.get('done') and not result.get('wave'):
        debug('plan: empty wave response, falling through to synthesis')
        return {}

    return result


# ---------------------------------------------------------------------------
# Result summarizer (used by the executor for wave history entries)
# ---------------------------------------------------------------------------

def summarize_result(result: Any, max_len: int = 300) -> str:
    """
    Produce a compact single-line summary of a tool result for wave history.

    JSON-serializable results are dumped as JSON; others are stringified.
    Output is truncated to ``max_len`` characters to keep wave history
    compact and avoid blowing up the planning context.
    """
    if result is None:
        return 'null'
    if isinstance(result, (dict, list)):
        try:
            s = json.dumps(result, ensure_ascii=False)
        except Exception:
            s = str(result)
    else:
        s = str(result)
    if len(s) > max_len:
        s = s[:max_len - 3] + '...'
    return s
