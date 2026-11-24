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
from bisect import bisect_left
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
# TODO(#935): this is a second copy of the reply handling in
# `agent_deepagent/deepagent.py`. Bring the two together when the tool-call
# envelope helpers are consolidated.
# ────────────────────────────────────────────────────────────────────────────────

#: Announces a final answer in place of a JSON envelope. Every character after it is the
#: answer, verbatim, so there is nothing to escape.
_FINAL_SENTINEL = 'FINAL>>>'

#: Model calls made for one turn before the turn is given up on.
_MAX_ATTEMPTS = 3

#: The sentinel at the start of a line. Text that mentions it mid-line does not announce an answer.
_SENTINEL_LINE = re.compile(rf'(?m)^[ \t]*{re.escape(_FINAL_SENTINEL)}')

#: A reply that opens with a JSON object, optionally inside a markdown fence: a brace, then a quoted key and
#: its colon, its closing, or the end of a reply that was cut off there. Either kind of quote, because a model
#: may write a Python dict. A brace followed by anything else opens prose.
_ENVELOPE_OPEN = re.compile(r"""^\s*(?:```[A-Za-z]*\s*)?\{\s*(?:\}|\Z|(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*:)""")

#: An object's opening brace.
_OBJECT_OPENING = re.compile(r'\{')

#: A word: a letter or a digit. Punctuation, a brace and an underscore are not words.
_WORD = re.compile(r'[^\W_]')

#: A word after an object on its line. Punctuation and closings are not words, and the line is read no
#: further than a markup tag, a comment or another object that opens there.
_WORD_AFTER = re.compile(r'[^\w\n\r{\[</#]*[^\W_]')

#: Strings an object may open with before its first key: a key that lost its colon and its value, or a
#: comment's quoted words.
_STRINGS_BEFORE_A_KEY = 3

#: What the walk over an object stops at: a string, the quote of a string that never ends, a brace or a bracket.
_TOKEN = re.compile(r'"[^"\\]*(?:\\.[^"\\]*)*"|["{}\[\]]', re.S)

#: What follows a key: its colon, and its value when that is a string. Group 1 is the value, as written.
_MEMBER_VALUE = re.compile(r'\s*:(?:\s*"([^"\\]*(?:\\.[^"\\]*)*)")?', re.S)

#: What follows a string in JSON: a colon, a comma, a closing, or the end of a reply that was cut off there.
#: A comment may follow one too, as JSON with comments has them.
_AFTER_STRING = re.compile(r'\s*(?:[:,}\]]|//|/\*|\Z)')

#: Where a comment starts, as JSON with comments has them. It is not what stands before the string after it.
_COMMENT_START = re.compile(r'//|/\*')

#: An object that opens with its type, as the prompt writes both envelopes. Group 1, 2 or 3 is the type, as written.
#: The key is in either kind of quote, or in none, as a JavaScript object has it, when the type is a tool call's.
#: It is how a tool call that JSON cannot read at all is still told on a line of its own.
_TYPE_FIRST = re.compile(
    r"""\{\s*(?:(?:"type"|'type')\s*:\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')|type\s*:\s*["'](tool_calls?)["'])"""
)

#: A tool call's type right after the brace, with the key or its colon miswritten: no colon, ``=`` or a
#: full-width colon in its place, curly quotes, or a key that lost its closing quote. Group 1 is the type.
_MISWRITTEN_TYPE = re.compile(r'\{\s*["“”]type["“”]?\s*[:：=]?\s*["“”]?(tool_calls?)["“”]')

#: An envelope type, or a tool call's arguments, named in text. Group 1 is the type, group 2 the ``args`` key.
#: Looked for when an object's own members do not say what it is.
_NAMED_MEMBER = re.compile(r'"type"\s*:\s*"(tool_calls?|final)"|"(args)"\s*:')

#: The closing of one envelope followed by the opening of an object. The match ends at the object's brace.
_STACKED_OBJECT = re.compile(r'"\s*\}\s*(?:```\s*)?(?=\{)')

