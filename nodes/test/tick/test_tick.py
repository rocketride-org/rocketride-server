# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""Tests for the tick source: the one-shot scan callback and the render.

The tick modules always load against a minimal ``rocketlib`` stub, even when
the real one is importable. The real ``IInstanceBase.preventDefault`` raises
the engine's PreventDefault error, so tests that depend on which base class
won the import would pass without an engine build and fail with one. The stub
sits in ``sys.modules`` only while a tick module loads, and the previous entry
is put back afterwards, so nothing leaks into other test modules (see
``nodes/test/_sys_modules_guard.py``, #1640).
"""

from __future__ import annotations

import contextlib
import importlib.util
import sys
import types
from datetime import datetime, timezone
from pathlib import Path

import pytest

_NODE_DIR = Path(__file__).resolve().parent.parent.parent / 'src' / 'nodes' / 'tick'

# Sentinel returned by the stubbed ``preventDefault`` so the render test can
# assert the engine's default render is suppressed.
_PREVENT_DEFAULT = 'PREVENT_DEFAULT'


def _noop(*args, **kwargs):
    return None


class _IInstanceBase:
    def preventDefault(self):
        return _PREVENT_DEFAULT


def _rocketlib_stub() -> types.ModuleType:
    """The ``rocketlib`` names the tick IEndpoint and IInstance import."""
    rl = types.ModuleType('rocketlib')
    rl.IEndpointBase = type('IEndpointBase', (), {})
    rl.IInstanceBase = _IInstanceBase
    rl.Entry = object
    rl.debug = _noop
    rl.warning = _noop
    return rl


@contextlib.contextmanager
def _engine_stubs():
    """Swap the stub in for ``rocketlib`` while a tick module loads, then restore."""
    had = 'rocketlib' in sys.modules
    saved = sys.modules.get('rocketlib')
    sys.modules['rocketlib'] = _rocketlib_stub()
    try:
        yield
    finally:
        if had:
            sys.modules['rocketlib'] = saved
        else:
            sys.modules.pop('rocketlib', None)


def _load(name: str):
    """Load one tick module under a unique name, engine bases stubbed."""
    with _engine_stubs():
        spec = importlib.util.spec_from_file_location(f'tick_{name}_real', str(_NODE_DIR / f'{name}.py'))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod


def _endpoint(text=None):
    """A tick IEndpoint wired to a flat parameters block (``text=None`` omits it)."""
    ep = _load('IEndpoint').IEndpoint()
    params = {} if text is None else {'text': text}
    ep.endpoint = types.SimpleNamespace(serviceConfig={'parameters': params})
    return ep


def _scan(ep, ret=0):
    """Run scanObjects, returning (entries reported, scan return value)."""
    entries = []

    def callback(entry):
        entries.append(entry)
        return ret

    return entries, ep.scanObjects('', callback)


class _FakeInstance:
    """Records the engine send* calls issued during a render."""

    def __init__(self):
        self.calls = []

    def __getattr__(self, name):
        def record(*args):
            self.calls.append((name, args))

        return record


def _fire(ep):
    """Run one tick the way the engine does: scan, then render the reported entry.

    Returns the one reported entry and the text the render sent.
    """
    entries, _ = _scan(ep)
    assert len(entries) == 1, 'the tick must report exactly one object'
    inst = _FakeInstance()
    ep.renderTick(types.SimpleNamespace(name=entries[0]['name']), inst)
    sent = [args for name, args in inst.calls if name == 'sendText']
    assert len(sent) == 1, 'the tick must send exactly one text'
    return entries[0], sent[0][0]


def _assert_fire_time(entry, text):
    """The sent text is the fire time in ISO 8601 UTC, matching the entry."""
    fired = datetime.fromisoformat(text)
    assert fired.tzinfo is not None, 'the fire time must be timezone-aware'
    assert fired.utcoffset().total_seconds() == 0, 'the fire time must be UTC'
    named = datetime.strptime(entry['name'], 'tick-%Y%m%dT%H%M%SZ').replace(tzinfo=timezone.utc)
    assert fired == named, 'the entry name and the sent text must carry the same fire time'
    assert entry['size'] == len(text.encode('utf-8'))


# ---------------------------------------------------------------------------
# scanObjects: exactly one object reported to the engine
# ---------------------------------------------------------------------------


def test_configured_text_reports_one_entry():
    ep = _endpoint('daily digest')
    entries, _ = _scan(ep)

    assert len(entries) == 1, 'the tick must report exactly one object'
    entry = entries[0]
    assert entry['name'].startswith('tick-')
    assert ':' not in entry['name'], 'the engine treats the entry name as a path'
    assert entry['size'] == len('daily digest'.encode('utf-8'))
    assert entry['isContainer'] is False


def test_entry_size_is_utf8_byte_length_not_character_count():
    ep = _endpoint('héllo')
    entries, _ = _scan(ep)
    assert entries[0]['size'] == 6


@pytest.mark.parametrize('text', ['', '   ', None])
def test_empty_text_falls_back_to_iso_timestamp(text):
    entry, sent = _fire(_endpoint(text))

    _assert_fire_time(entry, sent)


def test_missing_endpoint_falls_back_to_timestamp():
    # A source started without a parameters block must still fire, not raise.
    ep = _load('IEndpoint').IEndpoint()
    entry, sent = _fire(ep)

    _assert_fire_time(entry, sent)


def test_engine_config_without_parameters_key_falls_back_to_timestamp():
    # The engine's serviceConfig is an IJson whose missing-key error reaches
    # Python as ValueError, not KeyError. A tick written as "config": {} must
    # still fire.
    class EngineJson:
        def __getitem__(self, key):
            raise ValueError('Invalid key')

    ep = _load('IEndpoint').IEndpoint()
    ep.endpoint = types.SimpleNamespace(serviceConfig=EngineJson())
    entry, sent = _fire(ep)

    _assert_fire_time(entry, sent)


def test_nonzero_callback_return_still_reports_exactly_one_entry():
    # The engine returns non-zero from the callback on cancellation/license
    # limit. There is only ever one entry, so there is nothing to stop; the
    # scan must simply return cleanly.
    ep = _endpoint('ping')
    entries, _ = _scan(ep, ret=-1)

    assert len(entries) == 1


# ---------------------------------------------------------------------------
# renderTick: the one write into the already-open pipe
# ---------------------------------------------------------------------------


def test_render_sends_text_then_closes():
    ep = _endpoint('daily digest')
    entries, _ = _scan(ep)
    inst = _FakeInstance()

    ep.renderTick(types.SimpleNamespace(name=entries[0]['name']), inst)

    assert [c[0] for c in inst.calls] == ['sendText', 'sendClose']
    assert inst.calls[0][1] == ('daily digest',)
    assert inst.calls[1][1] == ()


# ---------------------------------------------------------------------------
# IInstance.renderObject: engine render entry point delegates to the endpoint
# ---------------------------------------------------------------------------


def _instance():
    inst = _load('IInstance').IInstance()
    inst.instance = _FakeInstance()
    return inst


def test_instance_render_object_delegates_and_prevents_default():
    inst = _instance()
    entry = types.SimpleNamespace(name='tick-20260913T080000Z')

    calls = []
    inst.IEndpoint = types.SimpleNamespace(renderTick=lambda e, i: calls.append((e, i)))

    assert inst.renderObject(entry) == _PREVENT_DEFAULT
    assert calls == [(entry, inst.instance)]
