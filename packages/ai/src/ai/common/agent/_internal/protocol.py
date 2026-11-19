"""
The reply side of the text protocol the LangChain-based agent drivers speak with the host LLM.

RocketRide's LLM seam returns text, while a LangChain agent expects a chat model
that returns structured tool calls. ``agent_langchain`` and ``agent_deepagent``
therefore ask the model, in a prompt each of them owns, for a tool call or a
final answer, and read the reply here. Three shapes are understood:

- a tool call, as one JSON object;
- the final answer, as ``FINAL>>>`` followed by plain text;
- the final answer as the JSON object ``{"type":"final","content":"..."}``.

Parsing a reply, recovering a `final` envelope whose escaping is broken, telling
the model what was wrong with a reply, retrying, and deciding what a turn ends on
when the retries run out all live here, so both drivers accept and refuse the
same things.

Nothing here imports LangChain. A parsed reply comes back as a ``ModelTurn``,
and each driver builds its own ``AIMessage`` from it.
"""

from __future__ import annotations

import json
import re
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Tuple

from ai.common.utils import safe_str

#: How a final answer is announced, in place of a JSON envelope.
#:
#: A tool call is structured data and JSON is the right shape for it. A final
#: answer is prose or a document of its own (tables, links, quoted names, JSON),
#: and a JSON string value needs every inner double quote and line break escaped
#: for the length of the whole answer. One miss and the envelope does not parse.
#:
#: After this marker every remaining character is the answer, verbatim, so there
#: is nothing to escape. ``agent_deepagent`` asks for it in its prompt. For
#: ``agent_langchain``, whose prompt asks for the JSON form, it is where a retry
#: sends an answer that did not parse.
FINAL_SENTINEL = 'FINAL>>>'

#: Model calls made for one turn before the turn is given up on.
MAX_ATTEMPTS = 3

#: The sentinel at the start of a line. See ``parse_tool_call_envelope`` for why it is anchored.
_SENTINEL_LINE = re.compile(rf'(?m)^[ \t]*{re.escape(FINAL_SENTINEL)}')

#: The opening of a `final` envelope, up to the first character of its content.
_FINAL_ENVELOPE_OPEN = re.compile(r'^\s*\{\s*"type"\s*:\s*"final"\s*,\s*"content"\s*:\s*"', re.S)

#: The end of a `final` envelope: the quote that closes the content, then the closing brace.
_FINAL_ENVELOPE_CLOSE = re.compile(r'"\s*\}\s*$')

#: The opening of a JSON envelope, optionally inside a markdown fence.
_ENVELOPE_OPEN = re.compile(r'^\s*(?:```[A-Za-z]*\s*)?\{')

#: The `"type"` the model was reaching for. Matched on the text, because it is
#: needed most when the envelope is too broken to parse.
_ATTEMPTED_TYPE = re.compile(r'"type"\s*:\s*"(tool_calls?|final)"')

_TOOL_CALL_SHAPE = '{"type":"tool_call","name":"server.tool","args":{...}}'


@dataclass(frozen=True)
class ModelTurn:
    """
    What the model decided on one turn: tool calls to run, or the final answer.

    Attributes:
        content: The final answer. Empty when the turn is a tool call.
        tool_calls: The calls to run, each ``{'id', 'type': 'tool_call', 'name', 'args'}``,
            which is the shape ``AIMessage(tool_calls=...)`` takes. Empty for an answer.
    """

    content: str = ''
    tool_calls: List[Dict[str, Any]] = field(default_factory=list)


# ────────────────────────────────────────────────────────────────────────────────
# WHAT THE MODEL SENT BACK
# ────────────────────────────────────────────────────────────────────────────────


def _without_fence(raw: str) -> str:
    """The reply with surrounding whitespace and one enclosing markdown fence removed."""
    s = raw.strip()
    if s.startswith('```'):
        s = s.split('\n', 1)[1] if '\n' in s else s[3:]
        if '```' in s:
            s = s.rsplit('```', 1)[0]
        s = s.strip()
    return s


