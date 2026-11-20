"""Unit tests for rr_ci_skip_wmi.py: the Windows CI hook that skips CPython 3.12's WMI queries.

Every test that changes ``_wmi`` or ``sys`` goes through ``monkeypatch``, so no
patch outlives its test.
"""

import importlib.util
import platform
import sys
import types
from pathlib import Path

import pytest

_SOURCE = Path(__file__).resolve().parent / 'rr_ci_skip_wmi.py'


def _load():
    """Run rr_ci_skip_wmi.py as a fresh module under a private name."""
    spec = importlib.util.spec_from_file_location('_rr_ci_skip_wmi_under_test', _SOURCE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _fake_wmi(monkeypatch):
    """Put a fake ``_wmi`` in ``sys.modules`` and return it with its original function."""
    fake = types.ModuleType('_wmi')

    def original(query):
        return 'Version=10.0.0\0'

    fake.exec_query = original
    monkeypatch.setitem(sys.modules, '_wmi', fake)
    return fake, original


def _as(monkeypatch, platform_name, version):
    monkeypatch.setattr(sys, 'platform', platform_name)
    monkeypatch.setattr(sys, 'version_info', version)


def test_not_windows_leaves_wmi_untouched(monkeypatch):
    fake, original = _fake_wmi(monkeypatch)
    _as(monkeypatch, 'linux', (3, 12, 13))

    assert _load().skip_wmi_queries() is False
    assert fake.exec_query is original


@pytest.mark.parametrize('version', [(3, 13, 0), (3, 14, 1)])
def test_python_313_or_later_leaves_wmi_untouched(monkeypatch, version):
    fake, original = _fake_wmi(monkeypatch)
    _as(monkeypatch, 'win32', version)

    assert _load().skip_wmi_queries() is False
    assert fake.exec_query is original


def test_windows_312_makes_exec_query_raise_oserror(monkeypatch):
    fake, _ = _fake_wmi(monkeypatch)
    _as(monkeypatch, 'win32', (3, 12, 13))

    assert _load().skip_wmi_queries() is True
    with pytest.raises(OSError):
        fake.exec_query('SELECT Version FROM Win32_OperatingSystem')


def test_applying_twice_keeps_the_same_replacement(monkeypatch):
    fake, _ = _fake_wmi(monkeypatch)
    _as(monkeypatch, 'win32', (3, 12, 13))
    module = _load()

    first = fake.exec_query
    assert module.skip_wmi_queries() is True
    assert fake.exec_query is first
    # A second copy of the module (a reload) recognises the first one's replacement.
    assert _load().skip_wmi_queries() is True
    assert fake.exec_query is first


def test_missing_wmi_does_not_break_startup(monkeypatch):
    _as(monkeypatch, 'win32', (3, 12, 13))
    # None in sys.modules makes ``import _wmi`` raise ImportError.
    monkeypatch.setitem(sys.modules, '_wmi', None)

    assert _load().skip_wmi_queries() is False


def test_an_unexpected_error_does_not_break_startup(monkeypatch):
    class Locked(types.ModuleType):
        def __setattr__(self, name, value):
            raise AttributeError(name)

    locked = Locked('_wmi')
    locked.__dict__['exec_query'] = lambda query: ''
    monkeypatch.setitem(sys.modules, '_wmi', locked)
    _as(monkeypatch, 'win32', (3, 12, 13))

    assert _load().skip_wmi_queries() is False


@pytest.mark.skipif(
    sys.platform != 'win32' or sys.version_info >= (3, 13), reason='needs the real _wmi of CPython 3.12 on Windows'
)
def test_platform_falls_back_without_wmi(monkeypatch):
    import _wmi

    # Restores the real function after the test, whatever the patch does.
    monkeypatch.setattr(_wmi, 'exec_query', _wmi.exec_query)
    monkeypatch.setattr(platform, '_uname_cache', None)

    assert _load().skip_wmi_queries() is True
    with pytest.raises(OSError):
        _wmi.exec_query('SELECT Version FROM Win32_OperatingSystem')

    assert platform.system() == 'Windows'
    release, version, csd, ptype = platform.win32_ver()
    assert release
    assert version.count('.') == 2
    uname = platform.uname()
    assert uname.system == 'Windows'
    assert uname.machine
    assert uname.processor
