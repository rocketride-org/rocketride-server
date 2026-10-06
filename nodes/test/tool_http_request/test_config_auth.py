# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Config-level authentication and default headers for tool_http_request (#2495).

A credential set in the node config must actually be sent, must only travel
to whitelisted https hosts, and must not be replaceable per call.
"""

from __future__ import annotations

import re
import types
from unittest.mock import Mock

import pytest

GITHUB = r'^https://api\.github\.com(?:/|$)'


def _started_global(iglobal, cfg: dict):
    """Run ``beginGlobal`` against ``cfg`` and return the IGlobal instance."""
    iglobal.Config.getNodeConfig.return_value = cfg
    instance = object.__new__(iglobal.IGlobal)
    instance.IEndpoint = types.SimpleNamespace(endpoint=types.SimpleNamespace(openMode='run'))
    instance.glb = types.SimpleNamespace(logicalType='tool_http_request', connConfig={})
    instance.beginGlobal()
    return instance


def _capture_transport(monkeypatch, http_client):
    """Stub DNS validation and the socket send; return the captured request kwargs."""
    sent: dict = {}
    monkeypatch.setattr(http_client, '_validate_public_url', lambda url: ())
    monkeypatch.setattr(http_client, '_build_response', lambda resp, elapsed_ms: {'status_code': 200})

    def fake_send(req_kwargs, addresses):
        sent.update(req_kwargs)
        return Mock()

    monkeypatch.setattr(http_client, '_request_with_validated_addresses', fake_send)
    return sent


def _instance(iinstance, glb):
    instance = object.__new__(iinstance.IInstance)
    instance.IGlobal = glb
    return instance


# ---------------------------------------------------------------------------
# IGlobal._build_config_auth
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'cfg', [{}, {'authType': ''}, {'authType': 'none'}, {'authType': ' None '}, {'authType': None}]
)
def test_no_auth_type_means_no_config_auth(node_modules, cfg):
    _http_client, iglobal, _iinstance = node_modules

    assert iglobal.IGlobal._build_config_auth(cfg) is None


def test_bearer_config_auth_matches_per_call_shape(node_modules):
    _http_client, iglobal, _iinstance = node_modules

    auth = iglobal.IGlobal._build_config_auth({'authType': 'Bearer', 'authToken': '  ghp_abc  '})

    assert auth == {'type': 'bearer', 'bearer': {'token': 'ghp_abc'}}


def test_basic_config_auth_allows_empty_password(node_modules):
    _http_client, iglobal, _iinstance = node_modules

    auth = iglobal.IGlobal._build_config_auth({'authType': 'basic', 'authUsername': 'svc', 'authPassword': ''})

    assert auth == {'type': 'basic', 'basic': {'username': 'svc', 'password': ''}}


def test_api_key_config_auth_is_header_only(node_modules):
    _http_client, iglobal, _iinstance = node_modules

    auth = iglobal.IGlobal._build_config_auth(
        {'authType': 'api_key', 'authHeaderName': 'X-API-Key', 'authHeaderValue': 'k-1'}
    )

    assert auth == {'type': 'api_key', 'api_key': {'key': 'X-API-Key', 'value': 'k-1', 'add_to': 'header'}}


@pytest.mark.parametrize(
    'cfg,error',
    [
        ({'authType': 'oauth'}, 'authType must be one of'),
        ({'authType': 'bearer'}, 'authToken is empty'),
        ({'authType': 'bearer', 'authToken': '   '}, 'authToken is empty'),
        ({'authType': 'basic', 'authPassword': 'pw'}, 'authUsername is empty'),
        ({'authType': 'api_key', 'authHeaderValue': 'k'}, 'authHeaderName is empty'),
        ({'authType': 'api_key', 'authHeaderName': 'X-API-Key'}, 'authHeaderValue is empty'),
        (
            {'authType': 'api_key', 'authHeaderName': 'X API Key', 'authHeaderValue': 'k'},
            'not a valid HTTP header name',
        ),
        ({'authType': 'api_key', 'authHeaderName': 'X-Key:', 'authHeaderValue': 'k'}, 'not a valid HTTP header name'),
        ({'authType': 'api_key', 'authHeaderName': 'host', 'authHeaderValue': 'k'}, 'cannot be Host'),
        ({'authType': 'bearer', 'authToken': 'abc\r\nX-Injected: 1'}, 'must not contain line breaks'),
        ({'authType': 'basic', 'authUsername': 'u\nx', 'authPassword': 'p'}, 'must not contain line breaks'),
    ],
)
def test_incomplete_or_invalid_config_auth_fails_closed(node_modules, cfg, error):
    """A configured credential is never silently downgraded to anonymous."""
    _http_client, iglobal, _iinstance = node_modules

    with pytest.raises(ValueError, match=error):
        iglobal.IGlobal._build_config_auth(cfg)


@pytest.mark.parametrize(
    'cfg,field,placeholder',
    [
        ({'authType': 'bearer', 'authToken': '${ROCKETRIDE_GITHUB_TOKEN}'}, 'authToken', '${ROCKETRIDE_GITHUB_TOKEN}'),
        ({'authType': 'bearer', 'authToken': 'Bearer ${ROCKETRIDE_X}'}, 'authToken', '${ROCKETRIDE_X}'),
        (
            {'authType': 'basic', 'authUsername': 'svc', 'authPassword': '${ROCKETRIDE_PW}'},
            'authPassword',
            '${ROCKETRIDE_PW}',
        ),
        (
            {'authType': 'api_key', 'authHeaderName': 'X-Key', 'authHeaderValue': '${ROCKETRIDE_KEY}'},
            'authHeaderValue',
            '${ROCKETRIDE_KEY}',
        ),
    ],
)
def test_unresolved_placeholder_names_the_missing_variable(node_modules, cfg, field, placeholder):
    """The engine leaves ${ROCKETRIDE_*} untouched when unset; never send that literal."""
    _http_client, iglobal, _iinstance = node_modules

    with pytest.raises(ValueError) as excinfo:
        iglobal.IGlobal._build_config_auth(cfg)

    message = str(excinfo.value)
    assert message.startswith(field)
    assert placeholder in message
    assert 'unresolved placeholder' in message


def test_redacted_placeholder_is_rejected(node_modules):
    """Non-ROCKETRIDE_ variables are redacted by the engine; the marker must not go on the wire."""
    _http_client, iglobal, _iinstance = node_modules

    with pytest.raises(ValueError, match='outside the ROCKETRIDE_\\* namespace'):
        iglobal.IGlobal._build_config_auth({'authType': 'bearer', 'authToken': '<REDACTED>'})


# ---------------------------------------------------------------------------
# IGlobal._build_default_headers
# ---------------------------------------------------------------------------


@pytest.mark.parametrize('cfg', [{}, {'defaultHeaders': None}, {'defaultHeaders': ''}, {'defaultHeaders': []}])
def test_missing_default_headers_is_empty(node_modules, cfg):
    _http_client, iglobal, _iinstance = node_modules

    assert iglobal.IGlobal._build_default_headers(cfg) == {}


def test_default_headers_keep_case_and_skip_blank_rows(node_modules):
    _http_client, iglobal, _iinstance = node_modules

    headers = iglobal.IGlobal._build_default_headers(
        {
            'defaultHeaders': [
                {'headerName': '', 'headerValue': ''},
                {'headerName': ' Accept ', 'headerValue': ' application/vnd.github+json '},
                {},
                {'headerName': 'X-GitHub-Api-Version', 'headerValue': '2022-11-28'},
                {'headerName': 'X-Empty', 'headerValue': ''},
            ]
        }
    )

    assert headers == {
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'X-Empty': '',
    }


def test_default_headers_accept_json_string_form(node_modules):
    _http_client, iglobal, _iinstance = node_modules

    headers = iglobal.IGlobal._build_default_headers(
        {'defaultHeaders': '[{"headerName": "Accept", "headerValue": "*/*"}]'}
    )

    assert headers == {'Accept': '*/*'}


@pytest.mark.parametrize(
    'rows,error',
    [
        ([{'headerName': '', 'headerValue': 'x'}], 'has a value but no header name'),
        ([{'headerName': 'Authorization', 'headerValue': 'Bearer t'}], 'Authorization cannot be a default header'),
        ([{'headerName': 'authorization', 'headerValue': 'Bearer t'}], 'cannot be a default header'),
        ([{'headerName': 'Proxy-Authorization', 'headerValue': 'x'}], 'cannot be a default header'),
        ([{'headerName': 'Cookie', 'headerValue': 'a=b'}], 'cannot be a default header'),
        ([{'headerName': 'HOST', 'headerValue': 'evil.example'}], 'cannot be a default header'),
        (
            [{'headerName': 'Accept', 'headerValue': 'a'}, {'headerName': 'accept', 'headerValue': 'b'}],
            'more than once',
        ),
        ([{'headerName': 'Bad Name', 'headerValue': 'x'}], 'not a valid HTTP header name'),
        ([{'headerName': 'X-Key', 'headerValue': '${ROCKETRIDE_MISSING}'}], 'unresolved placeholder'),
        ([{'headerName': 'X-Key', 'headerValue': 'a\r\nInjected: 1'}], 'must not contain line breaks'),
        ([{'headerName': 123, 'headerValue': 'x'}], 'headerName must be a string'),
        ([{'headerName': 'X', 'headerValue': ['x']}], 'headerValue must be a string'),
        (['Accept: */*'], 'must be an object'),
        ({'Accept': '*/*'}, 'malformed and cannot be parsed'),
        ('not json', 'malformed and cannot be parsed'),
    ],
)
def test_invalid_default_headers_fail_closed(node_modules, rows, error):
    _http_client, iglobal, _iinstance = node_modules

    with pytest.raises(ValueError, match=error):
        iglobal.IGlobal._build_default_headers({'defaultHeaders': rows})


# ---------------------------------------------------------------------------
# IGlobal.beginGlobal / validateConfig / endGlobal
# ---------------------------------------------------------------------------


def test_begin_global_loads_config_auth_and_default_headers(node_modules):
    _http_client, iglobal, _iinstance = node_modules

    glb = _started_global(
        iglobal,
        {
            'authType': 'bearer',
            'authToken': 'ghp_live',
            'urlWhitelist': [{'whitelistPattern': GITHUB}],
            'defaultHeaders': [{'headerName': 'Accept', 'headerValue': 'application/vnd.github+json'}],
        },
    )

    assert glb.config_auth == {'type': 'bearer', 'bearer': {'token': 'ghp_live'}}
    assert glb.default_headers == {'Accept': 'application/vnd.github+json'}

    glb.endGlobal()

    assert glb.config_auth is None
    assert glb.default_headers == {}


def test_begin_global_refuses_config_auth_without_whitelist(node_modules):
    """Point 2 of #2495: a configured token must not be sendable to any public host."""
    _http_client, iglobal, _iinstance = node_modules

    with pytest.raises(ValueError, match='URL whitelist is empty'):
        _started_global(iglobal, {'authType': 'bearer', 'authToken': 'ghp_live'})


