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

"""Unit tests for the shared Microsoft Graph credential/request machinery."""

from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from unittest import mock

import pytest

_NODES_SRC = Path(__file__).resolve().parents[2] / 'src'
if str(_NODES_SRC) not in sys.path:
    sys.path.insert(0, str(_NODES_SRC))

# Self-sufficient bootstrap: importing the nodes package pulls engine runtime
# modules (depends/rocketlib); stub them if absent so this file never depends
# on a sibling test having run first, then drop what we added.
from unittest.mock import MagicMock

_added = []
for _name in ('depends', 'rocketlib', 'ai', 'ai.common', 'ai.common.utils', 'ai.common.config'):
    if _name not in sys.modules:
        _stub = MagicMock()
        if _name == 'depends':
            _stub.depends = lambda *a, **k: None
        if _name == 'rocketlib':
            _stub.IInstanceBase = object
            _stub.IGlobalBase = object
            _stub.tool_function = lambda **kw: lambda f: f
        sys.modules[_name] = _stub
        _added.append(_name)

_fresh_nodes = 'nodes' not in sys.modules
from nodes.tool_microsoft_365 import graph_client as gc

for _name in _added:
    sys.modules.pop(_name, None)
if _fresh_nodes:
    for _name in [k for k in list(sys.modules) if k == 'nodes' or k.startswith('nodes.')]:
        sys.modules.pop(_name, None)
# Keep a direct reference; tests only touch graph_client's pure functions.

SVC = gc.GraphService(product='Excel')


def _resp(body: dict, status: int = 200, headers: dict | None = None):
    m = mock.MagicMock()
    m.read.return_value = json.dumps(body).encode()
    m.status = status
    m.headers = headers or {}
    m.__enter__ = lambda s: s
    m.__exit__ = lambda s, *a: False
    return m


class TestHostValidation:
    def test_refresh_url_rejects_untrusted_host(self):
        with pytest.raises(ValueError, match='not a trusted OAuth broker'):
            gc.resolve_refresh_url(SVC, 'https://evil.example.com/refresh')

    def test_refresh_url_accepts_builtin_and_env(self, monkeypatch):
        assert gc.resolve_refresh_url(SVC, 'https://oauth2.rocketride.ai/microsoft/refresh')
        monkeypatch.setenv('RR_OAUTH_BROKER_URL', 'https://broker.corp.local')
        assert gc.resolve_refresh_url(SVC, 'https://broker.corp.local/refresh')

    def test_refresh_url_rejects_http_scheme(self):
        with pytest.raises(ValueError):
            gc.resolve_refresh_url(SVC, 'http://oauth2.rocketride.ai/refresh')

    def test_token_uri_must_be_microsoftonline(self):
        with pytest.raises(ValueError, match='login.microsoftonline.com'):
            gc.resolve_token_uri(SVC, 'https://evil.example.com/token')
        ok = gc.resolve_token_uri(SVC, 'https://login.microsoftonline.com/common/oauth2/v2.0/token')
        assert ok.startswith('https://login.microsoftonline.com')


class TestAppOnlyAuth:
    CFG = {'tenantId': 't1', 'clientId': 'c1', 'clientSecret': 's1', 'userPrincipalName': 'a@b.com'}

    def test_acquires_and_caches_token(self):
        auth = gc.build_auth(SVC, 'service', self.CFG, ['Files.ReadWrite'])
        with mock.patch.object(gc, '_urlopen', return_value=_resp({'access_token': 'T', 'expires_in': 3600})) as u:
            assert auth.token() == 'T'
            assert auth.token() == 'T'  # cached, no second POST
            assert u.call_count == 1
            req = u.call_args[0][0]
            assert req.full_url == 'https://login.microsoftonline.com/t1/oauth2/v2.0/token'
            assert b'client_credentials' in req.data and b'.default' in req.data

    def test_expired_token_reacquired(self):
        auth = gc.build_auth(SVC, 'service', self.CFG, [])
        now = 1_700_000_000.0
        with mock.patch.object(gc._time, 'time', return_value=now):
            with mock.patch.object(gc, '_urlopen', return_value=_resp({'access_token': 'T1', 'expires_in': 3600})):
                auth.token()
        # Advance the fake clock past the 3600s lifetime (and 60s leeway).
        with mock.patch.object(gc._time, 'time', return_value=now + 3601):
            with mock.patch.object(gc, '_urlopen', return_value=_resp({'access_token': 'T2', 'expires_in': 3600})):
                assert auth.token() == 'T2'

    def test_missing_config_fails_loud(self):
        with pytest.raises(ValueError, match='tenantId'):
            gc.build_auth(SVC, 'service', {'clientId': 'c', 'clientSecret': 's'}, [])


