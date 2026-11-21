# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""LangChain driver implementing the shared `ai.common.agent.AgentBase` interface."""

from __future__ import annotations

import json
import re
import uuid
from typing import Any, Callable, Dict, List, Optional, Tuple

from rocketlib import ToolDescriptor

from ai.common.agent import AgentBase, AgentContext
from ai.common.agent.types import AgentRunResult
from ai.common.schema import Question

from ai.common.utils import langchain_messages_to_transcript, normalize_bound_tools
from ai.common.utils import safe_str


# ────────────────────────────────────────────────────────────────────────────────
# FRAMEWORK WRAPPER BUILDERS — DRIVER-PRIVATE MODULE HELPERS
# ────────────────────────────────────────────────────────────────────────────────


def _build_langchain_llm(agent_base: AgentBase, context: AgentContext) -> Any:
    """Build a LangChain BaseChatModel that delegates to AgentBase.call_llm.

    LangChain agents expect a chat model that returns structured `tool_calls`,
    but RocketRide's LLM seam is text-only.  We prompt the model to emit a
    strict JSON envelope describing either a tool call or a final answer,
    then parse it into an `AIMessage` with `tool_calls`.
    """
    from langchain_core.language_models import BaseChatModel
    from langchain_core.outputs import ChatGeneration, ChatResult

    class RocketRideToolCallingChatModel(BaseChatModel):
        def __init__(self):
            super().__init__()
            self._bound_tools: List[Dict[str, Any]] = []

        @property
        def _llm_type(self) -> str:
            return 'rocketride-host-llm'

        @property
        def _identifying_params(self) -> Dict[str, Any]:
            return {'framework': 'rocketride', 'adapter': 'tool_calling_json'}

        def bind_tools(self, tools: object, **_kwargs: Any) -> 'RocketRideToolCallingChatModel':
            try:
                self._bound_tools = normalize_bound_tools(tools)
            except Exception:
                self._bound_tools = []
            return self

        def _generate(self, messages: Any, stop: Any = None, run_manager: Any = None, **kwargs: Any) -> Any:
            transcript = langchain_messages_to_transcript(messages)
            tool_hint = _tool_call_protocol_prompt(self._bound_tools)
            prompt = (tool_hint + '\n\n' + transcript).strip()

            def ask(feedback: str) -> Any:
                return agent_base.call_llm(
                    context,
                    prompt + feedback,
                    role='You are a helpful assistant.',
                    stop_words=stop,
                )

            # Raises when no attempt gives a tool call or an answer. That fails the
            # run, so it ends as an error and not as an answer about giving up.
            return ChatResult(generations=[ChatGeneration(message=_run_model_turn(ask))])

    return RocketRideToolCallingChatModel()


def _with_schema_text(desc: str, input_schema: Any) -> str:
    """Return the description with the input schema pasted after it, or unchanged when there is no schema to paste."""
    if not isinstance(input_schema, dict):
        return desc
    try:
        schema_text = json.dumps(input_schema, ensure_ascii=False)
    except Exception:
        return desc
    return f'{desc}\n\nTool input schema (JSON): {schema_text}'


