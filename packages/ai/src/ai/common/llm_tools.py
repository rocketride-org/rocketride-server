# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Native tool calling for a turn-mode Question: names, specs, stop reasons, and the LangChain codec.

ChatBase.chat_turn drives the request; this module owns what a turn knows that is not
transport: how caller tool names map to provider names and back, how the conversation
becomes LangChain messages, and how the model's AIMessage becomes an AssistantMessage.
"""

import hashlib
import re
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional, Tuple

from ai.common.llm_adapter import flatten_content_parts
from ai.common.schema import (
    AssistantMessage,
    Message,
    Question,
    ReasoningBlock,
    StopReason,
    TextBlock,
    Tool,
    ToolCallBlock,
    ToolResultBlock,
)
from ai.common.validation import sanitize_prompt


def is_turn(question: Any) -> bool:
    """True for a turn-mode Question. Callers may hand in question-like objects, which never are."""
    return isinstance(question, Question) and question.isTurn()


class ToolsUnsupported(Exception):
    """A turn-mode Question reached an LLM node without native tool calling. Raised before any provider call."""

    def __init__(self, provider: str):
        """Name the node's provider in the message."""
        super().__init__(f'{provider} does not support native tool calling')


# The strictest rule among the providers (OpenAI: ^[a-zA-Z0-9_-]{1,64}$), so a tool keeps one
# provider name on every model and a conversation that moves between models stays cacheable.
_LEGAL = re.compile(r'^[A-Za-z0-9_-]{1,64}$')
_ILLEGAL_CHAR = re.compile(r'[^A-Za-z0-9_-]')
_HASH_LEN = 8


def provider_tool_name(name: str) -> str:
    """Map a caller tool name to one every provider accepts. Pure and injective.

    A legal name without '__' is kept. Otherwise each '.' becomes '__', which stays reversible
    while the name has no '__' and no '_' beside a dot. Any other name, or one over 64
    characters, is sanitized, truncated and given '_' plus 8 hex characters of its sha256.
    """
    if _LEGAL.match(name) and '__' not in name:
        return name
    dotted = name.replace('.', '__')
    if '__' not in name and '_.' not in name and '._' not in name and _LEGAL.match(dotted):
        return dotted
    digest = hashlib.sha256(name.encode('utf-8')).hexdigest()[:_HASH_LEN]
    return f'{_ILLEGAL_CHAR.sub("_", dotted)[: 64 - _HASH_LEN - 1]}_{digest}'


@dataclass(frozen=True)
class ToolNames:
    """Caller name to provider name for one request, and back."""

    to_caller: Dict[str, str]

    @classmethod
    def build(cls, tools: Iterable[Tool], messages: Iterable[Message]) -> 'ToolNames':
        """Rebuilt per request from the tools and every call in the history, so it keeps no state.

        Calls are included so a call to a tool the caller has since removed still maps back.
        """
        names = {tool.name for tool in tools}
        for message in messages:
            if message.role == 'assistant' and not isinstance(message.content, str):
                names.update(block.name for block in message.content if isinstance(block, ToolCallBlock))
        return cls({provider_tool_name(name): name for name in names})

    def caller(self, provider_name: str) -> str:
        """Map a name the model used back to the caller's.

        A name the table does not know passes through: a model that echoes the caller's own
        dotted name gets that name, and a made-up tool fails the caller's own lookup.
        """
        return self.to_caller.get(provider_name, provider_name)


def tool_specs(tools: Iterable[Tool]) -> List[Dict[str, Any]]:
    """Return the tools as bare {name, description, parameters} dicts, which bind_tools converts per provider."""
    specs = []
    for tool in tools:
        spec: Dict[str, Any] = {'name': provider_tool_name(tool.name), 'parameters': tool.inputSchema}
        if tool.description:
            spec['description'] = tool.description
        specs.append(spec)
    return specs


# Provider stop and finish reasons, by provider: Anthropic; OpenAI Chat Completions; OpenAI
# Responses (status, incomplete_details.reason).
_STOP_REASONS: Dict[str, StopReason] = {
    'end_turn': 'end_turn',
    'tool_use': 'tool_use',
    'max_tokens': 'max_tokens',
    'model_context_window_exceeded': 'max_tokens',
    'stop_sequence': 'stop_sequence',
    'refusal': 'refusal',
    'pause_turn': 'end_turn',
    'stop': 'end_turn',
    'tool_calls': 'tool_use',
    'function_call': 'tool_use',
    'length': 'max_tokens',
    'content_filter': 'refusal',
    'completed': 'end_turn',
    'max_output_tokens': 'max_tokens',
}


def stop_reason(raw: Optional[str], has_calls: bool) -> StopReason:
    """Normalize a provider's reason, kept consistent with the calls actually returned.

    Some OpenAI-compatible servers answer 'stop' alongside tool calls, and a 'tool_use' with no
    parsable call would leave the caller looping on nothing.
    """
    reason = _STOP_REASONS.get(raw or '', 'end_turn')
    if has_calls and reason == 'end_turn':
        return 'tool_use'
    if not has_calls and reason == 'tool_use':
        return 'end_turn'
    return reason