class TestBrokerUserAuth:
    def _payload(self, **over):
        p = {
            'access_token': 'A',
            'refresh_token': 'R',
            'token_uri': 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
            'oauth_server_url': 'https://oauth2.rocketride.ai/microsoft/refresh',
            'expiry_date': int((time.time() - 10) * 1000),  # already expired
            'scope': 'Files.ReadWrite Mail.Read',
        }
        p.update(over)
        return {'userToken': json.dumps(p)}

    def test_refresh_posts_refresh_token_to_broker(self):
        auth = gc.build_auth(SVC, 'user', self._payload(), ['Files.ReadWrite'])
        with mock.patch.object(
            gc, '_urlopen', return_value=_resp({'access_token': 'B', 'expiry_date': int((time.time() + 3600) * 1000)})
        ) as u:
            assert auth.token() == 'B'
            req = u.call_args[0][0]
            assert req.full_url == 'https://oauth2.rocketride.ai/microsoft/refresh'
            assert json.loads(req.data) == {'refresh_token': 'R'}

    def test_refresh_200_without_token_is_contract_violation(self):
        auth = gc.build_auth(SVC, 'user', self._payload(), [])
        with mock.patch.object(gc, '_urlopen', return_value=_resp({'ok': True})):
            with pytest.raises(ValueError, match='no access token'):
                auth.token()

    def test_refresh_http_error_is_rejection(self):
        auth = gc.build_auth(SVC, 'user', self._payload(), [])
        err = urllib.error.HTTPError('u', 401, 'nope', {}, None)
        with mock.patch.object(gc, '_urlopen', side_effect=err):
            with pytest.raises(ValueError, match='rejected by the broker'):
                auth.token()

    def test_expired_without_refresh_path_fails_now(self):
        cfg = self._payload(oauth_server_url=None, refresh_token=None)
        with pytest.raises(ValueError, match='expired'):
            gc.build_auth(SVC, 'user', cfg, [])

    def test_missing_required_scope_fails_at_build(self):
        with pytest.raises(ValueError, match='Mail.Send'):
            gc.build_auth(SVC, 'user', self._payload(), ['Mail.Send'])

    def test_scope_report_reads_payload(self):
        granted, ok, missing = gc.token_scope_report(SVC, self._payload(), ['Files.Read'])
        assert 'Files.ReadWrite' in granted and ok and missing == []

    def test_token_expiring_within_leeway_is_refreshed(self):
        # 30s of life left is inside the 60s leeway: refresh now rather than
        # risk the token dying mid-request (401 is fatal, not retried).
        cfg = self._payload(expiry_date=int((time.time() + 30) * 1000))
        with mock.patch.object(
            gc, '_urlopen', return_value=_resp({'access_token': 'B', 'expiry_date': int((time.time() + 3600) * 1000)})
        ) as u:
            assert gc.build_auth(SVC, 'user', cfg, []).token() == 'B'
            assert u.call_count == 1

    def test_numeric_string_expiry_date_is_normalized(self):
        # JSON-in-a-string config may carry expiry_date as a numeric string;
        # build_auth must coerce it once so BrokerUserAuth never divides a str.
        cfg = self._payload(expiry_date=str(int((time.time() + 3600) * 1000)))
        with mock.patch.object(gc, '_urlopen') as u:
            assert gc.build_auth(SVC, 'user', cfg, []).token() == 'A'
            assert u.call_count == 0

    def test_garbage_expiry_date_raises_readable_error(self):
        cfg = self._payload(expiry_date='not-a-number')
        with pytest.raises(ValueError, match='Excel.*Please disconnect and reconnect your Microsoft account'):
            gc.build_auth(SVC, 'user', cfg, [])


class TestRedirectAuthStripping:
    """/content 302s go to a pre-authorized host that rejects foreign bearers."""

    def _redirect(self, from_url, to_url):
        req = urllib.request.Request(from_url, headers={'Authorization': 'Bearer T'})
        h = gc._AuthStrippingRedirectHandler()
        fp = mock.MagicMock()
        return h.redirect_request(req, fp, 302, 'Found', {'location': to_url}, to_url)

    def test_cross_host_redirect_drops_authorization(self):
        new_req = self._redirect(
            'https://graph.microsoft.com/v1.0/me/drive/items/X/content',
            'https://public.dl.example.net/pre-authed-blob',
        )
        assert new_req is not None
        assert not new_req.has_header('Authorization')

    def test_same_host_redirect_keeps_authorization(self):
        new_req = self._redirect(
            'https://graph.microsoft.com/v1.0/me/a',
            'https://graph.microsoft.com/v1.0/me/b',
        )
        assert new_req is not None
        assert new_req.has_header('Authorization')


