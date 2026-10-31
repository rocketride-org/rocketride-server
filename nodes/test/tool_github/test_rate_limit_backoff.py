# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Rate-limit backoff on the envelope path (repository reads and graphql); the sleep is injected."""

import io
import json
from email.utils import formatdate
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
import requests

from ._stubs import scoped_stubs

TOKEN = 'sentinel-backoff-token-2592'
NOW = 1_800_000_000.0
OK_HEADERS = {
    'X-RateLimit-Remaining': '4999',
    'X-RateLimit-Limit': '5000',
    'X-RateLimit-Reset': str(int(NOW) + 3600),
    'X-RateLimit-Resource': 'core',
}


def response(payload, status=200, headers=None):
    """A response with a streamed body: the read path loads it, graphql streams it."""
    resp = requests.Response()
    resp.status_code = status
    resp.headers.update(OK_HEADERS if headers is None else headers)
    resp.raw = io.BytesIO(json.dumps(payload).encode())
    return resp


def primary_limit(status=403, reset_in=5):
    headers = {
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Limit': '5000',
        'X-RateLimit-Reset': str(int(NOW) + reset_in),
        'X-RateLimit-Resource': 'core',
    }
    return response({'message': f'API rate limit exceeded for {TOKEN}.'}, status, headers)


def secondary_limit(status=403, retry_after='7'):
    headers = {**OK_HEADERS, 'Retry-After': retry_after}
    return response({'message': 'You have exceeded a secondary rate limit.'}, status, headers)


TOOLS = {
    'read': ('repo_languages', {}, {'Python': 1}),
    'graphql': ('graphql', {'query': 'query { viewer { login } }'}, {'data': {'viewer': {'login': 'octocat'}}}),
}


@pytest.fixture
def node(monkeypatch):
    with scoped_stubs():
        from tool_github import IInstance
        from tool_github import github_client

        slept = []
        inst = IInstance()
        inst.IGlobal = SimpleNamespace(
            auth_type='pat',
            token=TOKEN,
            private_key_pem='',
            default_repo='owner/repo',
            read_only=True,
            get_token=Mock(return_value=TOKEN),
            tools=frozenset(),
            graphql_max_bytes=github_client.DEFAULT_GRAPHQL_MAX_BYTES,
        )
        request = Mock()
        monkeypatch.setattr(github_client.requests, 'request', request)
        # A real sleep fails the test: every wait must go through the injected one.
        monkeypatch.setattr(github_client.time, 'sleep', Mock(side_effect=AssertionError('slept for real')))

        def policy(**kwargs):
            inst.IGlobal.retry_policy = github_client.RetryPolicy(sleep=slept.append, clock=lambda: NOW, **kwargs)

        policy()
        yield SimpleNamespace(inst=inst, request=request, client=github_client, slept=slept, policy=policy)


def run(node, path):
    tool, args, payload = TOOLS[path]
    return getattr(node.inst, tool)(args), payload


def expected_data(path, payload):
    return {'data': payload['data'], 'errors': None} if path == 'graphql' else payload


@pytest.mark.parametrize('path', TOOLS)
@pytest.mark.parametrize('status', [403, 429])
def test_primary_limit_waits_until_reset_then_succeeds(node, path, status):
    _, _, payload = TOOLS[path]
    node.request.side_effect = [primary_limit(status, reset_in=5), response(payload)]
    result, payload = run(node, path)
    assert node.slept == [5.0]
    assert result['status'] == 200
    assert result['data'] == expected_data(path, payload)
    assert result['rate_limit']['remaining'] == 4999
    assert 'retry_after' not in result
    assert node.request.call_count == 2


@pytest.mark.parametrize('path', TOOLS)
@pytest.mark.parametrize('status', [403, 429])
def test_secondary_limit_waits_retry_after_then_succeeds(node, path, status):
    _, _, payload = TOOLS[path]
    node.request.side_effect = [secondary_limit(status, '7'), response(payload)]
    result, _ = run(node, path)
    assert node.slept == [7.0]
    assert result['status'] == 200
    assert result['data'] == expected_data(path, payload)
    assert node.request.call_count == 2