def _build_langchain_tools(
    agent_base: AgentBase,
    context: AgentContext,
    tool_descriptors: List[ToolDescriptor],
) -> List[Any]:
    """Convert host tool descriptors into LangChain BaseTool instances.

    The inner ``HostTool`` subclass captures `agent_base` and `context` via
    closure on the enclosing function so its `_run` method can call
    `agent_base.call_tool(context, ...)`.
    """
    from langchain_core.tools import BaseTool
    from pydantic import BaseModel, ConfigDict, Field, create_model

    class _ToolInput(BaseModel):
        """
        Accept arbitrary tool args through a stable `input` field.

        LangChain tool execution paths vary across versions; this schema keeps
        invocation robust when arguments are passed either via `input=...` or
        as extra keyword args.
        """

        input: Any = Field(default=None, description='Tool input payload')
        model_config = ConfigDict(extra='allow')

    def _make_args_schema(input_schema: Optional[Dict[str, Any]]) -> type[BaseModel]:
        """
        Build a Pydantic model from a JSON Schema object.

        LangChain tool execution can filter kwargs based on `args_schema`. Using
        the real tool schema helps preserve tool parameters end-to-end.
        """
        if not isinstance(input_schema, dict):
            return _ToolInput
        props = input_schema.get('properties', {})
        if not isinstance(props, dict) or not props:
            return _ToolInput
        required_keys = set(input_schema.get('required', []) or [])

        field_defs: Dict[str, Any] = {}
        for key, prop in props.items():
            if not isinstance(key, str) or not key:
                continue
            if not isinstance(prop, dict):
                prop = {}
            desc = prop.get('description', '')
            if key in required_keys:
                field_defs[key] = (Any, Field(..., description=desc))
            else:
                default = prop.get('default', None)
                field_defs[key] = (Any, Field(default=default, description=desc))

        if not field_defs:
            return _ToolInput

        try:
            return create_model(
                '_DynToolInput',
                __config__=ConfigDict(extra='ignore'),
                **field_defs,
            )
        except Exception:
            return _ToolInput

    class HostTool(BaseTool):  # type: ignore[misc]
        name: str
        description: str
        args_schema: type[BaseModel] = _ToolInput

        def _run(self, **framework_args: Any) -> str:  # noqa: ANN401
            tool_name = safe_str(getattr(self, 'name', ''))

            try:
                out = agent_base.call_tool(context, tool_name, framework_args)
            except Exception as e:
                out = {'error': str(e), 'type': type(e).__name__}

            try:
                return json.dumps(out, default=str) if isinstance(out, (dict, list)) else safe_str(out)
            except Exception:
                return safe_str(out)

    tools: List[Any] = []
    for td in tool_descriptors:
        if not hasattr(td, 'get'):
            continue
        name = td.get('name')
        if not isinstance(name, str) or not name.strip():
            continue
        desc = td.get('description') if isinstance(td.get('description'), str) else f'Invoke host tool: {name}'
        input_schema = td.get('inputSchema')
        schema_cls = _make_args_schema(input_schema if isinstance(input_schema, dict) else None)
        tool = HostTool(name=name, description=desc, args_schema=schema_cls)
        try:
            setattr(tool, '_rr_input_schema', input_schema)
        except Exception:
            # The protocol prompt shows the original schema from _rr_input_schema (normalize_bound_tools). Without it
            # the model would see only the generated one, which types every field Any, so paste the original instead.
            tool = HostTool(name=name, description=_with_schema_text(desc, input_schema), args_schema=schema_cls)
        tools.append(tool)
    return tools


# ────────────────────────────────────────────────────────────────────────────────
# LANGCHAIN DRIVER
# ────────────────────────────────────────────────────────────────────────────────


class LangChainDriver(AgentBase):
    FRAMEWORK = 'langchain'

    def __init__(self, iGlobal: Any) -> None:
        """Initialize the LangChain driver."""
        super().__init__(iGlobal)

    def _run(self, *, context: AgentContext, question: Question) -> AgentRunResult:
        # Bound SSE forwarder -- captures context so the LangChain callback handler
        # always routes events to the correct invoker, even if the framework
        # invokes the callback from a worker thread.
        def _send_sse(type: str, **data: Any) -> None:
            self.sendSSE(context, type, **data)

        from langchain.agents import create_agent
        from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
        from langchain_core.callbacks import BaseCallbackHandler

        class _SSECallbackHandler(BaseCallbackHandler):
            def __init__(self, send_sse: Callable[..., Any]) -> None:
                super().__init__()
                self._send_sse = send_sse

            def on_tool_start(self, serialized: Any, input_str: Any, **kwargs: Any) -> None:
                tool_name = (serialized or {}).get('name', '') or 'tool'
                self._send_sse('thinking', message=f'Calling {tool_name}...', tool=tool_name, input=input_str)

            def on_tool_end(self, output: Any, **kwargs: Any) -> None:
                self._send_sse('thinking', message='Tool complete')

            def on_tool_error(self, error: Any, **kwargs: Any) -> None:
                self._send_sse('thinking', message=f'Tool error: {safe_str(error)}')

            def on_agent_action(self, action: Any, **kwargs: Any) -> None:
                self._send_sse('thinking', message='Agent thinking...')

            def on_agent_finish(self, finish: Any, **kwargs: Any) -> None:
                self._send_sse('thinking', message='Agent done')

            def on_llm_start(self, serialized: Any, prompts: Any, **kwargs: Any) -> None:
                self._send_sse('thinking', message='LLM call started')

            def on_chat_model_start(self, serialized: Any, messages: Any, **kwargs: Any) -> None:
                self._send_sse('thinking', message='LLM call started')

            def on_llm_end(self, response: Any, **kwargs: Any) -> None:
                self._send_sse('thinking', message='LLM call completed')

            def on_llm_error(self, error: Any, **kwargs: Any) -> None:
                self._send_sse('thinking', message=f'LLM error: {safe_str(error)}')

        tool_descriptors = context.tools.list
        llm = _build_langchain_llm(self, context)
        tools_for_agent = _build_langchain_tools(self, context, tool_descriptors)

        system_parts = [
            'You are an agent node in a tool-invocation hierarchy.',
            'Use the provided tools when needed.',
        ]
        system_message = SystemMessage(content='\n'.join(system_parts).strip())

        _send_sse('thinking', message='Starting LangChain agent...')
        stage = 'create_agent'
        try:
            agent = create_agent(model=llm, tools=tools_for_agent, system_prompt=system_message, debug=False)
            stage = 'invoke'
            state = agent.invoke(
                {'messages': [HumanMessage(content=safe_str(question.getPrompt() or ''))]},
                config={'callbacks': [_SSECallbackHandler(_send_sse)]},
            )
        except Exception as e:
            raise RuntimeError('LangChain agent {} failed: {}: {}'.format(stage, type(e).__name__, safe_str(e))) from e

        final_text = ''
        try:
            msgs = state.get('messages') if isinstance(state, dict) else None
            if isinstance(msgs, list) and msgs:
                last = msgs[-1]
                if isinstance(last, AIMessage):
                    final_text = safe_str(getattr(last, 'content', ''))
                else:
                    final_text = safe_str(getattr(last, 'content', last))
            else:
                final_text = safe_str(state)
        except Exception:
            final_text = safe_str(state)

        return safe_str(final_text), state