#: The opening of a `final` envelope, up to the first character of its content. A markdown fence may open first.
_FINAL_ENVELOPE_OPEN = re.compile(r'^\s*(?:```[A-Za-z]*\s*)?\{\s*"type"\s*:\s*"final"\s*,\s*"content"\s*:\s*"', re.S)

#: The end of a `final` envelope: the quote that closes the content, then the closing brace, then the fence if there was one.
_FINAL_ENVELOPE_CLOSE = re.compile(r'"\s*\}\s*(?:```\s*)?$')

#: A quote in unescaped content with what may be another member after it: a comma, a key and its colon. Group 1 starts at the key.
_MEMBER_AFTER = re.compile(r'"\s*,\s*("(?:[^"\\]|\\.)*"\s*:)')

#: A markdown fence that encloses all of a text. Group 1 is what is inside it.
_ENCLOSING_FENCE = re.compile(r'```[A-Za-z]*\s*(.*)```', re.S)

#: The digits of a ``\uXXXX`` escape. ``int(x, 16)`` alone also takes a sign, a space and an underscore.
_HEX4 = re.compile(r'[0-9A-Fa-f]{4}')

_TOOL_CALL_KINDS = ('tool_call', 'tool_calls')

_ENVELOPE_KINDS = _TOOL_CALL_KINDS + ('final',)

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


