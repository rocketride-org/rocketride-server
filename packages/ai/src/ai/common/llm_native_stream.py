# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Central registry for LLM streaming paths that bypass or augment LangChain's
# aggregated .stream() when a provider drops reasoning deltas on the wire.
# =============================================================================

"""Provider-specific streaming handlers that preserve reasoning deltas LangChain drops.

Drivers opt in via ``self._native_stream_provider``; ChatBase dispatches here before
the generic stream.
"""

from __future__ import annotations

import contextvars
from typing import Any, Callable, Dict, List, Optional

from rocketlib import debug, warning

# Per-call carrier for API-level stop sequences (e.g. CrewAI's ReAct "\nObservation:").
# Set on the ask path in llm_base._question and read at every model sink so the stop
# reaches the provider API instead of relying only on post-hoc text truncation. A
# contextvar (not a param) keeps the many ChatBase._chat/chat() provider overrides and
# the fixed-signature native handlers below untouched, and is concurrency-safe.
STOP_SEQUENCES_VAR: contextvars.ContextVar[Optional[List[str]]] = contextvars.ContextVar(
    'rocketride_llm_stop_sequences', default=None
)

# --- Anthropic: model id gates (vendor prefixes) ---

_VENDOR_MODEL_PREFIXES = (
    'openrouter/',
    'openai/',
    'anthropic/',
    'vertex_ai/',
    'google/',
)


def gate_model_name(model: str) -> str:
    """Strip routing prefixes so ``openrouter/anthropic/claude-opus-4-7`` matches Claude gates."""
    m = (model or '').strip().lower()
    for _ in range(8):
        stripped = False
        for p in _VENDOR_MODEL_PREFIXES:
            if m.startswith(p):
                m = m[len(p) :]
                stripped = True
                break
        if not stripped:
            break
    return m