# ────────────────────────────────────────────────────────────────────────────────
# DRIVER-PRIVATE HELPERS
#
# Problem: LangChain agents expect a chat model that returns structured `tool_calls`,
# but RocketRide's LLM seam is text-only.  Solution: we prompt the model to emit a
# strict JSON envelope describing either a tool call or a final answer, then parse
# it into an `AIMessage` with `tool_calls`.
# ────────────────────────────────────────────────────────────────────────────────


def _prompt_tools(bound_tools: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """One entry per tool with one schema: the original input schema when the tool carries it, else the generated one."""
    out = []
    for t in bound_tools:
        schema = t.get('input_schema') if isinstance(t.get('input_schema'), dict) else t.get('args_schema')
        out.append({'name': t.get('name', ''), 'description': t.get('description', ''), 'args_schema': schema})
    return out


def _tool_call_protocol_prompt(bound_tools: List[Dict[str, Any]]) -> str:
    tools_json = json.dumps(_prompt_tools(bound_tools), ensure_ascii=False)
    return '\n'.join(
        [
            'system: You MUST respond with exactly one JSON object and nothing else.',
            'system: Allowed schemas:',
            'system: Tool call:',
            'system: {"type":"tool_call","name":"server.tool","args":{...}}',
            'system: Final answer:',
            'system: {"type":"final","content":"..."}',
            'system: Never wrap JSON in markdown. Never include extra keys unless required.',
            f'system: Available tools (name + description + args schema): {tools_json}',
        ]
    ).strip()


# ────────────────────────────────────────────────────────────────────────────────
# READING THE MODEL'S REPLY
#
# Three shapes are understood: a tool call as one JSON object, the final answer as
# the JSON object the prompt asks for, and the final answer as `FINAL>>>` followed
# by plain text.  The prompt does not mention the last one.  A retry hint does, as
# the way out for an answer that did not parse.
#
# A reply is parsed, a `final` envelope whose escaping is broken is recovered, a
# reply that is neither a tool call nor an answer is retried with a hint that says
# what was wrong, and a turn that still has nothing to deliver fails the run.
#
# This follows the reply handling in `agent_deepagent/deepagent.py` and is this
# node's own code: the two nodes are kept apart, so a change here does not change
# that one.
# ────────────────────────────────────────────────────────────────────────────────

#: How a final answer is announced, in place of a JSON envelope.
#:
#: A tool call is structured data and JSON is the right shape for it. A final
#: answer is prose or a document of its own (tables, links, quoted names, JSON),
#: and a JSON string value needs every inner double quote and line break escaped
#: for the length of the whole answer. One miss and the envelope does not parse.
#:
#: After this marker every remaining character is the answer, verbatim, so there
#: is nothing to escape. The prompt asks for the JSON form, so this is where a
#: retry sends an answer that did not parse.
_FINAL_SENTINEL = 'FINAL>>>'

#: Model calls made for one turn before the turn is given up on.
_MAX_ATTEMPTS = 3

#: The sentinel at the start of a line. See ``_parse_tool_call_envelope`` for why it is anchored.
_SENTINEL_LINE = re.compile(rf'(?m)^[ \t]*{re.escape(_FINAL_SENTINEL)}')

#: The opening of a `final` envelope, up to the first character of its content. A markdown fence may open first.
_FINAL_ENVELOPE_OPEN = re.compile(r'^\s*(?:```[A-Za-z]*\s*)?\{\s*"type"\s*:\s*"final"\s*,\s*"content"\s*:\s*"', re.S)

#: The end of a `final` envelope: the quote that closes the content, then the closing brace, then the fence if there was one.
_FINAL_ENVELOPE_CLOSE = re.compile(r'"\s*\}\s*(?:```\s*)?$')

#: A closing followed straight away by the opening of another object. When that object is an
#: envelope, the reply is two envelopes and not one (``_is_stacked``).
_STACKED_OBJECT = re.compile(r'"\s*\}\s*(?:```\s*)?\{')

#: A markdown fence that encloses all of a text. Group 1 is what is inside it.
_ENCLOSING_FENCE = re.compile(r'```[A-Za-z]*[ \t]*\n(.*)```', re.S)

#: The same quote and brace anywhere in a reply: where an envelope whose content is unescaped may have closed.
_FINAL_ENVELOPE_CLOSING = re.compile(r'"\s*\}')

#: The opening of a JSON envelope, optionally inside a markdown fence.
_ENVELOPE_OPEN = re.compile(r'^\s*(?:```[A-Za-z]*\s*)?\{')

#: The `"type"` the model was reaching for. Matched on the text, because it is
#: needed most when the envelope is too broken to parse.
_ATTEMPTED_TYPE = re.compile(r'"type"\s*:\s*"(tool_calls?|final)"')

#: The digits of a ``\uXXXX`` escape. ``int(x, 16)`` alone also takes a sign, a space and an underscore.
_HEX4 = re.compile(r'[0-9A-Fa-f]{4}')

#: What follows a ``"type"`` key when its value is a plain string. Group 1 is the value.
_TYPE_VALUE = re.compile(r'\s*:\s*"([^"\\]*)"')

_ENVELOPE_KINDS = ('tool_call', 'tool_calls', 'final')

_TOOL_CALL_SHAPE = '{"type":"tool_call","name":"server.tool","args":{...}}'


def _message(content: str = '', tool_calls: Optional[List[Dict[str, Any]]] = None) -> Any:
    """The ``AIMessage`` LangChain is given for a turn: the final answer, or the tool calls to run."""
    from langchain_core.messages import AIMessage

    return AIMessage(content=content, tool_calls=tool_calls or [])


def _without_fence(raw: str) -> str:
    """The reply with surrounding whitespace and one enclosing markdown fence removed."""
    s = raw.strip()
    if s.startswith('```'):
        s = s.split('\n', 1)[1] if '\n' in s else s[3:]
        if '```' in s:
            s = s.rsplit('```', 1)[0]
        s = s.strip()
    return s


def _own_type(text: str) -> Optional[str]:
    """
    The ``"type"`` an unparsed JSON object carries itself, and not one nested in a member's value.

    Walks the first object in `text` as far as it goes and reads the first ``"type"`` member at its
    top level, whatever comes before it and whatever its other members hold. Returns None when the
    object ends or the text runs out before one is found. Escaping that is broken can put the walk
    out of step with the object, which is why ``_attempted_kind`` falls back to searching the text.
    """
    at = text.find('{')
    depth = 0
    while 0 <= at < len(text):
        ch = text[at]
        if ch == '"':
            end = at + 1
            while end < len(text) and (text[end] != '"' or _is_escaped(text, end)):
                end += 1
            if end >= len(text):
                return None
            if depth == 1 and text[at + 1 : end] == 'type':
                value = _TYPE_VALUE.match(text, end + 1)
                if value:
                    return value.group(1)
            at = end + 1
            continue
        if ch in '{[':
            depth += 1
        elif ch in '}]':
            depth -= 1
            if depth <= 0:
                return None
        at += 1
    return None


def _attempted_kind(text: str) -> Optional[str]:
    """
    The envelope type a reply is, or was reaching for: ``tool_call``, ``tool_calls``, ``final`` or None.

    The envelope's own ``"type"`` decides, so one nested in a tool's arguments or in an answer's
    content does not: the parsed object's when the first object parses, and the one at its top
    level when it does not (``_own_type``). Only when neither is there to read is the text
    searched, and then a tool-call type anywhere in it wins over ``final``: a broken call must
    stay a call.
    """
    obj = _extract_first_json_object(text)
    if isinstance(obj, dict):
        kind = obj.get('type')
        return kind if kind in _ENVELOPE_KINDS else None
    own = _own_type(text)
    if own is not None:
        return own if own in _ENVELOPE_KINDS else None
    kinds = [match.group(1) for match in _ATTEMPTED_TYPE.finditer(text)]
    return next((kind for kind in kinds if kind != 'final'), kinds[0] if kinds else None)


def _attempted_tool_call(text: str) -> bool:
    """Whether the text is a tool-call envelope, a broken attempt at one, or one that lost its ``"type"``."""
    return _attempted_kind(text) in ('tool_call', 'tool_calls') or _tool_call_without_type(text)


def _tool_call_without_type(text: str) -> bool:
    """Whether the first JSON object in the text has a tool call's members, a name and its arguments, and no ``"type"``."""
    obj = _extract_first_json_object(text)
    return isinstance(obj, dict) and 'type' not in obj and isinstance(obj.get('name'), str) and 'args' in obj


def _extract_first_json_object(raw: Any) -> Any:
    """
    The first JSON object in a model reply.

    Read from the first ``{`` of the reply as it was sent, which is how this node
    has always found its envelope. That takes in its stride the usual ways a host
    LLM gets the envelope almost right: prose around it, a markdown fence of any
    shape, the object wrapped in an array, or a second JSON object appended after
    the first one closes (a duplicate tool call, or a `final` stacked onto a
    `tool_call`). Only the first object is returned.

    Args:
        raw: The model's reply.

    Returns:
        The decoded object, or None when the reply has no ``{`` or what starts
        there is not valid JSON.
    """
    if not isinstance(raw, str):
        return None
    start = raw.find('{')
    if start < 0:
        return None
    try:
        obj, _end = json.JSONDecoder().raw_decode(raw, start)
    except Exception:
        return None
    return obj


def _escape_code(body: str, at: int) -> Optional[int]:
    """The code unit of a ``\\uXXXX`` escape whose digits start at `at`, or None when they are not four hex digits."""
    digits = body[at : at + 4]
    return int(digits, 16) if _HEX4.fullmatch(digits) else None


def _unescape_json_string_body(body: str) -> str:
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
        elif nxt == 'u' and (code := _escape_code(body, i + 2)) is not None:
            # A surrogate pair is one character spelled as two escapes, and JSON
            # has no other way to write an astral character such as an emoji.
            # Decoded apart they are two lone surrogates, which `str.encode`
            # refuses, so the salvaged answer would raise on its way out.
            low_start = i + 6
            low = _escape_code(body, low_start + 2) if body[low_start : low_start + 2] == '\\u' else None
            if 0xD800 <= code <= 0xDBFF and low is not None and 0xDC00 <= low <= 0xDFFF:
                out.append(chr(0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00)))
                i = low_start + 6
                continue
            out.append(chr(code))
            i += 6
        else:
            # Not an escape we know, a `\u` without four hex digits included. A
            # lone backslash is far likelier to be part of the answer (a Windows
            # path, a LaTeX fragment) than a mistake.
            out.append(ch)
            i += 1
    return ''.join(out)