def _attempted_kind(text: str) -> Optional[str]:
    """
    The envelope type a reply is, or was reaching for: ``tool_call``, ``tool_calls``, ``final`` or None.

    When the first object parses, its own ``"type"`` decides, so a ``"type"`` nested in a tool's
    arguments or quoted in an answer does not. When nothing parses, the text is searched, and a
    tool-call type anywhere in it wins over ``final``: a broken call must stay a call.
    """
    obj = extract_first_json_object(text)
    if isinstance(obj, dict):
        kind = obj.get('type')
        return kind if kind in ('tool_call', 'tool_calls', 'final') else None
    kinds = [match.group(1) for match in _ATTEMPTED_TYPE.finditer(text)]
    return next((kind for kind in kinds if kind != 'final'), kinds[0] if kinds else None)


def _attempted_tool_call(text: str) -> bool:
    """Whether the text is a tool-call envelope, or a broken attempt at one."""
    return _attempted_kind(text) in ('tool_call', 'tool_calls')


def extract_first_json_object(raw: Any) -> Any:
    """
    Extract the first balanced JSON object from a model reply.

    Handles the usual ways a host LLM gets the envelope almost right: prose
    around it, a markdown fence, or a second JSON object appended after the
    first one closes (a duplicate tool call, or a `final` stacked onto a
    `tool_call`). Only the first object is returned.

    Args:
        raw: The model's reply.

    Returns:
        The decoded JSON value, or None when nothing decodes. A reply that is
        valid JSON as a whole is returned as it is, so this can be a list or a
        scalar; a caller that needs an object checks for a dict.
    """
    if not isinstance(raw, str) or not raw:
        return None

    s = _without_fence(raw)

    # Fast path: valid JSON as it is.
    try:
        return json.loads(s)
    except Exception:
        pass

    # Walk from the first '{' to its matching '}', honouring string escapes.
    start = s.find('{')
    if start < 0:
        return None

    depth = 0
    in_str = False
    esc = False
    for i in range(start, len(s)):
        ch = s[i]
        if in_str:
            if esc:
                esc = False
            elif ch == '\\':
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == '{':
            depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0:
                candidate = s[start : i + 1]
                try:
                    return json.loads(candidate)
                except Exception:
                    return None
    return None


def unescape_json_string_body(body: str) -> str:
    """
    Undo JSON string escaping, tolerating the escapes that broke the envelope.

    ``json.loads`` is all or nothing: one unescaped quote and the whole answer is
    lost. This walks the body instead, translating the escapes it recognises and
    passing everything else through as itself, which is the right reading of the
    stray quote that made the envelope invalid.

    Args:
        body: The text between a JSON string's opening and closing quotes.

    Returns:
        The unescaped text.
    """
    simple = {'n': '\n', 't': '\t', 'r': '\r', 'b': '\b', 'f': '\f', '"': '"', '\\': '\\', '/': '/'}
    out: List[str] = []
    i, n = 0, len(body)
    while i < n:
        ch = body[i]
        if ch != '\\' or i + 1 >= n:
            out.append(ch)
            i += 1
            continue
        nxt = body[i + 1]
        if nxt in simple:
            out.append(simple[nxt])
            i += 2
        elif nxt == 'u' and i + 6 <= n:
            try:
                code = int(body[i + 2 : i + 6], 16)
            except ValueError:
                out.append(ch)
                i += 1
                continue
            # A surrogate pair is one character spelled as two escapes, and JSON
            # has no other way to write an astral character such as an emoji.
            # Decoded apart they are two lone surrogates, which `str.encode`
            # refuses, so the salvaged answer would raise on its way out.
            low_start = i + 6
            if 0xD800 <= code <= 0xDBFF and body[low_start : low_start + 2] == '\\u' and low_start + 6 <= n:
                try:
                    low = int(body[low_start + 2 : low_start + 6], 16)
                except ValueError:
                    low = -1
                if 0xDC00 <= low <= 0xDFFF:
                    out.append(chr(0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00)))
                    i = low_start + 6
                    continue
            out.append(chr(code))
            i += 6
        else:
            # Not an escape we know. A lone backslash is far likelier to be part
            # of the answer (a Windows path, a LaTeX fragment) than a mistake.
            out.append(ch)
            i += 1
    return ''.join(out)


