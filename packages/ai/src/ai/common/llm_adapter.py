# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Normalized LLM provider interface: one Event shape for every provider.

ChatBase consumes Adapters and never touches provider-native content shapes.
Design: repo discussion #1679 (RFC — virtualized provider Adapter).
"""

from dataclasses import dataclass, field
from typing import Any, Callable, Iterator, Optional, Protocol, runtime_checkable


@dataclass
class Event:
    """One normalized streaming event: a display delta, or the terminal ``done``."""

    type: str  # "thinking" | "text" | "done"
    text: str = ''
    items: list[Any] = field(default_factory=list)


@runtime_checkable
class Adapter(Protocol):
    """Provider adapter: owns provider-native ``history``, streams normalized Events.

    Yields ``Event("thinking"|"text")`` deltas in order, then exactly one terminal
    ``Event("done", items=...)``. ``items`` is provider-native and OPAQUE: append it
    to ``history`` verbatim — never inspect, edit, reorder, or reserialize it.
    """

    history: list[Any]

    def stream(self, user_text: str) -> Iterator[Event]: ...


def drive_adapter(
    adapter: Adapter,
    user_text: str,
    on_text: Optional[Callable[[str], None]] = None,
    on_thinking: Optional[Callable[[str], None]] = None,
) -> tuple[str, list[Any]]:
    """Consume an adapter's Event stream: fan text/thinking deltas to the sinks,
    return the joined answer text and the terminal opaque ``done.items``.
    """
    parts: list[str] = []
    items: list[Any] = []
    for ev in adapter.stream(user_text):
        if ev.type == 'text':
            parts.append(ev.text)
            if on_text is not None:
                on_text(ev.text)
        elif ev.type == 'thinking':
            if on_thinking is not None:
                on_thinking(ev.text)
        elif ev.type == 'done':
            items = ev.items
    return ''.join(parts), items


def _make_think_tag_splitter():
    """Split ``<think>...</think>`` CoT out of the content stream (Ollama, Perplexity).

    Returns a ``feed(text) -> (visible, reasoning)`` closure; tags may span deltas.
    """
    OPEN, CLOSE = '<think>', '</think>'
    state = {'mode': 'visible', 'buf': ''}

    def feed(text: str):
        if not text:
            return '', ''
        buf = state['buf'] + text
        visible_parts: list = []
        reasoning_parts: list = []
        while buf:
            if state['mode'] == 'visible':
                idx = buf.find(OPEN)
                if idx < 0:
                    # Hold back trailing chars that could be a partial '<think>'.
                    safe = len(buf) - (len(OPEN) - 1)
                    if safe > 0:
                        visible_parts.append(buf[:safe])
                        buf = buf[safe:]
                    break
                if idx:
                    visible_parts.append(buf[:idx])
                buf = buf[idx + len(OPEN) :]
                state['mode'] = 'thinking'
            else:
                idx = buf.find(CLOSE)
                if idx < 0:
                    safe = len(buf) - (len(CLOSE) - 1)
                    if safe > 0:
                        reasoning_parts.append(buf[:safe])
                        buf = buf[safe:]
                    break
                if idx:
                    reasoning_parts.append(buf[:idx])
                buf = buf[idx + len(CLOSE) :]
                state['mode'] = 'visible'
        state['buf'] = buf
        return ''.join(visible_parts), ''.join(reasoning_parts)

    def flush():
        """Emit anything buffered at end-of-stream (e.g. an unterminated tag)."""
        tail = state['buf']
        state['buf'] = ''
        if state['mode'] == 'thinking':
            return '', tail
        return tail, ''

    feed.flush = flush  # type: ignore[attr-defined]
    return feed


def _make_stream_content_parser(has_reasoning_sink: bool):
    """Split streamed content (str, or Anthropic/LangChain-v1 typed blocks) into
    (visible_text, reasoning_text); also strips inline ``<think>`` from str content.
    """
    think_split = _make_think_tag_splitter()
    state = {'signature_noted': False}

    def feed(content):
        text = ''
        thinking = ''
        if isinstance(content, list):
            for b in content:
                if not isinstance(b, dict):
                    continue
                btype = b.get('type', '')
                if btype == 'thinking':
                    # carries either text deltas or a signature-only final delta.
                    piece_text = b.get('thinking') or b.get('text') or ''
                    if piece_text:
                        thinking += piece_text
                    elif b.get('signature') and not state['signature_noted'] and has_reasoning_sink:
                        thinking += (
                            '_Extended thinking ran, but this stream only delivered the '
                            'block verification signature, not the readable chain-of-thought '
                            'text. The answer below still reflects internal reasoning._\n\n'
                        )
                        state['signature_noted'] = True
                elif btype == 'reasoning':
                    # LangChain v1 standard block (thinking → reasoning).
                    piece_text = b.get('reasoning') or b.get('text') or ''
                    if piece_text:
                        thinking += piece_text
                elif btype == 'text' or not btype:
                    text += b.get('text', '')
        elif isinstance(content, str):
            text, thinking_inline = think_split(content)
            if thinking_inline:
                thinking += thinking_inline
        return text, thinking

    feed.flush = think_split.flush  # type: ignore[attr-defined]
    return feed


def flatten_content(content: Any) -> str:
    """Collapse a full (non-streamed) message content to visible text, dropping thinking.

    Non-streaming callers (agents, expectJson) must get a string, never a block list.
    """
    parse = _make_stream_content_parser(False)
    text, _thinking = parse(content)
    tail, _ = parse.flush()
    return text + tail


class LangChainAdapter:
    """Wraps a LangChain chat model so non-reasoning providers speak the Event contract.

    ``done.items`` is the assistant text turn — LangChain carries no opaque reasoning state.
    """

    def __init__(self, llm: Any, history: list[Any] | None = None, stream_kwargs: dict | None = None):
        self.llm = llm
        self.history: list[Any] = history if history is not None else []
        self.stream_kwargs = stream_kwargs or {}
        self.finish_reason: Optional[str] = None

    def stream(self, user_text: str) -> Iterator[Event]:
        self.history.append({'role': 'user', 'content': user_text})
        parse = _make_stream_content_parser(True)
        parts: list[str] = []
        for piece in self.llm.stream(self.history, **self.stream_kwargs):
            text, thinking = parse(piece.content)
            if thinking:
                yield Event('thinking', thinking)
            if text:
                parts.append(text)
                yield Event('text', text)
            reason = (getattr(piece, 'response_metadata', None) or {}).get('finish_reason')
            if reason:
                self.finish_reason = reason
        tail_text, tail_thinking = parse.flush()
        if tail_thinking:
            yield Event('thinking', tail_thinking)
        if tail_text:
            parts.append(tail_text)
            yield Event('text', tail_text)
        assistant = {'role': 'assistant', 'content': ''.join(parts)}
        self.history.append(assistant)
        yield Event('done', items=[assistant])


class AnthropicAdapter:
    """history is a Messages-API `messages` list; done.items is the assembled content
    (thinking `signature` / redacted blocks intact) — append verbatim, never rebuild.
    """

    def __init__(
        self,
        client: Any,
        model: str,
        max_tokens: int = 16000,
        thinking: dict | None = None,
        history: list[Any] | None = None,
    ):
        self.client = client
        self.model = model
        self.max_tokens = max_tokens
        self.thinking = thinking
        self.history: list[Any] = history if history is not None else []

    def stream(self, user_text: str) -> Iterator[Event]:
        self.history.append({'role': 'user', 'content': user_text})
        kwargs: dict[str, Any] = {'model': self.model, 'max_tokens': self.max_tokens, 'messages': self.history}
        if self.thinking:
            kwargs['thinking'] = self.thinking
        with self.client.messages.stream(**kwargs) as stream:
            for ev in stream:
                if getattr(ev, 'type', '') != 'content_block_delta':
                    continue
                delta = ev.delta
                dtype = getattr(delta, 'type', '')
                if dtype == 'thinking_delta':
                    yield Event('thinking', getattr(delta, 'thinking', '') or '')
                elif dtype == 'text_delta':
                    yield Event('text', getattr(delta, 'text', '') or '')
            final = stream.get_final_message()
        self.history.append({'role': 'assistant', 'content': final.content})
        yield Event('done', items=final.content)


class OpenAIAdapter:
    """history is a Responses-API `input` item list; done.items are the output items
    (encrypted reasoning + assistant) — extend history verbatim, never replay a subset.
    """

    def __init__(self, client: Any, model: str, effort: str = 'medium', history: list[Any] | None = None):
        self.client = client
        self.model = model
        self.effort = effort
        self.history: list[Any] = history if history is not None else []

    def stream(self, user_text: str) -> Iterator[Event]:
        self.history.append({'role': 'user', 'content': user_text})
        with self.client.responses.stream(
            model=self.model,
            input=self.history,
            store=False,  # stateless: encrypted_content rides back on the reasoning items.
            reasoning={'effort': self.effort, 'summary': 'auto', 'context': 'all_turns'},
        ) as stream:
            for ev in stream:
                etype = getattr(ev, 'type', '')
                if etype in ('response.reasoning_summary_text.delta', 'response.reasoning_text.delta'):
                    yield Event('thinking', getattr(ev, 'delta', '') or '')
                elif etype == 'response.output_text.delta':
                    yield Event('text', getattr(ev, 'delta', '') or '')
            final = stream.get_final_response()
        items = [item.model_dump() for item in final.output]
        self.history.extend(items)
        yield Event('done', items=items)
