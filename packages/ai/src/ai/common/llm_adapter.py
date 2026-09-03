# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Normalized LLM provider interface: one Event shape for every provider.

ChatBase consumes Adapters and never touches provider-native content shapes.
Design: repo discussion #1679 (RFC — virtualized provider Adapter).
"""

import threading
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Any, Callable, Iterator, Optional, Protocol, runtime_checkable

from ai.common.utils import flatten_content_blocks

# Per-turn LLM usage collector. Every model call appends one entry to the open turn's
# list; a scope (turn_usage) reads the entries added while it was open and hangs them on
# the Answer.
#
# The list lives in a ContextVar, but the VALUE is a mutable list appended IN PLACE —
# never re-``.set()``. That distinction is the whole design:
#   - Per-turn isolation: two turns that overlap in time each get their own list, so one
#     turn's Trace never shows another's tokens, and the list dies with its scope (no
#     global clear, no unbounded growth under load). Concurrent turns are normal here —
#     agent_rocketride/executor.py runs a tool wave on a ThreadPoolExecutor, and one
#     pipeline is started per inbound message via asyncio.to_thread.
#   - Cross-thread capture: contextvars.copy_context() copies the mapping, not the
#     values, so a worker thread that runs under copy_context().run(...) (CrewAI/deepagent
#     kickoffs; a ThreadPoolExecutor wave that submits copy_context().run) inherits the
#     SAME list object — its appends are visible to the reader that opened the turn.
# A lock keeps concurrent appends race-free with the reader's slice.
_USAGE_LOCK = threading.Lock()
_TURN_CALLS: ContextVar[Optional[list]] = ContextVar('llm_turn_calls', default=None)


def _record_usage(call: dict) -> None:
    """Append one model call's usage to the open turn's collector (thread-safe).

    A no-op when no turn is open (a bare LLM call outside any ``turn_usage`` scope): the
    call is simply not collected for a Trace. Billing is unaffected — ``report_llm_tokens``
    fires its counters regardless of whether a turn is open.
    """
    calls = _TURN_CALLS.get()
    if calls is None:
        return
    with _USAGE_LOCK:
        calls.append(call)


@contextmanager
def turn_usage():
    """Scope one Answer's model calls; yields a reader for the usage they produced.

    Every scope owns its OWN list and, on exit, extends its parent's list under the lock.
    A reader therefore sees exactly the calls made in its own scope, and nothing else:

    - Nesting-safe: an agent drives sub-agents (or per-call ``ask`` invokes), each a nested
      scope. The nested reader sees only its own calls; the parent, which reads after the
      child has exited and folded its calls in, sees the whole turn.
    - Concurrency-safe two ways: two independent turns never share a list (the ContextVar
      default is None outside any scope), AND two sibling scopes inside one turn — a
      parallel tool wave where each tool drives an LLM invoke — each get their own list, so
      neither per-invoke reader shows the other's tokens. A shared turn list sliced by an
      offset could not tell concurrent siblings apart (both would open at offset 0).

    The list is reachable only through its scope, so it is freed when the scope exits — no
    global clear and no depth counter.
    """
    parent = _TURN_CALLS.get()
    calls: list = []
    token = _TURN_CALLS.set(calls)
    try:
        yield lambda: aggregate_usage(calls)
    finally:
        _TURN_CALLS.reset(token)
        # Fold this scope's calls into the parent so the outer turn still sees them.
        if parent is not None:
            with _USAGE_LOCK:
                parent.extend(calls)


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


def is_usage_flag_rejection(e: Exception) -> bool:
    """True when an endpoint refused the request itself, so one retry without the flag pays off.

    Any 4xx means the endpoint rejected this request as written: 400 (BadRequestError) is
    what the openai SDK raises for an unknown ``stream_options.include_usage``, and 422
    (UnprocessableEntityError) is what a FastAPI-based server — vLLM's OpenAI-compatible
    server is one — answers request-validation failures with. Auth, timeout and rate-limit
    statuses say nothing about the flag, so they re-raise without a second round trip, and a
    transient connection failure carries no ``status_code`` at all.
    """
    status = getattr(e, 'status_code', None)
    return isinstance(status, int) and 400 <= status < 500 and status not in (401, 403, 408, 429)


def debug_usage_failure(exc: BaseException) -> None:
    """Leave an operational trace for a metering failure without ever raising.

    Every usage read is best-effort: accounting must not cost the user the answer they
    already paid for. Shared so the drivers that report from their own call site
    (they override the ``ChatBase`` seam and never reach the Adapter) fail the same way.
    """
    try:
        from rocketlib import debug

        debug(f'LLM token reporting failed: {type(exc).__name__}')
    except Exception:
        pass


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
        # The counters (above) carry the billable totals; task_metrics rolls them up.
        # Record the per-call detail on the turn collector for the Trace instead of a
        # per-call metrics.event — that fed an unbounded events list re-serialized in
        # full after every object (multi-MB metric lines on long-lived chat tasks).
        _record_usage({'input': it, 'output': ot, 'cache_read': cr, 'cache_creation': cc, 'model': model})
    except Exception as exc:
        # Best-effort accounting: keep the chat turn alive, but leave an operational trace.
        debug_usage_failure(exc)


def aggregate_usage(calls: Optional[list] = None) -> Optional[dict]:
    """Aggregate one scope's model calls into the dict the Trace renders.

    ``calls`` is the scope's own collector — how a scope isolates itself from its
    concurrent siblings is that each owns its list (see ``turn_usage``), never an offset
    into a shared one. It defaults to the current context's list so a caller inside a
    ``turn_usage`` scope can read it without threading the list through. One call returns
    that call unchanged, so a single-call invoke renders as plain totals with no
    redundant breakdown.
    """
    if calls is None:
        calls = _TURN_CALLS.get() or []
    with _USAGE_LOCK:
        calls = list(calls)
    if not calls:
        return None
    if len(calls) == 1:
        return dict(calls[0])
    total = {k: sum(int(c.get(k, 0)) for c in calls) for k in ('input', 'output', 'cache_read', 'cache_creation')}
    return {**total, 'model': calls[-1].get('model', ''), 'calls': len(calls), 'breakdown': list(calls)}


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


def report_usage_metadata(usage: Any, llm: Any) -> None:
    """Extract LangChain ``usage_metadata`` and report it (fresh input + cache split).

    Public because a driver that overrides ``ChatBase._chat`` bypasses ``collect()``
    and has to report from its own call site to be metered at all.
    """
    if not isinstance(usage, dict):
        return
    # Best-effort like report_llm_tokens itself: the split runs before that guard, so a
    # provider answering a non-numeric count would otherwise turn a paid, successful
    # response into a failed turn (a retry loop reads the raise as a provider error).
    try:
        model = getattr(llm, 'model', None) or getattr(llm, 'model_name', '') or ''
        fresh, out, cr, cc = _split_input_cache(usage)
    except Exception as exc:
        debug_usage_failure(exc)
        return
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
        # OpenAI-family models only emit streaming usage when asked. Ask whichever model
        # declares the flag rather than matching on the class name: ChatXAI inherits it
        # from BaseChatOpenAI without carrying 'OpenAI' in its name, and a model that
        # lacks it (ChatBedrock) would reject it as an unknown kwarg. langchain-openai
        # sends stream_options.include_usage only when this is on, so without it every
        # custom-base-URL provider (xAI, DeepSeek, Qwen, Together, Groq, self-hosted vLLM)
        # bills zero. So we ask unconditionally and RETRY once without it if the endpoint
        # rejects it before the first chunk — the old-vLLM/strict-proxy case. That makes
        # metering the default for the whole OpenAI-compatible family while the
        # incompatible minority still streams (it just goes unmetered). An explicit
        # stream_usage in stream_kwargs (a node/operator override) wins over this default.
        skw = dict(self.stream_kwargs)
        ask_usage = hasattr(self.llm, 'stream_usage') and 'stream_usage' not in skw
        if ask_usage:
            skw['stream_usage'] = True
        total_in = out_toks = cache_read = cache_creation = 0

        def _open(kw: dict):
            # Pull the first chunk here: a 400 on stream_options.include_usage raises on
            # this call, before anything has been yielded downstream, so the retry is safe.
            gen = self.llm.stream(self.history, **kw)
            return gen, next(gen)

        try:
            gen, piece = _open(skw)
        except StopIteration:
            gen, piece = None, None
        except Exception as e:
            # Retry without the usage flag ONLY for the failure it causes: a client error
            # rejecting stream_options.include_usage (an old vLLM/strict proxy — 400 from the
            # openai SDK, 422 from a FastAPI-based server). Re-raise everything else — a
            # 401/429 surfaces without a second round trip, and a transient connection/timeout
            # (no status_code) is not mistaken for a flag rejection and silently retried
            # unmetered.
            if not ask_usage or not is_usage_flag_rejection(e):
                raise
            from rocketlib import warning

            warning(
                f'LangChain stream rejected stream_usage ({type(e).__name__}); '
                'retrying without include_usage (this call is unmetered).'
            )
            skw.pop('stream_usage', None)
            try:
                gen, piece = _open(skw)
            except StopIteration:
                gen, piece = None, None

        # try/finally so a mid-stream raise still records the usage the chunks already
        # carried, matching the two native adapters.
        try:
            while piece is not None:
                um = getattr(piece, 'usage_metadata', None)
                if isinstance(um, dict):
                    # LangChain's usage_metadata is additive by contract (AIMessageChunk
                    # merges chunks with add_usage), but every provider we reach emits it
                    # on exactly one chunk, so max() == that single total. If one ever
                    # streams usage across chunks, switch these to summing the deltas.
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
                try:
                    piece = next(gen)
                except StopIteration:
                    break
            tail_text, tail_thinking = parse.flush()
            if tail_thinking:
                yield Event('thinking', tail_thinking)
            if tail_text:
                parts.append(tail_text)
                yield Event('text', tail_text)
        finally:
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
        report_usage_metadata(getattr(result, 'usage_metadata', None), self.llm)
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
                elif etype in ('response.completed', 'response.incomplete', 'response.failed', 'response.error'):
                    resp = getattr(event, 'response', None)
                    # Terminal events (success, incomplete, OR failure) can carry usage;
                    # a truncated or failed request may already be chargeable, so read it.
                    u = getattr(resp, 'usage', None) if resp is not None else None
                    if u is not None:
                        input_tokens = int(getattr(u, 'input_tokens', 0) or 0)
                        output_tokens = int(getattr(u, 'output_tokens', 0) or 0)
                        # cached_tokens are part of input_tokens; split them out.
                        cache_read = int(getattr(getattr(u, 'input_tokens_details', None), 'cached_tokens', 0) or 0)
                    if etype in ('response.failed', 'response.error'):
                        self.finish_reason = 'error'
                    elif etype == 'response.incomplete':
                        # Separate terminal event (e.g. max_output_tokens); map its reason.
                        details = getattr(resp, 'incomplete_details', None)
                        self.finish_reason = (getattr(details, 'reason', None) if details else None) or 'length'
                    else:  # response.completed
                        status = getattr(resp, 'status', None) if resp is not None else None
                        if status == 'incomplete':
                            details = getattr(resp, 'incomplete_details', None)
                            self.finish_reason = (getattr(details, 'reason', None) if details else None) or 'length'
                        else:
                            self.finish_reason = 'stop' if status == 'completed' else (status or 'stop')
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
