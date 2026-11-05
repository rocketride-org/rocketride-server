# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Exercise the read tools through real HTTP parsing with only requests mocked."""

import json
import time
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
import requests

from ._stubs import scoped_stubs


TOKEN = 'sentinel-private-token-2592'
RATE = {'remaining': 49, 'limit': 5000, 'reset': 2000000000, 'resource': 'core'}
HEADERS = {
    'X-RateLimit-Remaining': '49',
    'X-RateLimit-Limit': '5000',
    'X-RateLimit-Reset': '2000000000',
    'X-RateLimit-Resource': 'core',
}
AUTH_FAILED = 'GitHub authentication failed. Check the node credentials and installation access.'
REQUEST_FAILED = 'GitHub request failed or returned invalid JSON. Check connectivity and retry.'


def response(data, status=200, headers=None, content=None):
    resp = requests.Response()
    resp.status_code = status
    resp.headers.update(HEADERS if headers is None else headers)
    resp._content = json.dumps(data).encode() if content is None else content
    return resp


@pytest.fixture
def node(monkeypatch):
    with scoped_stubs():
        from tool_github import IInstance
        from tool_github import github_client

        inst = IInstance()
        inst.IGlobal = SimpleNamespace(
            auth_type='pat',
            token=TOKEN,
            private_key_pem='',
            default_repo='owner/repo',
            read_only=True,
            get_token=Mock(return_value=TOKEN),
        )
        request = Mock()
        monkeypatch.setattr(github_client.requests, 'request', request)
        yield inst, request, github_client


@pytest.mark.parametrize(
    ('tool', 'suffix', 'payload', 'expected'),
    [
        (
            'repo_contributors',
            '/contributors',
            [{'login': 'octocat', 'contributions': 9, 'type': 'User', 'email': 'private@example.test'}],
            [{'login': 'octocat', 'contributions': 9, 'type': 'User'}],
        ),
        (
            'label_list',
            '/labels',
            [{'id': 7, 'name': 'bug', 'color': 'ff0000', 'description': None}],
            [{'name': 'bug', 'color': 'ff0000', 'description': None}],
        ),
    ],
)
def test_paginated_reads_in_read_only_mode(node, tool, suffix, payload, expected):
    inst, request, _ = node
    request.return_value = response(
        payload,
        headers={
            **HEADERS,
            'Link': '<https://api.github.com/repos/owner/repo/labels?page=3&per_page=100>; rel="next", <https://api.github.com/repos/owner/repo/labels?page=4>; rel="last"',
        },
    )
    result = getattr(inst, tool)({'page': 2, 'per_page': 500})
    assert result == {'status': 200, 'data': expected, 'rate_limit': RATE, 'next_page': 3}
    assert request.call_args.args == ('GET', 'https://api.github.com/repos/owner/repo' + suffix)
    assert request.call_args.kwargs['params'] == {'page': 2, 'per_page': 100}
    assert request.call_args.kwargs['headers']['Authorization'] == f'Bearer {TOKEN}'
    assert TOKEN not in json.dumps(result)


def test_null_paging_inputs_mean_defaults(node):
    inst, request, _ = node
    request.return_value = response([])
    inst.label_list({'page': None, 'per_page': None})
    assert request.call_args.kwargs['params'] == {'page': 1, 'per_page': 30}


def test_languages_explicit_repository(node):
    inst, request, _ = node
    request.return_value = response({'Python': 9123, 'TypeScript': 8000})
    result = inst.repo_languages({'repo': 'another/project'})
    assert result['data'] == {'Python': 9123, 'TypeScript': 8000}
    assert result['rate_limit'] == RATE
    assert result['next_page'] is None
    assert request.call_args.args[1].endswith('/repos/another/project/languages')


@pytest.mark.parametrize(
    ('tool', 'payload', 'status', 'expected'),
    [
        ('repo_contributors', None, 204, []),
        ('repo_contributors', [], 200, []),
        ('label_list', [], 200, []),
        ('repo_languages', {}, 200, {}),
    ],
)
def test_empty_repository_reads(node, tool, payload, status, expected):
    inst, request, _ = node
    request.return_value = response(payload, status)
    result = getattr(inst, tool)({})
    assert result['data'] == expected
    assert result['status'] == status