def _extract_first_json_object(raw: Any) -> Any:
    """
    The first JSON object in a model reply, or None when there is none or it is not valid JSON.

    Read from the first ``{`` of the reply, which is how this node has always found its envelope.
    Prose before it, a markdown fence, an enclosing array and a second object after it do not get
    in the way.
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


def _own_members(text: str, at: int) -> Tuple[Dict[str, Optional[str]], Optional[int], bool]:
    """
    The members the object that opens at `at` carries itself, where it ends, and whether a quote in it is out of place.

    Walks the object once and collects each key at its top level, not the ones nested in its
    values, with its value when that is a string and None when it is anything else. Keys and
    values are unescaped as JSON would unescape them, so ``"tool\\u005fcall"`` is ``tool_call``.
    This is how an object that does not parse is still read for what it set out to be.

    A brace that is not followed by a key opens no object: a block of code, a set, a brace in a
    sentence. Nothing more of it is read, and it has no members. A few strings may come before
    the first key, because a key that lost its colon is still the opening of an object. The quote
    there counts as out of place.

    The end is the position after the closing brace. It is None for an object that never closes
    and for a brace that opens no object and is not closed at once. A quote is out of place when
    a string stands where JSON has none: not after a brace, a bracket, a comma or a colon, or
    not before a colon, a comma or a closing, comments aside. The walk may then be out of step
    with the object, so it finds what comes before that quote and may miss what follows.
    """
    members: Dict[str, Optional[str]] = {}
    depth, stray, read, keyless = 0, False, at, 0
    for token in _TOKEN.finditer(text, at):
        written = token.group()
        if written == '"':
            # A string that never ends: nothing after it can be read.
            break
        if len(written) > 1:
            follows = _MEMBER_VALUE.match(text, token.end())
            if depth == 1 and follows:
                members.setdefault(
                    _unescape_json_string_body(written[1:-1]),
                    None if follows.group(1) is None else _unescape_json_string_body(follows.group(1)),
                )
            between = text[read : token.start()]
            comment = _COMMENT_START.search(between)
            before = (between[: comment.start()] if comment else between).rstrip()[-1:] or text[read - 1]
            stray = stray or before not in '{[,:' or not _AFTER_STRING.match(text, token.end())
        elif written in '{[':
            depth += 1
        else:
            depth -= 1
            if depth <= 0:
                return members, token.end(), stray
        if not members and token.start() > at:
            # No key yet. A string may be a key that lost its colon. Anything else opens no object.
            keyless += 1
            if len(written) == 1 or keyless > _STRINGS_BEFORE_A_KEY:
                return {}, None, False
            stray = True
        read = token.end()
    return members, None, stray


def _mentions(text: str) -> Tuple[List[int], List[str], List[int], List[int]]:
    """
    Where the text names what an envelope has: the tool call types with their positions, the `final` types, the ``args`` keys.

    Collected in one pass, so that asking what is named after one object or another costs a lookup.
    """
    calls: List[int] = []
    kinds: List[str] = []
    finals: List[int] = []
    args: List[int] = []
    for named in _NAMED_MEMBER.finditer(text):
        if named.group(2):
            args.append(named.start())
        elif named.group(1) == 'final':
            finals.append(named.start())
        else:
            calls.append(named.start())
            kinds.append(named.group(1))
    return calls, kinds, finals, args


def _named(
    mentions: Tuple[List[int], List[str], List[int], List[int]], at: int, stop: int
) -> Tuple[Optional[str], bool]:
    """
    What the text names from `at` up to `stop`: an envelope type, and whether a tool call's arguments.

    A tool call's type comes before `final`, because a broken call must stay a call.
    """
    calls, kinds, finals, args = mentions
    call, final, arg = bisect_left(calls, at), bisect_left(finals, at), bisect_left(args, at)
    if call < len(calls) and calls[call] < stop:
        named_type: Optional[str] = kinds[call]
    else:
        named_type = 'final' if final < len(finals) and finals[final] < stop else None
    return named_type, arg < len(args) and args[arg] < stop


def _unfinished_envelope(text: str) -> Optional[str]:
    """
    The type of the first envelope in the text that is not finished, or None.

    An object is quoted when it has a word before it and a word after it on its line. Any other
    object stands as written, whatever punctuation, brace, closing, markup tag or comment is around
    it. A tool call that stands is never finished: one that parses counts by its own ``"type"``,
    in whatever order its members come. A `final` that stands counts only when it does not parse:
    it was cut off, or its escaping is broken. Of the quoted objects only a tool call that does
    not parse counts: work that never ran is not prose.

    An object with a tool call's ``name`` and ``args`` and no type will not run. It counts as a
    tool call where a reply's envelope is looked for: as the first object of the text, or with no
    word before it on its line. Anywhere else it is data or code, as in an answer that shows a
    function being called with such an object.

    An object that does not parse is read by its own members (``_own_members``): its type, or a
    tool call's name and arguments with no type. When it has neither, what its own text names
    decides (``_named``). When a quote out of place or a missing closing kept its members from
    being read, that is the text up to the end of the reply, and arguments named there make a
    tool call of an object that has a name. An object of another type owns what is inside it
    when it was read to its closing. When it was not, a tool call named after its first line
    still counts.

    A brace that opens no object is prose and hides nothing that follows it. With no word before
    it on its line it is still a tool call when a tool call's type comes right after it with no
    quotes or in single quotes, as JavaScript and Python write one. And a tool call's type right
    after a brace is a tool call anywhere when only the key or its colon is miswritten
    (``_MISWRITTEN_TYPE``).

    A brace that opens no object costs a look at what follows it. An object is read once, with
    what is inside it, and the reply is searched once for what it names. So the time this takes
    grows with the length of the reply and no faster.
    """
    first, read_to, looked_to, word_before = text.find('{'), 0, 0, False
    mentions: Optional[Tuple[List[int], List[str], List[int], List[int]]] = None
    for opening in _OBJECT_OPENING.finditer(text):
        at = opening.start()
        # Whether a word stands before the brace on its line. The text between one brace and the next is
        # looked at once, and a brace earlier on the line is no word.
        line = max(text.rfind('\n', looked_to, at), text.rfind('\r', looked_to, at)) + 1
        if line:
            word_before, looked_to = False, line
        word_before = word_before or bool(_WORD.search(text, looked_to, at))
        looked_to, no_word_before = at, not word_before
        if at < read_to:
            continue
        members, end, stray = _own_members(text, at)
        miswritten = None if 'type' in members else _MISWRITTEN_TYPE.match(text, at)
        if miswritten:
            return miswritten.group(1)
        if not members:
            loose = _TYPE_FIRST.match(text, at) if no_word_before else None
            if loose and (loose.group(1) or loose.group(2) or loose.group(3)) in _TOOL_CALL_KINDS:
                return loose.group(1) or loose.group(2) or loose.group(3)
            continue
        stands = no_word_before or end is None or not _WORD_AFTER.match(text, end)
        # Read to its closing, with every quote in its place.
        read = end is not None and not stray
        try:
            parsed = json.loads(text[at:end]) if end else None
        except Exception:
            parsed = None
        own = members.get('type')
        # Where a name and arguments with no type make a tool call. Elsewhere they are data or code.
        may_lack_type = no_word_before or at == first
        if isinstance(parsed, dict):
            names_a_tool = may_lack_type and isinstance(parsed.get('name'), str) and 'args' in parsed
            kind = parsed.get('type', 'tool_call' if names_a_tool else None) if stands else None
        elif own in _ENVELOPE_KINDS or (own is not None and read):
            # Its own type says what it is. An object of another type that was read owns what is inside it.
            kind = own
        elif may_lack_type and 'type' not in members and isinstance(members.get('name'), str) and 'args' in members:
            kind = 'tool_call'
        else:
            mentions = mentions or _mentions(text)
            if own is not None:
                # Another type, and not read to its closing: a tool call named after its first line still counts.
                line_end = text.find('\n', at)
                named_type, _names_args = _named(mentions, len(text) if line_end < 0 else line_end, len(text))
                kind = named_type if named_type in _TOOL_CALL_KINDS else None
            else:
                named_type, names_args = _named(mentions, at, end if read else len(text))
                has_a_name = may_lack_type and not read and isinstance(members.get('name'), str)
                names_a_call = named_type in _TOOL_CALL_KINDS
                kind = 'tool_call' if names_args and has_a_name and not names_a_call else named_type
        # A `final` that parses is finished, and a quoted one is prose.
        if isinstance(kind, str) and kind in (_ENVELOPE_KINDS if parsed is None and stands else _TOOL_CALL_KINDS):
            return kind
        if end is None:
            # It never closes, so the rest of the text is inside it.
            break
        read_to = end
    return None


def _tool_call_without_type(text: str) -> bool:
    """
    Whether the first JSON object in the text has a tool call's name and arguments and no ``"type"``.

    Also when the object does not parse: bad escaping in the arguments does not make it less of a
    call. Only the first object is looked at, as the parser reads a reply.
    """
    obj = _extract_first_json_object(text)
    start = text.find('{')
    members = obj if isinstance(obj, dict) else _own_members(text, start)[0] if start >= 0 else {}
    return 'type' not in members and isinstance(members.get('name'), str) and 'args' in members


def _attempted_kind(text: str) -> Optional[str]:
    """
    The envelope type a reply is, or was reaching for: ``tool_call``, ``tool_calls``, ``final`` or None.

    The first JSON object's own ``"type"`` when that object parses and is an envelope, wherever
    it sits, as the parser reads it. Otherwise an envelope that is not finished
    (``_unfinished_envelope``). A broken `final` quoted inside a sentence is prose, and so is
    text that mentions a type with no object opening on it.
    """
    obj = _extract_first_json_object(text)
    kind = obj.get('type') if isinstance(obj, dict) else None
    if isinstance(kind, str) and kind in _ENVELOPE_KINDS:
        return kind
    return _unfinished_envelope(text)


def _escape_code(body: str, at: int) -> Optional[int]:
    """The code unit of a ``\\uXXXX`` escape whose digits start at `at`, or None when they are not four hex digits."""
    digits = body[at : at + 4]
    return int(digits, 16) if _HEX4.fullmatch(digits) else None


def _unescape_json_string_body(body: str) -> str:
    """
    Undo JSON string escaping, tolerating the escapes that broke the envelope.

    ``json.loads`` is all or nothing: one unescaped quote and the whole answer is lost. This walks
    the body instead, translating the escapes it recognises and passing everything else through
    as itself.
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
            # A surrogate pair is one character spelled as two escapes. Decoded apart they are two
            # lone surrogates, which `str.encode` refuses, so the answer would raise on its way out.
            low_start = i + 6
            low = _escape_code(body, low_start + 2) if body[low_start : low_start + 2] == '\\u' else None
            if 0xD800 <= code <= 0xDBFF and low is not None and 0xDC00 <= low <= 0xDFFF:
                out.append(chr(0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00)))
                i = low_start + 6
                continue
            out.append(chr(code))
            i += 6
        else:
            # Not an escape we know. A lone backslash is far likelier to be part of the answer
            # (a Windows path, a LaTeX fragment) than a mistake.
            out.append(ch)
            i += 1
    return ''.join(out)