@pytest.mark.parametrize(
    'pattern',
    [
        r'^https://[^/]+/',
        r'^https://[^/]{1,64}(?:/|$)',
        r'^http://api\.github\.com/',
        r'https?://api\.github\.com/',
        r'^(https)://api\.github\.com/',
        r'api\.github\.com',
        r'^https://(api|www)\.example\.com/',
        r'^https://api.github.com/',
        r'^https://.*\.github\.com/',
        r'^https://[a-z]+\.github\.com/',
        r'^https://\[\]/',
    ],
)
def test_begin_global_refuses_unpinned_whitelist_with_config_auth(node_modules, pattern):
    """Whole-authority, plain-http, and non-literal-host patterns cannot guard a credential."""
    _http_client, iglobal, _iinstance = node_modules

    with pytest.raises(ValueError, match='does not pin an exact https host'):
        _started_global(
            iglobal,
            {'authType': 'bearer', 'authToken': 'ghp_live', 'urlWhitelist': [{'whitelistPattern': pattern}]},
        )


def test_begin_global_refuses_mixed_whitelist_with_config_auth(node_modules):
    """One permissive pattern alongside a pinned one is still a leak path."""
    _http_client, iglobal, _iinstance = node_modules

    with pytest.raises(ValueError, match=re.escape(r'^https://[^/]+/')):
        _started_global(
            iglobal,
            {
                'authType': 'bearer',
                'authToken': 'ghp_live',
                'urlWhitelist': [{'whitelistPattern': GITHUB}, {'whitelistPattern': r'^https://[^/]+/'}],
            },
        )


