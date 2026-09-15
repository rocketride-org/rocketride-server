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

import hashlib
import hmac
import importlib

import pytest

from nodes.slack.IGlobal import IGlobal
from nodes.slack.slack_events import resolve_signing_secret, verify_slack_signature


SECRET = 'test-signing-secret'
NOW = 1_700_000_000
BODY = b'{"type":"event_callback","event_id":"Ev1"}'


def signature(body: bytes = BODY, timestamp: int = NOW) -> str:
    base = b'v0:' + str(timestamp).encode() + b':' + body
    return 'v0=' + hmac.new(SECRET.encode(), base, hashlib.sha256).hexdigest()


def test_accepts_exact_raw_body_signature():
    assert verify_slack_signature(SECRET, str(NOW), signature(), BODY, now=NOW)


def test_signature_base_preserves_the_exact_timestamp_header():
    timestamp = f'0{NOW}'
    base = b'v0:' + timestamp.encode() + b':' + BODY
    provided = 'v0=' + hmac.new(SECRET.encode(), base, hashlib.sha256).hexdigest()

    assert verify_slack_signature(SECRET, timestamp, provided, BODY, now=NOW)


@pytest.mark.parametrize(
    ('secret', 'timestamp', 'provided', 'body'),
    [
        ('', str(NOW), signature(), BODY),
        (SECRET, '', signature(), BODY),
        (SECRET, str(NOW), '', BODY),
        (SECRET, str(NOW), 'v0=wrong', BODY),
        (SECRET, str(NOW - 301), signature(timestamp=NOW - 301), BODY),
        (SECRET, str(NOW + 301), signature(timestamp=NOW + 301), BODY),
        (SECRET, str(NOW), signature(), BODY + b' '),
    ],
)
def test_rejects_invalid_or_replayed_request(secret, timestamp, provided, body):
    assert not verify_slack_signature(secret, timestamp, provided, body, now=NOW)


def test_secret_config_precedes_environment():
    assert resolve_signing_secret({'signingSecret': ' config '}, {'SLACK_SIGNING_SECRET': 'env'}) == 'config'


def test_secret_falls_back_to_environment():
    assert resolve_signing_secret({}, {'SLACK_SIGNING_SECRET': ' env '}) == 'env'


class _FakeEndpoint:
    def __init__(self, open_mode):
        self.endpoint = type(
            'EndpointState',
            (),
            {
                'openMode': open_mode,
                'serviceConfig': {'parameters': {}},
            },
        )()
        self._signing_secret = 'unchanged'


def _global(open_mode):
    instance = IGlobal()
    instance.IEndpoint = _FakeEndpoint(open_mode)
    instance.glb = type('GlobalState', (), {'logicalType': 'slack', 'connConfig': {}})()
    return instance


def test_config_mode_does_not_load_or_transfer_runtime_secret():
    global_module = importlib.import_module('nodes.slack.IGlobal')

    instance = _global(global_module.OPEN_MODE.CONFIG)

    instance.beginGlobal()

    assert not hasattr(instance, 'signing_secret')
    assert instance.IEndpoint._signing_secret == 'unchanged'


def test_execution_uses_config_secret_before_environment(monkeypatch):
    global_module = importlib.import_module('nodes.slack.IGlobal')

    instance = _global(global_module.OPEN_MODE.SOURCE)
    instance.IEndpoint.endpoint.serviceConfig = {'parameters': {'signingSecret': 'configured'}}
    monkeypatch.setenv('SLACK_SIGNING_SECRET', 'environment')

    instance.beginGlobal()

    assert instance.signing_secret == 'configured'
    assert instance.IEndpoint._signing_secret == 'configured'


def test_execution_reads_signing_secret_from_endpoint_service_config_parameters():
    global_module = importlib.import_module('nodes.slack.IGlobal')

    instance = _global(global_module.OPEN_MODE.SOURCE)
    instance.IEndpoint.endpoint.serviceConfig = {'parameters': {'signingSecret': 'canvas-secret'}}

    instance.beginGlobal()

    assert instance.signing_secret == 'canvas-secret'
    assert instance.IEndpoint._signing_secret == 'canvas-secret'


def test_validate_config_reads_signing_secret_from_endpoint_service_config_parameters(monkeypatch):
    global_module = importlib.import_module('nodes.slack.IGlobal')

    instance = _global(global_module.OPEN_MODE.CONFIG)
    instance.IEndpoint.endpoint.serviceConfig = {'parameters': {'signingSecret': 'canvas-secret'}}
    warnings = []
    monkeypatch.setattr(global_module, 'warning', warnings.append)

    instance.validateConfig()

    assert warnings == []


def test_missing_secret_warns_instead_of_raising(monkeypatch):
    global_module = importlib.import_module('nodes.slack.IGlobal')

    instance = _global(global_module.OPEN_MODE.SOURCE)
    warnings = []
    monkeypatch.delenv('SLACK_SIGNING_SECRET', raising=False)
    monkeypatch.setattr(global_module, 'warning', warnings.append)

    instance.beginGlobal()

    assert warnings


def test_end_global_clears_global_and_endpoint_secrets():
    global_module = importlib.import_module('nodes.slack.IGlobal')

    instance = _global(global_module.OPEN_MODE.SOURCE)
    instance.signing_secret = 'secret'
    instance.IEndpoint._signing_secret = 'secret'

    instance.endGlobal()

    assert instance.signing_secret == ''
    assert instance.IEndpoint._signing_secret == ''