@pytest.mark.parametrize('status', [401, 403, 404, 409, 422])
def test_http_errors_are_results(node, status):
    inst, request, _ = node
    request.return_value = response(
        {'message': 'Not available', 'documentation_url': 'https://docs.github.com/rest'}, status
    )
    assert inst.label_list({}) == {
        'status': status,
        'message': 'Not available',
        'documentation_url': 'https://docs.github.com/rest',
        'rate_limit': RATE,
        'next_page': None,
    }
    assert request.call_count == 1


def test_error_details_are_appended_and_non_json_bodies_are_summarised(node):
    inst, request, _ = node
    request.return_value = response(
        {
            'message': 'Validation Failed',
            'errors': [{'resource': 'Label', 'code': 'custom', 'message': 'name is missing'}, 'second detail'],
        },
        422,
    )
    assert inst.label_list({})['message'] == 'Validation Failed: name is missing; second detail'
    request.return_value = response(None, 502, content=b'<html>' + b'x' * 5000 + b'</html>')
    assert inst.label_list({}) == {
        'status': 502,
        'message': 'GitHub returned HTTP 502 without a JSON error body.',
        'documentation_url': None,
        'rate_limit': RATE,
        'next_page': None,
    }


def test_error_details_without_a_message_string_are_still_results(node):
    inst, request, _ = node
    request.return_value = response(
        {'message': 'Validation Failed', 'errors': [{'message': None}, {'code': 7}, 3]}, 422
    )
    result = inst.label_list({})
    assert result['status'] == 422
    assert result['message'] == "Validation Failed: {'message': None}; {'code': 7}; 3"


@pytest.mark.parametrize('message', [None, 7])
def test_a_message_that_is_not_a_string_is_still_a_result(node, message):
    inst, request, _ = node
    # HEADERS carries X-RateLimit-Reset, so the legacy error text gets a hint appended.
    request.return_value = response({'message': message}, 404)
    assert inst.label_list({}) == {
        'status': 404,
        'message': 'GitHub returned HTTP 404 without a JSON error body.',
        'documentation_url': None,
        'rate_limit': RATE,
        'next_page': None,
    }


def test_long_error_messages_are_capped(node):
    inst, request, _ = node
    request.return_value = response({'message': 'x' * 5000}, 422)
    assert len(inst.label_list({})['message']) == 2000


def test_a_credential_across_the_cap_is_redacted_before_the_cut(node, rsa_private_key_pem):
    inst, request, _ = node
    inst.IGlobal.private_key_pem = rsa_private_key_pem
    for secret in (TOKEN, rsa_private_key_pem):
        # The cut at 2,000 characters falls inside the echoed credential.
        request.return_value = response({'message': 'x' * 1990 + secret}, 422)
        message = inst.label_list({})['message']
        assert len(message) == 2000
        assert message.startswith('x' * 1990 + '[REDACTED')
        assert secret[:10] not in message


@pytest.mark.parametrize(
    ('tool', 'payload', 'expected'),
    [
        ('repo_contributors', {'login': 'not-a-list'}, 'a list'),
        ('repo_languages', ['not', 'an', 'object'], 'an object'),
        ('user_get', [], 'an object'),
        # Only a 204 means an empty list; an empty object at 200 is the wrong shape.
        ('label_list', {}, 'a list'),
    ],
)
def test_unexpected_body_shapes_are_results(node, tool, payload, expected):
    inst, request, _ = node
    request.return_value = response(payload)
    result = getattr(inst, tool)({})
    assert result['status'] == 200
    assert 'data' not in result
    assert result['message'] == f'GitHub returned an unexpected response body; expected {expected}.'
    assert result['documentation_url'] is None
    assert result['rate_limit'] == RATE


