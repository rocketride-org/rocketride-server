# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Central registry for LLM streaming paths that bypass or augment LangChain's
# aggregated .stream() when a provider drops reasoning deltas on the wire.
# =============================================================================

"""Native / provider-specific streaming hooks for :class:`ai.common.chat.ChatBase`.

Drivers opt in by setting ``self._native_stream_provider`` to a registered key
(e.g. ``\"anthropic\"`` or ``\"mistral\"``). :meth:`ChatBase.chat_string` calls
:func:`dispatch_native_chat_stream` before the generic LangChain stream loop.
"""

from __future__ import annotations

from typing import Any, Callable, Dict, Optional

from rocketlib import debug, warning

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


def build_anthropic_thinking_kwargs(model_gate: str, model_output_tokens: int, enabled: bool) -> Dict[str, Any]:
    """Return extra ``ChatAnthropic`` kwargs for extended thinking, or ``{}`` if disabled."""
    if not enabled:
        return {}
    out: Dict[str, Any] = {'temperature': 1}
    if not model_gate.startswith('claude-opus-4-7'):
        out['betas'] = ['interleaved-thinking-2025-05-14']
    if model_gate.startswith('claude-opus-4-7'):
        out['thinking'] = {'type': 'adaptive', 'display': 'summarized'}
    else:
        budget = max(2048, model_output_tokens // 2)
        if budget >= model_output_tokens:
            budget = model_output_tokens - 1024
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
    payload: dict[str, Any] = dict(llm._get_request_payload(prompt, stop=None, stream=True))
    _raw_client = getattr(llm, '_client', None)
    client = _raw_client() if callable(_raw_client) else _raw_client
    if client is None:
        raise RuntimeError('ChatAnthropic has no _client for native streaming')

    if on_reasoning_chunk is not None and anthropic_extended_thinking_active(chat):
        on_reasoning_chunk('_Thinking…_\n\n')

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


# --- Mistral: official SDK chat.stream (no LangChain _llm on this driver) ---


def _mistral_thinking_sub_to_reasoning(sub: Any) -> str:
    if sub is None:
        return ''
    if isinstance(sub, str):
        return sub
    typ = getattr(sub, 'type', None)
    if typ is None and isinstance(sub, dict):
        typ = sub.get('type')
    typ_s = str(typ).lower() if typ is not None else ''
    if typ_s == 'text':
        txt = getattr(sub, 'text', None)
        if txt is None and isinstance(sub, dict):
            txt = sub.get('text')
        return str(txt or '')
    return ''


def _mistral_split_delta(delta: Any) -> tuple[str, str]:
    """Split a Mistral stream ``delta`` into (answer_text, reasoning_text)."""
    answer, reasoning = '', ''
    if delta is None:
        return answer, reasoning
    content = getattr(delta, 'content', None)
    if content is None:
        return answer, reasoning
    if isinstance(content, str):
        return content, reasoning
    if not isinstance(content, list):
        return answer, reasoning
    for c in content:
        if c is None:
            continue
        typ = getattr(c, 'type', None)
        if typ is None and isinstance(c, dict):
            typ = c.get('type')
        typ_s = str(typ).lower() if typ is not None else ''
        if typ_s == 'text':
            txt = getattr(c, 'text', None)
            if txt is None and isinstance(c, dict):
                txt = c.get('text')
            if txt:
                answer += str(txt)
        elif typ_s == 'thinking':
            tl = getattr(c, 'thinking', None)
            if tl is None and isinstance(c, dict):
                tl = c.get('thinking')
            if isinstance(tl, list):
                for sub in tl:
                    reasoning += _mistral_thinking_sub_to_reasoning(sub)
    return answer, reasoning


def _mistral_finish_map(fr: Any) -> Optional[str]:
    if fr is None:
        return None
    s = str(fr).lower()
    if s in ('stop', 'end_turn'):
        return 'stop'
    if s in ('length', 'max_tokens', 'model_length'):
        return 'length'
    if 'error' in s:
        return 'error'
    return s or 'stop'


def _mistral_consume_stream_event(
    event: Any,
    on_chunk: Callable[[str], None],
    on_reasoning_chunk: Optional[Callable[[str], None]],
    parts: list[str],
) -> Optional[str]:
    """Append streamed text to ``parts``; return mapped finish_reason if present."""
    chunk = getattr(event, 'data', None)
    if chunk is None:
        return None
    choices = getattr(chunk, 'choices', None) or []
    finish_out: Optional[str] = None
    for ch in choices:
        delta = getattr(ch, 'delta', None)
        if delta is not None:
            ans, reas = _mistral_split_delta(delta)
            if reas and on_reasoning_chunk is not None:
                on_reasoning_chunk(reas)
            if ans:
                on_chunk(ans)
                parts.append(ans)
        fr = getattr(ch, 'finish_reason', None)
        if fr is not None:
            finish_out = _mistral_finish_map(fr)
    return finish_out


def try_mistral_native_chat_stream(
    chat: Any,
    prompt: str,
    on_chunk: Callable[[str], None],
    on_finish: Optional[Callable[[Optional[str]], None]],
    on_reasoning_chunk: Optional[Callable[[str], None]],
) -> Optional[str]:
    """Stream via ``mistralai`` :meth:`chat.stream`; return full text or ``None`` to fall back."""
    client = getattr(chat, '_client', None)
    if client is None:
        return None
    stream_fn = getattr(client.chat, 'stream', None)
    if not callable(stream_fn):
        return None

    model = chat._model
    messages = [{'role': 'user', 'content': prompt}]
    kwargs: Dict[str, Any] = {
        'model': model,
        'messages': messages,
        'temperature': 0.0,
        'max_tokens': chat._modelOutputTokens,
        'stream': True,
    }
    if 'magistral' in model.lower():
        kwargs['prompt_mode'] = 'reasoning'
        if on_reasoning_chunk is not None:
            on_reasoning_chunk('_Thinking…_\n\n')

    stream_result: Any = None
    try:
        stream_result = stream_fn(**kwargs)
    except TypeError as first_err:
        debug(f'llm_native_stream mistral: stream TypeError ({first_err!r}); retrying without optional kwargs')
        kwargs.pop('prompt_mode', None)
        try:
            stream_result = stream_fn(**kwargs)
        except TypeError:
            kwargs.pop('max_tokens', None)
            try:
                stream_result = stream_fn(model=model, messages=messages, temperature=0.0, stream=True)
            except Exception as inner_e:
                debug(f'llm_native_stream mistral: stream() unavailable ({inner_e!s})')
                return None
        except Exception as mid_e:
            debug(f'llm_native_stream mistral: stream retry failed ({mid_e!s})')
            return None
    except Exception as outer_e:
        debug(f'llm_native_stream mistral: stream open FAIL {type(outer_e).__name__}: {outer_e!s}')
        return None

    if stream_result is None:
        return None

    parts: list[str] = []
    finish_reason: Optional[str] = None
    try:
        if hasattr(stream_result, '__enter__'):
            with stream_result as event_stream:
                for event in event_stream:
                    fr = _mistral_consume_stream_event(event, on_chunk, on_reasoning_chunk, parts)
                    if fr is not None:
                        finish_reason = fr
        else:
            for event in stream_result:
                fr = _mistral_consume_stream_event(event, on_chunk, on_reasoning_chunk, parts)
                if fr is not None:
                    finish_reason = fr
    except Exception as e:
        warning(
            f'llm_native_stream mistral: stream failed ({type(e).__name__}): {e} (falling back to non-streaming chat).'
        )
        return None

    if not parts:
        return None

    text = ''.join(parts)
    if on_finish is not None:
        on_finish(finish_reason)
    return text


# --- OpenAI-compatible Chat Completions with reasoning_content ---
#
# langchain-openai (1.2.x) explicitly drops non-standard delta fields like
# `reasoning_content`. Providers that use the OpenAI Chat Completions shape
# (Qwen/DashScope, DeepSeek, xAI Grok, GMI Cloud, Ollama thinking models) can
# bypass LangChain via the raw `openai` SDK, whose Pydantic models keep extra
# fields. Drivers opt in by setting:
#   self._raw_openai_client    = OpenAI(api_key=..., base_url=...)
#   self._reasoning_kwargs     = {'extra_body': {...}, 'reasoning_effort': ...}  # optional
#   self._native_stream_provider = 'openai_compat_reasoning'


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
    register_native_stream_handler('mistral', try_mistral_native_chat_stream)
    register_native_stream_handler('openai_compat_reasoning', try_openai_compat_reasoning_stream)


_register_builtin_handlers()
