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

"""Network-free unit tests for the tool_deepl node (TDD RED phase).

These tests are the executable spec. They are written BEFORE the node exists:
``nodes/src/nodes/tool_deepl/`` is not yet created, so the import below raises
ModuleNotFoundError and EVERY test errors red. That is the intended RED state.
Once the engineer implements the module to this contract, each test must turn
green by exercising real behaviour — and each assertion is written to
DISCRIMINATE the most plausible wrong implementation (a tavily copy-paste),
not merely to pass.

Design contract these tests pin (locked with team-lead + human):

  Module surface (all in nodes.tool_deepl.IInstance, imported as ``mod``):
    * Module-scope free function ``post_with_retry`` (imported from
      ai.common.utils) — the single HTTP chokepoint. Tests monkeypatch
      ``mod.post_with_retry`` to capture requests or raise. The node must NOT
      call requests.post directly or alias the helper onto a method.
    * Pure helpers, tested directly with plain dict/str inputs (no Response):
        _base_url(apikey: str) -> str        # host routing by ':fx' suffix
        _build_translate_payload(args, cfg) -> dict
        _build_write_payload(args, cfg) -> dict
        _shape_translate(body: dict) -> dict
        _shape_write(body: dict) -> dict
    * Two @tool_function methods on IInstance: ``deepl_translate`` and
      ``deepl_write``. These OWN all input validation and the
      "no HTTP call on bad input" guarantee; the pure builders assume their
      inputs already passed validation and only shape/wrap.

  text input: string OR array[string]. A single string is wrapped to [text];
    a list is forwarded as-is with order preserved. Empty text, a list with
    >50 entries, and a list containing a non-string element are each rejected
    by the METHOD with an error dict and NO HTTP call.

  Endpoints / hosts:
    * key endswith ':fx' -> https://api-free.deepl.com ; else https://api.deepl.com
    * translate -> {base}/v2/translate ; write -> {base}/v2/write/rephrase
    * auth header: "Authorization: DeepL-Auth-Key <key>"  (NOT Bearer)

  translate args: text (req), target_lang (req, wide ~30-lang set, NOT
    restricted client-side), source_lang/formality/model_type/context optional.
    Unset optionals are OMITTED from the payload entirely (absent keys, not
    null/empty values).
  write args: text (req), target_lang (optional but RESTRICTED to the write
    set: de, en-GB, en-US, es, fr, it, ja, ko, pt-BR, pt-PT, zh — others
    rejected client-side with no HTTP call), writing_style XOR tone (never both).

  Response shaping: _shape_translate returns the full translations[] list AND
    a top-level convenience ``text`` = first translation's text;
    _shape_write returns the full improvements[] list AND ``text`` = first
    improvement's text.

  Errors: every failure returns a dict with success False and an ``error``
    string; the apikey never appears in error text. Status mapping:
    456 -> quota / Free 500k-char cap ; 403 -> auth/key ; 429 -> rate limit ;
    other non-2xx -> status + body 'message'. A non-JSON body (resp.json()
    raising InvalidJSONError) is caught BEFORE the generic RequestException
    handler.

Stub bootstrap (isolation-hardened — see the bootstrap block below for the
mechanism and the flake it fixes):
  Importing nodes.tool_deepl.IInstance triggers its top-level imports — and,
  via ``from .IGlobal import IGlobal``, IGlobal's imports too. We import the
  module under a CONTROLLED stub state and restore sys.modules exactly afterward,
  rather than the install-if-absent/pop pattern the sibling tool_* tests use:
  under xdist, a foreign file's leaked ai.common.utils stub resident in
  sys.modules would make install-if-absent SKIP ours, binding the node to a
  foreign normalize_tool_input (a ~1-in-3 flake). We snapshot, force-install our
  own stubs unconditionally, evict any cached deepl module, import, then restore
  the snapshot — immune to others' leaks and leaking nothing of ours.

  We stub precisely the modules tool_deepl imports: rocketlib, requests, ai,
  ai.common, ai.common.utils, ai.common.config, depends. We do NOT stub a
  validate_public_url passthrough — tool_deepl does no result-URL filtering and
  never imports it; carrying tavily's stub over would be cargo-culting.

  The stub ``requests`` exposes a FAITHFUL exception hierarchy
  (InvalidJSONError and HTTPError both subclass RequestException, mirroring the
  real library) so the "InvalidJSONError caught before RequestException"
  ordering test genuinely discriminates a mis-ordered except chain. Making them
  all bare ``Exception`` (the tavily shortcut) would silently defeat that test.
"""

from __future__ import annotations

import importlib
import sys
from pathlib import Path
from unittest.mock import MagicMock

# Add nodes/src so `nodes.tool_deepl.IInstance` is resolvable.
_NODES_SRC = Path(__file__).resolve().parents[1] / 'src'
if str(_NODES_SRC) not in sys.path:
    sys.path.insert(0, str(_NODES_SRC))


# ---------------------------------------------------------------------------
# Stub library used by the error-path tests.
#
# CRITICAL ENVIRONMENT INVARIANT: the node binds whatever ``requests`` lives in
# sys.modules at its import time, and its ``except requests.RequestException``
# catches exactly that class. So the exception types the error-path tests RAISE
# (from a monkeypatched post_with_retry) must be the SAME classes the node will
# catch. Two environments, both of which must pass:
#
#   * Engine harness (``builder nodes:test``): the real ``requests`` is already
#     resident in sys.modules before this file is collected. Our stub is then
#     NOT installed (the "install only if absent" guard below), so the node
#     binds the REAL requests, and the tests must raise REAL requests.exceptions
#     types. (A previous version raised local stub exceptions with no inheritance
#     link to requests.RequestException, so the node's except never caught them
#     and all 8 error-path tests failed under the engine harness while passing
#     under a bare interpreter — an environment-relative green. This is the fix.)
#   * Bare interpreter (no requests installed): our stub IS installed, the node
#     binds it, and the tests raise our pure stub exceptions.
#
# We resolve the exception classes ONCE here from the real library when it is
# importable, falling back to a faithful pure hierarchy otherwise. The same
# resolved classes are used both inside the installed stub module and as the
# module-level names the tests raise — guaranteeing the raise-site and the
# catch-site always agree, in either environment.
# ---------------------------------------------------------------------------