def salvage_final_content(raw: Any) -> Optional[str]:
    """
    The answer out of a `final` envelope that does not parse as JSON.

    When a reply opens with the literal ``{"type":"final","content":"`` and
    closes with ``"}``, what lies between is the answer the person was meant to
    read, and the only thing in the way is an escape the model got wrong
    somewhere in the middle. Recovering it is better than failing the turn.

    Deliberately narrow, in two ways:

    - Only an explicit ``"type":"final"`` is salvaged. A malformed tool call is
      never rescued into an answer: that would turn work the agent meant to do
      into a sentence claiming it was done.
    - Only a reply that ends with the envelope's closing ``"}`` is salvaged.
      One that stops mid-content was cut off (an output limit, a dropped
      stream), and delivering it would pass a partial answer as a finished one.
      Because the content is unescaped, the end of the reply is the only place
      the closing can be told from a ``"}`` inside the answer. Two consequences:
      a broken envelope with more text after it is retried, not recovered, and
      an answer cut exactly after an inner ``"}`` still reads as closed.

    Args:
        raw: The model's unparsed reply.

    Returns:
        The recovered content, or None when this is not a closed `final` envelope.
    """
    if not isinstance(raw, str):
        return None
    opening = _FINAL_ENVELOPE_OPEN.match(raw)
    if not opening:
        return None
    body = raw[opening.end() :]
    closing = _FINAL_ENVELOPE_CLOSE.search(body)
    if not closing:
        return None
    return unescape_json_string_body(body[: closing.start()])


def looks_like_envelope(raw: Any) -> bool:
    """
    Whether an unparsed reply was an attempt at a JSON envelope.

    Separates the two things a retry loop can run out on: a JSON object that was
    never a valid tool call or answer (which must not reach the person), and
    prose from a model that skipped the sentinel (which is still an answer).

    Args:
        raw: The model's unparsed reply.

    Returns:
        True when the reply opens like a JSON object.
    """
    return isinstance(raw, str) and bool(_ENVELOPE_OPEN.match(raw))


def _after_sentinel(rest: str) -> str:
    """
    The answer, with only the sentinel's separator removed.

    Args:
        rest: Everything after the ``FINAL>>>`` marker.

    Returns:
        The answer as the model wrote it, minus one separator: a single newline
        (the answer starts on the next line) or a single space or tab on the same
        line. Any further whitespace is the answer's own: leading spaces open a
        code block, and a blank first line is a deliberate gap.
    """
    if rest.startswith('\r\n'):
        return rest[2:]
    if rest[:1] in ('\n', ' ', '\t'):
        return rest[1:]
    return rest


def _final_text(content: Any) -> str:
    """The text of a `final` envelope's content. Anything but a string is written back as JSON, not as a Python repr."""
    if content is None:
        return ''
    if isinstance(content, str):
        return content
    return json.dumps(content, ensure_ascii=False)


def _tool_call(entry: Any) -> Optional[Dict[str, Any]]:
    """One tool call from an envelope entry, or None when the entry names no tool."""
    if not isinstance(entry, dict):
        return None
    name = safe_str(entry.get('name', '')).strip()
    if not name:
        return None
    args = entry.get('args')
    if args is None:
        args = {}
    elif not isinstance(args, dict):
        # Whatever the model sent still reaches the tool, a false, 0 or empty value included.
        args = {'input': args}
    # The id is an opaque token LangGraph uses to pair the call with its result.
    return {'id': f'call_{uuid.uuid4().hex[:12]}', 'type': 'tool_call', 'name': name, 'args': args}


