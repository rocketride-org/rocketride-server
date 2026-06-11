# =============================================================================
# RocketRide Engine
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

"""
DeepL tool node instance.

Exposes ``deepl_translate`` (translate text into a target language) and
``deepl_write`` (rewrite text in a chosen style or tone) as @tool_function
methods backed by the DeepL REST API.

Structure: the @tool_function methods own all input validation and the
"no HTTP call on invalid input" guarantee. The module-scope pure helpers
(_base_url, _build_translate_payload, _build_write_payload, _shape_translate,
_shape_write) assume their inputs already passed validation and only build or
shape — keeping them trivially unit-testable without a network or an engine.
"""

from __future__ import annotations

from typing import Any, Dict, List

import requests

from rocketlib import IInstanceBase, tool_function

from ai.common.utils import normalize_tool_input, post_with_retry

from .IGlobal import IGlobal

# DeepL hosts. A key ending in ':fx' is a Free-tier key served by api-free.
DEEPL_API_HOST = 'https://api.deepl.com'
DEEPL_FREE_API_HOST = 'https://api-free.deepl.com'

# DeepL caps a single request at 50 text entries.
MAX_TEXT_ENTRIES = 50

VALID_FORMALITIES = {'default', 'more', 'less', 'prefer_more', 'prefer_less'}
VALID_MODEL_TYPES = {'latency_optimized', 'quality_optimized', 'prefer_quality_optimized'}
VALID_WRITING_STYLES = {
    'default',
    'simple',
    'business',
    'academic',
    'casual',
    'prefer_simple',
    'prefer_business',
    'prefer_academic',
    'prefer_casual',
}
VALID_TONES = {
    'default',
    'enthusiastic',
    'friendly',
    'confident',
    'diplomatic',
    'prefer_enthusiastic',
    'prefer_friendly',
    'prefer_confident',
    'prefer_diplomatic',
}
# deepl_write supports a narrower target-language set than translate.
VALID_WRITE_TARGET_LANGS = {'de', 'en-GB', 'en-US', 'es', 'fr', 'it', 'ja', 'ko', 'pt-BR', 'pt-PT', 'zh'}