def _resolve_requests_exceptions():
    """Return (RequestException, HTTPError, InvalidJSONError, Timeout, ConnectionError).

    Prefer the real ``requests.exceptions`` classes when importable so the node's
    real ``except requests.RequestException`` catches what the tests raise. Fall
    back to a pure hierarchy (faithful subclassing: HTTPError/InvalidJSONError/
    Timeout/ConnectionError all derive from RequestException, mirroring the real
    library) when requests is absent.
    """
    try:
        import requests as _real_requests  # noqa: F401
        from requests.exceptions import (
            ConnectionError as _ConnErr,
            HTTPError as _HTTPErr,
            InvalidJSONError as _InvalidJSON,
            RequestException as _ReqExc,
            Timeout as _Timeout,
        )

        return _ReqExc, _HTTPErr, _InvalidJSON, _Timeout, _ConnErr
    except Exception:

        class _ReqExc(Exception):
            """Stand-in for requests.exceptions.RequestException (base)."""

        class _HTTPErr(_ReqExc):
            """Stand-in for requests.exceptions.HTTPError. Carries .response."""

            def __init__(self, *args, response=None):
                super().__init__(*args)
                self.response = response

        class _InvalidJSON(_ReqExc):
            """Stand-in for requests.exceptions.InvalidJSONError (subclass of RequestException)."""

        class _Timeout(_ReqExc):
            """Stand-in for requests.exceptions.Timeout."""

        class _ConnErr(_ReqExc):
            """Stand-in for requests.exceptions.ConnectionError."""

        return _ReqExc, _HTTPErr, _InvalidJSON, _Timeout, _ConnErr


(
    _RequestException,
    _HTTPError,
    _InvalidJSONError,
    _Timeout,
    _ConnectionError,
) = _resolve_requests_exceptions()


def _build_import_stubs():
    """Return {module_name: stub} for exactly the deps tool_deepl imports.

    The stub ``requests`` exposes the SAME exception classes resolved above
    (real ones when available, pure ones otherwise), so a node bound to this
    stub catches exactly what the tests raise.
    """
    rocketlib = MagicMock()
    rocketlib.IInstanceBase = object  # real class so inheritance works
    rocketlib.IGlobalBase = object
    rocketlib.tool_function = lambda **kwargs: lambda f: f  # pass-through decorator
    rocketlib.debug = lambda *a, **kw: None
    rocketlib.error = lambda *a, **kw: None
    rocketlib.warning = lambda *a, **kw: None
    rocketlib.OPEN_MODE = MagicMock()

    depends = MagicMock()
    depends.depends = lambda *a, **kw: None

    ai_common_utils = MagicMock()
    # Pass-through normalisation: dict in -> dict out; non-dict -> {}.
    ai_common_utils.normalize_tool_input = lambda args, **kw: args if isinstance(args, dict) else {}
    # The real validators are exercised by the ai package's own tests; provide
    # faithful-enough passthroughs only if tool_deepl imports them. (If the node
    # uses require_str/optional_str, they are imported from here.)
    ai_common_utils.require_str = lambda args, key, **kw: (args.get(key) or '').strip()
    ai_common_utils.optional_str = lambda args, key, default=None, **kw: args.get(key, default)

    requests = MagicMock()
    requests.exceptions = MagicMock()
    requests.exceptions.RequestException = _RequestException
    requests.exceptions.HTTPError = _HTTPError
    requests.exceptions.InvalidJSONError = _InvalidJSONError
    requests.exceptions.Timeout = _Timeout
    requests.exceptions.ConnectionError = _ConnectionError
    requests.RequestException = _RequestException

    return {
        'rocketlib': rocketlib,
        'depends': depends,
        'ai': MagicMock(),
        'ai.common': MagicMock(),
        'ai.common.utils': ai_common_utils,
        'ai.common.config': MagicMock(),
        'requests': requests,
    }


# Import the module under a CONTROLLED, ISOLATED stub state, then restore
# sys.modules exactly to its prior contents.
#
# Why not "install only if absent": under ``builder nodes:test`` xdist can run
# several stub-using node test files on one worker. If another file (tool_tavily,
# tool_xtrace_memory, ...) has leaked its OWN ai.common.utils / requests stub into
# sys.modules, an install-if-absent bootstrap would SKIP installing ours and the
# deepl module would bind the FOREIGN normalize_tool_input — a variant that drops
# arg keys — making deepl_translate({'text': ...}) lose its text and fail. That
# manifested as a ~1-in-3 flake under --pytest-pattern='tool_'. (Reproduced
# deterministically by making a foreign normalize return {} before this import.)
#
# The robust fix, immune to whatever any other file leaks AND leaking nothing of
# ours: snapshot every name we touch; FORCE-INSTALL our own stubs unconditionally
# (overwriting any foreign stub); EVICT any cached nodes.tool_deepl* modules so the
# import binds our stubs rather than returning a previously-imported (possibly
# foreign-bound) module object; import and keep a direct reference in ``mod``
# (immune to any later sys.modules mutation); then RESTORE sys.modules exactly —
# re-inserting names that were present, deleting names that were absent. We never
# rely on, and never leave behind, shared module state.
_DEEPL_MODULES = ('nodes.tool_deepl.IInstance', 'nodes.tool_deepl.IGlobal', 'nodes.tool_deepl')
_stubs = _build_import_stubs()
_touched_names = list(_stubs) + list(_DEEPL_MODULES)
_MODULE_ABSENT = object()  # sentinel: name was not in sys.modules before we touched it
_saved_modules = {name: sys.modules.get(name, _MODULE_ABSENT) for name in _touched_names}

try:
    for _name, _stub in _stubs.items():
        sys.modules[_name] = _stub  # unconditional — overwrite any foreign stub
    for _name in _DEEPL_MODULES:
        sys.modules.pop(_name, None)  # force a fresh import under our stubs
    # RED: this raises ModuleNotFoundError until the node is implemented. Intended.
    mod = importlib.import_module('nodes.tool_deepl.IInstance')