def parse_tool_call_envelope(raw: Any, *, parallel: bool = False) -> Optional[ModelTurn]:
    """
    Parse one model reply into a ``ModelTurn``.

    Three ways in, in the order they are trusted: the ``FINAL>>>`` sentinel,
    which cannot be malformed because there is nothing in it to escape; a JSON
    envelope; and last, a `final` envelope that does not parse but closes, whose
    content is recovered (``salvage_final_content``).

    The sentinel is matched at the start of a line only, and before any JSON is
    looked for. Before, because an answer may itself open with ``{``. Anchored,
    because protocol text travels (a delegation carrying instructions, a note
    quoting the format, a transcript replayed into a prompt), and an unanchored
    match would read a tool call that merely mentions ``FINAL>>>`` as a final
    answer and drop the call.

    One reply is not read sentinel first: a tool call with a ``FINAL>>>`` line
    after it. The model stacked an answer about the result onto the call that
    was to produce it, and taking the sentinel would drop the work and deliver
    the claim. The first object counts, as it does when a JSON `final` is
    stacked onto a call, and whether or not prose comes before the call.

    Args:
        raw: The model's reply.
        parallel: Accept the ``tool_calls`` form, which carries several calls in
            one turn. A driver whose prompt does not offer it does not run it either.

    Returns:
        The answer or the tool calls, or None when the reply is neither. None
        sends the model through the retry loop.
    """
    if not isinstance(raw, str):
        return None

    marker = _SENTINEL_LINE.search(raw)
    if marker and _attempted_tool_call(raw[: marker.start()]):
        marker = None
    if marker:
        # Delivered as written: only the separator comes off, never the answer's own whitespace.
        answer = _after_sentinel(raw[marker.end() :])
        # A sentinel with nothing after it is not an answer. Returning it would
        # end the turn on an empty success, so fall through to the retry instead.
        if answer.strip():
            return ModelTurn(content=answer)

    obj = extract_first_json_object(raw)
    if not isinstance(obj, dict):
        salvaged = salvage_final_content(raw)
        return ModelTurn(content=salvaged) if salvaged else None

    msg_type = obj.get('type')
    if msg_type == 'final':
        return ModelTurn(content=_final_text(obj.get('content', '')))

    if msg_type == 'tool_call':
        call = _tool_call(obj)
        return ModelTurn(tool_calls=[call]) if call else None

    if msg_type == 'tool_calls' and parallel:
        # One assistant message with several tool calls. LangGraph's async
        # ToolNode dispatches the list concurrently.
        entries = obj.get('calls')
        calls = [call for call in map(_tool_call, entries) if call] if isinstance(entries, list) else []
        return ModelTurn(tool_calls=calls) if calls else None

    # Any other object is refused, a bare JSON answer included: it may be a tool
    # call that lost its "type", and delivering it would drop the call.
    return None


def _diagnose(raw: Any, parallel: bool) -> Tuple[str, str]:
    """
    What was wrong with a reply, and what the model should send instead.

    Kept apart because they have different readers. The problem also goes into
    the error a failed turn raises, which a person or a parent agent's model
    reads. The remedy is an instruction to this model and must stay in its prompt.

    Args:
        raw: The reply that failed to parse.
        parallel: Whether the driver accepts the ``tool_calls`` form.

    Returns:
        ``(problem, remedy)``. The problem completes "Your last output ..." and
        "The last reply ...". The remedy may be empty.
    """
    text = safe_str(raw).strip()
    if not text:
        return 'was empty.', ''
    marker = _SENTINEL_LINE.search(text)
    if marker and not text[marker.end() :].strip():
        return f'ended at {FINAL_SENTINEL} with no answer after it.', f'Write the answer after {FINAL_SENTINEL}.'

    attempted = _attempted_kind(text)
    wanted_a_tool_call = attempted in ('tool_call', 'tool_calls')
    # Diagnose the JSON itself: without its fence, and from its opening brace when prose came first.
    candidate = _without_fence(text)
    if attempted and not candidate.startswith('{') and '{' in candidate:
        candidate = candidate[candidate.find('{') :]
    try:
        json.loads(candidate)
    except json.JSONDecodeError as err:
        pos = max(0, err.pos)
        excerpt = candidate[max(0, pos - 60) : pos + 20].replace('\n', ' ')
        problem = f'was not valid JSON: {err.msg}, at character {pos}. It broke here: ...{excerpt}...'
        if wanted_a_tool_call:
            return (
                problem,
                'Send the SAME tool call again as one valid JSON object: repair the JSON, do not answer in prose.',
            )
        return problem, f'Do not retype it as JSON: send the answer as {FINAL_SENTINEL} followed by plain text.'
    except Exception:  # noqa: BLE001 - any other parse failure gets the same advice
        return 'could not be parsed.', ''

    # Valid JSON that is neither shape: a bare JSON answer, an unknown "type", a
    # tool call with no name, or the parallel form sent to a driver without it.
    problem = 'parsed as JSON, but was not one of the allowed shapes.'
    if wanted_a_tool_call:
        if attempted == 'tool_calls' and not parallel:
            return problem, f'Send one tool call per reply, as {_TOOL_CALL_SHAPE}.'
        return problem, f'Send the tool call again as {_TOOL_CALL_SHAPE}.'
    return problem, (
        f'To call a tool, send {_TOOL_CALL_SHAPE}. '
        f'To give this JSON as your answer, write {FINAL_SENTINEL} followed by the JSON.'
    )