def test_list_items_that_are_not_objects_are_dropped(node):
    inst, request, _ = node
    request.return_value = response([{'name': 'bug', 'color': 'f00', 'description': None}, 'junk', None])
    assert inst.label_list({})['data'] == [{'name': 'bug', 'color': 'f00', 'description': None}]


@pytest.mark.parametrize('value', [0, -1, True, 1.5, 'wrong', '2'])
def test_invalid_page_never_sends_a_request(node, value):
    inst, request, _ = node
    with pytest.raises(ValueError, match='^label_list: "page"'):
        inst.label_list({'page': value})
    request.assert_not_called()
    inst.IGlobal.get_token.assert_not_called()


@pytest.mark.parametrize('value', [True, 1.5, '50'])
def test_per_page_of_the_wrong_type_never_sends_a_request(node, value):
    inst, request, _ = node
    with pytest.raises(ValueError, match='^label_list: "per_page"'):
        inst.label_list({'per_page': value})
    request.assert_not_called()


def test_per_page_below_one_is_clamped_to_one(node):
    inst, request, _ = node
    request.return_value = response([])
    inst.label_list({'per_page': 0})
    assert request.call_args.kwargs['params'] == {'page': 1, 'per_page': 1}


@pytest.mark.parametrize(
    'repo', ['../repo', 'owner/..', 'owner/repo/issues', 'owner/repo?x=1', 'https://other.test/repo']
)
def test_repository_path_is_not_an_arbitrary_endpoint(node, repo):
    inst, request, _ = node
    with pytest.raises(ValueError, match='^repo_languages: repo must be in owner/repo format$'):
        inst.repo_languages({'repo': repo})
    request.assert_not_called()


@pytest.mark.parametrize('repo', [123, ['owner/repo'], True])
def test_a_repo_that_is_not_a_string_is_a_validation_error(node, repo):
    inst, request, _ = node
    with pytest.raises(ValueError, match='^label_list: repo must be in owner/repo format$'):
        inst.label_list({'repo': repo})
    request.assert_not_called()


def test_pat_identity_does_not_return_full_profile(node):
    inst, request, _ = node
    request.return_value = response(
        {'login': 'octocat', 'type': 'User', 'email': 'private@example.test', 'token': TOKEN}
    )
    result = inst.user_get({})
    assert result['data'] == {'login': 'octocat', 'type': 'User'}
    assert request.call_args.args == ('GET', 'https://api.github.com/user')


def test_app_identity_uses_signed_jwt_not_installation_token(node, rsa_private_key_pem):
    import jwt

    inst, request, client = node
    inst.IGlobal.auth_type = 'app'
    inst.IGlobal.app_id = '123'
    inst.IGlobal.private_key_pem = rsa_private_key_pem
    request.return_value = response({'slug': 'my-app', 'name': 'My App', 'owner': {'login': 'owner'}})
    result = inst.user_get({})
    assert result['data'] == {'login': 'my-app', 'type': 'App'}
    assert request.call_args.args == ('GET', 'https://api.github.com/app')
    inst.IGlobal.get_token.assert_not_called()
    bearer = request.call_args.kwargs['headers']['Authorization'].removeprefix('Bearer ')
    claims = jwt.decode(bearer, client.load_app_private_key(rsa_private_key_pem).public_key(), algorithms=['RS256'])
    assert claims['iss'] == '123'
    assert bearer not in json.dumps(result)
    assert rsa_private_key_pem not in json.dumps(result)


def test_pat_identity_without_a_login_is_a_shape_failure(node):
    # A 200 that names no user must not become a success with login None.
    inst, request, _ = node
    request.return_value = response({'type': 'User', 'id': 7}, headers={'X-RateLimit-Remaining': '41'})
    result = inst.user_get({})
    assert result['status'] == 200
    assert 'data' not in result
    assert result['message'] == 'GitHub returned an unexpected response body; expected an object naming the user.'
    assert result['rate_limit']['remaining'] == 41