finally:
    for _name in _touched_names:
        _prev = _saved_modules[_name]
        if _prev is _MODULE_ABSENT:
            sys.modules.pop(_name, None)
        else:
            sys.modules[_name] = _prev


# ---------------------------------------------------------------------------
# Test fixtures / helpers
# ---------------------------------------------------------------------------


class _Cfg:
    """Minimal stand-in for IGlobal passed to the methods / builders.

    Carries the config-default attributes the resolver reads: target_lang,
    formality, model_type (the names ratified by the team-lead). They default to
    EMPTY here, not to IGlobal's production defaults (EN-US / default /
    quality_optimized), on purpose: an empty cfg contributes nothing to the
    arg-or-cfg-or-omit resolution, so the many arg-driven tests keep asserting
    exactly the arg behaviour. The cfg-fallback tests pass explicit non-empty
    values to exercise the fallback path. (apikey keeps a real default because
    every request needs one.)
    """

    def __init__(self, apikey='pro-key-1234', target_lang='', formality='', model_type=''):
        self.apikey = apikey
        self.target_lang = target_lang
        self.formality = formality
        self.model_type = model_type


class _Resp:
    """Fake requests.Response: only .json() is consumed by the shapers' callers."""

    def __init__(self, payload=None, *, json_exc=None):
        self._payload = payload
        self._json_exc = json_exc

    def json(self):
        if self._json_exc is not None:
            raise self._json_exc
        return self._payload


def _make_instance(cfg=None):
    """Construct an IInstance wired to a config, with no engine runtime."""
    inst = mod.IInstance()
    inst.IGlobal = cfg or _Cfg()
    return inst


def _capture_post(monkeypatch, response):
    """Patch mod.post_with_retry to record its call and return `response`.

    Returns a dict that, after the call, holds 'url', 'headers', 'json' (payload).
    Asserting on these is how request-shaping tests inspect the outgoing request
    without a network or a real requests stub.
    """
    captured = {}

    def _fake(url, *, headers=None, json=None, **kwargs):
        captured['url'] = url
        captured['headers'] = headers
        captured['json'] = json
        return response

    monkeypatch.setattr(mod, 'post_with_retry', _fake)
    return captured


def _no_call_post(monkeypatch):
    """Patch mod.post_with_retry to fail the test if it is ever called.

    Used by the input-validation tests to prove a bad input is rejected BEFORE
    any HTTP request is attempted.
    """

    def _fake(*a, **kw):
        raise AssertionError('post_with_retry was called; expected no HTTP on invalid input')

    monkeypatch.setattr(mod, 'post_with_retry', _fake)


# Exception classes the error-path tests raise — resolved to the REAL
# requests.exceptions when importable, else the pure fallbacks, so the raise
# site always matches the class the node's except clause catches.
HTTPError = _HTTPError
InvalidJSONError = _InvalidJSONError
Timeout = _Timeout
ConnectionError_ = _ConnectionError

# Valid target languages for the write endpoint (delta 2).
WRITE_LANGS = {'de', 'en-GB', 'en-US', 'es', 'fr', 'it', 'ja', 'ko', 'pt-BR', 'pt-PT', 'zh'}


# ===========================================================================
# B. URL routing (_base_url) — assert EXACT host, never a substring.
# ===========================================================================


def test_free_key_routes_to_api_free():
    """A ':fx'-suffixed key routes to the free host exactly.

    Discriminates inverted routing: asserting equality to the full free URL
    fails if the impl returns the pro host, and 'deepl.com in url' would not.
    """
    assert mod._base_url('abcd-1234:fx') == 'https://api-free.deepl.com'


def test_pro_key_routes_to_api():
    """A non-':fx' key routes to the pro host exactly (catches inversion)."""
    assert mod._base_url('abcd-1234') == 'https://api.deepl.com'


def test_fx_substring_not_suffix_routes_pro():
    """':fx' in the MIDDLE of a key is not a free key -> pro host.

    Discriminates ``':fx' in key`` (a naive membership test) from
    ``key.endswith(':fx')``. The membership version wrongly routes this to free.
    """
    assert mod._base_url('ab:fx-cd-ef') == 'https://api.deepl.com'


def test_translate_url_is_v2_translate(monkeypatch):
    """deepl_translate POSTs to {base}/v2/translate (exact path)."""
    cap = _capture_post(monkeypatch, _Resp({'translations': [{'text': 'x', 'detected_source_language': 'EN'}]}))
    _make_instance().deepl_translate({'text': 'hi', 'target_lang': 'DE'})
    assert cap['url'] == 'https://api.deepl.com/v2/translate'


def test_write_url_is_v2_write_rephrase(monkeypatch):
    """deepl_write POSTs to {base}/v2/write/rephrase, NOT /v2/translate.

    Discriminates a copy-paste that left the translate path on the write method.
    """
    cap = _capture_post(monkeypatch, _Resp({'improvements': [{'text': 'x', 'detected_source_language': 'EN'}]}))
    _make_instance().deepl_write({'text': 'hi'})
    assert cap['url'] == 'https://api.deepl.com/v2/write/rephrase'


# ===========================================================================
# C. translate request shaping (_build_translate_payload + method capture)
# ===========================================================================


def test_translate_single_string_wrapped_in_array():
    """A single string text becomes payload['text'] == ['hi'] exactly.

    ``payload['text'] == ['hi']`` discriminates a scalar-text bug
    (payload['text'] == 'hi'); a substring check 'hi' in str(payload) would not.
    """
    payload = mod._build_translate_payload({'text': 'hi', 'target_lang': 'DE'}, _Cfg())
    assert payload['text'] == ['hi']


def test_translate_list_text_preserved_in_order():
    """A list text is forwarded verbatim, order preserved (delta 1, batching)."""
    payload = mod._build_translate_payload({'text': ['a', 'b', 'c'], 'target_lang': 'DE'}, _Cfg())
    assert payload['text'] == ['a', 'b', 'c']


def test_translate_target_lang_forwarded_verbatim():
    """target_lang is passed through unchanged."""
    payload = mod._build_translate_payload({'text': 'hi', 'target_lang': 'DE'}, _Cfg())
    assert payload['target_lang'] == 'DE'


