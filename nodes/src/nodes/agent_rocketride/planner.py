# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Planner for the RocketRide Wave execution loop.

Owns the single-phase planning cycle:

  **Wave planning** — present full tool descriptions (name, description,
  input_schema, output_schema) for all available tools.  The LLM replies
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

Each tool call may include ONE of these result-handling modes:
  "store": "<memory_key>" — (default) store result in memory. USE THIS for any tool that returns data.
  "peek": "<memory_key>"  — store result in memory, show a short preview in wave history
  "result": true          — return full result inline. ONLY for small results like confirmations.

IMPORTANT: Always use "store" or "peek" for tools that return data (queries, lookups, fetches).
Never use "result" for data-returning tools — results may be too large for the context window.

To reference stored data in a later wave, use {{memory.get:<key>}} in args:
    {"tool": "chart.create", "args": {"data": "{{memory.get:my_data}}"}}

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
- Only use the tools listed above. Do not invent or modify tool names.
- Keep the "answer" field SHORT. Never embed raw data in the answer — reference stored data with {{memory.get:key@format}}.
- For inline results (`result: true`), interpret the value and write a natural response — never copy raw JSON into the answer.
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
    """
    Provide a fallback serializer for objects unsupported by json.dumps.
    
    Converts objects with a float-like interface to a float, objects with an isoformat() method to that ISO-formatted string, and otherwise returns the object's string representation.
    
    Returns:
        A JSON-serializable value: a `float`, an ISO-format `str`, or `str(obj)`.
    """
    if hasattr(obj, '__float__'):
        return float(obj)
    if hasattr(obj, 'isoformat'):
        return obj.isoformat()
    return str(obj)


def _format_waves(waves: List[Dict[str, Any]]) -> List[str]:
    """
    Serialize prior wave results into JSON strings, one per wave.
    
    Parameters:
        waves (List[Dict[str, Any]]): Sequence of wave result objects to serialize.
    
    Returns:
        List[str]: JSON strings where each element is the serialized representation of the corresponding wave.
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
    Construct a System-role Question that asks the LLM to plan the next wave of tool calls.
    
    Builds a deep copy of the user's original question, marks it as a system prompt expecting JSON, promotes any user questions to goals, and appends context blocks describing available tools, the required response schema, any provided instructions, the current plan checklist, and formatted prior wave results. The resulting Question ends with a single prompt asking the LLM to "Plan the next wave of tool calls to advance towards the goal."
    
    Parameters:
        agent_input (AgentInput): The original user input containing the Question and any attached documents, examples, or context.
        host (AgentHost): The agent host used to enumerate available tools for inclusion in the prompt.
        waves (List[Dict[str, Any]]): Prior wave call/result entries to include as contextual history.
        instructions (List[str]): Additional instruction strings to include as separate prompt instruction blocks.
        plan (str): Current plan checklist text to inject as contextual state (may be empty).
    
    Returns:
        Question: A Question object configured as a SYSTEM-role prompt that requests the next wave plan in the module's wave response schema.
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
        debug('plan: empty wave response, returning done')
        fallback = result.get('answer') or result.get('thought') or 'Unable to determine next steps.'
        return {'done': True, 'answer': fallback}

    return result


# ---------------------------------------------------------------------------
# Result summarizer (used by the executor for wave history entries)
# ---------------------------------------------------------------------------

def summarize_result(result: Any, max_len: int = 300) -> str:
    """
    Create a compact single-line summary of a tool result for inclusion in wave history.
    
    Serializes dicts and lists to JSON when possible; otherwise uses str(result). Truncates the output to at most `max_len` characters and returns the string 'null' when `result` is None.
    
    Parameters:
        result (Any): The tool result to summarize.
        max_len (int): Maximum length of the returned summary in characters.
    
    Returns:
        summary (str): A single-line string representation of `result`, JSON-serialized for dicts/lists when possible, truncated with "..." if longer than `max_len`, or 'null' if `result` is None.
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
