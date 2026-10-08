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
"""Unit tests for ai.common.decision.client (httpx.MockTransport, no network)."""

import json

import httpx
import pytest

from ai.common.decision.client import SystemOneClient, SystemOneError

OK = {
    'model': 'jev-1.13.0',
    'answers': {'u': {'type': 'noul', 'noul': 0.95}},
    'usage': {'input_tokens': 296, 'output_tokens': 20},
}


def _client(handler, **kw):
    return SystemOneClient(
        kw.pop('base', 'https://api.typesafe.ai'),
        kw.pop('key', 'sk-1'),
        transport=httpx.MockTransport(handler),
        sleep=lambda _s: None,
        **kw,
    )


@pytest.mark.parametrize(
    'base, url',
    [
        ('https://api.typesafe.ai', 'https://api.typesafe.ai/v1/systemone'),
        ('https://api.typesafe.ai/', 'https://api.typesafe.ai/v1/systemone'),
        ('http://localhost:11434/v1', 'http://localhost:11434/v1/systemone'),
    ],
)
def test_endpoint(base, url):
    assert SystemOneClient(base).endpoint == url


def test_decide_sends_body_and_auth():
    seen = {}

    def handler(request):
        seen['auth'] = request.headers.get('authorization')
        seen['body'] = json.loads(request.content)
        return httpx.Response(200, json=OK)

    out = _client(handler).decide('jev-latest', 'text', {'u': {'type': 'noul', 'instructions': 'q'}})
    assert out == OK
    assert seen['auth'] == 'Bearer sk-1'
    assert seen['body'] == {
        'model': 'jev-latest',
        'state': 'text',
        'questions': {'u': {'type': 'noul', 'instructions': 'q'}},
    }


def test_no_auth_header_without_key():
    seen = {}

    def handler(request):
        seen['auth'] = request.headers.get('authorization')
        return httpx.Response(200, json=OK)

    _client(handler, key=None).decide('nimble', 's', {})
    assert seen['auth'] is None


def test_retries_then_succeeds_honouring_retry_after():
    calls, sleeps = [], []

    def handler(request):
        calls.append(1)
        if len(calls) < 3:
            return httpx.Response(429, headers={'Retry-After': '2'}, json={'error': 'slow down'})
        return httpx.Response(200, json=OK)

    client = SystemOneClient('https://x', 'k', transport=httpx.MockTransport(handler), sleep=sleeps.append)
    assert client.decide('m', 's', {}) == OK
    assert len(calls) == 3 and sleeps == [2.0, 2.0]


def test_retry_after_ms_header():
    sleeps, calls = [], []

    def handler(request):
        calls.append(1)
        return httpx.Response(503 if len(calls) == 1 else 200, headers={'retry-after-ms': '250'}, json=OK)

    SystemOneClient('https://x', transport=httpx.MockTransport(handler), sleep=sleeps.append).decide('m', 's', {})
    assert sleeps == [0.25]


def test_retries_exhausted_raises_server():
    def handler(request):
        return httpx.Response(529, json={'error': 'overloaded'})

    with pytest.raises(SystemOneError) as exc:
        _client(handler, max_retries=2).decide('m', 's', {})
    assert exc.value.kind == 'server' and exc.value.status == 529


@pytest.mark.parametrize(
    'status, body, kind',
    [
        (401, {'error': 'bad key'}, 'auth'),
        (403, {'error': 'nope'}, 'auth'),
        (404, {'error': 'model "nimble" not found'}, 'not_found'),
        (413, {'error': 'too big'}, 'too_large'),
        (400, {'error': {'code': 'max_tokens_exceeded'}}, 'too_large'),
        (422, {'detail': 'questions.u.type'}, 'invalid'),
        (400, {'error': 'bad option count'}, 'invalid'),
    ],
)
def test_error_kinds_not_retried(status, body, kind):
    calls = []

    def handler(request):
        calls.append(1)
        return httpx.Response(status, json=body, headers={'x-typesafe-request-id': 'req-9'})

    with pytest.raises(SystemOneError) as exc:
        _client(handler).decide('m', 's', {})
    assert exc.value.kind == kind and exc.value.status == status and exc.value.request_id == 'req-9'
    assert len(calls) == 1


def test_network_error_retried_then_raised():
    def handler(request):
        raise httpx.ConnectError('refused', request=request)

    with pytest.raises(SystemOneError) as exc:
        _client(handler, max_retries=1).decide('m', 's', {})
    assert exc.value.kind == 'network'


