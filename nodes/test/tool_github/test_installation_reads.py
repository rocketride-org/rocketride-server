# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""installation_repos, and the user_get_repos filters and paging checks."""

import pytest
import requests

from ._fake_github import RATE, RATE_HEADERS, FakeGitHub, app_config, dispatch, real_node, response

INSTALLATION_PAGE = {
    'total_count': 3,
    'repositories': [
        {'name': 'api', 'full_name': 'acme/api', 'private': True, 'owner': {'login': 'acme'}, 'id': 1},
        {'name': 'web', 'full_name': 'acme/web', 'private': False, 'permissions': {'admin': True}},
        'not-a-repository',
    ],
}
NEXT = {**RATE_HEADERS, 'Link': '<https://api.github.com/installation/repositories?page=3>; rel="next"'}


@pytest.fixture
def github(monkeypatch):
    fake = FakeGitHub()
    monkeypatch.setattr(requests, 'request', fake)
    return fake


# ---------------------------------------------------------------------------
# installation_repos
# ---------------------------------------------------------------------------


def test_installation_repos_reports_the_installation_whose_token_it_used_after_a_reinstall(github, rsa_private_key_pem):
    github.installations = {'acme/app': 11}
    github.routes[('GET', '/installation/repositories')] = response({'total_count': 0, 'repositories': []})
    with real_node(app_config(rsa_private_key_pem)) as inst:
        assert inst.IGlobal.installation_id_for('acme/app') == '11'
        # Reinstalled: installation 11 is gone, so the mint finds 12 (the 404 rule).
        github.installations['acme/app'] = 12
        github.mint_missing = {'11'}
        result = dispatch(inst, 'installation_repos', {'repo': 'acme/app'})
    assert github.bearer_for('/installation/repositories') == 'ghs_fake_12_1'
    assert result['data']['installation_id'] == 12


def test_installation_repos_lists_one_page_with_the_installation_it_used(github, rsa_private_key_pem):
    github.routes[('GET', '/installation/repositories')] = response(INSTALLATION_PAGE, headers=NEXT)
    with real_node(app_config(rsa_private_key_pem, installationId='456')) as inst:
        result = dispatch(inst, 'installation_repos', {'page': 2, 'per_page': 500})
    assert result == {
        'status': 200,
        'data': {
            'installation_id': 456,
            'total_count': 3,
            'repositories': [
                {'name': 'api', 'full_name': 'acme/api', 'private': True},
                {'name': 'web', 'full_name': 'acme/web', 'private': False},
            ],
        },
        'rate_limit': RATE,
        'next_page': 3,
    }
    call = github.requests_to('/installation/repositories')[0]
    assert call.params == {'page': 2, 'per_page': 100}
    assert call.bearer == 'ghs_fake_456_1'


def test_installation_repos_finds_the_installation_from_the_repository(github, rsa_private_key_pem):
    github.installations = {'acme/api': 11, 'beta/web': 22}
    github.routes[('GET', '/installation/repositories')] = response({'total_count': 0, 'repositories': []})
    with real_node(app_config(rsa_private_key_pem)) as inst:
        assert dispatch(inst, 'installation_repos', {'repo': 'beta/web'})['data']['installation_id'] == 22
        assert dispatch(inst, 'installation_repos', {'repo': 'acme/api'})['data']['installation_id'] == 11
    calls = github.requests_to('/installation/repositories')
    assert [call.bearer for call in calls] == ['ghs_fake_22_1', 'ghs_fake_11_1']


def test_installation_repos_uses_the_default_repository(github, rsa_private_key_pem):
    github.installations = {'beta/web': 22}
    github.routes[('GET', '/installation/repositories')] = response({'total_count': 0, 'repositories': []})
    with real_node(app_config(rsa_private_key_pem, defaultRepo='beta/web')) as inst:
        assert dispatch(inst, 'installation_repos', {})['data']['installation_id'] == 22