@pytest.mark.parametrize(('reset_in', 'retry_after'), [(9, '3'), (3, '9')])
def test_both_headers_wait_for_the_longer(node, reset_in, retry_after):
    limited = primary_limit(reset_in=reset_in)
    limited.headers['Retry-After'] = retry_after
    node.request.side_effect = [limited, response({'Python': 1})]
    run(node, 'read')
    assert node.slept == [9.0]


def test_reset_already_passed_waits_one_second(node):
    node.request.side_effect = [primary_limit(reset_in=-30), response({'Python': 1})]
    run(node, 'read')
    assert node.slept == [1.0]


def headerless_limit():
    return response({'message': 'You have exceeded a secondary rate limit.'}, 403, dict(OK_HEADERS))


@pytest.mark.parametrize('path', TOOLS)
def test_rate_limit_without_a_named_wait_waits_a_minute(node, path):
    _, _, payload = TOOLS[path]
    node.request.side_effect = [headerless_limit(), response(payload)]
    result, _ = run(node, path)
    assert node.slept == [60.0]
    assert result['status'] == 200
    assert result['data'] == expected_data(path, payload)


def test_default_budget_allows_one_retry_without_a_named_wait(node):
    node.request.side_effect = lambda *a, **k: headerless_limit()
    result, _ = run(node, 'read')
    # 60 s fits the 60 s budget; the doubled 120 s does not, so it is never started.
    assert node.slept == [60.0]
    assert node.request.call_count == 2
    assert result['status'] == 403
    assert result['retry_after'] == 120
    assert 'names no wait' in result['message']
    assert 'rateLimitBudgetSeconds' in result['message']


def test_waits_without_a_named_wait_double_within_a_larger_budget(node):
    node.policy(budget_seconds=420, max_retries=5)
    node.request.side_effect = lambda *a, **k: headerless_limit()
    result, _ = run(node, 'read')
    assert node.slept == [60.0, 120.0, 240.0]
    assert sum(node.slept) == 420
    assert node.request.call_count == 4
    assert result['retry_after'] == 480


def test_retry_count_ends_the_doubling(node):
    node.policy(budget_seconds=3600, max_retries=2)
    node.request.side_effect = lambda *a, **k: headerless_limit()
    result, _ = run(node, 'read')
    assert node.slept == [60.0, 120.0]
    assert node.request.call_count == 3
    assert result['retry_after'] == 240
    assert 'rateLimitMaxRetries (2)' in result['message']


def test_a_minute_that_does_not_fit_the_budget_is_not_started(node):
    node.policy(budget_seconds=30)
    node.request.return_value = headerless_limit()
    result, _ = run(node, 'read')
    assert node.slept == []
    assert node.request.call_count == 1
    assert result['retry_after'] == 60


def test_exhausted_primary_limit_without_a_usable_reset_waits_a_minute(node):
    limited = primary_limit()
    limited.headers['X-RateLimit-Reset'] = 'soon'
    node.request.side_effect = [limited, response({'Python': 1})]
    result, _ = run(node, 'read')
    assert node.slept == [60.0]
    assert result['status'] == 200


def test_retry_after_zero_still_waits_one_second(node):
    node.request.side_effect = [secondary_limit(403, '0'), response({'Python': 1})]
    result, _ = run(node, 'read')
    assert node.slept == [1.0]
    assert result['status'] == 200


@pytest.mark.parametrize('limit', ['retry-after-0', 'unnamed'])
def test_zero_budget_never_spins(node, limit):
    node.policy(budget_seconds=0, max_retries=10)
    node.request.side_effect = lambda *a, **k: (
        secondary_limit(403, '0') if limit == 'retry-after-0' else headerless_limit()
    )
    result, _ = run(node, 'read')
    # One request, then the structured error: no wait fits a zero budget, not even one second.
    assert node.slept == []
    assert node.request.call_count == 1
    assert result['status'] == 403
    assert result['retry_after'] == (1 if limit == 'retry-after-0' else 60)


def test_retry_after_as_an_http_date(node):
    limited = secondary_limit(403, formatdate(NOW + 30, usegmt=True))
    node.request.side_effect = [limited, response({'Python': 1})]
    result, _ = run(node, 'read')
    assert node.slept == [30.0]
    assert result['status'] == 200


RATE_LIMITED = {
    'data': None,
    'errors': [{'type': 'RATE_LIMITED', 'message': 'API rate limit already exceeded for user ID 1.'}],
}