def model_origin(llm: Any) -> str:
    """Name the model class a turn ran on. Reasoning state is replayed only to the class that wrote it."""
    while hasattr(llm, 'bound'):
        llm = llm.bound
    return type(llm).__name__


_CACHE = {'type': 'ephemeral'}


def _cached(content: Any) -> List[Any]:
    blocks = [{'type': 'text', 'text': content}] if isinstance(content, str) else [dict(b) for b in content]
    blocks[-1]['cache_control'] = _CACHE
    return blocks


def to_langchain(system: str, messages: List[Message], origin: str, cache: bool) -> List[Any]:
    """Encode a turn as LangChain messages for the model class named by `origin`.

    Tool results come first in their user turn, as Anthropic requires. Reasoning written by
    another model class is dropped. With `cache`, the end of the system prompt and the end of
    the last message are marked for the provider's prompt cache.
    """
    from langchain_core.messages import HumanMessage, SystemMessage, ToolMessage

    out: List[Any] = []
    if system.strip():
        text = sanitize_prompt(system)
        out.append(SystemMessage(content=_cached(text) if cache else text))
    for message in messages:
        if message.role == 'assistant':
            out.append(_to_ai_message(message, origin))
            continue
        blocks = [TextBlock(text=message.content)] if isinstance(message.content, str) else message.content
        for block in blocks:
            if isinstance(block, ToolResultBlock):
                out.append(
                    ToolMessage(
                        content=sanitize_prompt(block.content),
                        tool_call_id=block.callId,
                        status='error' if block.isError else 'success',
                    )
                )
        texts = [{'type': 'text', 'text': sanitize_prompt(b.text)} for b in blocks if isinstance(b, TextBlock)]
        if texts:
            out.append(HumanMessage(content=texts))
    if cache and messages and out[-1].content:
        out[-1] = out[-1].model_copy(update={'content': _cached(out[-1].content)})
    return out


def _to_ai_message(message: AssistantMessage, origin: str) -> Any:
    from langchain_core.messages import AIMessage

    if isinstance(message.content, str):
        return AIMessage(content=message.content)
    content: List[Any] = []
    calls = []
    for block in message.content:
        if isinstance(block, ReasoningBlock):
            state = block.state if isinstance(block.state, dict) else {}
            if state.get('origin') == origin and isinstance(state.get('block'), dict):
                content.append(state['block'])
        elif isinstance(block, TextBlock):
            content.append({'type': 'text', 'text': block.text})
        else:
            # A call whose arguments were not valid JSON goes back with none: some LangChain
            # versions drop invalid_tool_calls when formatting, which would orphan its result.
            args = block.args if isinstance(block.args, dict) else {}
            calls.append({'id': block.id, 'name': provider_tool_name(block.name), 'args': args})
    return AIMessage(content=content, tool_calls=calls)


def from_langchain(message: Any, names: ToolNames, origin: str) -> Tuple[AssistantMessage, StopReason]:
    """Decode an AIMessage (invoked, or aggregated from stream chunks) into the turn and its stop reason.

    Reasoning comes first, then text, then calls. Provider reasoning blocks are kept whole in
    `state`, so the next request can send them back unchanged.
    """
    blocks: List[Any] = []
    content = message.content
    if isinstance(content, str):
        text, thinking = flatten_content_parts(content)
        if thinking:
            blocks.append(ReasoningBlock(text=thinking))
        if text:
            blocks.append(TextBlock(text=text))
    else:
        reasoning, texts = [], []
        for block in content:
            kind = block.get('type') if isinstance(block, dict) else 'text'
            if kind == 'text':
                texts.append(TextBlock(text=block if isinstance(block, str) else block.get('text', '')))
            elif kind in ('thinking', 'redacted_thinking', 'reasoning'):
                reasoning.append(ReasoningBlock(text=_reasoning_text(block), state={'origin': origin, 'block': block}))
        blocks = [*reasoning, *texts]
    calls = [
        ToolCallBlock(id=call['id'], name=names.caller(call['name']), args=call['args']) for call in message.tool_calls
    ]
    calls += [
        ToolCallBlock(id=call.get('id') or '', name=names.caller(call.get('name') or ''), args=call.get('args') or '')
        for call in message.invalid_tool_calls
    ]
    metadata = message.response_metadata or {}
    raw = (
        metadata.get('stop_reason')
        or metadata.get('finish_reason')
        or (metadata.get('incomplete_details') or {}).get('reason')
        or metadata.get('status')
    )
    return AssistantMessage(content=[*blocks, *calls]), stop_reason(raw, bool(calls))


def _reasoning_text(block: Dict[str, Any]) -> str:
    if block.get('summary'):
        return ''.join(part.get('text', '') for part in block['summary'] if isinstance(part, dict))
    return block.get('thinking') or block.get('reasoning') or block.get('text') or ''