def test_translate_unset_optionals_absent_from_payload():
    """Unset source_lang/formality/model_type/context are ABSENT keys.

    Asserts key absence, not falsiness: a payload carrying
    {'formality': None} would 400 at DeepL but pass a ``not payload['formality']``
    style check. ``not in`` is the discriminating assertion.
    """
    payload = mod._build_translate_payload({'text': 'hi', 'target_lang': 'DE'}, _Cfg())
    for k in ('source_lang', 'formality', 'model_type', 'context'):
        assert k not in payload


def test_translate_source_lang_included_when_given():
    payload = mod._build_translate_payload({'text': 'hi', 'target_lang': 'DE', 'source_lang': 'EN'}, _Cfg())
    assert payload['source_lang'] == 'EN'


def test_translate_valid_formality_forwarded():
    payload = mod._build_translate_payload({'text': 'hi', 'target_lang': 'DE', 'formality': 'less'}, _Cfg())
    assert payload['formality'] == 'less'


def test_translate_invalid_formality_dropped():
    """A junk formality is not sent raw (enum guard).

    Discriminates an impl that forwards any string: the bad value must not
    appear in the payload at all.
    """
    payload = mod._build_translate_payload({'text': 'hi', 'target_lang': 'DE', 'formality': 'super-formal'}, _Cfg())
    assert 'formality' not in payload or payload.get('formality') != 'super-formal'


def test_translate_valid_model_type_forwarded():
    payload = mod._build_translate_payload(
        {'text': 'hi', 'target_lang': 'DE', 'model_type': 'quality_optimized'}, _Cfg()
    )
    assert payload['model_type'] == 'quality_optimized'


def test_translate_invalid_model_type_dropped():
    payload = mod._build_translate_payload({'text': 'hi', 'target_lang': 'DE', 'model_type': 'turbo'}, _Cfg())
    assert 'model_type' not in payload or payload.get('model_type') != 'turbo'


def test_translate_context_included_when_given():
    payload = mod._build_translate_payload({'text': 'hi', 'target_lang': 'DE', 'context': 'a menu'}, _Cfg())
    assert payload['context'] == 'a menu'


def test_translate_auth_header_is_deepl_auth_key(monkeypatch):
    """Authorization header is exactly 'DeepL-Auth-Key <key>', NOT Bearer.

    Discriminates the tavily-inherited 'Bearer <key>' bug. Asserting the full
    string value (not just that an Authorization header exists) is what catches it.
    """
    cap = _capture_post(monkeypatch, _Resp({'translations': [{'text': 'x', 'detected_source_language': 'EN'}]}))
    _make_instance(_Cfg(apikey='secret-key-9')).deepl_translate({'text': 'hi', 'target_lang': 'DE'})
    auth = cap['headers'].get('Authorization') or cap['headers'].get('authorization')
    assert auth == 'DeepL-Auth-Key secret-key-9'


def test_translate_preserve_formatting_true_forwarded():
    """preserve_formatting=True is forwarded as the bool True."""
    payload = mod._build_translate_payload({'text': 'hi', 'target_lang': 'DE', 'preserve_formatting': True}, _Cfg())
    assert payload['preserve_formatting'] is True


def test_translate_preserve_formatting_false_is_kept_not_dropped():
    """preserve_formatting=False stays in the payload as False.

    False is a real, intentional DeepL value, not "unset". This discriminates a
    truthiness guard (``if args.get('preserve_formatting'):``) that would drop
    the key on False — the easy bug. Asserts the key is PRESENT and is False.
    """
    payload = mod._build_translate_payload({'text': 'hi', 'target_lang': 'DE', 'preserve_formatting': False}, _Cfg())
    assert 'preserve_formatting' in payload
    assert payload['preserve_formatting'] is False


def test_translate_preserve_formatting_absent_omitted():
    """An unset preserve_formatting is absent from the payload entirely."""
    payload = mod._build_translate_payload({'text': 'hi', 'target_lang': 'DE'}, _Cfg())
    assert 'preserve_formatting' not in payload


def test_translate_preserve_formatting_non_bool_omitted():
    """A non-bool preserve_formatting (string 'true', or 1) is dropped, not coerced.

    Strict-bool, mirroring optional_bool in ai.common.utils.tool_args: a coerced
    string/int smells like a hallucination. Discriminates both a loose
    ``is not None`` guard (which would keep 'true'/1) and a truthiness coercion.
    The int 1 case also guards against ``isinstance(x, int)`` wrongly admitting
    a bool-adjacent value, since bool is an int subclass but 1 is not a bool.
    """
    for bad in ('true', 1):
        payload = mod._build_translate_payload({'text': 'hi', 'target_lang': 'DE', 'preserve_formatting': bad}, _Cfg())
        assert 'preserve_formatting' not in payload


# ===========================================================================
# D. translate response shaping (_shape_translate)
# ===========================================================================


def test_translate_shape_success_and_translations_list():
    """A well-formed body yields success True and the full translations list."""
    body = {'translations': [{'text': 'Hallo', 'detected_source_language': 'EN'}]}
    out = mod._shape_translate(body)
    assert out['success'] is True
    assert out['translations'] == [{'text': 'Hallo', 'detected_source_language': 'EN'}]


def test_translate_shape_convenience_text_is_first_result(monkeypatch):
    """Top-level 'text' convenience field equals the FIRST translation's text (delta 3).

    Discriminates an impl that omits the convenience field or sets it to the
    whole list / the last element.
    """
    body = {'translations': [{'text': 'Hallo', 'detected_source_language': 'EN'}, {'text': 'Welt'}]}
    out = mod._shape_translate(body)
    assert out['text'] == 'Hallo'


def test_translate_shape_detected_source_language_surfaced():
    body = {'translations': [{'text': 'Hallo', 'detected_source_language': 'EN'}]}
    out = mod._shape_translate(body)
    assert out['translations'][0]['detected_source_language'] == 'EN'


def test_translate_shape_order_preserved_for_batch():
    """Batch in -> batch out, order preserved (delta 1: D6 replacement)."""
    body = {'translations': [{'text': 'A'}, {'text': 'B'}, {'text': 'C'}]}
    out = mod._shape_translate(body)
    assert [t['text'] for t in out['translations']] == ['A', 'B', 'C']