def _is_escaped(text: str, at: int) -> bool:
    """Whether the character at `at` has an odd number of backslashes before it, which makes a quote an escaped one."""
    first = at
    while first > 0 and text[first - 1] == '\\':
        first -= 1
    return (at - first) % 2 == 1


def _is_stacked(body: str) -> bool:
    """
    Whether the text after an envelope's opening holds a closing and then another envelope.

    The object right after the closing decides, by its own type and in either member order. An
    envelope quoted further on in the answer does not make an ordinary object before it one.
    """
    return any(_attempted_kind(body[stacked.end() - 1 :]) is not None for stacked in _STACKED_OBJECT.finditer(body))


def _salvage_final_content(raw: Any) -> Optional[str]:
    """
    The answer out of a `final` envelope that does not parse as JSON.

    When a reply opens with the literal ``{"type":"final","content":"`` and
    closes with ``"}``, what lies between is the answer the person was meant to
    read, and the only thing in the way is an escape the model got wrong
    somewhere in the middle. Recovering it is better than failing the turn. A
    markdown fence around the envelope does not change that.

    Deliberately narrow, in two ways:

    - Only an explicit ``"type":"final"`` is salvaged. A malformed tool call is
      never rescued into an answer: that would turn work the agent meant to do
      into a sentence claiming it was done.
    - Only a reply that ends with the envelope's closing ``"}`` is salvaged.
      One that stops mid-content was cut off (an output limit, a dropped
      stream), and delivering it would pass a partial answer as a finished one.
      Because the content is unescaped, the end of the reply is the only place
      the closing can be told from a ``"}`` inside the answer. Three consequences:
      a broken envelope with more text after it is retried, not recovered; an
      answer cut exactly after an inner ``"}`` still reads as closed, unless that
      quote is escaped, which the closing quote never is; and a member written
      after ``content`` is taken for part of the answer. A second envelope
      stacked after a broken one is not: that reply is retried.

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
    content = body[: closing.start()]
    # A quote with an odd number of backslashes before it is an escaped quote in
    # the answer, not the one that closes it: the reply was cut off right there.
    if _is_escaped(body, closing.start()):
        return None
    # A JSON document pasted into the envelope as it is, with nothing escaped for
    # the envelope: its backslashes are the document's own, and undoing them would
    # turn a quoted word in one of its values into a syntax error.
    try:
        if isinstance(json.loads(content), (dict, list)):
            return content
    except Exception:
        pass
    # A second envelope stacked after this one would otherwise be taken for the
    # end of its content, and the person shown both.
    if _is_stacked(body):
        return None
    return _unescape_json_string_body(content)


def _looks_like_envelope(raw: Any) -> bool:
    """
    Whether an unparsed reply was an attempt at a JSON envelope.

    Separates the two things a retry loop can run out on: a JSON object that was
    never a valid tool call or answer (which must not reach the person), and
    prose from a model that skipped the envelope (which is still an answer).

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