@pytest.mark.parametrize(
    'pattern',
    [
        GITHUB,
        r'\Ahttps://raw\.githubusercontent\.com/',
        r'https://api\.github\.com(?::443)?(?:/|$)',
        r'^https://203\.0\.113\.10:8443/',
        r'^https://\[2001:db8::1\]/',
    ],
)
def test_begin_global_accepts_pinned_whitelist_with_config_auth(node_modules, pattern):
    _http_client, iglobal, _iinstance = node_modules

    glb = _started_global(
        iglobal,
        {'authType': 'bearer', 'authToken': 'ghp_live', 'urlWhitelist': [{'whitelistPattern': pattern}]},
    )

    assert glb.config_auth is not None


def test_whitelist_is_optional_without_config_auth(node_modules):
    """Existing behaviour: no credential, empty whitelist, all public hosts allowed."""
    _http_client, iglobal, _iinstance = node_modules

    glb = _started_global(iglobal, {'authType': 'none'})

    assert glb.config_auth is None
    assert glb.url_patterns == []


def test_begin_global_warns_about_credentials_the_auth_type_ignores(node_modules):
    """The silent-ignore the issue reported now at least says so."""
    _http_client, iglobal, _iinstance = node_modules

    glb = _started_global(iglobal, {'authType': 'none', 'authToken': 'ghp_live', 'authHeaderValue': 'k'})

    assert glb.config_auth is None
    messages = [call.args[0] for call in iglobal.warning.call_args_list]
    assert any("authType is 'none'; authHeaderValue, authToken will not be sent" == m for m in messages)