def test_installation_repos_without_a_repository_or_installation_id_is_a_result(github, rsa_private_key_pem):
    with real_node(app_config(rsa_private_key_pem)) as inst:
        from tool_github.credentials import NO_REPOSITORY

        result = dispatch(inst, 'installation_repos', {})
    assert result['status'] is None
    assert result['message'] == NO_REPOSITORY
    assert github.calls == []


@pytest.mark.parametrize('cfg', [{'token': 'ghp_pat'}, {'credentialMap': {'*': 'ghp_pat'}}])
def test_installation_repos_needs_app_auth_and_sends_nothing_with_a_token(github, cfg):
    with real_node(cfg) as inst:
        result = dispatch(inst, 'installation_repos', {'repo': 'acme/api'})
    assert result['status'] is None
    assert result['message'].startswith('installation_repos needs GitHub App auth')
    assert 'data' not in result
    assert github.calls == []


@pytest.mark.parametrize(
    'args', [{'page': 0}, {'page': 'two'}, {'per_page': '50'}, {'page': True}, {'repo': 'acme'}, {'repo': 5}]
)
def test_installation_repos_inputs_are_checked_before_any_request(github, rsa_private_key_pem, args):
    with real_node(app_config(rsa_private_key_pem, installationId='456')) as inst:
        with pytest.raises(ValueError):
            dispatch(inst, 'installation_repos', args)
    assert github.calls == []


def test_installation_repos_unexpected_body_is_a_result(github, rsa_private_key_pem):
    github.routes[('GET', '/installation/repositories')] = response([{'name': 'api'}])
    with real_node(app_config(rsa_private_key_pem, installationId='456')) as inst:
        result = dispatch(inst, 'installation_repos', {})
    assert result['status'] == 200
    assert 'data' not in result
    assert 'repositories list' in result['message']


def test_installation_repos_errors_are_results(github, rsa_private_key_pem):
    github.routes[('GET', '/installation/repositories')] = response({'message': 'Bad credentials'}, 401)
    with real_node(app_config(rsa_private_key_pem, installationId='456')) as inst:
        result = dispatch(inst, 'installation_repos', {})
    assert (result['status'], result['message']) == (401, 'Bad credentials')


# ---------------------------------------------------------------------------
# user_get_repos: new filters, paging checks, unchanged result shape
# ---------------------------------------------------------------------------


def _repos_call(github):
    return [call for call in github.calls if call.path.endswith('/repos') or call.path.endswith('/repositories')][-1]


def test_user_get_repos_sends_the_new_filters_without_type(github):
    github.routes[('GET', '/user/repos')] = response([{'full_name': 'me/r', 'private': True, 'node_id': 'x'}])
    with real_node({'token': 'ghp_pat'}) as inst:
        result = dispatch(
            inst,
            'user_get_repos',
            {'affiliation': ' owner, collaborator ,owner', 'visibility': 'private', 'sort': 'updated', 'per_page': 50},
        )
    # The list shape existing callers rely on is kept.
    assert isinstance(result, list)
    assert result[0]['full_name'] == 'me/r'
    assert 'node_id' not in result[0]
    assert _repos_call(github).params == {
        'affiliation': 'owner,collaborator',
        'visibility': 'private',
        'sort': 'updated',
        'page': 1,
        'per_page': 50,
    }


def test_user_get_repos_keeps_type_owner_by_default(github):
    github.routes[('GET', '/user/repos')] = response([])
    with real_node({'token': 'ghp_pat'}) as inst:
        assert dispatch(inst, 'user_get_repos', {}) == []
        dispatch(inst, 'user_get_repos', {'type': 'all', 'sort': 'pushed', 'page': 2})
    first, second = github.requests_to('/user/repos')
    assert first.params == {'type': 'owner', 'page': 1, 'per_page': 30}
    assert second.params == {'type': 'all', 'sort': 'pushed', 'page': 2, 'per_page': 30}