def test_translate_shape_empty_translations_no_indexerror():
    """translations:[] must not raise IndexError on translations[0].

    Discriminates an impl that blindly reads translations[0] for the convenience
    field. success stays True (the API call succeeded) and 'text' is empty/safe.
    """
    out = mod._shape_translate({'translations': []})
    assert out['success'] is True
    assert out.get('text', '') == ''


def test_translate_shape_missing_translations_key_is_error():
    """Body {} -> error dict, no KeyError."""
    out = mod._shape_translate({})
    assert out['success'] is False
    assert 'error' in out


def test_translate_shape_non_dict_body_is_error():
    """A list/str body -> 'unexpected payload' error dict, no AttributeError."""
    out = mod._shape_translate(['oops'])
    assert out['success'] is False
    assert 'error' in out


# ===========================================================================
# E. write request shaping + response shaping
# ===========================================================================


def test_write_single_string_wrapped_in_array():
    payload = mod._build_write_payload({'text': 'draft'}, _Cfg())
    assert payload['text'] == ['draft']


def test_write_list_text_preserved_in_order():
    payload = mod._build_write_payload({'text': ['a', 'b']}, _Cfg())
    assert payload['text'] == ['a', 'b']


def test_write_valid_writing_style_forwarded():
    payload = mod._build_write_payload({'text': 'd', 'writing_style': 'business'}, _Cfg())
    assert payload['writing_style'] == 'business'


def test_write_valid_tone_forwarded():
    payload = mod._build_write_payload({'text': 'd', 'tone': 'friendly'}, _Cfg())
    assert payload['tone'] == 'friendly'


def test_write_builder_style_and_tone_defensive_single_key():
    """Builder-level defensive fallback: never emits BOTH writing_style and tone.

    The user-facing both-present case is rejected by the deepl_write METHOD with
    an error dict and no HTTP call (see
    test_write_style_and_tone_both_present_rejected_no_http). This test pins the
    builder's SECOND line of defence: even if a both-present body reaches the
    pure builder directly (it never should from the method), the builder must
    still emit at most one of the two keys so a DeepL 400 cannot slip through.
    Discriminates a builder that forwards both. It does NOT assert which one
    wins; that is the method's job to prevent, not the builder's to arbitrate.
    """
    payload = mod._build_write_payload({'text': 'd', 'writing_style': 'business', 'tone': 'friendly'}, _Cfg())
    assert not ('writing_style' in payload and 'tone' in payload)


def test_write_style_and_tone_both_present_rejected_no_http(monkeypatch):
    """deepl_write rejects a call setting BOTH writing_style and tone: error dict,
    no HTTP call. (CodeRabbit 3399561893: the old behaviour silently picked
    writing_style and dropped tone; the contract now requires an explicit
    client-side rejection so the agent disambiguates rather than getting a
    silently-altered request.)

    Two discriminators in one test: ``_no_call_post`` makes the OLD silent-pick
    impl (which proceeds to POST writing_style) fail with the no-HTTP assertion,
    and the message check requires the error to NAME both fields rather than be a
    generic failure, so a bare ``return _write_error('bad input')`` would not pass.
    """
    _no_call_post(monkeypatch)
    out = _make_instance().deepl_write({'text': 'd', 'writing_style': 'business', 'tone': 'friendly'})
    assert out['success'] is False
    low = out['error'].lower()
    assert 'writing_style' in low or 'style' in low
    assert 'tone' in low


def test_write_valid_style_junk_tone_both_present_rejected_no_http(monkeypatch):
    """A valid writing_style plus a JUNK tone is STILL a both-present conflict.

    Semantics agreed with the engineer (CodeRabbit 3399561893 fix): the
    mutual-exclusivity gate is raw PRESENCE (truthiness), not resolved-enum
    validity. Any truthy tone signals intent to use tone, so the call is rejected
    and the agent must disambiguate, rather than the node silently honouring the
    style and discarding the (malformed) tone. Pins that 'business' + 'garbage'
    is rejected with no HTTP. Discriminates an impl that gated on enum validity
    (which would let this through, sending writing_style='business').
    """
    _no_call_post(monkeypatch)
    out = _make_instance().deepl_write({'text': 'd', 'writing_style': 'business', 'tone': 'garbage'})
    assert out['success'] is False
    assert 'error' in out


def test_write_style_only_not_rejected(monkeypatch):
    """A writing_style with NO tone is not a conflict: the request proceeds.

    Guards against an over-eager gate that rejects whenever writing_style is set.
    The request must be made and carry writing_style.
    """
    cap = _capture_post(monkeypatch, _Resp({'improvements': [{'text': 'x', 'detected_source_language': 'EN'}]}))
    out = _make_instance().deepl_write({'text': 'd', 'writing_style': 'business'})
    assert out['success'] is True
    assert cap['json']['writing_style'] == 'business'
    assert 'tone' not in cap['json']


def test_write_tone_only_not_rejected(monkeypatch):
    """A tone with NO writing_style is not a conflict: the request proceeds."""
    cap = _capture_post(monkeypatch, _Resp({'improvements': [{'text': 'x', 'detected_source_language': 'EN'}]}))
    out = _make_instance().deepl_write({'text': 'd', 'tone': 'friendly'})
    assert out['success'] is True
    assert cap['json']['tone'] == 'friendly'
    assert 'writing_style' not in cap['json']


def test_write_invalid_writing_style_dropped():
    payload = mod._build_write_payload({'text': 'd', 'writing_style': 'sarcastic'}, _Cfg())
    assert 'writing_style' not in payload or payload.get('writing_style') != 'sarcastic'


def test_write_invalid_tone_dropped():
    payload = mod._build_write_payload({'text': 'd', 'tone': 'angry'}, _Cfg())
    assert 'tone' not in payload or payload.get('tone') != 'angry'


def test_write_shape_reads_improvements_not_translations():
    """_shape_write reads 'improvements' and surfaces the improved text.

    Asserts the positive path: improvements[] forwarded, convenience text = first.
    """
    body = {'improvements': [{'text': 'Polished.', 'detected_source_language': 'EN'}]}
    out = mod._shape_write(body)
    assert out['success'] is True
    assert out['improvements'] == [{'text': 'Polished.', 'detected_source_language': 'EN'}]
    assert out['text'] == 'Polished.'