def test_begin_global_warns_about_fields_outside_selected_auth_type(node_modules):
    _http_client, iglobal, _iinstance = node_modules

    _started_global(
        iglobal,
        {
            'authType': 'bearer',
            'authToken': 'ghp_live',
            'authUsername': 'svc',
            'urlWhitelist': [{'whitelistPattern': GITHUB}],
        },
    )

    messages = [call.args[0] for call in iglobal.warning.call_args_list]
    assert any("authType is 'bearer'; authUsername will not be sent" == m for m in messages)


def test_validate_config_reports_auth_problems_as_warnings(node_modules):
    _http_client, iglobal, _iinstance = node_modules
    iglobal.Config.getNodeConfig.return_value = {
        'serverName': 'http',
        'authType': 'bearer',
        'authToken': '${ROCKETRIDE_GITHUB_TOKEN}',
    }
    glb = object.__new__(iglobal.IGlobal)
    glb.glb = types.SimpleNamespace(logicalType='tool_http_request', connConfig={})

    glb.validateConfig()

    messages = [call.args[0] for call in iglobal.warning.call_args_list]
    assert any('${ROCKETRIDE_GITHUB_TOKEN}' in m and 'unresolved placeholder' in m for m in messages)


def test_validate_config_warns_when_config_auth_lacks_whitelist(node_modules):
    _http_client, iglobal, _iinstance = node_modules
    iglobal.Config.getNodeConfig.return_value = {'serverName': 'http', 'authType': 'bearer', 'authToken': 'ghp_live'}
    glb = object.__new__(iglobal.IGlobal)
    glb.glb = types.SimpleNamespace(logicalType='tool_http_request', connConfig={})

    glb.validateConfig()

    messages = [call.args[0] for call in iglobal.warning.call_args_list]
    assert any('URL whitelist is empty; add at least one' in m for m in messages)


# ---------------------------------------------------------------------------
# IInstance.http_request: what actually goes on the wire
# ---------------------------------------------------------------------------


def _bearer_global(iglobal, **extra):
    cfg = {'authType': 'bearer', 'authToken': 'ghp_config', 'urlWhitelist': [{'whitelistPattern': GITHUB}]}
    cfg.update(extra)
    return _started_global(iglobal, cfg)


def test_config_bearer_token_is_sent(node_modules, monkeypatch):
    """The exact scenario from #2495: token in config, anonymous request on the wire."""
    http_client, iglobal, iinstance = node_modules
    sent = _capture_transport(monkeypatch, http_client)
    tool = _instance(iinstance, _bearer_global(iglobal))

    result = tool.http_request({'url': 'https://api.github.com/user', 'method': 'GET'})

    assert result == {'status_code': 200}
    assert sent['headers']['Authorization'] == 'Bearer ghp_config'
    assert sent['auth'] is None