class IInstance(IInstanceBase):
    """Node instance exposing DeepL translation and rephrasing as agent tools."""

    IGlobal: IGlobal

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['text', 'target_lang'],
            'properties': {
                'text': {
                    'type': ['string', 'array'],
                    'items': {'type': 'string'},
                    'description': 'Text to translate. A single string, or an array of up to 50 strings to translate in one call.',
                },
                'target_lang': {
                    'type': 'string',
                    'description': 'Target language code. Regional variants are allowed, e.g. EN-US, EN-GB, PT-BR, PT-PT, ZH-HANS, ZH-HANT, plus base codes like DE, FR, JA, RU.',
                },
                'source_lang': {
                    'type': 'string',
                    'description': 'Source language as a BASE code only (e.g. EN, not EN-US). Auto-detected when omitted.',
                },
                'formality': {
                    'type': 'string',
                    'enum': sorted(VALID_FORMALITIES),
                    'description': 'Formality of the translation. Only honored by some target languages; unsupported ones cause a DeepL error that is surfaced.',
                },
                'model_type': {
                    'type': 'string',
                    'enum': sorted(VALID_MODEL_TYPES),
                    'description': 'Translation model: quality_optimized, latency_optimized, or prefer_quality_optimized.',
                },
                'preserve_formatting': {
                    'type': 'boolean',
                    'description': 'Preserve original formatting (punctuation, casing) when set.',
                },
                'context': {
                    'type': 'string',
                    'description': 'Additional context that influences translation but is not itself translated.',
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'success': {'type': 'boolean'},
                'translations': {'type': 'array', 'items': {'type': 'object'}},
                'text': {'type': 'string'},
                'error': {'type': 'string'},
            },
        },
        description='Translate text into a target language using DeepL. Accepts a single string or a batch of up to 50 strings. Returns each translation with its detected source language, plus a convenience "text" holding the first translation.',
    )
    def deepl_translate(self, args):
        """Translate text into a target language using the DeepL API."""
        args = normalize_tool_input(args, tool_name='deepl_translate')

        texts, text_error = _coerce_texts(args.get('text'))
        if text_error:
            return _translate_error(text_error)

        # Resolve translation parameters: an explicit arg wins, otherwise fall
        # back to the node config default. target_lang is required, so it errors
        # only when neither the arg nor the config supplies one. Resolved values
        # are written back into args so the pure builder stays arg-only.
        target_lang = _resolve_str(args.get('target_lang'), getattr(self.IGlobal, 'target_lang', None))
        if not target_lang:
            return _translate_error('target_lang is required: set it on the call or as the node default')
        args['target_lang'] = target_lang

        formality = _resolve_enum(args.get('formality'), getattr(self.IGlobal, 'formality', None), VALID_FORMALITIES)
        if formality is not None:
            args['formality'] = formality

        model_type = _resolve_enum(args.get('model_type'), getattr(self.IGlobal, 'model_type', None), VALID_MODEL_TYPES)
        if model_type is not None:
            args['model_type'] = model_type

        payload = _build_translate_payload(args, self.IGlobal)
        payload['text'] = texts

        return _request(
            f'{_base_url(self.IGlobal.apikey)}/v2/translate',
            self.IGlobal.apikey,
            payload,
            _shape_translate,
            _translate_error,
        )

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['text'],
            'properties': {
                'text': {
                    'type': ['string', 'array'],
                    'items': {'type': 'string'},
                    'description': 'Text to rewrite. A single string, or an array of up to 50 strings to rewrite in one call.',
                },
                'target_lang': {
                    'type': 'string',
                    'enum': sorted(VALID_WRITE_TARGET_LANGS),
                    'description': 'Optional target language. Restricted to: de, en-GB, en-US, es, fr, it, ja, ko, pt-BR, pt-PT, zh. Omit to rewrite in the detected language.',
                },
                'writing_style': {
                    'type': 'string',
                    'enum': sorted(VALID_WRITING_STYLES),
                    'description': 'Writing style to apply. Mutually exclusive with tone.',
                },
                'tone': {
                    'type': 'string',
                    'enum': sorted(VALID_TONES),
                    'description': 'Tone to apply. Mutually exclusive with writing_style.',
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'success': {'type': 'boolean'},
                'improvements': {'type': 'array', 'items': {'type': 'object'}},
                'text': {'type': 'string'},
                'error': {'type': 'string'},
            },
        },
        description='Rewrite text using DeepL Write. Accepts a single string or a batch of up to 50 strings, and an optional writing_style OR tone (not both). Returns each improvement with its detected source language, plus a convenience "text" holding the first improvement.',
    )
    def deepl_write(self, args):
        """Rewrite text in a chosen style or tone using the DeepL Write API."""
        args = normalize_tool_input(args, tool_name='deepl_write')

        texts, text_error = _coerce_texts(args.get('text'))
        if text_error:
            return _write_error(text_error)

        # writing_style and tone are mutually exclusive: DeepL 400s on a body
        # carrying both, so reject client-side rather than silently dropping one.
        # Gate on raw presence (truthiness), not resolved-enum validity: any
        # truthy tone signals intent to use tone, so a valid style paired with a
        # junk tone is still a conflict the agent must disambiguate, rather than
        # us silently honouring the style and discarding the malformed tone.
        if args.get('writing_style') and args.get('tone'):
            return _write_error('writing_style and tone are mutually exclusive: provide one or the other, not both')

        target_lang = args.get('target_lang')
        if target_lang is not None:
            if not isinstance(target_lang, str) or target_lang not in VALID_WRITE_TARGET_LANGS:
                return _write_error(
                    'target_lang for deepl_write must be one of: ' + ', '.join(sorted(VALID_WRITE_TARGET_LANGS))
                )

        payload = _build_write_payload(args, self.IGlobal)
        payload['text'] = texts

        return _request(
            f'{_base_url(self.IGlobal.apikey)}/v2/write/rephrase',
            self.IGlobal.apikey,
            payload,
            _shape_write,
            _write_error,
        )