def parse_failure_hint(raw: Any, *, parallel: bool = False) -> str:
    """
    What to tell the model about the reply that just failed to parse.

    "Your last output was invalid" is true and useless: the model cannot see
    which character broke it, so it writes the same reply again. Naming the
    position and quoting the text around it gives the retry a chance.

    What to do next depends on what was attempted. A broken answer should come
    back as ``FINAL>>>`` plus the answer, where nothing can break again. A
    broken tool call must come back as a tool call: pointing the model at the
    sentinel instead would trade the work for a sentence about it.

    Args:
        raw: The reply that failed to parse.
        parallel: Whether the driver accepts the ``tool_calls`` form.

    Returns:
        A one-line diagnostic to append to the next prompt.
    """
    problem, remedy = _diagnose(raw, parallel)
    return f'Your last output {problem} {remedy}'.strip()


# ────────────────────────────────────────────────────────────────────────────────
# ONE MODEL TURN
# ────────────────────────────────────────────────────────────────────────────────


def run_model_turn(ask: Callable[[str], Any], *, parallel: bool = False) -> ModelTurn:
    """
    Ask the model for one turn, retrying a reply that is neither a tool call nor an answer.

    A turn ends in one of three ways, and a failed turn is never reported as an answer:

    - a reply parsed as a tool call or an answer: it is returned;
    - no reply parsed and the last one is prose with no sentinel: that prose is
      the answer, because the model said something readable;
    - no reply parsed and the last one is empty, a sentinel with nothing after
      it, a JSON object, or an attempt at an envelope anywhere in it: the turn
      raises, so the run ends as an error instead of delivering the envelope or
      a sentence about giving up. The error says what was wrong with the last
      reply and leaves out the instructions written for the model.

    Args:
        ask: Sends the turn's prompt with the given text appended, and returns the
            model's reply. The text is empty on the first attempt and grows by one
            ``parse_failure_hint`` line for each reply that did not parse.
        parallel: Whether the driver offered, and so accepts, the ``tool_calls`` form.

    Returns:
        The tool calls or the answer the turn ended on.

    Raises:
        ValueError: No attempt produced a tool call or a deliverable answer.
    """
    feedback = ''
    raw = ''
    for _ in range(MAX_ATTEMPTS):
        raw = safe_str(ask(feedback)).strip()
        turn = parse_tool_call_envelope(raw, parallel=parallel)
        if turn is not None:
            return turn
        feedback += '\n\nsystem: ' + parse_failure_hint(raw, parallel=parallel)

    # A sentinel still unparsed here has nothing after it. An envelope that never
    # parsed is a tool call that never ran or an answer that was cut off, and
    # neither is prose to deliver, wherever in the reply it sits.
    undeliverable = not raw or looks_like_envelope(raw) or _ATTEMPTED_TYPE.search(raw) or _SENTINEL_LINE.search(raw)
    if undeliverable:
        problem, _remedy = _diagnose(raw, parallel)
        raise ValueError(f'No valid tool call or final answer after {MAX_ATTEMPTS} attempts. The last reply {problem}')
    return ModelTurn(content=raw)