def _is_escaped(text: str, at: int) -> bool:
    """Whether the character at `at` has an odd number of backslashes before it, which makes a quote an escaped one."""
    first = at
    while first > 0 and text[first - 1] == '\\':
        first -= 1
    return (at - first) % 2 == 1


def _inside_fence(text: str) -> Optional[str]:
    """
    The text inside a markdown fence that encloses all of `text`, or None when no fence does.

    The closing is looked at first. On a fence that never closes, the pattern would try every
    split of the whitespace after its opening.
    """
    fenced = _ENCLOSING_FENCE.fullmatch(text) if text.endswith('```') else None
    return fenced.group(1) if fenced else None


def _is_stacked(raw: str, start: int, stop: int) -> bool:
    """
    Whether the content of a broken `final` envelope, from `start` to `stop`, holds its closing and then another envelope.

    The object right after a closing decides, by its own type, wherever that comes among its
    members. An ordinary object there is part of the answer, with whatever it holds, and so is an
    envelope quoted further on.
    """
    read_to = start
    for closing in _STACKED_OBJECT.finditer(raw, start, stop):
        if closing.end() < read_to:
            continue
        members, end, _stray = _own_members(raw, closing.end())
        if members.get('type') in _ENVELOPE_KINDS:
            return True
        read_to = len(raw) if end is None else end
    return False