# ---------------------------------------------------------------------------
# Pure helpers (no network, no engine) — unit-tested directly.
# ---------------------------------------------------------------------------


def _base_url(apikey: str) -> str:
    """Return the DeepL host for ``apikey``: free for ':fx'-suffixed keys, else pro."""
    if isinstance(apikey, str) and apikey.endswith(':fx'):
        return DEEPL_FREE_API_HOST
    return DEEPL_API_HOST


def _resolve_str(arg: Any, default: Any) -> str:
    """Return the arg as a stripped non-empty string, else the config default, else ''.

    Used for arg-or-config fallback where an explicit call argument wins over the
    node default. Non-string or blank values fall through to the default.
    """
    if isinstance(arg, str) and arg.strip():
        return arg.strip()
    if isinstance(default, str) and default.strip():
        return default.strip()
    return ''


def _resolve_enum(arg: Any, default: Any, allowed: set):
    """Return the first of (arg, config default) that is in ``allowed``, else None.

    An explicit, valid arg wins; otherwise a valid config default applies;
    otherwise the option is omitted (None) so the caller leaves it out of the
    payload entirely.
    """
    if arg in allowed:
        return arg
    if default in allowed:
        return default
    return None


def _coerce_texts(raw: Any):
    """Validate and normalise the ``text`` argument to a list[str].

    Returns ``(texts, None)`` on success or ``(None, error_message)`` on
    invalid input. A single string is wrapped to a one-element list; a list is
    forwarded verbatim (order preserved). ``bool`` is rejected even though it is
    not a ``str``; empty/whitespace-only entries, non-string list elements, and
    lists longer than 50 are rejected so no HTTP call is attempted.
    """
    if isinstance(raw, str):
        if not raw.strip():
            return None, 'text is required and must be a non-empty string'
        return [raw], None

    if isinstance(raw, list):
        if not raw:
            return None, 'text list must contain at least one string'
        if len(raw) > MAX_TEXT_ENTRIES:
            return None, f'text list may contain at most {MAX_TEXT_ENTRIES} entries'
        for item in raw:
            if isinstance(item, bool) or not isinstance(item, str):
                return None, 'every text list entry must be a string'
            if not item.strip():
                return None, 'text list entries must be non-empty strings'
        return list(raw), None

    return None, 'text is required and must be a string or an array of strings'


def _build_translate_payload(args: Dict[str, Any], cfg: Any) -> Dict[str, Any]:
    """Build the /v2/translate body from already-validated args.

    Only keys explicitly present (and valid) in ``args`` are included; unset
    optionals are omitted entirely rather than sent as null. ``text`` is set by
    the caller after validation. ``cfg`` is accepted for signature parity with
    the other builders but translate reads everything from ``args``.
    """
    texts = args.get('text')
    payload: Dict[str, Any] = {
        'text': [texts] if isinstance(texts, str) else list(texts),
        'target_lang': args.get('target_lang'),
    }

    source_lang = args.get('source_lang')
    if isinstance(source_lang, str) and source_lang.strip():
        payload['source_lang'] = source_lang

    formality = args.get('formality')
    if formality in VALID_FORMALITIES:
        payload['formality'] = formality

    model_type = args.get('model_type')
    if model_type in VALID_MODEL_TYPES:
        payload['model_type'] = model_type

    if isinstance(args.get('preserve_formatting'), bool):
        payload['preserve_formatting'] = args['preserve_formatting']

    context = args.get('context')
    if isinstance(context, str) and context.strip():
        payload['context'] = context

    return payload