def test_app_identity_without_a_slug_is_a_shape_failure(node, rsa_private_key_pem):
    inst, request, _ = node
    inst.IGlobal.auth_type = 'app'
    inst.IGlobal.app_id = '123'
    inst.IGlobal.private_key_pem = rsa_private_key_pem
    request.return_value = response({'name': 'My App', 'owner': {'login': 'owner'}})
    result = inst.user_get({})
    assert result['status'] == 200
    assert 'data' not in result
    assert result['message'] == 'GitHub returned an unexpected response body; expected an object naming the App.'
    assert request.call_args.args == ('GET', 'https://api.github.com/app')


def test_a_missing_repo_names_the_tool(node):
    inst, request, _ = node
    inst.IGlobal.default_repo = ''
    with pytest.raises(ValueError, match='^label_list: repo is required'):
        inst.label_list({})
    request.assert_not_called()


def test_app_identity_with_a_bad_key_is_a_safe_failure(node):
    inst, request, _ = node
    inst.IGlobal.auth_type = 'app'
    inst.IGlobal.app_id = '123'
    inst.IGlobal.private_key_pem = 'not a pem ' + TOKEN
    result = inst.user_get({})
    assert result['status'] is None
    assert result['message'] == AUTH_FAILED
    assert TOKEN not in json.dumps(result)
    request.assert_not_called()


def test_installation_auth_read_uses_existing_token_refresh(node):
    inst, request, _ = node
    inst.IGlobal.auth_type = 'app'
    inst.IGlobal.get_token.return_value = 'installation-sentinel'
    request.return_value = response({'Python': 100})
    inst.repo_languages({})
    inst.IGlobal.get_token.assert_called_once_with()
    assert request.call_args.kwargs['headers']['Authorization'] == 'Bearer installation-sentinel'


def test_authentication_failure_is_safe_and_logged_for_the_operator(node):
    import rocketlib

    inst, request, _ = node
    inst.IGlobal.get_token.side_effect = ValueError('failed with secret: ' + TOKEN)
    result = inst.repo_languages({})
    assert result['status'] is None
    assert result['message'] == AUTH_FAILED
    assert TOKEN not in json.dumps(result)
    request.assert_not_called()
    rocketlib.warning.assert_called_once()
    logged = rocketlib.warning.call_args.args[0]
    assert 'ValueError' in logged
    assert TOKEN not in logged


def test_echoed_credentials_are_redacted_in_successful_results(node, rsa_private_key_pem):
    inst, request, client = node
    inst.IGlobal.private_key_pem = rsa_private_key_pem
    request.return_value = response([{'name': TOKEN, 'color': 'f00', 'description': f'see {rsa_private_key_pem}'}])
    assert inst.label_list({})['data'] == [{'name': '[REDACTED]', 'color': 'f00', 'description': 'see [REDACTED]'}]
    request.return_value = response({TOKEN: 1, 'Python': 2})
    assert inst.repo_languages({})['data'] == {'[REDACTED]': 1, 'Python': 2}
    # The client layer redacts on its own, not only through IInstance._get.
    request.return_value = response([{'login': TOKEN}])
    assert client.get_result(TOKEN, '/x')['data'] == [{'login': '[REDACTED]'}]


def test_next_page_ignores_a_non_positive_page(node):
    inst, request, _ = node
    request.return_value = response([], headers={**HEADERS, 'Link': '<https://api.github.com/x?page=0>; rel="next"'})
    assert inst.label_list({})['next_page'] is None


def test_echoed_credentials_are_redacted_in_errors(node, rsa_private_key_pem):
    inst, request, _ = node
    inst.IGlobal.private_key_pem = rsa_private_key_pem
    request.return_value = response(
        {'message': TOKEN + '\n' + rsa_private_key_pem, 'documentation_url': f'https://example.test/{TOKEN}'}, 422
    )
    result = inst.repo_languages({})
    assert TOKEN not in json.dumps(result)
    assert rsa_private_key_pem not in result['message']
    assert '[REDACTED]' in result['message']