def _salvage_final_content(raw: Any) -> Optional[str]:
    """
    The answer out of a `final` envelope that does not parse as JSON, or None when it cannot be trusted.

    A reply that opens with ``{"type":"final","content":"`` and ends with ``"}``, in a markdown
    fence or not, holds the answer between the two, and all that is wrong is an escape the model
    missed. A malformed tool call is never recovered into an answer: that would turn work the
    agent meant to do into a sentence claiming it was done.

    Because the content is unescaped, only the end of the reply says which ``"}`` is the
    envelope's own. So these are not recovered, and the reply is retried:

    - an envelope that does not end the reply: it was cut off, or more text follows it;
    - content followed by the envelope's other members (``","note":"z"}``) or by a second
      envelope: after one of its quotes, the rest of the reply reads as members up to the
      closing brace, so the content ended before it. JSON inside the answer does not read that way;
    - content with a ``FINAL>>>`` line in it, which may be the answer's own text or the sentinel;
    - content with the closing of one envelope and the opening of another in it: two envelopes.

    One cut-off still reads as closed: a reply that stops right after an unescaped ``"}`` inside the answer.
    """
    if not isinstance(raw, str):
        return None
    opening = _FINAL_ENVELOPE_OPEN.match(raw)
    closing = _FINAL_ENVELOPE_CLOSE.search(raw, opening.end()) if opening else None
    # An escaped quote is the answer's own and closes nothing: the reply was cut off right there.
    if not closing or _is_escaped(raw, closing.start()):
        return None
    content = raw[opening.end() : closing.start()]
    # A JSON document pasted in as it is, in a markdown fence or not: its backslashes are its own,
    # and undoing them would break it.
    inside = _inside_fence(content.strip())
    try:
        if isinstance(json.loads(content if inside is None else inside), (dict, list)):
            return content
    except Exception:
        pass
    if _SENTINEL_LINE.search(content) or _is_stacked(raw, opening.end(), closing.start()):
        return None
    # The envelope's other members after the content: the reply, from the last such key on, reads as its end.
    members = list(_MEMBER_AFTER.finditer(content))
    if members:
        try:
            json.loads('{' + content[members[-1].start(1) :] + '"}')
            return None
        except Exception:
            pass
    return _unescape_json_string_body(content)