def build_anthropic_thinking_kwargs(model_gate: str, model_output_tokens: int) -> Dict[str, Any]:
    """Return ``ChatAnthropic`` thinking kwargs by model name, or ``{}`` if unsupported."""
    if 'haiku' in model_gate:
        return {}  # Haiku has no extended thinking — sending it 400s.
    out: Dict[str, Any] = {}
    if model_gate.startswith('claude-opus-4-7') or model_gate.startswith('claude-opus-4-8'):
        out['thinking'] = {'type': 'adaptive', 'display': 'summarized'}
    else:
        budget = max(2048, model_output_tokens // 2)
        if budget >= model_output_tokens:
            budget = model_output_tokens - 1024
        if budget < 1024:
            return {}  # output window too small for a valid thinking budget
        out['betas'] = ['interleaved-thinking-2025-05-14']
        out['thinking'] = {'type': 'enabled', 'budget_tokens': budget}
    return out


# --- Anthropic native Messages API stream ---

_NATIVE_CREATE_KEYS = frozenset(
    {
        'model',
        'messages',
        'max_tokens',
        'system',
        'temperature',
        'top_p',
        'top_k',
        'stop_sequences',
        'stream',
        'metadata',
        'thinking',
        'tools',
        'tool_choice',
        'betas',
        'service_tier',
        'container',
        'output_config',
        'inference_geo',
        'cache_control',
    }
)


def _map_claude_stop_reason(stop_reason: Any) -> Optional[str]:
    if stop_reason is None:
        return None
    s = str(stop_reason).lower()
    if s in ('end_turn', 'stop_sequence'):
        return 'stop'
    if s in ('max_tokens', 'model_context_window_exceeded', 'length'):
        return 'length'
    if 'error' in s:
        return 'error'
    return 'stop'


def _delta_type_name(delta: Any) -> str:
    if delta is None:
        return ''
    t = getattr(delta, 'type', None)
    if t is None:
        return ''
    v = getattr(t, 'value', t)
    return str(v)


def _event_type_name(event: Any) -> str:
    if event is None:
        return ''
    t = getattr(event, 'type', None)
    if t is None:
        return ''
    v = getattr(t, 'value', t)
    return str(v)


def _payload_for_native_create(payload: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in payload.items() if k in _NATIVE_CREATE_KEYS and v is not None}


def _open_raw_message_stream(client: Any, payload: dict[str, Any]):
    safe = _payload_for_native_create(payload)
    try:
        if safe.get('betas'):
            return client.beta.messages.create(**safe)
        return client.messages.create(**safe)
    except TypeError as first_err:
        minimal = {
            k: safe[k]
            for k in ('model', 'messages', 'max_tokens', 'stream', 'thinking', 'temperature', 'system')
            if k in safe
        }
        debug(f'llm_native_stream: anthropic create TypeError ({first_err!r}); retrying minimal keys {list(minimal)}')
        if safe.get('betas'):
            minimal['betas'] = safe['betas']
            return client.beta.messages.create(**minimal)
        return client.messages.create(**minimal)


def anthropic_extended_thinking_active(chat: Any) -> bool:
    if getattr(chat, '_extended_thinking', False):
        return True
    llm = getattr(chat, '_llm', None)
    if llm is None:
        return False
    if getattr(llm, 'thinking', None):
        return True
    mk = getattr(llm, 'model_kwargs', None) or {}
    return bool(mk.get('thinking'))


def _stream_anthropic_messages_api(
    chat: Any,
    prompt: str,
    on_chunk: Callable[[str], None],
    on_finish: Optional[Callable[[Optional[str]], None]],
    on_reasoning_chunk: Optional[Callable[[str], None]],
) -> str:
    llm = chat._llm
    # INVARIANT: read synchronously within the ask() call, while LLMBase._question still
    # holds the contextvar (before its finally reset). The stream is consumed here, not
    # deferred to the caller, so this never runs after the reset (which would send None).
    payload: dict[str, Any] = dict(llm._get_request_payload(prompt, stop=STOP_SEQUENCES_VAR.get() or None, stream=True))
    _raw_client = getattr(llm, '_client', None)
    client = _raw_client() if callable(_raw_client) else _raw_client
    if client is None:
        raise RuntimeError('ChatAnthropic has no _client for native streaming')

    parts: list[str] = []
    finish_reason: Optional[str] = None
    reasoning_deltas = 0
    raw_stream = _open_raw_message_stream(client, payload)

    try:
        for event in raw_stream:
            et = _event_type_name(event)
            if et == 'content_block_delta':
                delta = getattr(event, 'delta', None)
                if delta is None:
                    continue
                dt = _delta_type_name(delta)
                if dt == 'thinking_delta' and on_reasoning_chunk is not None:
                    piece = getattr(delta, 'thinking', None) or ''
                    if piece:
                        on_reasoning_chunk(piece)
                        reasoning_deltas += 1
                elif dt == 'text_delta' and on_chunk is not None:
                    piece = getattr(delta, 'text', None) or ''
                    if piece:
                        on_chunk(piece)
                        parts.append(piece)
            elif et == 'message_delta':
                md = getattr(event, 'delta', None)
                if md is not None:
                    sr = getattr(md, 'stop_reason', None)
                    if sr is not None:
                        finish_reason = _map_claude_stop_reason(sr)
    finally:
        closer = getattr(raw_stream, 'close', None)
        if callable(closer):
            try:
                closer()
            except Exception:
                pass

    if not parts:
        raise RuntimeError('Anthropic SDK stream produced no text')

    if on_finish is not None:
        on_finish(finish_reason)

    return ''.join(parts)


def try_anthropic_native_chat_stream(
    chat: Any,
    prompt: str,
    on_chunk: Callable[[str], None],
    on_finish: Optional[Callable[[Optional[str]], None]],
    on_reasoning_chunk: Optional[Callable[[str], None]],
) -> Optional[str]:
    """Return full assistant text if native Anthropic streaming handled the call."""
    if not anthropic_extended_thinking_active(chat):
        return None

    try:
        text = _stream_anthropic_messages_api(chat, prompt, on_chunk, on_finish, on_reasoning_chunk)
        return text
    except Exception as e:
        warning(
            f'llm_native_stream anthropic: native stream failed ({type(e).__name__}): {e} '
            '(falling back to LangChain; thinking text may be missing).'
        )
        return None


# --- OpenAI-compatible Chat Completions with reasoning_content ---
# langchain-openai drops delta.reasoning_content, so we stream via the raw openai
# SDK (DeepSeek, Qwen, xAI, GMI, Ollama, …). ChatBase auto-wires this in chat_string.


def try_openai_compat_reasoning_stream(
    chat: Any,
    prompt: str,
    on_chunk: Callable[[str], None],
    on_finish: Optional[Callable[[Optional[str]], None]],
    on_reasoning_chunk: Optional[Callable[[str], None]],
) -> Optional[str]:
    """Stream via the raw ``openai`` SDK to preserve ``delta.reasoning_content``."""
    client = getattr(chat, '_raw_openai_client', None)
    if client is None:
        return None
    kwargs: Dict[str, Any] = {
        'model': chat._model,
        'messages': [{'role': 'user', 'content': prompt}],
        'stream': True,
        'max_tokens': chat._modelOutputTokens,
    }
    kwargs.update(getattr(chat, '_reasoning_kwargs', {}))

    parts: list[str] = []
    finish_reason: Optional[str] = None
    try:
        for chunk in client.chat.completions.create(**kwargs):
            if not chunk.choices:
                continue
            ch = chunk.choices[0]
            delta = ch.delta
            rc = getattr(delta, 'reasoning_content', None)
            if rc and on_reasoning_chunk is not None:
                on_reasoning_chunk(rc)
            if delta.content:
                on_chunk(delta.content)
                parts.append(delta.content)
            if ch.finish_reason:
                finish_reason = ch.finish_reason
    except Exception as e:
        warning(
            f'llm_native_stream openai_compat_reasoning: stream failed ({type(e).__name__}): {e} '
            '(falling back to non-streaming chat).'
        )
        return None

    if not parts:
        return None
    if on_finish is not None:
        on_finish(finish_reason or 'stop')
    return ''.join(parts)


# --- registry ---

NativeStreamFn = Callable[
    [Any, str, Callable[[str], None], Optional[Callable[[Optional[str]], None]], Optional[Callable[[str], None]]],
    Optional[str],
]

_NATIVE_STREAM_REGISTRY: dict[str, NativeStreamFn] = {}


def register_native_stream_handler(name: str, fn: NativeStreamFn) -> None:
    """Register a provider-specific streaming handler (tests may replace)."""
    _NATIVE_STREAM_REGISTRY[name] = fn


def dispatch_native_chat_stream(
    chat: Any,
    prompt: str,
    on_chunk: Optional[Callable[[str], None]],
    on_finish: Optional[Callable[[Optional[str]], None]],
    on_reasoning_chunk: Optional[Callable[[str], None]],
) -> Optional[str]:
    """If a registered handler fully serves the stream, return the answer string."""
    if on_chunk is None:
        return None
    key = getattr(chat, '_native_stream_provider', None)
    if not key:
        return None
    fn = _NATIVE_STREAM_REGISTRY.get(str(key))
    if fn is None:
        return None
    return fn(chat, prompt, on_chunk, on_finish, on_reasoning_chunk)


def _register_builtin_handlers() -> None:
    register_native_stream_handler('anthropic', try_anthropic_native_chat_stream)
    register_native_stream_handler('openai_compat_reasoning', try_openai_compat_reasoning_stream)


_register_builtin_handlers()