def test_non_json_success_is_protocol_error():
    with pytest.raises(SystemOneError) as exc:
        _client(lambda r: httpx.Response(200, text='<html>')).decide('m', 's', {})
    assert exc.value.kind == 'protocol'


def test_non_ascii_state_and_content_type():
    from ai.common.decision.limits import encode_json

    seen = {}

    def handler(request):
        seen['content'] = request.content
        seen['content_type'] = request.headers.get('content-type')
        return httpx.Response(200, json=OK)

    body = {'model': 'm', 'state': 'café 😀', 'questions': {}}
    _client(handler).decide('m', 'café 😀', {})
    assert seen['content'] == encode_json(body)
    assert seen['content_type'] == 'application/json'


def test_lone_surrogate_in_state_reaches_transport():
    seen = {}

    def handler(request):
        seen['called'] = True
        return httpx.Response(200, json=OK)

    _client(handler).decide('m', 'text\ud800more', {})
    assert seen['called'] is True


def test_last_request_id_set_from_response_header():
    def handler(request):
        return httpx.Response(200, json=OK, headers={'x-typesafe-request-id': 'req-1'})

    client = _client(handler)
    client.decide('m', 's', {})
    assert client.last_request_id == 'req-1'


@pytest.mark.parametrize(
    'header_value, expected_delay',
    [
        ('abc', None),  # unparseable, uses backoff
        ('-1', None),  # negative, uses backoff
        ('inf', None),  # infinite, uses backoff
        ('nan', None),  # NaN, uses backoff
        ('3600', 60.0),  # capped at MAX_RETRY_DELAY
    ],
)
def test_delay_handles_bad_retry_after_header(header_value, expected_delay):
    sleeps = []

    def handler(request):
        return httpx.Response(503, headers={'Retry-After': header_value}, json=OK)

    client = SystemOneClient('https://x', transport=httpx.MockTransport(handler), sleep=sleeps.append)
    try:
        client.decide('m', 's', {})
    except SystemOneError:
        pass

    assert len(sleeps) > 0
    delay = sleeps[0]
    if expected_delay is not None:
        assert delay == expected_delay
    else:
        # Should use exponential backoff, not crash
        assert 0 <= delay <= 60.0


@pytest.mark.parametrize('header_value', ['abc', '-1', 'inf', 'nan'])
def test_delay_handles_bad_retry_after_ms_header(header_value):
    sleeps = []

    def handler(request):
        return httpx.Response(503, headers={'retry-after-ms': header_value}, json=OK)

    client = SystemOneClient('https://x', transport=httpx.MockTransport(handler), sleep=sleeps.append)
    try:
        client.decide('m', 's', {})
    except SystemOneError:
        pass

    assert len(sleeps) > 0
    # Should not crash, should use a sane default
    assert 0 <= sleeps[0] <= 60.0


def test_error_message_excludes_body_but_exc_body_keeps_it():
    def handler(request):
        return httpx.Response(422, json={'detail': 'echo: SECRET-DOC-TEXT ' + 'y' * 800})

    with pytest.raises(SystemOneError) as exc:
        _client(handler).decide('m', 's', {})
    assert 'SECRET-DOC-TEXT' not in str(exc.value)
    assert '422' in str(exc.value) and 'https://api.typesafe.ai/v1/systemone' in str(exc.value)
    assert 'SECRET-DOC-TEXT' in exc.value.body and len(exc.value.body) <= 500


@pytest.mark.parametrize(
    'body, code',
    [
        ({'error': {'code': 'bad_option'}}, 'bad_option'),
        ({'error': {'type': 'invalid_request'}}, 'invalid_request'),
        ({'error': 'short message'}, 'short message'),
        ({'error': 'z' * 81}, None),
        ({'detail': 'x'}, None),
    ],
)
def test_error_message_carries_only_a_short_code(body, code):
    def handler(request):
        return httpx.Response(400, json=body)

    with pytest.raises(SystemOneError) as exc:
        _client(handler).decide('m', 's', {})
    message = str(exc.value)
    assert (code in message) if code else ('z' * 81 not in message and 'detail' not in message)


@pytest.mark.parametrize('base', ['api.typesafe.ai', 'localhost:11434/v1', '', 'ftp://x'])
def test_scheme_less_base_url_rejected(base):
    with pytest.raises(ValueError, match='http'):
        SystemOneClient(base)
