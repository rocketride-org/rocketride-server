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

from ai.common.utils import flatten_content_blocks


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
        # Inline `<think>` tags are a stateful concern owned by this streaming path;
        # the block vocabulary is not, so it stays in flatten_content_blocks.
        if isinstance(content, str):
            return think_split(content)
        text, thinking, sig_only = flatten_content_blocks(content)
        if sig_only and not state['signature_noted'] and has_reasoning_sink:
            thinking += (
                '_Extended thinking ran, but this stream only delivered the '
                'block verification signature, not the readable chain-of-thought '
                'text. The answer below still reflects internal reasoning._\n\n'
            )
            state['signature_noted'] = True
        return text, thinking

    feed.flush = think_split.flush  # type: ignore[attr-defined]
    return feed


def flatten_content_parts(content: Any) -> tuple[str, str]:
    """Collapse a full (non-streamed) message content into (visible_text, reasoning)."""
    parse = _make_stream_content_parser(False)
    text, thinking = parse(content)
    tail, tail_thinking = parse.flush()
    return text + tail, thinking + tail_thinking


def flatten_content(content: Any) -> str:
    """Collapse a full (non-streamed) message content to visible text, dropping thinking.

    Non-streaming callers (agents, expectJson) must get a string, never a block list.
    """
    return flatten_content_parts(content)[0]


def report_llm_tokens(
    input_tokens: int = 0,
    output_tokens: int = 0,
    *,
    model: str = '',
    cache_read_tokens: int = 0,
    cache_creation_tokens: int = 0,
) -> None:
    """Surface per-run LLM token usage to the metrics singleton.

    Reported in the subprocess via ``metrics.counter``; ``task_metrics`` accumulates
    it per ``client_id`` (>MET*) so usage bills per user. A counter becomes billable
    only when its name has a rate in the ``metrics_conversions`` table; it flows as a
    raw count regardless.

    ``input_tokens`` is fresh (non-cached) input. Cache-read and cache-creation tokens
    ride their own counters because providers bill them at rates distinct from fresh
    input; the four counters are disjoint. Best-effort: never break a chat turn.
    """
    try:
        it = int(input_tokens or 0)
        ot = int(output_tokens or 0)
        cr = int(cache_read_tokens or 0)
        cc = int(cache_creation_tokens or 0)
        if not (it or ot or cr or cc):
            return
        from ai.web.metrics import metrics

        if it:
            metrics.counter('llm_input_tokens', it)
        if ot:
            metrics.counter('llm_output_tokens', ot)
        if cr:
            metrics.counter('llm_cache_read_tokens', cr)
        if cc:
            metrics.counter('llm_cache_creation_tokens', cc)
        metrics.event(
            {'llm_tokens': {'input': it, 'output': ot, 'cache_read': cr, 'cache_creation': cc, 'model': model}}
        )
    except Exception as exc:
        # Best-effort accounting: keep the chat turn alive, but leave an operational trace.
        try:
            from rocketlib import debug

            debug(f'LLM token reporting failed: {type(exc).__name__}')
        except Exception:
            pass


def _split_input_cache(um: dict) -> tuple[int, int, int, int]:
    """From a LangChain ``usage_metadata`` dict, return
    ``(fresh_input, output, cache_read, cache_creation)``. LangChain reports
    ``input_tokens`` as the full prompt (cache included), so the cache detail is
    subtracted back out to keep the four counters disjoint.
    """
    out = int(um.get('output_tokens') or 0)
    total_in = int(um.get('input_tokens') or 0)
    det = um.get('input_token_details')
    det = det if isinstance(det, dict) else {}
    cr = int(det.get('cache_read') or 0)
    cc = int(det.get('cache_creation') or 0)
    return max(0, total_in - cr - cc), out, cr, cc


def _report_usage_metadata(usage: Any, llm: Any) -> None:
    """Extract LangChain ``usage_metadata`` and report it (fresh input + cache split)."""
    if not isinstance(usage, dict):
        return
    model = getattr(llm, 'model', None) or getattr(llm, 'model_name', '') or ''
    fresh, out, cr, cc = _split_input_cache(usage)
    report_llm_tokens(fresh, out, model=str(model), cache_read_tokens=cr, cache_creation_tokens=cc)


