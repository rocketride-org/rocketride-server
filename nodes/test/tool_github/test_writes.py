# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""The envelope writes: pr_request_reviewers, pr_remove_requested_reviewers, issue_add_labels.

Each sends one request with the credential for its repository and returns the result
envelope; read-only mode refuses them as results before any token is minted; a write
is retried only after a rate-limit answer.
"""

import json
from unittest.mock import Mock

import pytest
import requests

from ._fake_github import RATE, RATE_HEADERS, FakeGitHub, app_config, dispatch, real_node, response

TOKEN = 'ghp_sentinel_writes_2592pr3'
PR = {
    'number': 7,
    'title': 'Add retries',
    'requested_reviewers': [{'login': 'octocat', 'id': 1}, {'login': 'hubot', 'id': 2}],
    'requested_teams': [{'slug': 'core', 'name': 'Core'}],
}
LABELS = [
    {'id': 1, 'name': 'existing', 'color': '000000', 'description': 'already there', 'url': 'x'},
    {'id': 2, 'name': 'bug', 'color': 'd73a4a', 'description': None, 'url': 'y'},
]
WRITES = {
    'pr_request_reviewers': {'repo': 'acme/api', 'pr_number': 7, 'reviewers': ['octocat']},
    'pr_remove_requested_reviewers': {'repo': 'acme/api', 'pr_number': 7, 'team_reviewers': ['core']},
    'issue_add_labels': {'repo': 'acme/api', 'issue_number': 7, 'labels': ['bug']},
}


@pytest.fixture
def github(monkeypatch):
    fake = FakeGitHub()
    monkeypatch.setattr(requests, 'request', fake)
    monkeypatch.setattr('time.sleep', Mock(side_effect=AssertionError('slept for real')))
    return fake


def test_request_reviewers_posts_the_logins_and_teams(github):
    github.routes[('POST', '/repos/acme/api/pulls/7/requested_reviewers')] = response(PR, 201)
    with real_node({'token': TOKEN}) as inst:
        result = dispatch(
            inst,
            'pr_request_reviewers',
            {'repo': 'acme/api', 'pr_number': 7, 'reviewers': ['octocat', 'hubot'], 'team_reviewers': ['core']},
        )
    assert result == {
        'status': 201,
        'data': {'number': 7, 'requested_reviewers': ['octocat', 'hubot'], 'requested_teams': ['core']},
        'rate_limit': RATE,
        'next_page': None,
    }
    [call] = github.calls
    assert (call.method, call.path, call.bearer) == ('POST', '/repos/acme/api/pulls/7/requested_reviewers', TOKEN)
    assert call.body == {'reviewers': ['octocat', 'hubot'], 'team_reviewers': ['core']}


def test_remove_requested_reviewers_sends_delete_and_returns_the_requests_left(github):
    left = {**PR, 'requested_reviewers': [{'login': 'hubot'}], 'requested_teams': []}
    github.routes[('DELETE', '/repos/acme/api/pulls/7/requested_reviewers')] = response(left)
    with real_node({'token': TOKEN}) as inst:
        result = dispatch(
            inst, 'pr_remove_requested_reviewers', {'repo': 'acme/api', 'pr_number': 7, 'reviewers': ['octocat']}
        )
    assert result['status'] == 200
    assert result['data'] == {'number': 7, 'requested_reviewers': ['hubot'], 'requested_teams': []}
    [call] = github.calls
    assert (call.method, call.path) == ('DELETE', '/repos/acme/api/pulls/7/requested_reviewers')
    assert call.body == {'reviewers': ['octocat'], 'team_reviewers': []}


def test_issue_add_labels_appends_with_post_and_keeps_existing_labels(github):
    github.routes[('POST', '/repos/acme/api/issues/7/labels')] = response(LABELS)
    with real_node({'token': TOKEN}) as inst:
        result = dispatch(inst, 'issue_add_labels', {'repo': 'acme/api', 'issue_number': 7, 'labels': ['bug']})
    [call] = github.calls
    # POST to the labels endpoint appends; issue_edit's PATCH of the issue would replace the set.
    assert (call.method, call.path) == ('POST', '/repos/acme/api/issues/7/labels')
    assert call.body == {'labels': ['bug']}
    assert result['status'] == 200
    assert result['data'] == [
        {'name': 'existing', 'color': '000000', 'description': 'already there'},
        {'name': 'bug', 'color': 'd73a4a', 'description': None},
    ]


def test_issue_edit_still_replaces_the_whole_label_set(github):
    github.routes[('PATCH', '/repos/acme/api/issues/7')] = response({'number': 7, 'labels': [{'name': 'bug'}]})
    with real_node({'token': TOKEN}) as inst:
        dispatch(inst, 'issue_edit', {'repo': 'acme/api', 'issue_number': 7, 'labels': ['bug']})
    [call] = github.calls
    assert (call.method, call.path, call.body) == ('PATCH', '/repos/acme/api/issues/7', {'labels': ['bug']})


@pytest.mark.parametrize('tool', sorted(WRITES))
def test_writes_are_refused_in_read_only_mode_as_results_before_any_token(github, rsa_private_key_pem, tool):
    cfg = app_config(rsa_private_key_pem, readOnly=True)
    with real_node(cfg) as inst:
        result = dispatch(inst, tool, WRITES[tool])
        # The refusal comes first: even an invalid call is refused, not validated.
        assert dispatch(inst, tool, {'repo': 'not a repo'}) == result
    assert result == {
        'status': None,
        'message': f'{tool} refused by readOnly: read-only mode blocks writes. '
        'Turn readOnly off in the node configuration to run it.',
        'documentation_url': None,
        'rate_limit': {'remaining': None, 'limit': None, 'reset': None, 'resource': None},
        'next_page': None,
    }
    # No installation lookup, no token mint, no write.
    assert github.calls == []


@pytest.mark.parametrize('tool', sorted(WRITES))
def test_writes_succeed_with_read_only_off(github, tool):
    method = 'DELETE' if tool == 'pr_remove_requested_reviewers' else 'POST'
    path = (
        '/repos/acme/api/issues/7/labels'
        if tool == 'issue_add_labels'
        else '/repos/acme/api/pulls/7/requested_reviewers'
    )
    github.routes[(method, path)] = response(LABELS if tool == 'issue_add_labels' else PR)
    with real_node({'token': TOKEN, 'readOnly': False}) as inst:
        result = dispatch(inst, tool, WRITES[tool])
    assert result['status'] == 200
    assert 'data' in result
    assert [(call.method, call.path) for call in github.calls] == [(method, path)]


@pytest.mark.parametrize(
    ('tool', 'args', 'expected'),
    [
        ('pr_request_reviewers', {'repo': 'acme/api', 'reviewers': ['a']}, 'pr_number'),
        ('pr_request_reviewers', {'repo': 'acme/api', 'pr_number': 0, 'reviewers': ['a']}, 'pr_number'),
        ('pr_request_reviewers', {'repo': 'acme/api', 'pr_number': 7}, 'at least one login'),
        (
            'pr_request_reviewers',
            {'repo': 'acme/api', 'pr_number': 7, 'reviewers': [], 'team_reviewers': None},
            'at least one',
        ),
        ('pr_request_reviewers', {'repo': 'acme/api', 'pr_number': 7, 'reviewers': 'octocat'}, 'reviewers'),
        (
            'pr_remove_requested_reviewers',
            {'repo': 'acme/api', 'pr_number': 7, 'team_reviewers': [' ']},
            'team_reviewers',
        ),
        ('pr_remove_requested_reviewers', {'repo': 'acme/api', 'pr_number': 7, 'reviewers': [5]}, 'reviewers'),
        ('issue_add_labels', {'repo': 'acme/api', 'issue_number': 7}, 'labels'),
        ('issue_add_labels', {'repo': 'acme/api', 'issue_number': 7, 'labels': []}, 'labels'),
        ('issue_add_labels', {'repo': 'acme/api', 'issue_number': 7, 'labels': 'bug'}, 'labels'),
        ('issue_add_labels', {'repo': 'acme/api', 'issue_number': True, 'labels': ['bug']}, 'issue_number'),
        ('issue_add_labels', {'repo': 'acme/api/x', 'issue_number': 7, 'labels': ['bug']}, 'owner/repo'),
    ],
)
def test_write_inputs_are_checked_before_any_request(github, tool, args, expected):
    with real_node({'token': TOKEN}) as inst:
        with pytest.raises(ValueError, match=expected):
            dispatch(inst, tool, args)
    assert github.calls == []


@pytest.mark.parametrize('status', [403, 404, 422])
def test_write_errors_are_results(github, status):
    github.routes[('POST', '/repos/acme/api/issues/7/labels')] = response(
        {'message': 'Validation Failed', 'documentation_url': 'https://docs.github.com/rest'}, status
    )
    with real_node({'token': TOKEN}) as inst:
        result = dispatch(inst, 'issue_add_labels', WRITES['issue_add_labels'])
    assert result == {
        'status': status,
        'message': 'Validation Failed',
        'documentation_url': 'https://docs.github.com/rest',
        'rate_limit': RATE,
        'next_page': None,
    }
    assert len(github.calls) == 1


# ---------------------------------------------------------------------------
# The write retry rule: retried only when GitHub did not apply the request
# ---------------------------------------------------------------------------


def _injected_sleep(inst):
    from tool_github.github_client import RetryPolicy

    slept = []
    inst.IGlobal.retry_policy = RetryPolicy(sleep=slept.append, clock=lambda: 1_800_000_000.0)
    return slept


def test_a_write_is_retried_after_a_secondary_rate_limit(github):
    limited = response(
        {'message': 'You have exceeded a secondary rate limit.'}, 403, {**RATE_HEADERS, 'Retry-After': '3'}
    )
    answers = iter([limited, response(PR, 201)])
    github.routes[('POST', '/repos/acme/api/pulls/7/requested_reviewers')] = lambda call: next(answers)
    with real_node({'token': TOKEN}) as inst:
        slept = _injected_sleep(inst)
        result = dispatch(inst, 'pr_request_reviewers', WRITES['pr_request_reviewers'])
    assert result['status'] == 201
    assert slept == [3.0]
    assert len(github.calls) == 2


def test_a_write_is_retried_after_a_primary_rate_limit(github):
    headers = {**RATE_HEADERS, 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': str(1_800_000_000 + 5)}
    answers = iter([response({'message': 'API rate limit exceeded'}, 403, headers), response(LABELS)])
    github.routes[('POST', '/repos/acme/api/issues/7/labels')] = lambda call: next(answers)
    with real_node({'token': TOKEN}) as inst:
        slept = _injected_sleep(inst)
        result = dispatch(inst, 'issue_add_labels', WRITES['issue_add_labels'])
    assert result['status'] == 200
    assert slept == [5.0]


@pytest.mark.parametrize('error', [requests.Timeout, requests.ConnectionError])
def test_a_write_is_never_retried_after_a_timeout_or_a_dropped_connection(monkeypatch, github, error):
    request = Mock(side_effect=error(f'read timed out {TOKEN}'))
    monkeypatch.setattr(requests, 'request', request)
    with real_node({'token': TOKEN}) as inst:
        slept = _injected_sleep(inst)
        result = dispatch(inst, 'issue_add_labels', WRITES['issue_add_labels'])
    assert request.call_count == 1
    assert slept == []
    assert result['status'] is None
    assert result['message'] == (
        'GitHub request failed or returned invalid JSON, so the write may or may not have been applied. '
        'Check its current state before you retry.'
    )
    assert TOKEN not in json.dumps(result)


@pytest.mark.parametrize('status', [500, 502, 504])
def test_a_write_is_never_retried_after_a_server_error(github, status):
    github.routes[('DELETE', '/repos/acme/api/pulls/7/requested_reviewers')] = response(
        {'message': 'Server Error'}, status
    )
    with real_node({'token': TOKEN}) as inst:
        slept = _injected_sleep(inst)
        result = dispatch(inst, 'pr_remove_requested_reviewers', WRITES['pr_remove_requested_reviewers'])
    assert result['status'] == status
    assert slept == []
    assert len(github.calls) == 1


def test_a_write_is_not_retried_after_a_permission_403(github):
    github.routes[('POST', '/repos/acme/api/pulls/7/requested_reviewers')] = response(
        {'message': 'Resource not accessible by integration'}, 403
    )
    with real_node({'token': TOKEN}) as inst:
        slept = _injected_sleep(inst)
        result = dispatch(inst, 'pr_request_reviewers', WRITES['pr_request_reviewers'])
    assert result['status'] == 403
    assert slept == []
    assert len(github.calls) == 1


@pytest.mark.parametrize('failure', ['timeout', 'connection', 'invalid-json'])
def test_legacy_write_reports_unknown_outcome_without_retrying(monkeypatch, github, failure):
    request = Mock()
    if failure == 'invalid-json':
        request.return_value = response(None, raw=f'unreadable {TOKEN}'.encode())
    else:
        error = requests.Timeout if failure == 'timeout' else requests.ConnectionError
        request.side_effect = error(TOKEN)
    monkeypatch.setattr(requests, 'request', request)
    with real_node({'token': TOKEN}) as inst:
        with pytest.raises(ValueError) as error:
            dispatch(inst, 'issue_comment', {'repo': 'acme/api', 'issue_number': 7, 'body': 'test'})
    assert 'write may or may not have been applied' in str(error.value)
    assert 'Check its current state before you retry' in str(error.value)
    assert TOKEN not in str(error.value)
    assert error.value.__context__ is None
    assert request.call_count == 1


def test_a_read_keeps_its_transport_message(monkeypatch, github):
    monkeypatch.setattr(requests, 'request', Mock(side_effect=requests.Timeout('slow')))
    with real_node({'token': TOKEN}) as inst:
        result = dispatch(inst, 'label_list', {'repo': 'acme/api'})
    assert result['message'] == 'GitHub request failed or returned invalid JSON. Check connectivity and retry.'