def test_config_basic_auth_is_sent(node_modules, monkeypatch):
    http_client, iglobal, iinstance = node_modules
    sent = _capture_transport(monkeypatch, http_client)
    glb = _started_global(
        iglobal,
        {
            'authType': 'basic',
            'authUsername': 'svc',
            'authPassword': 'pw',
            'urlWhitelist': [{'whitelistPattern': GITHUB}],
        },
    )

    _instance(iinstance, glb).http_request({'url': 'https://api.github.com/user', 'method': 'GET'})

    assert isinstance(sent['auth'], http_client.HTTPBasicAuth)
    assert (sent['auth'].username, sent['auth'].password) == ('svc', 'pw')
    assert 'Authorization' not in sent['headers']


def test_config_api_key_header_is_sent(node_modules, monkeypatch):
    http_client, iglobal, iinstance = node_modules
    sent = _capture_transport(monkeypatch, http_client)
    glb = _started_global(
        iglobal,
        {
            'authType': 'api_key',
            'authHeaderName': 'X-API-Key',
            'authHeaderValue': 'k-config',
            'urlWhitelist': [{'whitelistPattern': GITHUB}],
        },
    )

    _instance(iinstance, glb).http_request({'url': 'https://api.github.com/user', 'method': 'GET'})

    assert sent['headers']['X-API-Key'] == 'k-config'
    assert sent['auth'] is None


@pytest.mark.parametrize(
    'extra,named',
    [
        ({'bearer_token': 'ghp_call'}, 'bearer_token'),
        ({'bearer_token': ''}, 'bearer_token'),
        ({'basic_auth': {'username': 'u', 'password': 'p'}}, 'basic_auth'),
        ({'auth': {'type': 'bearer', 'bearer': {'token': 'ghp_call'}}}, 'auth'),
        ({'auth': {'type': 'api_key', 'api_key': {'key': 'k', 'value': 'v', 'add_to': 'query_param'}}}, 'auth'),
        ({'auth': 'bearer ghp_call'}, 'auth'),
        ({'headers': {'Authorization': 'Bearer ghp_call'}}, 'headers.Authorization'),
        ({'headers': {'authorization': 'Bearer ghp_call'}}, 'headers.authorization'),
        ({'headers': {'AUTHORIZATION': 'token x'}}, 'headers.AUTHORIZATION'),
    ],
)
def test_per_call_credentials_are_rejected_when_config_auth_is_set(node_modules, monkeypatch, extra, named):
    """The agent can neither replace nor shadow the configured credential."""
    http_client, iglobal, iinstance = node_modules
    sent = _capture_transport(monkeypatch, http_client)
    tool = _instance(iinstance, _bearer_global(iglobal))

    with pytest.raises(ValueError, match=f'per-call credentials \\({re.escape(named)}\\) are not allowed'):
        tool.http_request({'url': 'https://api.github.com/user', 'method': 'GET', **extra})

    assert sent == {}


def test_per_call_rejection_lists_every_offending_input(node_modules, monkeypatch):
    http_client, iglobal, iinstance = node_modules
    sent = _capture_transport(monkeypatch, http_client)
    tool = _instance(iinstance, _bearer_global(iglobal))

    with pytest.raises(ValueError, match=r'\(bearer_token, auth, headers\.Authorization\)'):
        tool.http_request(
            {
                'url': 'https://api.github.com/user',
                'method': 'GET',
                'bearer_token': 'a',
                'auth': {'type': 'basic', 'basic': {'username': 'u', 'password': 'p'}},
                'headers': {'Authorization': 'x'},
            }
        )

    assert sent == {}


def test_per_call_header_cannot_shadow_config_api_key_header(node_modules, monkeypatch):
    http_client, iglobal, iinstance = node_modules
    sent = _capture_transport(monkeypatch, http_client)
    glb = _started_global(
        iglobal,
        {
            'authType': 'api_key',
            'authHeaderName': 'X-API-Key',
            'authHeaderValue': 'k-config',
            'urlWhitelist': [{'whitelistPattern': GITHUB}],
        },
    )

    with pytest.raises(ValueError, match=r'\(headers\.x-api-key\)'):
        _instance(iinstance, glb).http_request(
            {'url': 'https://api.github.com/user', 'method': 'GET', 'headers': {'x-api-key': 'k-call'}}
        )

    assert sent == {}