class LangChainAdapter:
    """Wraps a LangChain chat model so non-reasoning providers speak the Event contract.

    ``done.items`` is the assistant text turn — LangChain carries no opaque reasoning state.
    """

    def __init__(self, llm: Any, history: list[Any] | None = None, stream_kwargs: dict | None = None):
        self.llm = llm
        self.history: list[Any] = history if history is not None else []
        self.stream_kwargs = stream_kwargs or {}
        self.finish_reason: Optional[str] = None
        # Reasoning drained by the last collect(); kept off the visible text.
        self.reasoning: str = ''

    def stream(self, user_text: str) -> Iterator[Event]:
        self.history.append({'role': 'user', 'content': user_text})
        parse = _make_stream_content_parser(True)
        parts: list[str] = []
        # OpenAI-family models only emit streaming usage when asked; others (e.g.
        # Anthropic) emit it by default, so scope the flag to avoid an unknown kwarg.
        skw = dict(self.stream_kwargs)
        if 'OpenAI' in type(self.llm).__name__:
            skw.setdefault('stream_usage', True)
        total_in = out_toks = cache_read = cache_creation = 0
        for piece in self.llm.stream(self.history, **skw):
            um = getattr(piece, 'usage_metadata', None)
            if isinstance(um, dict):
                # Chunks carry cumulative counts; max() lands on the final totals.
                total_in = max(total_in, int(um.get('input_tokens') or 0))
                out_toks = max(out_toks, int(um.get('output_tokens') or 0))
                det = um.get('input_token_details')
                if isinstance(det, dict):
                    cache_read = max(cache_read, int(det.get('cache_read') or 0))
                    cache_creation = max(cache_creation, int(det.get('cache_creation') or 0))
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
        report_llm_tokens(
            max(0, total_in - cache_read - cache_creation),
            out_toks,
            model=str(getattr(self.llm, 'model', None) or getattr(self.llm, 'model_name', '') or ''),
            cache_read_tokens=cache_read,
            cache_creation_tokens=cache_creation,
        )
        assistant = {'role': 'assistant', 'content': ''.join(parts)}
        self.history.append(assistant)
        yield Event('done', items=[assistant])

    def collect(self, user_text: str) -> tuple[str, list[Any]]:
        """Non-streaming drain: invoke() + shared normalization. A genuinely different
        mechanism from stream(), so it can still recover when streaming fails.
        """
        had_history = bool(self.history)
        self.history.append({'role': 'user', 'content': user_text})
        # Single-turn callers keep the historical contract: the backend is handed the
        # prompt string it was given, not a one-element message list.
        payload = self.history if had_history else user_text
        result = self.llm.invoke(payload, **self.stream_kwargs)
        _report_usage_metadata(getattr(result, 'usage_metadata', None), self.llm)
        text, self.reasoning = flatten_content_parts(getattr(result, 'content', ''))
        assistant = {'role': 'assistant', 'content': text}
        self.history.append(assistant)
        return text, [assistant]


class NativeOpenAIResponsesAdapter:
    """Bridges the OpenAI Responses reasoning stream (create/stream=True) to Events."""

    def __init__(self, chat: Any):
        # Single-turn: history is not accepted (the request is built from user_text, not history).
        self.chat = chat
        self.history: list[Any] = []
        self.finish_reason: Optional[str] = None

    def stream(self, user_text: str) -> Iterator[Event]:
        self.history.append({'role': 'user', 'content': user_text})
        chat = self.chat
        parts: list[str] = []
        input_tokens = output_tokens = cache_read = 0
        stream = chat._raw_client.responses.create(
            model=chat._model,
            input=user_text,
            store=False,  # stateless: don't retain prompts/responses server-side (30-day default).
            reasoning={'summary': 'auto'},
            max_output_tokens=chat._modelOutputTokens,
            stream=True,
        )
        # try/finally + close() so a raise or early GeneratorExit releases the HTTP
        # stream, matching NativeAnthropicAdapter's cleanup.
        try:
            for event in stream:
                etype = getattr(event, 'type', '') or ''
                if etype == 'response.reasoning_summary_text.delta':
                    delta = getattr(event, 'delta', '') or ''
                    if delta:
                        yield Event('thinking', delta)
                elif etype == 'response.output_text.delta':
                    delta = getattr(event, 'delta', '') or ''
                    if delta:
                        parts.append(delta)
                        yield Event('text', delta)
                elif etype == 'response.completed':
                    resp = getattr(event, 'response', None)
                    # Responses API reports token usage on the terminal event.
                    u = getattr(resp, 'usage', None) if resp is not None else None
                    if u is not None:
                        input_tokens = int(getattr(u, 'input_tokens', 0) or 0)
                        output_tokens = int(getattr(u, 'output_tokens', 0) or 0)
                        # cached_tokens are part of input_tokens; split them out.
                        cache_read = int(getattr(getattr(u, 'input_tokens_details', None), 'cached_tokens', 0) or 0)
                    status = getattr(resp, 'status', None) if resp is not None else None
                    if status == 'incomplete':
                        details = getattr(resp, 'incomplete_details', None)
                        self.finish_reason = (getattr(details, 'reason', None) if details else None) or 'length'
                    else:
                        self.finish_reason = 'stop' if status == 'completed' else (status or 'stop')
                elif etype in ('response.failed', 'response.error'):
                    self.finish_reason = 'error'
        finally:
            closer = getattr(stream, 'close', None)
            if callable(closer):
                try:
                    closer()
                except Exception:
                    pass
            # Record usage even if the stream raised mid-way — a partial request
            # can already have provider-reported input/cache/output tokens.
            report_llm_tokens(
                max(0, input_tokens - cache_read),
                output_tokens,
                model=str(getattr(self.chat, '_model', '') or ''),
                cache_read_tokens=cache_read,
            )
        assistant = {'role': 'assistant', 'content': ''.join(parts)}
        self.history.append(assistant)
        yield Event('done', items=[assistant])