def _looks_like_envelope(raw: Any) -> bool:
    """
    Whether a reply opens with a JSON object, in a markdown fence or not.

    One that never parsed into a tool call or an answer is not prose to deliver. Prose that
    merely starts with a brace is not one.
    """
    return isinstance(raw, str) and bool(_ENVELOPE_OPEN.match(raw))


def _sentinel(raw: str) -> Optional['re.Match[str]']:
    """
    The ``FINAL>>>`` line that announces the answer, or None when the reply has no line that does.

    A marker line is not the sentinel when an envelope that is not finished stands before it
    (``_unfinished_envelope``): a tool call that is not quoted, the first line included, a tool
    call anywhere that does not parse, or a broken `final` that is not quoted. After a tool call
    the line is a claim about work that has not run. After the opening of a broken `final` it
    may be the answer's own text or the sentinel, and nothing says which. The reply is then read
    as its first JSON object, as every reply without a sentinel is. A tool call that parses with
    a word before it and a word after it on its line is quoted, and a `final` that parses is
    finished: neither takes anything away from the marker.
    """
    marker = _SENTINEL_LINE.search(raw)
    return None if not marker or _unfinished_envelope(raw[: marker.start()]) else marker


def _after_sentinel(rest: str) -> str:
    """
    The text after the ``FINAL>>>`` marker, with only the marker's separator removed.

    One separator comes off: a newline, or a space or tab on the same line. Any further
    whitespace is the answer's own: leading spaces open a code block, and a blank first line is a
    deliberate gap.
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
    would be shown the protocol, so text that is a `final` envelope, whole, is read as one: its
    content when it parses or closes, and None when it was cut off. An envelope that parses with
    more text after it is an answer that quotes one, delivered as written. Nothing after the
    marker is None too.
    """
    whole = text.strip()
    if not whole:
        return None
    inside = _inside_fence(whole)
    try:
        obj = json.loads(whole if inside is None else inside)
    except Exception:
        obj = None
    if isinstance(obj, dict) and obj.get('type') == 'final':
        return _final_text(obj.get('content', ''))
    broken = _looks_like_envelope(text) and not isinstance(_extract_first_json_object(text), dict)
    return _salvage_final_content(whole) if broken and _attempted_kind(text) == 'final' else text


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


def _parse_tool_call_envelope(raw: Any) -> Any:
    """
    Parse one model reply into the ``AIMessage`` for the turn.

    A ``FINAL>>>`` line that is the sentinel (``_sentinel``) comes first: what follows it is the
    answer, and there is nothing in it to escape. With nothing after it, a `final` envelope that
    parses before it is the answer. Otherwise the first JSON object in the reply
    is the envelope, as it always was in this node: a `tool_call` runs and a `final` gives its
    content. A `final` envelope that does not parse but closes is recovered
    (``_salvage_final_content``).

    Everything else is refused: a bare JSON object (it may be a tool call that lost its
    ``"type"``), a tool call that names no tool, and the ``tool_calls`` form with several calls
    in one reply, which the prompt does not offer.

    Returns:
        An ``AIMessage`` carrying the answer or the tool call, or None when the reply is
        neither. None sends the model through the retry loop.
    """
    if not isinstance(raw, str):
        return None

    marker = _sentinel(raw)
    if marker:
        # Delivered as written: only the separator comes off, never the answer's own whitespace.
        answer = _sentinel_answer(_after_sentinel(raw[marker.end() :]))
        if answer is not None:
            return _message(content=answer)
        # Nothing after the marker: a `final` envelope that parses before it is still the answer.
        obj = _extract_first_json_object(raw) if not raw[marker.end() :].strip() else None
        if isinstance(obj, dict) and obj.get('type') == 'final':
            return _message(content=_final_text(obj.get('content', '')))
        return None

    obj = _extract_first_json_object(raw)
    if not isinstance(obj, dict):
        salvaged = _salvage_final_content(raw)
        return _message(content=salvaged) if salvaged else None

    if obj.get('type') == 'final':
        return _message(content=_final_text(obj.get('content', '')))
    if obj.get('type') == 'tool_call':
        call = _tool_call(obj)
        return _message(tool_calls=[call]) if call else None
    return None


