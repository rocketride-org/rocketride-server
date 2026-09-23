"""Unit tests for ai.common.ssl.ensure().

Covers the two guarantees the module's docstring makes:

- A truststore install/injection failure falls back to certifi rather than
  propagating out of ensure(), so a model load is never killed by it.
- Injection happens exactly once per process, and a caller that arrives while
  the first injection is in flight waits for it instead of returning early and
  downloading weights through a context that is not patched yet.

Run from project root:
  PYTHONPATH=packages/ai/src python -m pytest \
    packages/ai/tests/ai/common/test_ssl_ensure.py -v
"""

import sys
import threading
import time
import types

import pytest

import ai.common.ssl as ssl_module


@pytest.fixture(autouse=True)
def reset_guard(monkeypatch):
    """Clear the one-shot guard and the env vars the fallback writes."""
    monkeypatch.setattr(ssl_module, '_attempted', False)
    monkeypatch.setattr(ssl_module, '_lock', threading.Lock())
    monkeypatch.delenv('SSL_CERT_FILE', raising=False)
    monkeypatch.delenv('REQUESTS_CA_BUNDLE', raising=False)
    yield


@pytest.fixture
def fake_certifi(monkeypatch):
    """Install a certifi double pointing at a known bundle path."""
    certifi = types.ModuleType('certifi')
    certifi.where = lambda: '/fake/cacert.pem'
    monkeypatch.setitem(sys.modules, 'certifi', certifi)
    return certifi


@pytest.fixture
def fake_truststore(monkeypatch):
    """Install a truststore double that records injection calls."""
    calls = []
    truststore = types.ModuleType('truststore')
    truststore.inject_into_ssl = lambda: calls.append(1)
    monkeypatch.setitem(sys.modules, 'truststore', truststore)
    return calls


def test_injects_truststore_on_the_happy_path(monkeypatch, fake_truststore):
    monkeypatch.setattr(ssl_module, 'depends', lambda requirements: True)

    ssl_module.ensure()

    assert fake_truststore == [1]
    assert ssl_module._attempted is True


def test_failed_install_falls_back_to_certifi(monkeypatch, fake_certifi):
    """A depends() failure must still reach the certifi fallback."""

    def boom(requirements):
        raise RuntimeError('pip install failed: network unreachable')

    monkeypatch.setattr(ssl_module, 'depends', boom)

    # No exception escapes: a trust store problem must not fail the model load.
    ssl_module.ensure()

    import os

    assert os.environ['SSL_CERT_FILE'] == '/fake/cacert.pem'
    assert os.environ['REQUESTS_CA_BUNDLE'] == '/fake/cacert.pem'


def test_failed_injection_falls_back_to_certifi(monkeypatch, fake_certifi):
    """An inject_into_ssl() failure takes the same fallback."""
    truststore = types.ModuleType('truststore')

    def boom():
        raise RuntimeError('unsupported platform')

    truststore.inject_into_ssl = boom
    monkeypatch.setitem(sys.modules, 'truststore', truststore)
    monkeypatch.setattr(ssl_module, 'depends', lambda requirements: True)

    ssl_module.ensure()

    import os

    assert os.environ['SSL_CERT_FILE'] == '/fake/cacert.pem'


def test_total_failure_is_not_retried(monkeypatch):
    """When both paths fail, the install is still attempted only once."""
    calls = []

    def boom(requirements):
        calls.append(1)
        raise RuntimeError('nope')

    monkeypatch.setattr(ssl_module, 'depends', boom)
    monkeypatch.setitem(sys.modules, 'certifi', None)

    ssl_module.ensure()
    ssl_module.ensure()
    ssl_module.ensure()

    assert calls == [1]
    assert ssl_module._attempted is True


def test_concurrent_callers_wait_for_the_first_injection(monkeypatch, fake_truststore):
    """ensure() must not return while another thread is mid-injection."""
    state = {'in_flight': 0, 'max_in_flight': 0}

    def slow_depends(requirements):
        state['in_flight'] += 1
        state['max_in_flight'] = max(state['max_in_flight'], state['in_flight'])
        time.sleep(0.15)
        state['in_flight'] -= 1
        return True

    monkeypatch.setattr(ssl_module, 'depends', slow_depends)

    gate = threading.Event()
    observed = []

    def caller():
        gate.wait()
        ssl_module.ensure()
        # Injection must already be complete when ensure() hands back control.
        observed.append(len(fake_truststore))

    threads = [threading.Thread(target=caller) for _ in range(4)]
    for thread in threads:
        thread.start()
    gate.set()
    for thread in threads:
        thread.join()

    assert fake_truststore == [1], 'injection must run exactly once'
    assert state['max_in_flight'] == 1, 'installs must not overlap'
    assert observed == [1, 1, 1, 1], 'no caller may return on a half-patched context'