def test_user_get_repos_sort_works_with_a_username(github):
    github.routes[('GET', '/users/octocat/repos')] = response([])
    with real_node({'token': 'ghp_pat'}) as inst:
        dispatch(inst, 'user_get_repos', {'username': 'octocat', 'sort': 'full_name', 'per_page': 999})
    assert _repos_call(github).params == {'type': 'owner', 'sort': 'full_name', 'page': 1, 'per_page': 100}


@pytest.mark.parametrize(
    ('args', 'expected'),
    [
        ({'affiliation': 'admin, *'}, 'affiliation" takes owner, collaborator, organization_member; 2 value'),
        ({'affiliation': 7}, '"affiliation" must be a string'),
        ({'visibility': 'secret'}, '"visibility" must be one of all, public, private'),
        ({'sort': 'stars'}, '"sort" must be one of created, updated, pushed, full_name'),
        ({'type': 'all', 'affiliation': 'owner'}, 'type cannot be combined with affiliation or visibility'),
        ({'type': 'owner', 'visibility': 'public'}, 'type cannot be combined'),
        ({'username': 'octocat', 'visibility': 'public'}, 'omit username'),
        ({'username': 'octocat', 'affiliation': 'owner'}, 'omit username'),
    ],
)
def test_user_get_repos_inputs_are_checked_before_any_request(github, args, expected):
    with real_node({'token': 'ghp_pat'}) as inst:
        with pytest.raises(ValueError, match=expected.replace('(', r'\(')):
            dispatch(inst, 'user_get_repos', args)
    assert github.calls == []


@pytest.mark.parametrize(
    ('args', 'expected'),
    [
        ({'page': 0, 'per_page': 0}, {'page': 1, 'per_page': 30}),
        ({'page': -2, 'per_page': 500}, {'page': 1, 'per_page': 100}),
        ({'page': '3', 'per_page': '50'}, {'page': 3, 'per_page': 50}),
        ({'page': 1.9, 'per_page': None}, {'page': 1, 'per_page': 30}),
    ],
)
def test_user_get_repos_paging_is_read_as_it_always_was(github, args, expected):
    github.routes[('GET', '/user/repos')] = response([])
    with real_node({'token': 'ghp_pat'}) as inst:
        dispatch(inst, 'user_get_repos', args)
    assert _repos_call(github).params == {'type': 'owner', **expected}


def test_user_get_repos_type_is_passed_as_it_always_was(github):
    github.routes[('GET', '/user/repos')] = response([])
    with real_node({'token': 'ghp_pat'}) as inst:
        dispatch(inst, 'user_get_repos', {'type': None})
        dispatch(inst, 'user_get_repos', {'type': 'member'})
    first, second = github.requests_to('/user/repos')
    # An explicit null was dropped before, so GitHub's own default applies; that stays.
    assert first.params == {'page': 1, 'per_page': 30}
    assert second.params == {'type': 'member', 'page': 1, 'per_page': 30}


@pytest.mark.parametrize('args', [{'affiliation': 'owner'}, {'visibility': 'all'}, {'sort': 'created'}])
def test_user_get_repos_filters_are_refused_for_the_installation_list(github, rsa_private_key_pem, args):
    with real_node(app_config(rsa_private_key_pem, installationId='456')) as inst:
        with pytest.raises(ValueError, match='take only page and per_page'):
            dispatch(inst, 'user_get_repos', args)
    assert github.calls == []


def test_user_get_repos_under_app_auth_still_lists_the_installation(github, rsa_private_key_pem):
    page = {'total_count': 2, 'repositories': INSTALLATION_PAGE['repositories'][:2]}
    github.routes[('GET', '/installation/repositories')] = response(page)
    with real_node(app_config(rsa_private_key_pem, installationId='456')) as inst:
        result = dispatch(inst, 'user_get_repos', {'page': 2, 'type': 'all'})
    assert [repo['full_name'] for repo in result] == ['acme/api', 'acme/web']
    assert github.requests_to('/installation/repositories')[0].params == {'page': 2, 'per_page': 30}