def _build_write_payload(args: Dict[str, Any], cfg: Any) -> Dict[str, Any]:
    """Build the /v2/write/rephrase body from already-validated args.

    ``writing_style`` and ``tone`` are mutually exclusive; the deepl_write
    method rejects a call that sets both before reaching this builder, so the
    both-present case never arrives here. As a defensive fallback the builder
    still prefers ``writing_style`` if both are somehow present. Unset/invalid
    optionals are omitted.
    """
    texts = args.get('text')
    payload: Dict[str, Any] = {
        'text': [texts] if isinstance(texts, str) else list(texts),
    }

    target_lang = args.get('target_lang')
    if isinstance(target_lang, str) and target_lang in VALID_WRITE_TARGET_LANGS:
        payload['target_lang'] = target_lang

    writing_style = args.get('writing_style')
    tone = args.get('tone')
    if writing_style in VALID_WRITING_STYLES:
        payload['writing_style'] = writing_style
    elif tone in VALID_TONES:
        payload['tone'] = tone

    return payload


def _shape_translate(body: Any) -> Dict[str, Any]:
    """Map a /v2/translate response body into the translate output schema."""
    if not isinstance(body, dict):
        return _translate_error(f'DeepL returned an unexpected payload type: {type(body).__name__}')
    translations = body.get('translations')
    if not isinstance(translations, list):
        return _translate_error('DeepL response did not contain a translations list')
    return {
        'success': True,
        'translations': translations,
        'text': _first_text(translations),
        'error': '',
    }


def _shape_write(body: Any) -> Dict[str, Any]:
    """Map a /v2/write/rephrase response body into the write output schema."""
    if not isinstance(body, dict):
        return _write_error(f'DeepL returned an unexpected payload type: {type(body).__name__}')
    improvements = body.get('improvements')
    if not isinstance(improvements, list):
        return _write_error('DeepL response did not contain an improvements list')
    return {
        'success': True,
        'improvements': improvements,
        'text': _first_text(improvements),
        'error': '',
    }


def _first_text(items: List[Any]) -> str:
    """Return the ``text`` of the first list element, or '' when the list is empty."""
    if items and isinstance(items[0], dict):
        return items[0].get('text', '') or ''
    return ''


def _translate_error(message: str) -> Dict[str, Any]:
    """Error dict whose key set matches a successful translate result."""
    return {'success': False, 'translations': [], 'text': '', 'error': message}


def _write_error(message: str) -> Dict[str, Any]:
    """Error dict whose key set matches a successful write result."""
    return {'success': False, 'improvements': [], 'text': '', 'error': message}


def _request(url, apikey, payload, shaper, error_factory):
    """POST ``payload`` to DeepL and shape the response, returning an error dict on failure.

    The apikey is sent only in the Authorization header and is never placed in
    any returned error string. ``InvalidJSONError`` is caught before the generic
    ``RequestException`` because it is a subclass of it.
    """
    headers = {
        'Authorization': f'DeepL-Auth-Key {apikey}',
        'Content-Type': 'application/json',
    }
    try:
        resp = post_with_retry(url, headers=headers, json=payload)
        body = resp.json()
    except requests.exceptions.InvalidJSONError:
        return error_factory('DeepL returned a non-JSON response body')
    except requests.RequestException as exc:
        return error_factory(_error_message(exc))

    return shaper(body)


def _error_message(exc: Exception) -> str:
    """Build a redaction-safe error message from a DeepL request failure.

    Maps the well-known DeepL status codes to actionable messages and never
    includes the apikey (only the status and the server's own 'message' field).
    """
    resp = getattr(exc, 'response', None)
    status = getattr(resp, 'status_code', None)

    if status == 456:
        return 'DeepL quota exceeded (HTTP 456): the character limit for this key was reached (the Free tier caps at 500,000 characters/month).'
    if status == 403:
        return (
            'DeepL authentication failed (HTTP 403): the API key was rejected. Check that the key is valid and active.'
        )
    if status == 429:
        return 'DeepL rate limit hit (HTTP 429): too many requests. Retry after a short delay.'

    if status is not None:
        detail = ''
        try:
            data = resp.json()
            if isinstance(data, dict) and data.get('message'):
                detail = f': {data["message"]}'
        except Exception:
            detail = ''
        return f'DeepL request failed (HTTP {status}){detail}'

    return f'DeepL request failed: {type(exc).__name__}'