def graphql_limited(reset_in=5, remaining='0'):
    headers = {**OK_HEADERS, 'X-RateLimit-Remaining': remaining, 'X-RateLimit-Reset': str(int(NOW) + reset_in)}
    headers['X-RateLimit-Resource'] = 'graphql'
    return response(RATE_LIMITED, 200, headers)


def test_graphql_200_rate_limited_waits_until_reset_then_succeeds(node):
    _, _, payload = TOOLS['graphql']
    node.request.side_effect = [graphql_limited(reset_in=5), response(payload)]
    result, _ = run(node, 'graphql')
    assert node.slept == [5.0]
    assert node.request.call_count == 2
    assert result['status'] == 200
    assert result['data'] == expected_data('graphql', payload)


def test_graphql_200_rate_limited_budget_exhausted_keeps_the_graphql_errors(node):
    node.request.return_value = graphql_limited(reset_in=3600)
    result, _ = run(node, 'graphql')
    assert node.slept == []
    assert node.request.call_count == 1
    assert result['status'] == 200
    assert 'data' not in result
    assert result['errors'] == RATE_LIMITED['errors']
    assert result['retry_after'] == 3600
    assert result['rate_limit']['remaining'] == 0
    assert result['rate_limit']['resource'] == 'graphql'
    assert result['message'].startswith('API rate limit already exceeded for user ID 1.')
    assert 'rateLimitBudgetSeconds' in result['message']


def test_graphql_200_rate_limited_without_a_usable_reset_waits_a_minute(node):
    # OK_HEADERS says 4999 remain, so the reset an hour away is not the wait.
    _, _, payload = TOOLS['graphql']
    node.request.side_effect = [response(RATE_LIMITED, 200, dict(OK_HEADERS)), response(payload)]
    result, _ = run(node, 'graphql')
    assert node.slept == [60.0]
    assert result['status'] == 200


def test_graphql_200_rate_limited_with_partial_data_is_returned_not_retried(node):
    # GitHub ran part of the mutation; resending it could run that part twice.
    node.inst.IGlobal.read_only = False
    body = {
        'data': {'first': {'clientMutationId': 'a'}, 'second': None},
        'errors': [{'type': 'RATE_LIMITED', 'path': ['second'], 'message': 'API rate limit exceeded.'}],
    }
    node.request.return_value = response(body, 200, graphql_limited().headers)
    result = node.inst.graphql(
        {'query': 'mutation { first: addStar { clientMutationId } second: addStar { clientMutationId } }'}
    )
    assert node.slept == []
    assert node.request.call_count == 1
    assert result['status'] == 200
    assert result['data'] == {'data': body['data'], 'errors': body['errors']}


def test_graphql_200_with_retry_after_and_no_data_waits_then_succeeds(node):
    _, _, payload = TOOLS['graphql']
    limited = response(
        {'data': None, 'errors': [{'message': 'Please slow down.'}]}, 200, {**OK_HEADERS, 'Retry-After': '7'}
    )
    node.request.side_effect = [limited, response(payload)]
    result, _ = run(node, 'graphql')
    assert node.slept == [7.0]
    assert result['data'] == expected_data('graphql', payload)


SECONDARY_BODY = {
    'message': 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.',
    'documentation_url': 'https://docs.github.com/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api',
}


def test_graphql_200_secondary_limit_body_waits_a_minute_then_succeeds(node):
    _, _, payload = TOOLS['graphql']
    node.request.side_effect = [response(SECONDARY_BODY, 200, dict(OK_HEADERS)), response(payload)]
    result, _ = run(node, 'graphql')
    assert node.slept == [60.0]
    assert result['data'] == expected_data('graphql', payload)


def test_graphql_200_secondary_limit_exhausted_keeps_status_counters_and_message(node):
    node.policy(budget_seconds=0)
    node.request.return_value = response(SECONDARY_BODY, 200, dict(OK_HEADERS))
    result, _ = run(node, 'graphql')
    assert node.request.call_count == 1
    assert result['status'] == 200
    assert 'data' not in result
    assert result['rate_limit']['remaining'] == 4999
    assert result['message'].startswith('You have exceeded a secondary rate limit.')
    assert result['documentation_url'] == SECONDARY_BODY['documentation_url']
    assert result['retry_after'] == 60