def test_write_shape_translations_body_is_not_a_success():
    """A translate-shaped {'translations':...} body must NOT yield a write result.

    Negative discriminator: catches a copy-pasted _shape_translate on the write
    path. If the impl wrongly reads 'translations', this body would look like a
    success; the correct impl treats the absent 'improvements' key as an error.
    """
    out = mod._shape_write({'translations': [{'text': 'Hallo'}]})
    assert out['success'] is False


# ===========================================================================
# F. error paths (monkeypatch mod.post_with_retry to raise)
# ===========================================================================


def _http_error(status):
    resp = MagicMock()
    resp.status_code = status
    # body .json() may be consulted for the 'message' field on generic errors
    resp.json = lambda: {'message': f'deepl says {status}'}
    return HTTPError(f'HTTP {status}', response=resp)


def test_quota_456_message_names_quota(monkeypatch):
    """456 -> error dict whose message names quota / the character limit.

    Discriminates a generic non-2xx handler that never special-cases 456.
    Deliberately does NOT accept the bare '456' substring: the generic fallback
    ("DeepL request failed (HTTP 456): ...") also contains '456', so matching it
    would let the missing-special-case mutation pass. The assertion requires the
    quota *semantics* ('quota' / 'limit'), which only the mapped branch emits.
    """

    def _raise(*a, **kw):
        raise _http_error(456)

    monkeypatch.setattr(mod, 'post_with_retry', _raise)
    out = _make_instance().deepl_translate({'text': 'hi', 'target_lang': 'DE'})
    assert out['success'] is False
    low = out['error'].lower()
    assert 'quota' in low or 'limit' in low


def test_auth_403_message_names_auth(monkeypatch):
    """403 -> error dict naming authentication / the key (not a generic failure)."""

    def _raise(*a, **kw):
        raise _http_error(403)

    monkeypatch.setattr(mod, 'post_with_retry', _raise)
    out = _make_instance().deepl_translate({'text': 'hi', 'target_lang': 'DE'})
    assert out['success'] is False
    low = out['error'].lower()
    assert 'auth' in low or 'key' in low or '403' in low


def test_rate_limit_429_message(monkeypatch):
    """429 -> clean rate-limit error dict (retries already exhausted upstream)."""

    def _raise(*a, **kw):
        raise _http_error(429)

    monkeypatch.setattr(mod, 'post_with_retry', _raise)
    out = _make_instance().deepl_translate({'text': 'hi', 'target_lang': 'DE'})
    assert out['success'] is False
    low = out['error'].lower()
    assert 'rate' in low or 'limit' in low or '429' in low


def test_generic_400_error_dict(monkeypatch):
    """A non-mapped 4xx (400) still returns a clean error dict, no traceback."""

    def _raise(*a, **kw):
        raise _http_error(400)

    monkeypatch.setattr(mod, 'post_with_retry', _raise)
    out = _make_instance().deepl_translate({'text': 'hi', 'target_lang': 'DE'})
    assert out['success'] is False
    assert 'error' in out


def test_non_json_body_caught_before_generic(monkeypatch):
    """resp.json() raising InvalidJSONError -> a 'non-JSON' error dict.

    Mutation target: since the stub InvalidJSONError genuinely subclasses
    RequestException, an except chain that lists RequestException FIRST would
    swallow this into the generic branch. The assertion that the message names
    a non-JSON / invalid body (not a generic 'request failed') discriminates the
    mis-ordered chain.
    """
    resp = _Resp(json_exc=InvalidJSONError('no json'))

    def _ok(*a, **kw):
        return resp

    monkeypatch.setattr(mod, 'post_with_retry', _ok)
    out = _make_instance().deepl_translate({'text': 'hi', 'target_lang': 'DE'})
    assert out['success'] is False
    low = out['error'].lower()
    # Deliberately do NOT accept a bare 'json' substring: the generic fallback
    # ("DeepL request failed: InvalidJSONError") contains 'json' inside the
    # exception *type name*, so a mis-ordered except chain (RequestException
    # before InvalidJSONError) would pass that loose check. Require the
    # non-JSON-body phrasing the dedicated branch emits, and assert it is NOT
    # the generic 'request failed' message.
    assert 'non-json' in low
    assert 'request failed' not in low


def test_network_exception_returns_error_dict(monkeypatch):
    """A transport failure (Timeout/ConnectionError) surfaces as an error dict."""

    def _raise(*a, **kw):
        raise Timeout('timed out')

    monkeypatch.setattr(mod, 'post_with_retry', _raise)
    out = _make_instance().deepl_translate({'text': 'hi', 'target_lang': 'DE'})
    assert out['success'] is False
    assert 'error' in out


def test_apikey_never_in_error_text(monkeypatch):
    """The apikey must never appear in any returned error string (redaction).

    Raise with the apikey embedded in the exception text to simulate a careless
    f-string; the node's error dict must not echo it.
    """
    secret = 'super-secret-key-xyz'

    def _raise(*a, **kw):
        raise _http_error(403)

    monkeypatch.setattr(mod, 'post_with_retry', _raise)
    out = _make_instance(_Cfg(apikey=secret)).deepl_translate({'text': 'hi', 'target_lang': 'DE'})
    assert secret not in out['error']


def test_error_dict_shape_matches_success_keys(monkeypatch):
    """An error dict carries the same top-level keys as a success dict.

    A stable schema lets the agent parse both uniformly. We compare the key set
    of a success result against an error result from the same method.
    """
    ok_cap = _capture_post(monkeypatch, _Resp({'translations': [{'text': 'Hallo', 'detected_source_language': 'EN'}]}))
    ok = _make_instance().deepl_translate({'text': 'hi', 'target_lang': 'DE'})
    assert ok_cap  # request was made

    def _raise(*a, **kw):
        raise _http_error(456)

    monkeypatch.setattr(mod, 'post_with_retry', _raise)
    err = _make_instance().deepl_translate({'text': 'hi', 'target_lang': 'DE'})
    assert set(ok.keys()) == set(err.keys())


