# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""Tests for the tick source: the one-shot scan callback and the render.

Self-contained: ``rocketlib`` needs the native ``engLib``, so when it is not
importable a minimal stub stands in for the engine base classes. The stub is
installed only for the duration of the module load and then removed again, so
it never shadows a real ``rocketlib`` (CI) and never leaks into ``sys.modules``
for other test modules (see ``nodes/test/_sys_modules_guard.py``, #1640).
"""

from __future__ import annotations

import contextlib
import importlib.util
import sys
import types
from datetime import datetime
from pathlib import Path

import pytest

_NODE_DIR = Path(__file__).resolve().parent.parent.parent / 'src' / 'nodes' / 'tick'

# Sentinel returned by the stubbed ``preventDefault`` so the render test can
# assert the engine's default render is suppressed.
_PREVENT_DEFAULT = 'PREVENT_DEFAULT'


def _real_rocketlib_usable() -> bool:
    """True when a real ``rocketlib`` is importable and carries the bases we need."""
    rl = sys.modules.get('rocketlib')
    if rl is None:
        try:
            import rocketlib as rl  # noqa: F401
        except Exception:
            return False
    return hasattr(getattr(rl, 'IInstanceBase', None), 'preventDefault') and hasattr(rl, 'IEndpointBase')


@contextlib.contextmanager
def _engine_stubs():
    """Provide the minimal ``rocketlib`` surface the tick modules import."""
    if _real_rocketlib_usable():
        yield
        return

    class _IInstanceBase:
        def preventDefault(self):
            return _PREVENT_DEFAULT

    rl = types.ModuleType('rocketlib')
    rl.IEndpointBase = type('IEndpointBase', (), {})
    rl.IGlobalBase = type('IGlobalBase', (), {})
    rl.IInstanceBase = _IInstanceBase
    rl.Entry = object
    rl.debug = lambda *a, **k: None
    rl.error = lambda *a, **k: None

    had = 'rocketlib' in sys.modules
    saved = sys.modules.get('rocketlib')
    sys.modules['rocketlib'] = rl
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


# ---------------------------------------------------------------------------
# scanObjects: exactly one object reported to the engine
# ---------------------------------------------------------------------------


def test_configured_text_reports_one_entry():
    ep = _endpoint('daily digest')
    entries, result = _scan(ep)

    assert len(entries) == 1, 'the tick must report exactly one object'
    entry = entries[0]
    assert entry['name'].startswith('tick-')
    assert ':' not in entry['name'], 'the engine treats the entry name as a path'
    assert entry['size'] == len('daily digest'.encode('utf-8'))
    assert entry['isContainer'] is False
    # Returning ends the scan; the engine then renders the entry and completes.
    assert result is None
    assert ep._text == 'daily digest'


def test_entry_size_is_utf8_byte_length_not_character_count():
    ep = _endpoint('héllo')
    entries, _ = _scan(ep)
    assert entries[0]['size'] == 6


@pytest.mark.parametrize('text', ['', '   ', None])
def test_empty_text_falls_back_to_iso_timestamp(text):
    ep = _endpoint(text)
    _scan(ep)

    assert ep._text == ep._fired_at
    fired = datetime.fromisoformat(ep._text)
    assert fired.tzinfo is not None, 'the fire time must be timezone-aware'
    assert fired.utcoffset().total_seconds() == 0, 'the fire time must be UTC'


def test_missing_service_config_falls_back_to_timestamp():
    # A source started without a parameters block must still fire, not raise.
    ep = _load('IEndpoint').IEndpoint()
    entries, _ = _scan(ep)

    assert len(entries) == 1
    assert ep._text == ep._fired_at
    assert datetime.fromisoformat(ep._text).utcoffset().total_seconds() == 0


def test_nonzero_callback_return_still_reports_exactly_one_entry():
    # The engine returns non-zero from the callback on cancellation/license
    # limit. There is only ever one entry, so there is nothing to stop — the
    # scan must simply return cleanly.
    ep = _endpoint('ping')
    entries, result = _scan(ep, ret=-1)

    assert len(entries) == 1
    assert result is None


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


def test_render_sends_the_timestamp_when_no_text_configured():
    ep = _endpoint('')
    _scan(ep)
    inst = _FakeInstance()

    ep.renderTick(types.SimpleNamespace(name='tick-x'), inst)

    assert inst.calls[0] == ('sendText', (ep._fired_at,))


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