def test_graphql_200_errors_with_remaining_zero_wait_until_reset(node):
    _, _, payload = TOOLS['graphql']
    limited = graphql_limited(reset_in=5)
    limited = response({'data': None, 'errors': [{'message': 'quota used up'}]}, 200, limited.headers)
    node.request.side_effect = [limited, response(payload)]
    result, _ = run(node, 'graphql')
    assert node.slept == [5.0]
    assert result['status'] == 200


def test_graphql_errors_of_other_types_are_not_retried(node):
    body = {'data': None, 'errors': [{'type': 'NOT_FOUND', 'message': 'RATE_LIMITED is not this error'}]}
    node.request.return_value = response(body, 200, dict(OK_HEADERS))
    result, _ = run(node, 'graphql')
    assert node.slept == []
    assert result['data'] == {'data': None, 'errors': body['errors']}


def test_graphql_parse_error_that_quotes_rate_limit_is_not_retried(node):
    # Parse and validation errors carry locations and quote the document: never a rate limit.
    body = {
        'data': None,
        'errors': [
            {'message': 'Parse error on "rate limit" (STRING) at [1, 22]', 'locations': [{'line': 1, 'column': 22}]}
        ],
    }
    node.request.return_value = response(body, 200, dict(OK_HEADERS))
    result, _ = run(node, 'graphql')
    assert node.slept == []
    assert node.request.call_count == 1
    assert result['status'] == 200
    assert result['data'] == {'data': None, 'errors': body['errors']}


def test_graphql_located_errors_on_the_last_point_are_not_retried(node):
    body = {'data': None, 'errors': [{'message': "Field 'x' doesn't exist", 'locations': [{'line': 1, 'column': 9}]}]}
    headers = {**OK_HEADERS, 'X-RateLimit-Remaining': '0', 'X-RateLimit-Resource': 'graphql'}
    node.request.return_value = response(body, 200, headers)
    result, _ = run(node, 'graphql')
    assert node.slept == []
    assert node.request.call_count == 1
    assert result['data'] == {'data': None, 'errors': body['errors']}


@pytest.mark.parametrize('path', TOOLS)
def test_a_retry_after_a_long_wait_sends_a_freshly_minted_token(node, path):
    node.policy(budget_seconds=900)
    node.inst.IGlobal.get_token = Mock(side_effect=['tok-before-wait', 'tok-after-wait'])
    tool, args, _ = TOOLS[path]
    echoed = 'tok-before-wait and tok-after-wait'
    payload = {'data': {'echo': echoed}} if path == 'graphql' else {'echo': echoed}
    node.request.side_effect = [secondary_limit(retry_after='600'), response(payload)]
    result = getattr(node.inst, tool)(args)
    assert node.slept == [600.0]
    sent = [call.kwargs['headers']['Authorization'] for call in node.request.call_args_list]
    assert sent == ['Bearer tok-before-wait', 'Bearer tok-after-wait']
    assert result['status'] == 200
    assert 'tok-before-wait' not in json.dumps(result)
    assert 'tok-after-wait' not in json.dumps(result)


def test_the_node_layer_redacts_every_token_it_handed_out(node):
    node.inst.IGlobal.get_token = Mock(side_effect=['tok-one', 'tok-two'])
    result = node.inst._with_credentials(lambda credential, secrets: {'sent': [credential(), credential()]})
    assert result == {'sent': ['[REDACTED]', '[REDACTED]']}


def test_a_retry_signs_the_app_jwt_again(node, monkeypatch):
    node.policy(budget_seconds=900)
    node.inst.IGlobal.auth_type = 'app'
    node.inst.IGlobal.app_id = '123'
    monkeypatch.setattr(node.client, 'sign_app_jwt', Mock(side_effect=['jwt-one', 'jwt-two']))
    node.request.side_effect = [secondary_limit(retry_after='600'), response({'slug': 'my-app', 'note': 'jwt-two'})]
    result = node.inst.user_get({})
    sent = [call.kwargs['headers']['Authorization'] for call in node.request.call_args_list]
    assert sent == ['Bearer jwt-one', 'Bearer jwt-two']
    assert result['data'] == {'login': 'my-app', 'type': 'App'}
    node.inst.IGlobal.get_token.assert_not_called()