# ===========================================================================
# G. input validation (method owns it; assert NO HTTP on bad input)
# ===========================================================================


def test_translate_empty_text_error_no_http(monkeypatch):
    _no_call_post(monkeypatch)
    out = _make_instance().deepl_translate({'text': '   ', 'target_lang': 'DE'})
    assert out['success'] is False
    assert 'error' in out


def test_translate_missing_text_error_no_http(monkeypatch):
    _no_call_post(monkeypatch)
    out = _make_instance().deepl_translate({'target_lang': 'DE'})
    assert out['success'] is False


def test_translate_target_lang_missing_arg_and_cfg_errors_no_http(monkeypatch):
    """Neither a target_lang arg NOR a cfg default -> error dict, no HTTP call.

    Per the ratified arg-or-cfg-or-error contract, target_lang errors ONLY when
    both sources are empty. _Cfg() defaults target_lang='' so this is the
    both-empty case. Discriminates an impl that errors whenever the ARG is
    missing (which would wrongly reject the cfg-default-present case below).
    """
    _no_call_post(monkeypatch)
    out = _make_instance(_Cfg(target_lang='')).deepl_translate({'text': 'hi'})
    assert out['success'] is False
    assert 'error' in out


def test_translate_target_lang_falls_back_to_cfg_default(monkeypatch):
    """No target_lang arg + cfg.target_lang set -> SUCCESS using the cfg value.

    The flipped case: missing arg is NOT an error when the node config supplies
    a default. The outgoing payload must carry the cfg value. Discriminates an
    impl that still errors on a missing arg despite a configured default.
    """
    cap = _capture_post(monkeypatch, _Resp({'translations': [{'text': 'x', 'detected_source_language': 'EN'}]}))
    out = _make_instance(_Cfg(target_lang='FR')).deepl_translate({'text': 'hi'})
    assert out['success'] is True
    assert cap['json']['target_lang'] == 'FR'


def test_translate_target_lang_arg_overrides_cfg_default(monkeypatch):
    """An explicit target_lang arg wins over the cfg default.

    Discriminates an impl that reads cfg first (or ignores the arg when a cfg
    default exists): the payload must carry the ARG value 'DE', not cfg 'FR'.
    """
    cap = _capture_post(monkeypatch, _Resp({'translations': [{'text': 'x', 'detected_source_language': 'EN'}]}))
    out = _make_instance(_Cfg(target_lang='FR')).deepl_translate({'text': 'hi', 'target_lang': 'DE'})
    assert out['success'] is True
    assert cap['json']['target_lang'] == 'DE'


def test_translate_formality_falls_back_to_cfg_default(monkeypatch):
    """No formality arg + valid cfg.formality -> payload carries the cfg value."""
    cap = _capture_post(monkeypatch, _Resp({'translations': [{'text': 'x', 'detected_source_language': 'EN'}]}))
    _make_instance(_Cfg(target_lang='DE', formality='more')).deepl_translate({'text': 'hi'})
    assert cap['json']['formality'] == 'more'


def test_translate_formality_arg_overrides_cfg_default(monkeypatch):
    """An explicit valid formality arg wins over the cfg default."""
    cap = _capture_post(monkeypatch, _Resp({'translations': [{'text': 'x', 'detected_source_language': 'EN'}]}))
    _make_instance(_Cfg(target_lang='DE', formality='more')).deepl_translate(
        {'text': 'hi', 'target_lang': 'DE', 'formality': 'less'}
    )
    assert cap['json']['formality'] == 'less'


def test_translate_formality_omitted_when_neither_arg_nor_cfg(monkeypatch):
    """No formality arg AND empty cfg.formality -> key OMITTED, no error.

    Optional: unlike target_lang, an absent formality is omitted (not an error).
    The OMIT trigger is an EMPTY resolved value, NOT the literal 'default' (see
    the no-aliasing tests below). Discriminates an impl that sends formality: ''
    / None when nothing resolves.
    """
    cap = _capture_post(monkeypatch, _Resp({'translations': [{'text': 'x', 'detected_source_language': 'EN'}]}))
    _make_instance(_Cfg(target_lang='DE', formality='')).deepl_translate({'text': 'hi'})
    assert 'formality' not in cap['json']


def test_translate_formality_default_arg_is_sent_not_aliased(monkeypatch):
    """formality='default' (arg) is a REAL value and must be SENT, not dropped.

    The ratified no-aliasing rule: 'default' is a real DeepL formality, not a
    sentinel for "no preference". Discriminates an impl that treats 'default' as
    omit (e.g. `if formality and formality != 'default'`), which would silently
    drop a value the user explicitly asked for.
    """
    cap = _capture_post(monkeypatch, _Resp({'translations': [{'text': 'x', 'detected_source_language': 'EN'}]}))
    _make_instance(_Cfg(target_lang='DE')).deepl_translate({'text': 'hi', 'formality': 'default'})
    assert cap['json']['formality'] == 'default'


def test_translate_formality_default_from_cfg_is_sent_not_aliased(monkeypatch):
    """cfg.formality='default' with no arg is SENT (present out of the box).

    services.json ships formality='default', so a freshly-added node sends
    formality='default' on every translate. Discriminates the same alias-to-omit
    bug on the cfg path: 'default' resolved from config must reach the payload.
    """
    cap = _capture_post(monkeypatch, _Resp({'translations': [{'text': 'x', 'detected_source_language': 'EN'}]}))
    _make_instance(_Cfg(target_lang='DE', formality='default')).deepl_translate({'text': 'hi'})
    assert cap['json']['formality'] == 'default'


def test_translate_formality_invalid_arg_falls_back_to_cfg(monkeypatch):
    """An invalid formality arg falls through to a valid cfg default.

    Mirrors _resolve_enum: an arg not in the allowed set does not win; the valid
    cfg default applies. Discriminates an impl that forwards the junk arg, or one
    that drops to omit instead of using the cfg fallback.
    """
    cap = _capture_post(monkeypatch, _Resp({'translations': [{'text': 'x', 'detected_source_language': 'EN'}]}))
    _make_instance(_Cfg(target_lang='DE', formality='less')).deepl_translate(
        {'text': 'hi', 'formality': 'super-formal'}
    )
    assert cap['json']['formality'] == 'less'


