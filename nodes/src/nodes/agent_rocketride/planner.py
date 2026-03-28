# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================


"""
Planner for the RocketRide Wave execution loop.

Owns the single-phase planning cycle:

  **Wave planning** — present full tool descriptions (name, description,
  inputSchema) for all available tools.  The LLM replies with either
  concrete tool calls or a final answer in one shot:
    - ``{"thought": "...", "scratch": "...", "tool_calls": [{...}, ...]}``
    - ``{"thought": "...", "scratch": "...", "done": true, "answer": "..."}``

Usage::

    from .planner import plan

    result = plan(
        agent_input=agent_input,
        host=host,
        waves=waves,
        instructions=instructions,
        current_scratch=current_scratch,
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

# This string is injected as the LLM's persona at the start of every prompt.
# Keeping it brief and declarative — the detailed instructions follow in the
# numbered sections — so the model internalizes its role without noise.
SYSTEM_ROLE = 'You are RocketRide Wave, a planning agent that solves tasks step-by-step. '

# ---------------------------------------------------------------------------
# Private helpers — formatting
# ---------------------------------------------------------------------------


def _build_all_tool_descriptions(host: AgentHost) -> str:
    """
    Build full tool descriptor JSON for all available tools.

    Returns one compact JSON line per tool (json.dumps, no indentation).

    Memory tools are intentionally excluded here — the memory subsystem is
    a separate host service (classType 'memory') and does not appear in
    tool discovery.  memory.peek is injected separately by _build_wave_question
    so we can control its schema precisely (it has different runtime semantics
    from regular tools — it is executed locally, not through the tool pipeline).
    """
    lines: List[str] = []
    for td in host.tools.query():
        # Defensively handle both dict descriptors and object-style descriptors
        name = td.get('name', '') if isinstance(td, dict) else safe_str(getattr(td, 'name', ''))
        if not name:
            continue
        # One JSON line per tool — compact (no indent) to save prompt tokens
        lines.append(json.dumps(td, ensure_ascii=False))

    return '\n'.join(lines) if lines else '(none)'


def _json_default(obj: Any) -> Any:
    """Fallback serializer for types json.dumps doesn't handle natively.

    Used when serializing wave results into the prompt context. Database drivers
    return Decimal and datetime values that the standard encoder rejects; we
    convert them to float and ISO-8601 strings respectively so the structural
    summary remains readable to the LLM.
    """
    if hasattr(obj, '__float__'):
        # Covers decimal.Decimal and any other numeric wrapper
        return float(obj)
    if hasattr(obj, 'isoformat'):
        # Covers datetime.datetime, datetime.date, datetime.time
        return obj.isoformat()
    return str(obj)


# ---------------------------------------------------------------------------
# Private helpers — Question builder
# ---------------------------------------------------------------------------


def _build_wave_question(
    *,
    agent_input: AgentInput,
    host: AgentHost,
    waves: List[Dict[str, Any]],
    instructions: List[str],
    scratch: str = '',
) -> Question:
    """
    Build the wave-planning Question sent to the LLM each iteration.

    Deep-copies the user's original question (preserving attached documents,
    context blocks, examples, etc.) then augments it with:
      - Tool descriptions for every connected node
      - Memory usage instructions
      - Response format specification
      - Behavioral rules
      - Persistent scratch notes from previous iterations
      - Structural summaries of all prior tool results
      - The planning question itself
    """
    # Deep-copy so we can mutate (add goals, clear questions) without touching
    # the original AgentInput that the outer loop holds across iterations.
    q = agent_input.question.model_copy(deep=True)
    q.role = SYSTEM_ROLE
    # Instructs the schema layer to expect and parse a JSON response from the LLM
    q.expectJson = True

    # Reframe the user's original questions as goals so the LLM treats them as
    # the objective to satisfy rather than questions it should answer literally
    # in the first response.  After promotion the questions list is cleared so
    # they don't also appear as literal questions at the end of the prompt.
    for qt in q.questions:
        q.addGoal(qt.text)
    q.questions = []

    # ------------------------------------------------------------------
    # Tool descriptions
    # ------------------------------------------------------------------

    # Collect all tool descriptors from connected nodes via the host's tool
    # discovery mechanism.  Each descriptor is one compact JSON line.
    tools_block = _build_all_tool_descriptions(host)

    # memory.peek is injected separately from regular tools because:
    # 1. It is executed locally in the executor (not routed through the tool
    #    pipeline), so it never appears in the host's tool registry.
    # 2. We need to document its JMESPath semantics precisely — the schema here
    #    is authoritative for what the LLM should emit when calling it.
    peek_descriptor = json.dumps(
        {
            'name': 'memory.peek',
            'description': ('Extract data from a stored result using a JMESPath expression, or page through a large value in text chunks. Use the structural summary in Previous tool results to identify the path you need.'),
            'inputSchema': {
                'type': 'object',
                'required': ['key'],
                'properties': {
                    'key': {'type': 'string', 'description': 'Memory key to read from'},
                    'path': {
                        'type': 'string',
                        'description': ('JMESPath expression to extract a specific field or slice (e.g. "results[0].name", "rows[0:5].city", "postcodes[2]"). Arrays are capped at 50 items — use indexed paths for specific elements.'),
                    },
                    # offset/length enable chunked reading of large raw values
                    # when the LLM needs to page through data too large to load at once
                    'offset': {'type': 'integer', 'description': 'Character offset for chunk reading (default 0). Only when path is omitted.'},
                    'length': {'type': 'integer', 'description': 'Characters to return for chunk reading (default 8000). Only when path is omitted.'},
                },
            },
            'outputSchema': {
                'type': 'object',
                'properties': {
                    'preview': {'type': 'string', 'description': 'The extracted data (JMESPath result or text chunk)'},
                    'path': {'type': 'string', 'description': 'The JMESPath expression used, if any'},
                    'offset': {'type': 'integer', 'description': 'Character offset used (chunk mode only)'},
                    'total_chars': {'type': 'integer', 'description': 'Total length of the value (chunk mode only)'},
                    'truncated': {'type': 'boolean', 'description': 'True if an array result was capped'},
                    'returned_items': {'type': 'integer', 'description': 'Number of array items returned when truncated'},
                    'total_items': {'type': 'integer', 'description': 'Total array length when truncated'},
                },
            },
        },
        ensure_ascii=False,
    )

    # Append memory.peek after the regular tools so the LLM sees it last —
    # it is a utility tool, not a primary data source, and ordering matters
    # for how prominently it registers in the model's attention.
    tools_block = (tools_block + '\n' + peek_descriptor) if tools_block != '(none)' else peek_descriptor
    q.addInstruction('Available Tools', tools_block)

    # ------------------------------------------------------------------
    # User-specified additional instructions
    # ------------------------------------------------------------------

    # Node operators can attach extra instructions (e.g. domain constraints,
    # output style preferences) via the node's configuration.  Each one is
    # injected as a separate Instruction block so it renders distinctly in
    # the prompt and doesn't blend into the system-level instructions above.
    for inst in instructions:
        q.addInstruction('Instruction', inst)

    # ------------------------------------------------------------------
    # Memory usage instructions
    # ------------------------------------------------------------------

    # Teach the LLM the two-level memory model:
    # 1. Structural summaries (always visible) — shape the LLM's awareness of
    #    what data exists without flooding the context with raw values.
    # 2. memory.peek (on demand) — lets the LLM pull specific values when the
    #    summary isn't enough.
    # 3. {{memory.ref:key:format:path}} (in final answer) — lets the LLM
    #    reference bulk data in the answer without ever loading it into context.
    q.addInstruction(
        'Memory',
        """\
        Every tool result is automatically stored in memory. All prior results appear in
        "Previous tool results" below, keyed by memory key. Each entry shows a structural
        summary — field names, array lengths, and sample values — so you can understand
        the data shape without loading it.

        There are two distinct memory mechanisms. Use the right one:

       - memory.peek (tool call)
        Use during a wave to extract specific scalar values into scratch.
          {"tool": "memory.peek", "args": {"key": "<key>", "path": "results[0].name"}}
          {"tool": "memory.peek", "args": {"key": "<key>", "path": "rows[0:5].city"}}
          {"tool": "memory.peek", "args": {"key": "<key>", "path": "postcodes[2]"}}
        Arrays are capped at 50 items per call. Use indexed paths for specific elements.
        To page through a large raw value as text (no path), use offset/length:
          {"tool": "memory.peek", "args": {"key": "<key>", "offset": 0, "length": 8000}}
        Use total_chars to calculate how many more chunks remain.

        Do NOT use memory.peek to inspect or validate bulk data before answering.
        If the structural summary tells you what you need, that is enough.

        - {{memory.ref:key:format}} (answer template)
        Use in the final answer to embed stored data. The system fetches, formats, and
        substitutes it at render time — no tool call, no context limit, no truncation.
          {{memory.ref:wave-1.r0:markdown_table}}
          {{memory.ref:wave-1.r0:markdown_table:rows[0:20]}}
          {{memory.ref:wave-1.r0:markdown_table:rows[0:20].cities[0].postal_code}}
          {{memory.ref:wave-1.r0:csv:rows}}

        If the structural summary confirms the data exists and looks complete, write
        done=true and embed it with {{memory.ref:key:format}} directly — do not peek it first.

        Available formats: markdown_table, html_table, csv, json, text""",
    )

    # ------------------------------------------------------------------
    # Response format
    # ------------------------------------------------------------------

    # The two valid response shapes (tool-calling and final-answer) are
    # shown as concrete JSON examples rather than abstract descriptions.
    # Concrete examples dramatically improve LLM compliance with structured
    # output formats compared to prose descriptions alone.
    #
    # Fields:
    # - thought: one sentence keeps output tokens low while still giving the
    #   LLM a place to articulate its current decision (useful for debugging).
    # - scratch: the LLM's persistent working memory across turns.  Values
    #   written here survive to the next iteration injected in Context.
    # - remove: lets the LLM signal which memory keys it's done with so the
    #   driver can clear them and keep the context lean.
    # - tool_calls: parallel tool invocations for this wave.
    # - answer: the final user-facing response — strict rules on what goes here
    #   prevent the LLM from leaking planning notes or raw data into the output.
    q.addInstruction(
        'Response Format',
        """\
        Respond with one of these shapes (valid fenced JSON only):

        Invoke tools:
        ```json
        {"thought": "...", "scratch": "...", "remove": ["<key>"], "tool_calls": [{"tool": "<name>", "args": {...}}, ...]}
        ```

        Final answer:
        ```json
        {"thought": "...", "scratch": "...", "remove": ["<key>"], "done": true, "answer": "..."}
        ```

        Every response must either invoke at least one tool OR set done=true with an
        answer. An empty tool_calls list with no done/answer is never valid.

        Fields:
        - thought: one sentence — what you are doing this turn and why
        - scratch: working notes that persist across steps — store key names, intermediate
          calculations, observations. Keep it concise; it is not a data store.
          If a value is written in scratch, treat it as known — do not fetch it again.
        - remove: array of Previous tool result keys whose data has been fully extracted and will
          not be referenced again. The system clears them from memory and removes them from future
          context. Remove peek results (tool=memory.peek) as soon as their data is captured in
          scratch. Remove primary results once their data is no longer needed.
        - tool_calls: list of tool calls to execute in parallel
        - answer: the user-facing response to their question. Write this as if speaking
          directly to the user — present the result clearly and naturally. Do not include
          planning notes, memory key references, or descriptions of what you intend to do.
          Scalar values (numbers, names, computed results) come from scratch — write them
          directly. Bulk or tabular data that was never loaded into scratch must be
          referenced with {{memory.ref:key:format}} or {{memory.ref:key:format:path}} —
          the system will fetch, extract, and format it before delivering the answer.""",
    )

    # ------------------------------------------------------------------
    # Behavioral rules
    # ------------------------------------------------------------------

    # These rules address specific failure modes observed in agent traces:
    # - "write the answer now": prevents the agent deferring the answer to a
    #   future turn after recognising it has all the data it needs.
    # - "No-progress": prevents infinite loops when tools return structurally
    #   similar results across repeated attempts.
    # - "Check before fetching": prevents redundant memory.peek calls when the
    #   structural summary already contains the needed values.
    # - "Remove peek results": keeps the context window lean by evicting
    #   transient peek results as soon as their data is captured in scratch.
    q.addInstruction(
        'Rules',
        """\
        - Think things through thoroughly. Plan accordingly. Prefer the simplest
        approach that answers the question — do not over-analyze.
        - Trust that, if a tool succeeds, it worked and gave you the correct answer.
        You do not need to verify, re-fetch, or confirm a tool's results. If the result
        is clearly wrong (e.g. wrong columns, wrong data entirely), you may retry once
        with a different approach — but never re-run the same request hoping for a
        different outcome.
        - Once all the information needed to complete the goal is available in scratch or
        previous results, write the answer now and set done=true. Presenting the answer is
        not a future plan step — it happens in the same response where you recognize the
        data is ready.
        - Only use the tools listed in Available Tools. Do not invent or modify tool names.
        - NEVER include raw tool results, API responses, JSON blobs, or memory values in the final
        answer. Extract only what is needed to answer the question and present it naturally.
        - Check before fetching: Before any tool call — including memory.peek — check scratch and
        the result previews first. If the values you need are already there, do not fetch them.
        Missing secondary fields (units, labels, timestamps) are not blockers; if the primary
        values are known, set done=true. A plan unchanged from the previous response means you
        are not making progress — stop or change approach.
        - Remove peek results in the same response you capture their data in scratch. Do not
        carry transient peek results forward into subsequent steps.""",
    )

    #    - No-progress: If you have made two or more tool calls that return structurally
    #    similar results (same shape, same row count, same sample values) and you are not
    #    closer to done than you were two steps ago, STOP. Do not retry with reworded inputs.
    #    Present the best data you already have using {{memory.ref:key:format}} with
    #    reasonable defaults — do not ask the user clarifying questions about formatting,
    #    filtering, or edge cases. Just deliver the result. Add a brief caveat only if you
    #    genuinely believe the data may be incomplete.

    # ------------------------------------------------------------------
    # Context: persistent scratch from previous iterations
    # ------------------------------------------------------------------

    # Scratch notes are the LLM's working memory.  They are emitted in the
    # JSON response each turn and re-injected here so the LLM can continue
    # exactly where it left off: remembered memory keys, extracted values,
    # intermediate calculations, observations about tool results.
    # Only injected when non-empty to avoid a meaningless empty context block.
    if scratch:
        q.addContext(f'Scratch (your working notes from previous steps):\n{scratch}')

    # ------------------------------------------------------------------
    # Context: prior tool results (structural summaries)
    # ------------------------------------------------------------------

    # Flatten all wave result entries from every prior iteration into a single
    # dict keyed by memory key (e.g. "wave-0.r0").  Each entry holds the tool
    # name, the memory key, and the structural summary produced by _describe().
    # The 'key' field itself is excluded from the value dict since it's already
    # the dict key — no need to repeat it.
    #
    # Why a flat dict rather than the original nested wave list?  The LLM only
    # needs to know what keys exist and what shape their data is — the wave
    # numbering and call ordering are irrelevant to the planning decision.
    all_results: Dict[str, Any] = {}
    for w in waves:
        for r in w.get('results', []):
            key = r.get('key')
            if key:
                all_results[key] = {k: v for k, v in r.items() if k != 'key'}
    if all_results:
        # indent=2 for readability in the prompt; _json_default handles any
        # non-serializable values that sneak through from tool result summaries
        q.addContext('Previous tool results:\n' + json.dumps(all_results, ensure_ascii=False, indent=2, default=_json_default))

    # This is the actual planning question — placed last so it is the freshest
    # thing in the LLM's context window when it generates its response.
    q.addQuestion('Plan the next set of tool calls to advance towards the goal.')
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
    current_scratch: str = '',
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
        current_scratch: The LLM's working notes from the previous iteration.

    Returns:
        One of two shapes:
          - ``{"done": true, "answer": "...", "scratch": "..."}``
          - ``{"tool_calls": [...], "thought": "...", "scratch": "..."}``
          - ``{}`` — empty (LLM returned nothing useful).
    """
    wave_prompt = _build_wave_question(
        agent_input=agent_input,
        host=host,
        waves=waves,
        instructions=instructions,
        scratch=current_scratch,
    )
    debug(f'plan: request {wave_prompt.getPrompt()}')

    # Single LLM call — the response is parsed as JSON by getJson().
    # The schema layer enforces the fenced-JSON format requested via expectJson.
    result = host.llm.invoke(IInvokeLLM(op='ask', question=wave_prompt)).getJson()
    debug(f'plan: result={json.dumps(result, ensure_ascii=False, default=str)[:500]}')

    # Diagnostic trace file — append each REQUEST/RESULT pair for offline
    # analysis.  Failures are silently swallowed so a missing/locked file
    # never crashes the agent loop.
    # try:
    #     with open(r'C:\agents\agent.log', 'a', encoding='utf-8') as _f:
    #         _ts = datetime.datetime.now().isoformat(timespec='seconds')
    #         _f.write(f'\n{"=" * 80}\n[{_ts}] REQUEST\n{"=" * 80}\n')
    #         _f.write(wave_prompt.getPrompt())
    #         _f.write(f'\n{"=" * 80}\n[{_ts}] RESULT\n{"=" * 80}\n')
    #         _f.write(json.dumps(result, ensure_ascii=False, indent=2, default=str))
    #         _f.write('\n')
    # except Exception as _e:
    #     debug(f'plan: agent.txt write failed: {_e}')

    # If the LLM returned neither done=true nor tool_calls, the response is
    # malformed or empty.  Return {} to signal the outer loop to fall through
    # to the synthesis fallback rather than silently stalling.
    if not result.get('done') and not result.get('tool_calls'):
        debug('plan: empty wave response, falling through to synthesis')
        return {}

    return result