def test_a_credential_that_cannot_be_minted_for_a_retry_is_the_fixed_failure(node):
    import rocketlib

    node.policy(budget_seconds=900)
    node.inst.IGlobal.get_token = Mock(side_effect=['tok-before-wait', RuntimeError('token endpoint said ' + TOKEN)])
    node.request.side_effect = [secondary_limit(retry_after='600'), response({'Python': 1})]
    result = node.inst.repo_languages({})
    assert node.slept == [600.0]
    assert node.request.call_count == 1
    assert result['status'] is None
    assert result['message'] == node.client.AUTH_FAILURE
    assert 'data' not in result
    assert TOKEN not in json.dumps(result)
    logged = rocketlib.warning.call_args.args[0]
    assert 'RuntimeError' in logged
    assert TOKEN not in logged


def test_rest_200_is_never_read_as_a_graphql_rate_limit(node):
    node.request.return_value = response(RATE_LIMITED, 200, {**OK_HEADERS, 'X-RateLimit-Remaining': '0'})
    result, _ = run(node, 'read')
    assert node.slept == []
    assert result['status'] == 200
    assert result['data'] == RATE_LIMITED


def test_permission_403_is_not_retried(node):
    node.request.return_value = response({'message': 'Resource not accessible by integration'}, 403)
    result, _ = run(node, 'read')
    assert node.slept == []
    assert node.request.call_count == 1
    assert result['status'] == 403
    assert result['message'] == 'Resource not accessible by integration'
    assert 'retry_after' not in result


@pytest.mark.parametrize('path', TOOLS)
def test_budget_exhausted_returns_rate_limit_and_retry_after_without_oversleeping(node, path):
    node.policy(budget_seconds=10, max_retries=5)
    node.request.side_effect = lambda *a, **k: secondary_limit(403, '4')
    result, _ = run(node, path)
    # 4 + 4 fits the 10-second budget; a third 4-second wait would not, so it is never slept.
    assert node.slept == [4.0, 4.0]
    assert sum(node.slept) <= 10
    assert node.request.call_count == 3
    assert result['status'] == 403
    assert result['retry_after'] == 4
    assert result['rate_limit'] == {'remaining': 4999, 'limit': 5000, 'reset': int(NOW) + 3600, 'resource': 'core'}
    assert 'rateLimitBudgetSeconds' in result['message']
    assert result['message'].startswith('You have exceeded a secondary rate limit.')
    assert 'data' not in result


def test_wait_longer_than_the_budget_returns_at_once(node):
    node.request.return_value = primary_limit(reset_in=3600)
    result, _ = run(node, 'read')
    assert node.slept == []
    assert node.request.call_count == 1
    assert result['retry_after'] == 3600
    assert result['rate_limit']['remaining'] == 0
    assert 'rateLimitBudgetSeconds' in result['message']


@pytest.mark.parametrize('path', TOOLS)
def test_retry_count_exhausted_returns_the_structured_error(node, path):
    node.policy(max_retries=2)
    node.request.side_effect = lambda *a, **k: secondary_limit(429, '1')
    result, _ = run(node, path)
    assert node.slept == [1.0, 1.0]
    assert node.request.call_count == 3
    assert result['status'] == 429
    assert result['retry_after'] == 1
    assert 'rateLimitMaxRetries (2)' in result['message']


def test_zero_retries_never_waits(node):
    node.policy(max_retries=0)
    node.request.return_value = secondary_limit(403, '1')
    result, _ = run(node, 'read')
    assert node.slept == []
    assert result['retry_after'] == 1


def test_legacy_tools_keep_their_own_retry_policy(node, monkeypatch):
    # repo_get predates the envelope: it still raises after call()'s three attempts and
    # never uses the configured policy.
    monkeypatch.setattr(node.client.time, 'sleep', Mock())
    node.request.side_effect = lambda *a, **k: secondary_limit(429, '1')
    with pytest.raises(node.client.GitHubAPIError):
        node.inst.repo_get({})
    assert node.request.call_count == 3
    assert node.slept == []


@pytest.mark.parametrize('path', TOOLS)
def test_sentinel_token_never_reaches_a_rate_limit_error(node, path):
    node.policy(max_retries=1)
    node.request.side_effect = lambda *a, **k: primary_limit(403, reset_in=5)
    result, _ = run(node, path)
    assert result['retry_after'] == 5
    assert TOKEN not in json.dumps(result)