def test_translate_model_type_falls_back_to_cfg_default(monkeypatch):
    """No model_type arg + valid cfg.model_type -> payload carries the cfg value."""
    cap = _capture_post(monkeypatch, _Resp({'translations': [{'text': 'x', 'detected_source_language': 'EN'}]}))
    _make_instance(_Cfg(target_lang='DE', model_type='quality_optimized')).deepl_translate({'text': 'hi'})
    assert cap['json']['model_type'] == 'quality_optimized'


def test_translate_model_type_arg_overrides_cfg_default(monkeypatch):
    """An explicit valid model_type arg wins over the cfg default."""
    cap = _capture_post(monkeypatch, _Resp({'translations': [{'text': 'x', 'detected_source_language': 'EN'}]}))
    _make_instance(_Cfg(target_lang='DE', model_type='quality_optimized')).deepl_translate(
        {'text': 'hi', 'model_type': 'latency_optimized'}
    )
    assert cap['json']['model_type'] == 'latency_optimized'


def test_translate_model_type_omitted_when_neither_arg_nor_cfg(monkeypatch):
    """No model_type arg AND empty cfg.model_type -> key OMITTED, no error."""
    cap = _capture_post(monkeypatch, _Resp({'translations': [{'text': 'x', 'detected_source_language': 'EN'}]}))
    _make_instance(_Cfg(target_lang='DE', model_type='')).deepl_translate({'text': 'hi'})
    assert 'model_type' not in cap['json']


def test_write_target_lang_no_cfg_fallback(monkeypatch):
    """deepl_write target_lang is ARG-ONLY: a cfg.target_lang must NOT leak in.

    Discriminates an impl that reuses the translate cfg fallback on the write
    path. We deliberately set cfg.target_lang='de' — a value that IS in the write
    set — so a bleed-through would NOT error out; it would silently succeed with
    target_lang='de' in the payload. The clean assertion (request succeeds, but
    target_lang absent) then catches the bleed-through directly rather than
    relying on an incidental validation error. (The real harm is the uppercase
    translate default 'EN-US', which would 400; pinning the no-leak rule with a
    write-valid value makes the test robust to that detail.)
    """
    cap = _capture_post(monkeypatch, _Resp({'improvements': [{'text': 'x', 'detected_source_language': 'EN'}]}))
    out = _make_instance(_Cfg(target_lang='de')).deepl_write({'text': 'draft'})
    assert out['success'] is True
    assert 'target_lang' not in cap['json']


def test_translate_target_lang_unrestricted(monkeypatch):
    """Translate must NOT restrict target_lang to the write set (delta 2).

    'RU' is invalid for write but valid for translate; the translate method must
    issue the request, not reject it client-side.
    """
    cap = _capture_post(monkeypatch, _Resp({'translations': [{'text': 'x', 'detected_source_language': 'EN'}]}))
    out = _make_instance().deepl_translate({'text': 'hi', 'target_lang': 'RU'})
    assert out['success'] is True
    assert cap['json']['target_lang'] == 'RU'


def test_translate_list_over_50_rejected_no_http(monkeypatch):
    """A list of 51 texts -> error dict, no HTTP call (DeepL caps at 50)."""
    _no_call_post(monkeypatch)
    out = _make_instance().deepl_translate({'text': ['x'] * 51, 'target_lang': 'DE'})
    assert out['success'] is False


def test_translate_list_non_string_element_rejected_no_http(monkeypatch):
    """A list containing a non-string element -> error dict, no HTTP call."""
    _no_call_post(monkeypatch)
    out = _make_instance().deepl_translate({'text': ['ok', 42, 'fine'], 'target_lang': 'DE'})
    assert out['success'] is False


def test_translate_list_accepted_three_items(monkeypatch):
    """A valid 3-item list is sent verbatim as payload['text'] (delta 1)."""
    cap = _capture_post(
        monkeypatch,
        _Resp({'translations': [{'text': 'A'}, {'text': 'B'}, {'text': 'C'}]}),
    )
    out = _make_instance().deepl_translate({'text': ['a', 'b', 'c'], 'target_lang': 'DE'})
    assert out['success'] is True
    assert cap['json']['text'] == ['a', 'b', 'c']


def test_translate_bool_text_rejected_no_http(monkeypatch):
    """text=True (bool) -> error dict, never str(True)."""
    _no_call_post(monkeypatch)
    out = _make_instance().deepl_translate({'text': True, 'target_lang': 'DE'})
    assert out['success'] is False


def test_write_empty_text_error_no_http(monkeypatch):
    _no_call_post(monkeypatch)
    out = _make_instance().deepl_write({'text': ''})
    assert out['success'] is False


def test_write_invalid_target_lang_rejected_no_http(monkeypatch):
    """Write target_lang restricted to the write set; 'RU' -> error, no HTTP (delta 2).

    The error names the valid write languages so the agent can self-correct.
    """
    _no_call_post(monkeypatch)
    out = _make_instance().deepl_write({'text': 'draft', 'target_lang': 'RU'})
    assert out['success'] is False


def test_write_valid_target_lang_accepted(monkeypatch):
    """A write-valid target_lang (e.g. 'en-GB') is forwarded."""
    cap = _capture_post(monkeypatch, _Resp({'improvements': [{'text': 'x', 'detected_source_language': 'EN'}]}))
    out = _make_instance().deepl_write({'text': 'draft', 'target_lang': 'en-GB'})
    assert out['success'] is True
    assert cap['json']['target_lang'] == 'en-GB'


def test_security_context_not_in_payload(monkeypatch):
    """An engine-injected security_context never reaches the outgoing payload."""
    cap = _capture_post(monkeypatch, _Resp({'translations': [{'text': 'x', 'detected_source_language': 'EN'}]}))
    _make_instance().deepl_translate({'text': 'hi', 'target_lang': 'DE', 'security_context': {'tok': 1}})
    assert 'security_context' not in cap['json']


def test_none_args_error_no_crash(monkeypatch):
    """Tool called with None -> error dict via empty-args path, no crash."""
    _no_call_post(monkeypatch)
    out = _make_instance().deepl_translate(None)
    assert out['success'] is False