def test_explicit_auth_none_is_allowed_with_config_auth(node_modules, monkeypatch):
    http_client, iglobal, iinstance = node_modules
    sent = _capture_transport(monkeypatch, http_client)
    tool = _instance(iinstance, _bearer_global(iglobal))

    tool.http_request({'url': 'https://api.github.com/user', 'method': 'GET', 'auth': {'type': 'none'}})

    assert sent['headers']['Authorization'] == 'Bearer ghp_config'


def test_config_auth_is_never_sent_to_a_non_whitelisted_url(node_modules, monkeypatch):
    http_client, iglobal, iinstance = node_modules
    sent = _capture_transport(monkeypatch, http_client)
    tool = _instance(iinstance, _bearer_global(iglobal))

    with pytest.raises(ValueError, match='does not match any allowed URL pattern'):
        tool.http_request({'url': 'https://api.github.com.evil.example/user', 'method': 'GET'})
    with pytest.raises(ValueError, match='does not match any allowed URL pattern'):
        tool.http_request({'url': 'http://api.github.com/user', 'method': 'GET'})

    assert sent == {}


def test_per_call_auth_still_works_without_config_auth(node_modules, monkeypatch):
    """Regression: the per-call path the issue relied on is unchanged."""
    http_client, iglobal, iinstance = node_modules
    sent = _capture_transport(monkeypatch, http_client)
    tool = _instance(iinstance, _started_global(iglobal, {}))

    tool.http_request({'url': 'https://api.github.com/user', 'method': 'GET', 'bearer_token': 'ghp_call'})

    assert sent['headers']['Authorization'] == 'Bearer ghp_call'


def test_no_auth_anywhere_sends_no_authorization(node_modules, monkeypatch):
    http_client, iglobal, iinstance = node_modules
    sent = _capture_transport(monkeypatch, http_client)
    tool = _instance(iinstance, _started_global(iglobal, {}))

    tool.http_request({'url': 'https://api.github.com/user', 'method': 'GET'})

    assert 'Authorization' not in sent['headers']
    assert sent['auth'] is None


def test_default_headers_merge_under_per_call_headers(node_modules, monkeypatch):
    http_client, iglobal, iinstance = node_modules
    sent = _capture_transport(monkeypatch, http_client)
    glb = _started_global(
        iglobal,
        {
            'defaultHeaders': [
                {'headerName': 'Accept', 'headerValue': 'application/vnd.github+json'},
                {'headerName': 'X-GitHub-Api-Version', 'headerValue': '2022-11-28'},
            ]
        },
    )

    _instance(iinstance, glb).http_request(
        {'url': 'https://api.github.com/user', 'method': 'GET', 'headers': {'accept': 'text/plain', 'X-Trace': '1'}}
    )

    assert sent['headers'] == {'accept': 'text/plain', 'X-GitHub-Api-Version': '2022-11-28', 'X-Trace': '1'}


def test_default_headers_do_not_touch_config_auth(node_modules, monkeypatch):
    http_client, iglobal, iinstance = node_modules
    sent = _capture_transport(monkeypatch, http_client)
    glb = _bearer_global(iglobal, defaultHeaders=[{'headerName': 'Accept', 'headerValue': '*/*'}])

    _instance(iinstance, glb).http_request({'url': 'https://api.github.com/user', 'method': 'GET'})

    assert sent['headers'] == {'Accept': '*/*', 'Authorization': 'Bearer ghp_config'}


def test_per_call_headers_must_be_an_object(node_modules, monkeypatch):
    http_client, iglobal, iinstance = node_modules
    sent = _capture_transport(monkeypatch, http_client)
    tool = _instance(iinstance, _started_global(iglobal, {}))

    with pytest.raises(ValueError, match='headers must be a JSON object'):
        tool.http_request({'url': 'https://api.github.com/user', 'method': 'GET', 'headers': 'Accept: */*'})

    assert sent == {}


def test_merge_headers_handles_missing_inputs(node_modules):
    _http_client, _iglobal, iinstance = node_modules

    assert iinstance._merge_headers(None, None) == {}
    assert iinstance._merge_headers({'A': '1'}, None) == {'A': '1'}
    assert iinstance._merge_headers(None, {'A': '1'}) == {'A': '1'}
    assert iinstance._merge_headers({'Accept': 'a', 'X': '1'}, {'ACCEPT': 'b'}) == {'X': '1', 'ACCEPT': 'b'}