def _sentinel_answer(text: str) -> Optional[str]:
    """
    What is delivered for the text after the sentinel, or None when that text is not an answer.

    Nearly always the text itself, as written. The exception is a model that follows a retry hint
    to ``FINAL>>>`` and still writes the `final` envelope there. Delivered as written, the person
    would be shown the protocol, so text that is a `final` envelope is read as one:

    - all of it is the envelope, valid or with broken escaping, in a fence or not: its content is
      the answer;
    - it is an attempt at the envelope that does not parse and does not close (cut off, whatever
      its content was going to be, or broken with more text after it): it is retried, like the
      same reply without the marker;
    - a valid envelope with more text after it is an answer that quotes one. It is delivered as
      written, and so is every other text, a fenced code block and a JSON object included.

    Args:
        text: Everything after the marker, minus its separator.

    Returns:
        The answer, or None when the text is an envelope that never closed.
    """
    whole = text.strip()
    fenced = _ENCLOSING_FENCE.fullmatch(whole)
    try:
        obj = json.loads(fenced.group(1) if fenced else whole)
    except Exception:
        obj = None
    if isinstance(obj, dict) and obj.get('type') == 'final':
        return _final_text(obj.get('content', ''))
    if not (_looks_like_envelope(text) and _attempted_kind(text) == 'final'):
        return text
    if isinstance(_extract_first_json_object(text), dict):
        return text
    return _salvage_final_content(whole)