def _diagnose(raw: Any) -> Tuple[str, str, str]:
    """
    What was wrong with a reply, and what the model should send instead.

    Returns:
        ``(problem, excerpt, remedy)``. The problem completes "Your last output ..." and "The
        last reply ...", so it also goes into the error a failed turn raises. The excerpt quotes
        the reply around the break and the remedy is an instruction to this model: both go to the
        model only, because the error is logged and returned to the caller. Either may be empty.
    """
    text = safe_str(raw).strip()
    if not text:
        return 'was empty.', '', ''
    marker = _sentinel(text)
    if marker:
        # What was wrong is in the text after the marker: nothing at all, or an envelope that was cut off.
        text = text[marker.end() :].strip()
        if not text:
            return (
                f'ended at {_FINAL_SENTINEL} with no answer after it.',
                '',
                f'Write the answer after {_FINAL_SENTINEL}.',
            )

    # A broken answer should come back after the sentinel, where nothing can break again. A broken
    # tool call must come back as a tool call: the sentinel would trade the work for a sentence about it.
    attempted = _attempted_kind(text)
    wanted_a_tool_call = attempted in _TOOL_CALL_KINDS
    # Diagnose the JSON itself: without its fence, and from its opening brace when prose came first.
    candidate = _without_fence(text)
    if attempted and not candidate.startswith('{') and '{' in candidate:
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
    What to tell the model about the reply that just failed to parse, as one line for the next prompt.

    "Your last output was invalid" is true and useless: the model cannot see which character
    broke it, so it writes the same reply again. Naming the position and quoting the text around
    it gives the retry a chance.
    """
    problem, excerpt, remedy = _diagnose(raw)
    return f'Your last output {problem}{excerpt} {remedy}'.strip()


def _run_model_turn(ask: Callable[[str], Any]) -> Any:
    """
    Ask the model for one turn, retrying a reply that is neither a tool call nor an answer.

    A turn ends in one of three ways, and a failed turn is never reported as an answer:

    - a reply parsed as a tool call or an answer: it is returned;
    - no reply parsed and the last one is prose: that prose is the answer, because the model
      said something readable. Prose that starts with a brace which opens no object, or that
      mentions a type, is still prose;
    - no reply parsed and the last one is empty, opens with a JSON object, holds an envelope that
      was refused or never parsed (also after prose), has a tool call that lost its ``"type"`` and
      is not quoted, or has a ``FINAL>>>`` line with no answer: the turn raises, so the run ends
      as an error. The error says what was wrong with the last reply and quotes nothing of it.

    Args:
        ask: Sends the turn's prompt with the given text appended, and returns the model's reply.
            The text is empty on the first attempt and grows by one ``_parse_failure_hint`` line
            for each reply that did not parse.

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

    # An envelope that never parsed is a tool call that never ran or an answer that was cut off,
    # and a marker line still unparsed here has no answer after it. Neither is prose to deliver.
    undeliverable = (
        not raw or _looks_like_envelope(raw) or _attempted_kind(raw) is not None or _SENTINEL_LINE.search(raw)
    )
    if undeliverable:
        # A line of prose before a tool call that lost its type would otherwise be reported as invalid JSON.
        lost_its_type = _tool_call_without_type(raw)
        problem = 'named a tool and its arguments with no "type".' if lost_its_type else _diagnose(raw)[0]
        raise ValueError(f'No valid tool call or final answer after {_MAX_ATTEMPTS} attempts. The last reply {problem}')
    return _message(content=raw)