class TestUserBase:
    def test_user_auth_is_me(self):
        assert gc.user_base({'authType': 'user'}) == '/me'

    def test_app_auth_targets_upn(self):
        assert gc.user_base({'authType': 'service', 'userPrincipalName': 'a@b.com'}) == '/users/a@b.com'

    def test_app_auth_without_upn_fails(self):
        with pytest.raises(ValueError, match='Acting User'):
            gc.user_base({'authType': 'service'})


class TestRequest:
    def _auth(self):
        a = mock.MagicMock()
        a.token.return_value = 'TOK'
        return a

    def test_json_request_and_auth_header(self):
        with mock.patch.object(gc, '_urlopen', return_value=_resp({'value': [1]})) as u:
            out = gc.request(SVC, self._auth(), 'GET', '/me/drive/root/children')
            assert out == {'value': [1]}
            req = u.call_args[0][0]
            assert req.full_url.startswith('https://graph.microsoft.com/v1.0/me/drive')
            assert req.get_header('Authorization') == 'Bearer TOK'

    def test_retries_429_with_retry_after(self):
        err = urllib.error.HTTPError('u', 429, 'throttle', {'Retry-After': '0'}, None)
        with mock.patch.object(gc, '_urlopen', side_effect=[err, _resp({'ok': 1})]) as u:
            assert gc.request(SVC, self._auth(), 'GET', '/me') == {'ok': 1}
            assert u.call_count == 2

    def test_network_error_on_get_is_retried_then_succeeds(self):
        errs = [urllib.error.URLError('reset'), TimeoutError('timed out'), ConnectionResetError()]
        with (
            mock.patch.object(gc, '_urlopen', side_effect=[*errs, _resp({'ok': 1})]) as u,
            mock.patch.object(gc._time, 'sleep') as sleep,
        ):
            assert gc.request(SVC, self._auth(), 'GET', '/me') == {'ok': 1}
            assert u.call_count == 4
            assert [c.args[0] for c in sleep.call_args_list] == [1.0, 2.0, 4.0]

    def test_network_error_on_post_is_not_retried(self):
        with (
            mock.patch.object(gc, '_urlopen', side_effect=urllib.error.URLError('reset')) as u,
            mock.patch.object(gc._time, 'sleep') as sleep,
        ):
            with pytest.raises(gc.GraphError, match='network error'):
                gc.request(SVC, self._auth(), 'POST', '/me/sendMail', json_body={})
            assert u.call_count == 1
            assert sleep.call_count == 0

    def test_network_error_budget_exhaustion_raises_graph_error(self):
        with (
            mock.patch.object(gc, '_urlopen', side_effect=TimeoutError('timed out')) as u,
            mock.patch.object(gc._time, 'sleep'),
        ):
            with pytest.raises(gc.GraphError, match='network error'):
                gc.request(SVC, self._auth(), 'GET', '/me')
            assert u.call_count == 4

    def test_retries_429_with_http_date_retry_after_falls_back_to_backoff(self):
        # Graph may send an HTTP-date instead of delta-seconds; float() would
        # raise. Must fall back to exponential backoff instead of erroring.
        err = urllib.error.HTTPError('u', 429, 'throttle', {'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT'}, None)
        with (
            mock.patch.object(gc, '_urlopen', side_effect=[err, _resp({'ok': 1})]) as u,
            mock.patch.object(gc._time, 'sleep') as sleep,
        ):
            assert gc.request(SVC, self._auth(), 'GET', '/me') == {'ok': 1}
            assert u.call_count == 2
            sleep.assert_called_once_with(1.0)  # base_delay * 2**0

    def test_403_names_scope_fix(self):
        import io

        body = io.BytesIO(json.dumps({'error': {'code': 'ErrorAccessDenied', 'message': 'Access is denied.'}}).encode())
        err = urllib.error.HTTPError('u', 403, 'forbidden', {}, body)
        with mock.patch.object(gc, '_urlopen', side_effect=err):
            with pytest.raises(gc.GraphError, match='Excel.*denied'):
                gc.request(SVC, self._auth(), 'GET', '/me')

    def test_extra_headers_merge_into_request(self):
        # extra_headers (e.g. If-Match for docx round-trip) ride on the
        # outgoing request alongside the default headers. urllib normalizes
        # header names to Title-Case, so 'If-Match' is read back as 'If-match'.
        with mock.patch.object(gc, '_urlopen', return_value=_resp({'ok': 1})) as u:
            out = gc.request(
                SVC, self._auth(), 'PUT', '/me/drive/items/1/content', data=b'x', extra_headers={'If-Match': 'abc123'}
            )
            assert out == {'ok': 1}
            req = u.call_args[0][0]
            assert req.get_header('If-match') == 'abc123'
            assert req.get_header('Authorization') == 'Bearer TOK'

    def test_412_precondition_failed_raises_conflict_graph_error(self):
        import io

        body = io.BytesIO(json.dumps({'error': {'code': 'resourceModified', 'message': 'stale etag'}}).encode())
        err = urllib.error.HTTPError('u', 412, 'precondition failed', {}, body)
        with mock.patch.object(gc, '_urlopen', side_effect=err):
            with pytest.raises(gc.GraphError, match='conflict'):
                gc.request(SVC, self._auth(), 'PUT', '/me/drive/items/1/content', data=b'x')

    def test_409_conflict_raises_conflict_graph_error(self):
        import io

        body = io.BytesIO(json.dumps({'error': {'code': 'nameAlreadyExists', 'message': 'conflict'}}).encode())
        err = urllib.error.HTTPError('u', 409, 'conflict', {}, body)
        with mock.patch.object(gc, '_urlopen', side_effect=err):
            with pytest.raises(gc.GraphError, match='conflict'):
                gc.request(SVC, self._auth(), 'PUT', '/me/drive/items/1/content', data=b'x')

    def test_retry_after_is_clamped(self):
        err = urllib.error.HTTPError('u', 429, 'throttle', {'Retry-After': '600'}, None)
        with (
            mock.patch.object(gc, '_urlopen', side_effect=[err, _resp({'ok': 1})]),
            mock.patch.object(gc._time, 'sleep') as sleep,
        ):
            assert gc.request(SVC, self._auth(), 'GET', '/me') == {'ok': 1}
            sleep.assert_called_once_with(gc._MAX_RETRY_AFTER)

    def test_negative_retry_after_is_clamped_to_zero(self):
        err = urllib.error.HTTPError('u', 429, 'throttle', {'Retry-After': '-5'}, None)
        with (
            mock.patch.object(gc, '_urlopen', side_effect=[err, _resp({'ok': 1})]),
            mock.patch.object(gc._time, 'sleep') as sleep,
        ):
            assert gc.request(SVC, self._auth(), 'GET', '/me') == {'ok': 1}
            sleep.assert_called_once_with(0.0)

    def test_post_is_not_retried_on_5xx(self):
        # A POST may already have been applied before Graph reported 503;
        # replaying it could send a message or create an event twice.
        err = urllib.error.HTTPError('u', 503, 'unavailable', {}, None)
        with (
            mock.patch.object(gc, '_urlopen', side_effect=[err, _resp({'ok': 1})]) as u,
            mock.patch.object(gc._time, 'sleep'),
        ):
            with pytest.raises(gc.GraphError, match='HTTP 503'):
                gc.request(SVC, self._auth(), 'POST', '/me/sendMail', json_body={})
            assert u.call_count == 1

    def test_post_is_retried_on_429(self):
        # 429 means Graph did not process the request: safe to replay any method.
        err = urllib.error.HTTPError('u', 429, 'throttle', {'Retry-After': '0'}, None)
        with (
            mock.patch.object(gc, '_urlopen', side_effect=[err, _resp({'ok': 1})]) as u,
            mock.patch.object(gc._time, 'sleep'),
        ):
            assert gc.request(SVC, self._auth(), 'POST', '/me/sendMail', json_body={}) == {'ok': 1}
            assert u.call_count == 2

    def test_get_is_retried_on_5xx(self):
        err = urllib.error.HTTPError('u', 503, 'unavailable', {}, None)
        with (
            mock.patch.object(gc, '_urlopen', side_effect=[err, _resp({'ok': 1})]) as u,
            mock.patch.object(gc._time, 'sleep'),
        ):
            assert gc.request(SVC, self._auth(), 'GET', '/me') == {'ok': 1}
            assert u.call_count == 2

    def test_absolute_graph_url_is_accepted(self):
        link = 'https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=abc'
        with mock.patch.object(gc, '_urlopen', return_value=_resp({'value': []})) as u:
            assert gc.request(SVC, self._auth(), 'GET', link) == {'value': []}
            assert u.call_args[0][0].full_url == link

    @pytest.mark.parametrize(
        'link',
        [
            'https://evil.example.net/v1.0/me/calendarView/delta',
            'http://graph.microsoft.com/v1.0/me/calendarView/delta',
            'https://graph.microsoft.com.evil.example.net/v1.0/me',
        ],
    )
    def test_absolute_non_graph_url_never_receives_bearer(self, link):
        with mock.patch.object(gc, '_urlopen') as u:
            with pytest.raises(ValueError, match='non-Graph URL'):
                gc.request(SVC, self._auth(), 'GET', link)
            u.assert_not_called()