def _final_text(content: Any) -> str:
    """The text of a `final` envelope's content. Anything but a string is written back as JSON, not as a Python repr."""
    if content is None:
        return ''
    if isinstance(content, str):
        return content
    return json.dumps(content, ensure_ascii=False)


def _tool_call(entry: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """The tool call a `tool_call` envelope asks for, or None when it names no tool."""
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


def _envelope_before(raw: str, at: int) -> str:
    """
    How a `final` envelope stands at position `at`, where a ``FINAL>>>`` line starts.

    - ``'open'``: `at` lies in the content of an envelope that has not closed. The line is the
      answer's own text: the content has literal line breaks and one of its lines starts with the
      marker. The reply is then read as the envelope it opened as. One that closes at the end of
      the reply gives its content, and one that never closes was cut off and is retried.
    - ``'closed'``: an envelope ended before `at`, or there is none. The marker is the sentinel.
    - ``'unclear'``: a broken envelope that may or may not have ended before `at`. Unescaped
      content can only be closed by a quote and a brace, and here one is followed by more text, so
      it is either the envelope's own closing with prose after it, or part of an answer that is
      still going. Neither reading can be trusted, and the reply is retried.

    The envelope is looked for from the first ``{`` before `at`, as the parser looks for it, so a
    line of prose before it changes nothing. An escaped quote is the answer's own and closes
    nothing. An envelope whose content is not a string, or whose members come in another order,
    has no closing to look for: an attempt at one that has not parsed by `at` is taken as open.
    """
    start = raw.find('{', 0, at)
    if start < 0:
        return 'closed'
    before = raw[start:at]
    if isinstance(_extract_first_json_object(before), dict):
        return 'closed'
    opening = _FINAL_ENVELOPE_OPEN.match(before)
    if opening:
        closings = _FINAL_ENVELOPE_CLOSING.finditer(before, opening.end())
        if not any(not _is_escaped(before, closing.start()) for closing in closings):
            return 'open'
        # Closed for certain only when all of the text before the marker is one envelope.
        return 'closed' if _salvage_final_content(before) is not None else 'unclear'
    return 'open' if _looks_like_envelope(before) and _attempted_kind(before) == 'final' else 'closed'


def _reads_sentinel(text: str, marker: Any) -> bool:
    """
    Whether the parser reads the ``FINAL>>>`` line `marker` matched as the sentinel.

    It does not after a tool call, a broken one and one that lost its ``"type"`` included: the line
    is a claim about work that has not run. Nor inside an envelope that is still open, where the
    line is the answer's own text.
    """
    if _attempted_tool_call(text[: marker.start()]):
        return False
    return _envelope_before(text, marker.start()) == 'closed'


def _parse_tool_call_envelope(raw: Any) -> Any:
    """
    Parse one model reply into the ``AIMessage`` for the turn.

    Three ways in, in the order they are trusted: the ``FINAL>>>`` sentinel,
    which cannot be malformed because there is nothing in it to escape; a JSON
    envelope; and last, a `final` envelope that does not parse but closes, whose
    content is recovered (``_salvage_final_content``).

    The sentinel is matched at the start of a line only, and before any JSON is
    looked for. Before, because an answer may itself open with ``{``. Anchored,
    because protocol text travels (a note quoting the format, a transcript
    replayed into a prompt), and an unanchored match would read a tool call that
    merely mentions ``FINAL>>>`` as a final answer and drop the call.

    One reply is not read sentinel first: a tool call with a ``FINAL>>>`` line
    after it. The model stacked an answer about the result onto the call that
    was to produce it, and taking the sentinel would drop the work and deliver
    the claim. The first object counts, as it does when a JSON `final` is
    stacked onto a call, and whether or not prose comes before the call. A call
    that lost its ``"type"`` does not run, and its claim is not delivered either.

    Nor is a ``FINAL>>>`` line inside the content of a `final` envelope that is
    still open there: it is the answer's own text. When a broken envelope may or
    may not have closed before the line, the reply is retried (``_envelope_before``).

    The ``tool_calls`` form, several calls in one reply, is refused: the prompt
    does not offer it, and the node does not start running calls concurrently
    because a model sent it.

    Args:
        raw: The model's reply.

    Returns:
        An ``AIMessage`` carrying the answer or the tool call, or None when the
        reply is neither. None sends the model through the retry loop.
    """
    if not isinstance(raw, str):
        return None

    marker = _SENTINEL_LINE.search(raw)
    if (
        marker
        and not _attempted_tool_call(raw[: marker.start()])
        and _envelope_before(raw, marker.start()) == 'unclear'
    ):
        return None
    if marker and _reads_sentinel(raw, marker):
        # Delivered as written: only the separator comes off, never the answer's own whitespace.
        answer = _after_sentinel(raw[marker.end() :])
        # A sentinel with nothing after it is not an answer. Returning it would
        # end the turn on an empty success, so fall through to the retry instead.
        if answer.strip():
            delivered = _sentinel_answer(answer)
            return None if delivered is None else _message(content=delivered)

    obj = _extract_first_json_object(raw)
    if not isinstance(obj, dict):
        salvaged = _salvage_final_content(raw)
        return _message(content=salvaged) if salvaged else None

    msg_type = obj.get('type')
    if msg_type == 'final':
        return _message(content=_final_text(obj.get('content', '')))

    if msg_type == 'tool_call':
        call = _tool_call(obj)
        return _message(tool_calls=[call]) if call else None

    # Any other object is refused, a bare JSON answer included: it may be a tool
    # call that lost its "type", and delivering it would drop the call.
    return None


def _diagnose(raw: Any) -> Tuple[str, str, str]:
    """
    What was wrong with a reply, and what the model should send instead.

    Kept apart because they have different readers. The problem also goes into
    the error a failed turn raises, which a person or a parent agent's model
    reads. The remedy is an instruction to this model and must stay in its prompt.

    Args:
        raw: The reply that failed to parse.

    Returns:
        ``(problem, excerpt, remedy)``. The problem completes "Your last output ..."
        and "The last reply ...". The excerpt quotes the reply around the break and
        goes to the model only: an error is logged and returned to the caller, and
        must not carry text of the reply. Excerpt and remedy may be empty.
    """
    text = safe_str(raw).strip()
    if not text:
        return 'was empty.', '', ''
    marker = _SENTINEL_LINE.search(text)
    # A marker the parser does not read as the sentinel (stacked onto a tool call, or a line of an
    # answer that was cut off) is not what went wrong either.
    if marker and _reads_sentinel(text, marker) and not text[marker.end() :].strip():
        return f'ended at {_FINAL_SENTINEL} with no answer after it.', '', f'Write the answer after {_FINAL_SENTINEL}.'

    attempted = _attempted_kind(text)
    wanted_a_tool_call = _attempted_tool_call(text)
    # Diagnose the JSON itself: without its fence, and from its opening brace when prose came first.
    candidate = _without_fence(text)
    if (attempted or wanted_a_tool_call) and not candidate.startswith('{') and '{' in candidate:
        candidate = candidate[candidate.find('{') :]
    try:
        json.loads(candidate)
    except json.JSONDecodeError as err:
        pos = max(0, err.pos)
        excerpt = candidate[max(0, pos - 60) : pos + 20].replace('\n', ' ')
        problem = f'was not valid JSON: {err.msg}, at character {pos}.'
        shown = f' It broke here: ...{excerpt}...'
        if wanted_a_tool_call:
            return (
                problem,
                shown,
                'Send the SAME tool call again as one valid JSON object: repair the JSON, do not answer in prose.',
            )
        return problem, shown, f'Do not retype it as JSON: send the answer as {_FINAL_SENTINEL} followed by plain text.'
    except Exception:  # noqa: BLE001 - any other parse failure gets the same advice
        return 'could not be parsed.', '', ''

    # Valid JSON that is neither shape: a bare JSON answer, an unknown "type", a
    # tool call with no name, or several calls in one reply.
    problem = 'parsed as JSON, but was not one of the allowed shapes.'
    if attempted == 'tool_calls':
        return problem, '', f'Send one tool call per reply, as {_TOOL_CALL_SHAPE}.'
    if wanted_a_tool_call:
        return problem, '', f'Send the tool call again as {_TOOL_CALL_SHAPE}.'
    return (
        problem,
        '',
        f'To call a tool, send {_TOOL_CALL_SHAPE}. '
        f'To give this JSON as your answer, write {_FINAL_SENTINEL} followed by the JSON.',
    )


def _parse_failure_hint(raw: Any) -> str:
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

    Returns:
        A one-line diagnostic to append to the next prompt.
    """
    problem, excerpt, remedy = _diagnose(raw)
    return f'Your last output {problem}{excerpt} {remedy}'.strip()


def _run_model_turn(ask: Callable[[str], Any]) -> Any:
    """
    Ask the model for one turn, retrying a reply that is neither a tool call nor an answer.

    A turn ends in one of three ways, and a failed turn is never reported as an answer:

    - a reply parsed as a tool call or an answer: it is returned;
    - no reply parsed and the last one is prose with no sentinel: that prose is
      the answer, because the model said something readable;
    - no reply parsed and the last one is empty, a sentinel with nothing after
      it, a JSON object, an attempt at an envelope anywhere in it, or a tool
      call that lost its ``"type"`` after a line of prose: the turn raises, so
      the run ends as an error instead of delivering the envelope or a sentence
      about giving up. The error says what was wrong with the last reply. It
      leaves out the instructions written for the model and quotes nothing of
      the reply.

    Args:
        ask: Sends the turn's prompt with the given text appended, and returns the
            model's reply. The text is empty on the first attempt and grows by one
            ``_parse_failure_hint`` line for each reply that did not parse.

    Returns:
        The ``AIMessage`` for the tool call or the answer the turn ended on.

    Raises:
        ValueError: No attempt produced a tool call or a deliverable answer.
    """
    feedback = ''
    raw = ''
    for _ in range(_MAX_ATTEMPTS):
        raw = safe_str(ask(feedback)).strip()
        message = _parse_tool_call_envelope(raw)
        if message is not None:
            return message
        feedback += '\n\nsystem: ' + _parse_failure_hint(raw)

    # A sentinel still unparsed here has nothing after it. An envelope that never
    # parsed is a tool call that never ran or an answer that was cut off, and
    # neither is prose to deliver, wherever in the reply it sits.
    lost_its_type = _tool_call_without_type(raw)
    undeliverable = (
        not raw
        or lost_its_type
        or _looks_like_envelope(raw)
        or _ATTEMPTED_TYPE.search(raw)
        or _SENTINEL_LINE.search(raw)
    )
    if undeliverable:
        # Prose before a tool call that lost its type would otherwise be reported as invalid JSON at character 0.
        problem = 'named a tool and its arguments with no "type".' if lost_its_type else _diagnose(raw)[0]
        raise ValueError(f'No valid tool call or final answer after {_MAX_ATTEMPTS} attempts. The last reply {problem}')
    return _message(content=raw)