@pytest.mark.parametrize('error', [requests.ConnectionError, requests.Timeout])
def test_transport_error_is_structured_without_exception_details(node, error):
    inst, request, _ = node
    request.side_effect = error('raw-transport-detail ' + TOKEN)
    result = inst.repo_languages({})
    assert result['status'] is None
    assert result['message'] == REQUEST_FAILED
    assert 'raw-transport-detail' not in json.dumps(result)


def test_invalid_json_is_a_safe_result(node):
    inst, request, _ = node
    request.return_value = response(None, content=b'<html>upstream failure</html>')
    result = inst.repo_languages({})
    assert result['status'] is None
    assert result['message'] == REQUEST_FAILED
    assert 'data' not in result


@pytest.mark.parametrize('status', [403, 429])
def test_rate_limit_recovers_and_reports_final_headers(node, monkeypatch, status):
    inst, request, client = node
    sleep = Mock()
    monkeypatch.setattr(client.time, 'sleep', sleep)
    request.side_effect = [response({'message': 'rate limit'}, status, {'Retry-After': '1'}), response({'Python': 1})]
    result = inst.repo_languages({})
    assert result['data'] == {'Python': 1}
    assert result['rate_limit'] == RATE
    sleep.assert_called_once_with(1.0)


def test_exhausted_rate_limit_returns_structured_error(node, monkeypatch):
    inst, request, client = node
    monkeypatch.setattr(client.time, 'sleep', Mock())
    request.return_value = response({'message': 'rate limit'}, 429, {**HEADERS, 'Retry-After': '1'})
    result = inst.repo_languages({})
    assert result['status'] == 429
    assert 'data' not in result
    assert request.call_count == 3


def test_an_exhausted_rate_limit_error_chains_to_nothing(node, monkeypatch):
    _, request, client = node
    monkeypatch.setattr(client.time, 'sleep', Mock())
    # Retry-After past the legacy 30-second cap: call() gives up at once and raises.
    request.return_value = response({'message': 'secondary limit'}, 403, {**HEADERS, 'Retry-After': '60'})
    with pytest.raises(client.GitHubAPIError) as error:
        client.call(TOKEN, 'GET', '/test')
    assert error.value.status_code == 403
    # No __context__: the RateLimitError, whose response holds the request headers, is gone.
    assert error.value.__context__ is None
    assert error.value.__cause__ is None
    assert sorted(vars(error.value)) == ['body', 'headers', 'message', 'status_code']


def test_long_retry_after_fails_at_once_with_counters(node, monkeypatch):
    inst, request, client = node
    sleep = Mock()
    monkeypatch.setattr(client.time, 'sleep', sleep)
    request.return_value = response({'message': 'secondary limit'}, 403, {**HEADERS, 'Retry-After': '60'})
    result = inst.repo_languages({})
    assert result['status'] == 403
    assert result['rate_limit'] == RATE
    assert request.call_count == 1
    sleep.assert_not_called()


def test_primary_limit_exhaustion_returns_at_once(node, monkeypatch):
    inst, request, client = node
    sleep = Mock()
    monkeypatch.setattr(client.time, 'sleep', sleep)
    headers = {**HEADERS, 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': str(int(time.time()) + 3600)}
    request.return_value = response({'message': 'API rate limit exceeded'}, 403, headers)
    result = inst.repo_languages({})
    assert result['status'] == 403
    assert result['rate_limit']['remaining'] == 0
    assert request.call_count == 1
    sleep.assert_not_called()


def test_legacy_call_keeps_body_only_and_raises_http_errors(node):
    _, request, client = node
    request.return_value = response([{'name': 'existing-shape'}])
    assert client.call(TOKEN, 'GET', '/test') == [{'name': 'existing-shape'}]
    request.return_value = response({'message': 'Not Found'}, 404)
    with pytest.raises(client.GitHubAPIError, match='Not Found'):
        client.call(TOKEN, 'GET', '/test')


def test_legacy_call_keeps_empty_dict_for_204(node):
    _, request, client = node
    request.return_value = response(None, 204, content=b'')
    assert client.call(TOKEN, 'PUT', '/test') == {}
