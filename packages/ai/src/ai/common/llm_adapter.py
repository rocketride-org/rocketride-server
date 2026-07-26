# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Normalized LLM provider interface: one Event shape for every provider.

ChatBase consumes Adapters and never touches provider-native content shapes.
Design: repo discussion #1679 (RFC — virtualized provider Adapter).
"""

from dataclasses import dataclass, field
from typing import Any, Iterator, Protocol, runtime_checkable


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
