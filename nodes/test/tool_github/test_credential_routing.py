# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Credentials through the tools: each call uses the credential for its repository.

The node's real IGlobal and IInstance run with only HTTP faked, and the tools run
through the published tool map, as the engine runs them. The sentinel tests make the
fake GitHub echo every credential kind back, on the envelope path and in a legacy
tool's error, and check that none of it comes out.
"""

import base64
import json
import threading

import pytest
import requests

from ._fake_github import FakeGitHub, app, app_config, claims, dispatch, real_node, response

SENTINEL_PAT = 'ghp_sentinel_node_pat_2592pr3'
SENTINEL_MAP_PAT = 'ghp_sentinel_map_pat_2592pr3'
SENTINEL_OTHER = 'ghp_sentinel_other_entry_2592pr3'
NO_REQUEST_FAILURE = {
    'status': None,
    'documentation_url': None,
    'rate_limit': {'remaining': None, 'limit': None, 'reset': None, 'resource': None},
    'next_page': None,
}


@pytest.fixture
def github(monkeypatch):
    fake = FakeGitHub()
    monkeypatch.setattr(requests, 'request', fake)
    return fake


def _issue(call):
    return response({'number': 1, 'title': 'bug', 'labels': [], 'user': {'login': 'octocat'}})


# ---------------------------------------------------------------------------
# Routing
# ---------------------------------------------------------------------------


def test_one_app_reads_two_organizations_from_one_pipeline(github, rsa_private_key_pem):
    github.installations = {'acme/api': 11, 'beta/web': 22}
    github.routes[('GET', '/repos/acme/api/languages')] = response({'Python': 10})
    github.routes[('GET', '/repos/beta/web/issues/1')] = _issue
    github.routes[('POST', '/graphql')] = response({'data': {'repository': {'name': 'web'}}})
    with real_node(app_config(rsa_private_key_pem)) as inst:
        assert dispatch(inst, 'repo_languages', {'repo': 'acme/api'})['data'] == {'Python': 10}
        assert dispatch(inst, 'issue_get', {'repo': 'beta/web', 'issue_number': 1})['title'] == 'bug'
        query = 'query { repository(owner: "beta", name: "web") { name } }'
        assert dispatch(inst, 'graphql', {'query': query, 'repo': 'beta/web'})['status'] == 200
    assert github.bearer_for('/repos/acme/api/languages') == 'ghs_fake_11_1'
    assert github.bearer_for('/repos/beta/web/issues/1') == 'ghs_fake_22_1'
    assert github.bearer_for('/graphql') == 'ghs_fake_22_1'
    # One lookup and one token per installation for the whole run.
    assert len(github.requests_to('/repos/acme/api/installation')) == 1
    assert len(github.requests_to('/repos/beta/web/installation')) == 1
    assert len(github.requests_to('/app/installations/')) == 2


def test_the_default_repository_picks_the_credential_for_tools_without_one(github, rsa_private_key_pem):
    github.installations = {'beta/web': 22}
    github.routes[('POST', '/graphql')] = response({'data': {}})
    with real_node(app_config(rsa_private_key_pem, defaultRepo='beta/web')) as inst:
        assert dispatch(inst, 'graphql', {'query': 'query { viewer { login } }'})['status'] == 200
    assert github.bearer_for('/graphql') == 'ghs_fake_22_1'


def test_every_request_of_a_large_file_read_and_a_tree_walk_uses_the_repository_credential(github, rsa_private_key_pem):
    github.installations = {'beta/web': 22}
    text = 'x' * 1_048_577
    github.routes[('GET', '/repos/beta/web/contents/big.txt')] = response(
        {
            'type': 'file',
            'name': 'big.txt',
            'path': 'big.txt',
            'sha': 'blob-sha',
            'size': len(text),
            'encoding': 'none',
            'content': '',
        }
    )
    github.routes[('GET', '/repos/beta/web/git/blobs/blob-sha')] = response(
        {
            'sha': 'blob-sha',
            'size': len(text),
            'encoding': 'base64',
            'content': base64.encodebytes(text.encode()).decode(),
        }
    )
    github.routes[('GET', '/repos/beta/web/git/trees/HEAD')] = response(
        {'sha': 'root-sha', 'tree': [], 'truncated': True}
    )
    github.routes[('GET', '/repos/beta/web/git/trees/root-sha')] = response(
        {'sha': 'root-sha', 'tree': [{'path': 'src', 'type': 'tree', 'sha': 'src-sha'}], 'truncated': False}
    )
    github.routes[('GET', '/repos/beta/web/git/trees/src-sha')] = response(
        {'sha': 'src-sha', 'tree': [{'path': 'a.py', 'type': 'blob'}], 'truncated': False}
    )
    with real_node(app_config(rsa_private_key_pem)) as inst:
        assert dispatch(inst, 'file_get', {'repo': 'beta/web', 'path': 'big.txt'})['content'] == text
        tree = dispatch(inst, 'repo_tree', {'repo': 'beta/web', 'walk': True})
    assert [entry['path'] for entry in tree['data']['tree']] == ['src', 'src/a.py']
    assert tree['data']['complete'] is True
    for path in (
        '/repos/beta/web/contents/big.txt',
        '/repos/beta/web/git/blobs/blob-sha',
        '/repos/beta/web/git/trees/HEAD',
        '/repos/beta/web/git/trees/root-sha',
        '/repos/beta/web/git/trees/src-sha',
    ):
        assert github.bearer_for(path) == 'ghs_fake_22_1'
    assert len(github.requests_to('/repos/beta/web/installation')) == 1


def test_the_map_routes_each_tool_to_its_credential(github):
    credential_map = {'acme/payments': 'tok-exact', 'acme/*': 'tok-owner', '*': 'tok-default'}
    github.routes[('GET', '/repos/acme/payments/labels')] = response([])
    github.routes[('GET', '/repos/Acme/Web/pulls/3')] = response({'number': 3})
    github.routes[('GET', '/repos/other/x')] = response({'full_name': 'other/x'})
    github.routes[('GET', '/orgs/acme/repos')] = response([])
    github.routes[('GET', '/search/issues')] = response({'items': [_issue(None).json()]})
    github.routes[('GET', '/user/repos')] = response([])
    with real_node({'credentialMap': credential_map}) as inst:
        dispatch(inst, 'label_list', {'repo': 'acme/payments'})
        dispatch(inst, 'pr_get', {'repo': 'Acme/Web', 'pr_number': 3})
        dispatch(inst, 'repo_get', {'repo': 'other/x'})
        dispatch(inst, 'org_list_repos', {'org': 'acme'})
        dispatch(inst, 'search_issues', {'query': 'crash'})
        dispatch(inst, 'user_get_repos', {})
    assert github.bearer_for('/repos/acme/payments/labels') == 'tok-exact'
    assert github.bearer_for('/repos/Acme/Web/pulls/3') == 'tok-owner'
    assert github.bearer_for('/repos/other/x') == 'tok-default'
    assert github.bearer_for('/orgs/acme/repos') == 'tok-owner'
    assert github.bearer_for('/search/issues') == 'tok-default'
    assert github.bearer_for('/user/repos') == 'tok-default'


@pytest.mark.parametrize(
    ('tool', 'args'),
    [
        ('label_list', {'repo': 'other/x'}),
        ('repo_tree', {'repo': 'other/x'}),
        ('graphql', {'query': 'query { viewer { login } }', 'repo': 'other/x'}),
        ('user_get', {'repo': 'other/x'}),
        ('installation_repos', {'repo': 'other/x'}),
        ('issue_add_labels', {'repo': 'other/x', 'issue_number': 1, 'labels': ['bug']}),
    ],
)
def test_no_match_is_a_result_on_the_envelope_tools(github, tool, args):
    with real_node({'credentialMap': {'acme/*': SENTINEL_MAP_PAT}}) as inst:
        result = dispatch(inst, tool, args)
    assert result == {
        **NO_REQUEST_FAILURE,
        'message': (
            'No credentialMap entry matches other/x: the map has no entry for other/x, none for the owner other, '
            'and no default entry.'
        ),
    }
    assert github.calls == []


@pytest.mark.parametrize(
    ('tool', 'args', 'named'),
    [
        ('issue_get', {'repo': 'other/x', 'issue_number': 1}, 'other/x'),
        ('file_get', {'repo': 'other/x', 'path': 'README.md'}, 'other/x'),
        ('org_list_repos', {'org': 'zeta'}, 'the owner zeta'),
    ],
)
def test_no_match_is_raised_by_the_legacy_tools_naming_the_repository(github, tool, args, named):
    with real_node({'credentialMap': {'acme/*': SENTINEL_MAP_PAT}}) as inst:
        from tool_github.github_client import CredentialError

        with pytest.raises(CredentialError) as error:
            dispatch(inst, tool, args)
    assert f'No credentialMap entry matches {named}' in str(error.value)
    assert 'acme' not in str(error.value)
    assert SENTINEL_MAP_PAT not in str(error.value)
    assert github.calls == []


def test_app_not_installed_is_a_result_naming_the_repository(github, rsa_private_key_pem):
    with real_node(app_config(rsa_private_key_pem)) as inst:
        result = dispatch(inst, 'label_list', {'repo': 'gamma/tool'})
        assert result['status'] is None
        assert result['message'].startswith('The GitHub App is not installed on gamma/tool')
        from tool_github.github_client import CredentialError

        with pytest.raises(CredentialError, match='not installed on gamma/tool'):
            dispatch(inst, 'pr_get', {'repo': 'gamma/tool', 'pr_number': 1})
    assert {call.path for call in github.calls} == {'/repos/gamma/tool/installation'}


def test_user_get_identifies_the_credential_that_serves_the_repository(github, rsa_private_key_pem):
    github.routes[('GET', '/user')] = response({'login': 'acme-bot', 'type': 'User'})
    github.routes[('GET', '/app')] = response({'slug': 'beta-app'})
    credential_map = {'acme/*': 'tok-acme', 'beta/*': app(rsa_private_key_pem, '222', '5')}
    with real_node({'credentialMap': credential_map}) as inst:
        assert dispatch(inst, 'user_get', {'repo': 'acme/x'})['data'] == {'login': 'acme-bot', 'type': 'User'}
        assert dispatch(inst, 'user_get', {'repo': 'beta/y'})['data'] == {'login': 'beta-app', 'type': 'App'}
    assert github.bearer_for('/user') == 'tok-acme'
    assert claims(github.bearer_for('/app'), rsa_private_key_pem)['iss'] == '222'
    assert not github.requests_to('/app/installations/')


def test_repositories_the_map_does_not_match_use_the_node_credential(github):
    github.routes[('GET', '/repos/other/x/labels')] = response([])
    github.routes[('GET', '/repos/acme/x/issues/1')] = _issue
    with real_node({'token': SENTINEL_PAT, 'credentialMap': {'acme/*': SENTINEL_MAP_PAT}}) as inst:
        dispatch(inst, 'label_list', {'repo': 'other/x'})
        dispatch(inst, 'issue_get', {'repo': 'acme/x', 'issue_number': 1})
    assert github.bearer_for('/repos/other/x/labels') == SENTINEL_PAT
    assert github.bearer_for('/repos/acme/x/issues/1') == SENTINEL_MAP_PAT


# ---------------------------------------------------------------------------
# Dot segments: a path argument cannot move a request to another repository
# ---------------------------------------------------------------------------


# CodeRabbit's example: one raw segment that decodes to x/../../../../evil/x/contents/f.
ENCODED_SLASH = 'x%2F..%2F..%2F..%2F..%2Fevil%2Fx%2Fcontents%2Ff'
REFUSED_PATHS = {
    'plain': '../../../evil/x/contents/f',
    'encoded-dots': 'docs/%2e%2e/%2E%2E/%2e%2e/evil/x',
    'single-dot': 'a/./b',
    'encoded-slash': ENCODED_SLASH,
    'double-encoded': 'x%252F..%252F..%252F..%252F..%252Fevil%252Fx%252Fcontents%252Ff',
    'triple-encoded-dots': 'docs/%25252e%25252e/x',
    'escape-split-across-decodings': 'docs/%%32%65%%32%65/x',
    'backslash': 'x\\..\\..\\..\\..\\evil\\x\\contents\\f',
    'encoded-backslash': 'x%5C..%5C..%5Cevil',
    'encoded-question-mark-before-dots': 'x%3F/../../evil',
    'empty-segment': 'docs//x',
    'encoded-empty-segment': 'x%2F%2Fy',
}


@pytest.mark.parametrize('path', REFUSED_PATHS.values(), ids=REFUSED_PATHS.keys())
def test_dot_segments_in_a_legacy_path_are_refused_before_sending(github, path):
    with real_node({'credentialMap': {'acme/*': 'tok-acme'}}) as inst:
        from tool_github.github_client import UnsafePathError

        with pytest.raises(UnsafePathError, match='"." or ".." segment or an empty one'):
            dispatch(inst, 'file_get', {'repo': 'acme/app', 'path': path})
    assert github.calls == []


def test_an_encoded_slash_in_a_ref_cannot_hide_dot_segments(github):
    # repo_tree encodes the ref as one segment, x%2F..%2F..%2F..%2F..%2Fevil%2Fx: the shape CodeRabbit found.
    with real_node({'token': 'ghp_node'}) as inst:
        result = dispatch(inst, 'repo_tree', {'repo': 'acme/app', 'ref': 'x/../../../../evil/x'})
    assert result['status'] is None
    assert '"." or ".." segment or an empty one' in result['message']
    assert github.calls == []


def test_dot_segments_on_the_envelope_path_are_a_result(github):
    with real_node({'token': 'ghp_node'}) as inst:
        result = dispatch(inst, 'repo_tree', {'repo': 'acme/app', 'ref': '..'})
    assert result['status'] is None
    assert '"." or ".." segment' in result['message']
    assert github.calls == []


@pytest.mark.parametrize('name', ['a..b.md', '..foo', 'a.b', '...', 'x%2Fy', 'dir/'])
def test_names_that_are_not_dot_segments_are_sent_as_given(github, name):
    # Dots inside a name are not a segment; x%2Fy is sent as given, and GitHub reads it as x/y.
    path = f'/repos/acme/app/contents/docs/{name}'
    github.routes[('GET', path)] = response({'content': '', 'path': name})
    with real_node({'token': 'ghp_node'}) as inst:
        assert dispatch(inst, 'file_get', {'repo': 'acme/app', 'path': f'docs/{name}'})['found'] is True
    assert [call.path for call in github.calls] == [path]


def test_a_ref_with_a_slash_is_sent_encoded_and_allowed(github):
    path = '/repos/acme/app/git/trees/release%2Fnext'
    github.routes[('GET', path)] = response({'sha': 'abc', 'truncated': False, 'tree': []})
    with real_node({'token': 'ghp_node'}) as inst:
        result = dispatch(inst, 'repo_tree', {'repo': 'acme/app', 'ref': 'release/next'})
    assert result['status'] == 200
    assert [call.path for call in github.calls] == [path]


def test_the_guard_returns_the_path_unchanged_and_decodes_every_level():
    from tool_github.github_client import _checked_path, _decoded_path

    for path in ('/repos/acme/app/contents/', '/repos/acme/app/contents/x%2Fy', '/repos/acme/app/git/trees/a%252Fb'):
        assert _checked_path(path) is path
    slash = '/'
    for _ in range(6):
        slash = slash.replace('%', '%25').replace('/', '%2F')
        assert _decoded_path(f'a{slash}b') == 'a/b'
    assert _decoded_path('/a%2Fb?path=..%2F..') == '/a/b'


# ---------------------------------------------------------------------------
# Sentinel redaction: every credential kind, on the envelope path and in a legacy error
# ---------------------------------------------------------------------------


def _upload(pem: str) -> str:
    return 'data:application/x-pem-file;base64,' + base64.b64encode(pem.encode()).decode()


def _kinds(pem):
    """(config, preparation, secrets the fake echoes) per credential kind; ``bearer`` is echoed too."""
    other_app = app(pem, '999', '77')
    return {
        'node-pat': ({'token': SENTINEL_PAT}, None, [SENTINEL_PAT]),
        'map-pat': (
            {'credentialMap': {'acme/*': SENTINEL_MAP_PAT, 'beta/*': SENTINEL_OTHER}},
            None,
            [SENTINEL_MAP_PAT, SENTINEL_OTHER],
        ),
        'node-app-key': (app_config(pem, installationId='456'), None, [pem.strip()]),
        'map-app-key': ({'credentialMap': {'acme/*': app(_upload(pem), '111', '5')}}, None, [pem, _upload(pem)]),
        'installation-token': (app_config(pem, installationId='456'), None, ['ghs_fake_456_1']),
        'map-installation-token': (
            # The token minted for the other entry first must come out of this call's answer too.
            {'credentialMap': {'acme/*': app(pem, '111', '5'), 'beta/*': other_app}},
            lambda inst: inst.IGlobal.get_token('beta/web'),
            ['ghs_fake_5_1', 'ghs_fake_77_1'],
        ),
    }


KINDS = ['node-pat', 'map-pat', 'node-app-key', 'map-app-key', 'installation-token', 'map-installation-token']


def _echo(secrets, status=422):
    """A GitHub error that echoes the bearer and ``secrets``: short ones in message, all in documentation_url."""

    def answer(call):
        short = ' '.join(s for s in secrets if len(s) < 200)
        return response(
            {
                'message': f'echo {call.bearer} {short}',
                'documentation_url': 'https://docs.example.test/' + ' '.join([call.bearer, *secrets]),
            },
            status,
        )

    return answer


def _leaks(text: str, secrets) -> list[str]:
    return [secret for secret in secrets if secret in text]


@pytest.mark.parametrize('kind', KINDS)
def test_sentinel_credentials_never_reach_an_envelope_result(github, rsa_private_key_pem, kind):
    cfg, prepare, secrets = _kinds(rsa_private_key_pem)[kind]
    github.routes[('GET', '/repos/acme/api/languages')] = _echo(secrets)
    with real_node(cfg) as inst:
        from rocketlib import warning

        if prepare:
            prepare(inst)
        result = dispatch(inst, 'repo_languages', {'repo': 'acme/api'})
        bearer = github.bearer_for('/repos/acme/api/languages')
        logged = ' '.join(str(call) for call in warning.call_args_list)
    dumped = json.dumps(result)
    assert result['status'] == 422
    assert _leaks(dumped, [*secrets, bearer, f'Bearer {bearer}']) == []
    assert '[REDACTED]' in result['message']
    assert _leaks(logged, [*secrets, bearer]) == []


@pytest.mark.parametrize('kind', KINDS)
def test_sentinel_credentials_never_reach_a_legacy_tool_error(github, rsa_private_key_pem, kind):
    cfg, prepare, secrets = _kinds(rsa_private_key_pem)[kind]
    github.routes[('GET', '/repos/acme/api/issues/1')] = _echo(secrets)
    with real_node(cfg) as inst:
        if prepare:
            prepare(inst)
        with pytest.raises(ValueError) as error:
            dispatch(inst, 'issue_get', {'repo': 'acme/api', 'issue_number': 1})
        bearer = github.bearer_for('/repos/acme/api/issues/1')
    shown = f'{error.value} {error.value!r} {error.value.args}'
    assert _leaks(shown, [*secrets, bearer]) == []
    assert '[REDACTED]' in str(error.value)
    # Raised fresh: nothing that held the secret is chained to it.
    assert error.value.__cause__ is None
    assert error.value.__context__ is None


def test_the_app_jwt_never_reaches_an_envelope_result(github, rsa_private_key_pem):
    github.routes[('GET', '/app')] = _echo([])
    with real_node(app_config(rsa_private_key_pem, installationId='456')) as inst:
        result = dispatch(inst, 'user_get', {})
    jwt_token = github.bearer_for('/app')
    assert claims(jwt_token, rsa_private_key_pem)['iss'] == '111'
    assert result['status'] == 422
    assert jwt_token not in json.dumps(result)


def test_the_app_jwt_never_reaches_a_legacy_tool_error(github, rsa_private_key_pem):
    # The token endpoint refuses the JWT and echoes it; a legacy tool raises that error.
    github.mint_status = 401
    with real_node(app_config(rsa_private_key_pem, installationId='456')) as inst:
        with pytest.raises(ValueError) as error:
            dispatch(inst, 'issue_get', {'repo': 'acme/api', 'issue_number': 1})
    jwt_token = github.bearer_for('/app/installations/456/access_tokens')
    assert claims(jwt_token, rsa_private_key_pem)['iss'] == '111'
    assert jwt_token not in f'{error.value} {error.value!r} {error.value.args}'
    assert str(error.value).startswith('GitHub API 401: Bad credentials [REDACTED]')


def test_an_error_without_a_secret_is_raised_unchanged(github):
    github.routes[('GET', '/repos/acme/api/issues/9')] = response({'message': 'Not Found'}, 404, headers={})
    with real_node({'token': SENTINEL_PAT}) as inst:
        from tool_github.github_client import GitHubAPIError

        with pytest.raises(GitHubAPIError) as error:
            dispatch(inst, 'issue_get', {'repo': 'acme/api', 'issue_number': 9})
    assert error.value.status_code == 404
    assert str(error.value) == 'GitHub API 404: Not Found'


# ---------------------------------------------------------------------------
# Redaction comes before the 2,000-character message cap on the REST envelope path
# ---------------------------------------------------------------------------


def _straddling(secret: str) -> str:
    """A message that puts ``secret`` across the cap: its first 10 characters fall inside it."""
    return 'x' * (2000 - 10) + secret


@pytest.mark.parametrize('tool', ['read', 'write'])
@pytest.mark.parametrize('which', ['call-token', 'other-entry'])
def test_a_credential_across_the_message_cap_leaves_no_prefix(github, tool, which):
    secret = SENTINEL_MAP_PAT if which == 'call-token' else SENTINEL_OTHER
    path = '/repos/acme/api/languages' if tool == 'read' else '/repos/acme/api/issues/7/labels'
    method = 'GET' if tool == 'read' else 'POST'
    github.routes[(method, path)] = response({'message': _straddling(secret)}, 422)
    cfg = {'credentialMap': {'acme/*': SENTINEL_MAP_PAT, 'beta/*': SENTINEL_OTHER}}
    with real_node(cfg) as inst:
        if tool == 'read':
            result = dispatch(inst, 'repo_languages', {'repo': 'acme/api'})
        else:
            result = dispatch(inst, 'issue_add_labels', {'repo': 'acme/api', 'issue_number': 7, 'labels': ['bug']})
    assert result['status'] == 422
    assert secret[:10] not in result['message']
    assert result['message'] == 'x' * 1990 + '[REDACTED]'


# ---------------------------------------------------------------------------
# The seams the merged walk and the large-file read added: their own messages and data
# ---------------------------------------------------------------------------

SEAM_ACME = 'ghp_sentinel_seam_acme_2592pr3'
SEAM_BETA = 'ghp_sentinel_seam_beta_2592pr3'
SEAM_MAP = {'credentialMap': {'acme/*': SEAM_ACME, 'beta/*': SEAM_BETA}}


@pytest.mark.parametrize('secret', [SEAM_ACME, SEAM_BETA], ids=['call-token', 'other-entry'])
def test_a_walk_stopped_by_a_failure_that_echoes_a_credential_across_the_cap(github, secret):
    github.routes[('GET', '/repos/acme/app/git/trees/HEAD')] = response(
        {'sha': 'root', 'tree': [{'path': 'keep.txt', 'type': 'blob'}], 'truncated': True}
    )
    # The walk's own stop message wraps GitHub's, whose cut at 2,000 falls inside the credential.
    github.routes[('GET', '/repos/acme/app/git/trees/root')] = response({'message': 'x' * 1990 + secret}, 422)
    with real_node(SEAM_MAP) as inst:
        result = dispatch(inst, 'repo_tree', {'repo': 'acme/app', 'walk': True})
    assert result['status'] == 422
    assert result['data']['complete'] is False
    assert [entry['path'] for entry in result['data']['tree']] == ['keep.txt']
    assert result['message'].endswith('x[REDACTED]; data is partial.')
    dumped = json.dumps(result)
    for leaked in (SEAM_ACME, SEAM_BETA, secret[:10]):
        assert leaked not in dumped


def test_a_credential_in_a_partial_walk_entry_is_redacted(github):
    github.routes[('GET', '/repos/acme/app/git/trees/HEAD')] = response(
        {'sha': 'root', 'tree': [{'path': f'leak-{SEAM_BETA}', 'type': 'blob'}], 'truncated': True}
    )
    github.routes[('GET', '/repos/acme/app/git/trees/root')] = response({'message': 'boom'}, 500)
    with real_node(SEAM_MAP) as inst:
        result = dispatch(inst, 'repo_tree', {'repo': 'acme/app', 'walk': True})
    assert result['data']['tree'][0]['path'] == 'leak-[REDACTED]'
    dumped = json.dumps(result)
    assert SEAM_ACME not in dumped
    assert SEAM_BETA not in dumped


def test_a_failed_blob_read_that_echoes_credentials_is_a_result_without_them(github):
    github.routes[('GET', '/repos/acme/app/contents/big.bin')] = response(
        {
            'type': 'file',
            'path': 'big.bin',
            'name': 'big.bin',
            'sha': 'b1',
            'size': 2_000_000,
            'encoding': 'none',
            'content': '',
        }
    )
    github.routes[('GET', '/repos/acme/app/git/blobs/b1')] = lambda call: response(
        {'message': f'nope {call.bearer} {SEAM_BETA}'}, 403
    )
    with real_node(SEAM_MAP) as inst:
        result = dispatch(inst, 'file_get', {'repo': 'acme/app', 'path': 'big.bin'})
    assert result['content'] is None
    assert 'Git blob read failed (GitHub API 403: nope [REDACTED] [REDACTED]' in result['message']
    dumped = json.dumps(result)
    assert SEAM_ACME not in dumped
    assert SEAM_BETA not in dumped


# ---------------------------------------------------------------------------
# A 401 to a cached installation token: dropped, re-minted and retried once
# ---------------------------------------------------------------------------


def _revoked(*bad):
    """An API answer that refuses the given bearers with 401, as GitHub does after an uninstall."""

    def answer(call):
        if call.bearer in bad:
            return response({'message': 'Bad credentials'}, 401)
        return response({'Python': 10})

    return answer


def _sequence(github, since):
    return [(c.method, c.path) for c in github.calls[since:]]


LANGUAGES = ('GET', '/repos/acme/api/languages')


def test_a_revoked_installation_token_is_dropped_and_the_call_retried_once(github, rsa_private_key_pem):
    github.installations = {'acme/api': 11}
    github.routes[LANGUAGES] = _revoked('ghs_fake_11_1')
    with real_node(app_config(rsa_private_key_pem)) as inst:
        inst.IGlobal.get_token('acme/api')
        since = len(github.calls)
        result = dispatch(inst, 'repo_languages', {'repo': 'acme/api'})
    assert result['status'] == 200
    assert _sequence(github, since) == [LANGUAGES, ('POST', '/app/installations/11/access_tokens'), LANGUAGES]
    assert [c.bearer for c in github.calls if (c.method, c.path) == LANGUAGES] == ['ghs_fake_11_1', 'ghs_fake_11_2']


@pytest.mark.parametrize('keeps_rejecting', [False, True])
def test_blob_401_refreshes_app_token_once_and_retains_metadata_on_failure(
    github, rsa_private_key_pem, keeps_rejecting
):
    github.installations = {'acme/api': 11}
    text = 'x' * 1_048_577
    metadata_path = '/repos/acme/api/contents/big.txt'
    blob_path = '/repos/acme/api/git/blobs/b1'
    github.routes[('GET', metadata_path)] = lambda call: response(
        {'path': 'big.txt', 'name': 'big.txt', 'sha': 'b1', 'size': len(text), 'encoding': 'none'}
    )

    def read_blob(call):
        if call.bearer == 'ghs_fake_11_1' or keeps_rejecting:
            return response({'message': f'Bad credentials {call.bearer}'}, 401)
        return response({'encoding': 'base64', 'content': base64.b64encode(text.encode()).decode()})

    github.routes[('GET', blob_path)] = read_blob
    with real_node(app_config(rsa_private_key_pem, readOnly=True)) as inst:
        result = dispatch(inst, 'file_get', {'repo': 'acme/api', 'path': 'big.txt'})
    assert result['found'] is True
    assert result['sha'] == 'b1'
    if keeps_rejecting:
        assert result['content'] is None
        assert result['status'] == 401
        assert 'Git blob read failed' in result['message']
    else:
        assert result['content'] == text
        assert 'message' not in result
    assert 'ghs_fake_' not in json.dumps(result)
    assert [call.bearer for call in github.requests_to(blob_path)] == ['ghs_fake_11_1', 'ghs_fake_11_2']
    assert len(github.requests_to(metadata_path)) == 2
    assert len(github.requests_to('/app/installations/11/access_tokens')) == 2


def test_blob_401_with_a_pat_keeps_metadata_without_retrying(github):
    github.routes[('GET', '/repos/acme/api/contents/big.txt')] = response(
        {'path': 'big.txt', 'sha': 'b1', 'size': 1_048_577, 'encoding': 'none'}
    )
    github.routes[('GET', '/repos/acme/api/git/blobs/b1')] = response({'message': 'Bad credentials'}, 401)
    with real_node({'token': SENTINEL_PAT, 'readOnly': True}) as inst:
        result = dispatch(inst, 'file_get', {'repo': 'acme/api', 'path': 'big.txt'})
    assert result['found'] is True
    assert result['content'] is None
    assert result['status'] == 401
    assert len(github.calls) == 2


def test_after_a_reinstall_the_401_leads_to_the_404_rule(github, rsa_private_key_pem):
    github.installations = {'acme/api': 11}
    github.routes[LANGUAGES] = _revoked('ghs_fake_11_1')
    with real_node(app_config(rsa_private_key_pem)) as inst:
        inst.IGlobal.get_token('acme/api')
        # The App was reinstalled: the old installation's tokens are revoked and it is gone.
        github.installations['acme/api'] = 12
        github.mint_missing = {'11'}
        since = len(github.calls)
        result = dispatch(inst, 'repo_languages', {'repo': 'acme/api'})
    assert result['status'] == 200
    assert _sequence(github, since) == [
        LANGUAGES,
        ('POST', '/app/installations/11/access_tokens'),
        ('GET', '/repos/acme/api/installation'),
        ('POST', '/app/installations/12/access_tokens'),
        LANGUAGES,
    ]
    assert github.bearer_for('/repos/acme/api/languages') == 'ghs_fake_12_1'


def test_two_calls_in_flight_with_the_same_revoked_token_are_both_retried(github, rsa_private_key_pem):
    github.installations = {'acme/app': 11}
    barrier = threading.Barrier(2)

    def answer(call):
        if call.bearer == 'ghs_fake_11_1':
            # Both calls carry the revoked token before either sees its 401.
            try:
                barrier.wait(timeout=2)
            except threading.BrokenBarrierError:
                pass
            return response({'message': 'Bad credentials'}, 401)
        return response({'Python': 1})

    github.routes[('GET', '/repos/acme/app/languages')] = answer
    statuses = {}
    with real_node(app_config(rsa_private_key_pem)) as inst:
        inst.IGlobal.get_token('acme/app')

        def run(name):
            statuses[name] = dispatch(inst, 'repo_languages', {'repo': 'acme/app'})['status']

        threads = [threading.Thread(target=run, args=(name,)) for name in ('a', 'b')]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
    assert statuses == {'a': 200, 'b': 200}
    # Each call ran twice: once with the revoked token, once with a fresh one.
    assert len(github.requests_to('/repos/acme/app/languages')) == 4


def _walk_routes(github, root_limits):
    """A truncated tree whose first read per token is rate-limited; its subtree refuses the first token."""
    reads = {}

    def root(call):
        reads[call.bearer] = reads.get(call.bearer, 0) + 1
        if reads[call.bearer] <= root_limits:
            return response({'message': 'secondary rate limit'}, 429, {'Retry-After': '4'})
        return response({'sha': 'commit-A', 'tree': [], 'truncated': True})

    def subtree(call):
        if call.bearer == 'ghs_fake_11_1':
            return response({'message': 'Bad credentials'}, 401)
        return response({'sha': 'commit-A', 'tree': [{'path': 'file', 'type': 'blob', 'sha': 'blob-A'}]})

    github.installations = {'acme/api': 11}
    github.routes[('GET', '/repos/acme/api/git/trees/HEAD')] = root
    github.routes[('GET', '/repos/acme/api/git/trees/commit-A')] = subtree


def test_the_retry_after_a_401_continues_the_calls_rate_limit_budget(github, rsa_private_key_pem):
    # The reviewer's shape: 429 (wait 4 s) -> success -> 401 -> retry with a fresh token -> 429.
    _walk_routes(github, root_limits=1)
    slept = []
    with real_node(app_config(rsa_private_key_pem, rateLimitBudgetSeconds=5)) as inst:
        from tool_github import github_client

        inst.IGlobal.retry_policy = github_client.RetryPolicy(budget_seconds=5, sleep=slept.append)
        result = dispatch(inst, 'repo_tree', {'repo': 'acme/api', 'walk': True})
    # The second 4 s wait does not fit the 1 s the first left: the call stops there.
    assert slept == [4.0]
    assert sum(slept) <= 5
    assert result['status'] == 429
    assert result['retry_after'] == 4
    assert 'more than the 1 s left of rateLimitBudgetSeconds' in result['message']
    # The retry did run with a fresh token.
    assert [call.bearer for call in github.requests_to('/repos/acme/api/git/trees/HEAD')] == [
        'ghs_fake_11_1',
        'ghs_fake_11_1',
        'ghs_fake_11_2',
    ]


def test_separate_tool_calls_get_separate_budgets(github, rsa_private_key_pem):
    github.installations = {'acme/api': 11}
    answers = []

    def languages(call):
        answers.append(call)
        if len(answers) % 2:
            return response({'message': 'secondary rate limit'}, 429, {'Retry-After': '4'})
        return response({'Python': 1})

    github.routes[('GET', '/repos/acme/api/languages')] = languages
    slept = []
    with real_node(app_config(rsa_private_key_pem)) as inst:
        from tool_github import github_client

        inst.IGlobal.retry_policy = github_client.RetryPolicy(budget_seconds=5, sleep=slept.append)
        first = dispatch(inst, 'repo_languages', {'repo': 'acme/api'})
        second = dispatch(inst, 'repo_languages', {'repo': 'acme/api'})
    # Each call waits its own 4 s of a 5 s budget.
    assert slept == [4.0, 4.0]
    assert first['status'] == second['status'] == 200


def test_a_second_401_is_returned_as_github_sent_it(github, rsa_private_key_pem):
    github.installations = {'acme/api': 11}
    github.routes[LANGUAGES] = _revoked('ghs_fake_11_1', 'ghs_fake_11_2')
    github.routes[('GET', '/repos/acme/api/issues/1')] = lambda call: response({'message': 'Bad credentials'}, 401)
    with real_node(app_config(rsa_private_key_pem)) as inst:
        inst.IGlobal.get_token('acme/api')
        since = len(github.calls)
        result = dispatch(inst, 'repo_languages', {'repo': 'acme/api'})
        assert result['status'] == 401
        assert result['message'] == 'Bad credentials'
        assert _sequence(github, since) == [LANGUAGES, ('POST', '/app/installations/11/access_tokens'), LANGUAGES]
        # A legacy tool raises the second 401, after the same single retry.
        since = len(github.calls)
        from tool_github.github_client import GitHubAPIError

        with pytest.raises(GitHubAPIError) as error:
            dispatch(inst, 'issue_get', {'repo': 'acme/api', 'issue_number': 1})
    assert error.value.status_code == 401
    assert _sequence(github, since) == [
        ('GET', '/repos/acme/api/issues/1'),
        ('POST', '/app/installations/11/access_tokens'),
        ('GET', '/repos/acme/api/issues/1'),
    ]


def test_a_401_with_a_token_the_node_cannot_replace_is_not_retried(github):
    github.routes[LANGUAGES] = _revoked(SENTINEL_PAT)
    with real_node({'token': SENTINEL_PAT}) as inst:
        result = dispatch(inst, 'repo_languages', {'repo': 'acme/api'})
    assert result['status'] == 401
    assert _sequence(github, 0) == [LANGUAGES]


def test_a_401_to_a_configured_installation_is_retried_with_a_fresh_token(github, rsa_private_key_pem):
    github.routes[LANGUAGES] = _revoked('ghs_fake_456_1')
    with real_node(app_config(rsa_private_key_pem, installationId='456')) as inst:
        result = dispatch(inst, 'repo_languages', {'repo': 'acme/api'})
    assert result['status'] == 200
    assert _sequence(github, 0) == [
        ('POST', '/app/installations/456/access_tokens'),
        LANGUAGES,
        ('POST', '/app/installations/456/access_tokens'),
        LANGUAGES,
    ]


# ---------------------------------------------------------------------------
# Repository shape, defaultRepo and installation_repos (review nits)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize('repo', ['acme/payments/', '/evil/x', 'acme//payments'])
def test_a_malformed_repository_never_picks_a_less_specific_entry(github, repo):
    credential_map = {'acme/payments': 'tok-exact', 'acme/*': 'tok-owner', 'evil/*': 'tok-evil', '*': 'tok-default'}
    with real_node({'credentialMap': credential_map}) as inst:
        from tool_github.credentials import BAD_REPOSITORY
        from tool_github.github_client import CredentialError

        with pytest.raises(CredentialError) as error:
            dispatch(inst, 'issue_get', {'repo': repo, 'issue_number': 1})
        assert str(error.value) == BAD_REPOSITORY
    assert github.calls == []


def test_a_malformed_organization_is_refused_before_matching(github):
    with real_node({'credentialMap': {'acme/*': 'tok-owner', '*': 'tok-default'}}) as inst:
        from tool_github.credentials import BAD_OWNER
        from tool_github.github_client import CredentialError

        with pytest.raises(CredentialError) as error:
            dispatch(inst, 'org_list_repos', {'org': 'acme/x'})
    assert str(error.value) == BAD_OWNER
    assert github.calls == []


def test_a_malformed_default_repo_does_not_break_a_pat(github):
    github.routes[('GET', '/user')] = response({'login': 'me', 'type': 'User'})
    github.routes[('POST', '/graphql')] = response({'data': {'viewer': {'login': 'me'}}})
    with real_node({'token': SENTINEL_PAT, 'defaultRepo': 'acme'}) as inst:
        assert dispatch(inst, 'user_get', {})['data'] == {'login': 'me', 'type': 'User'}
        assert dispatch(inst, 'graphql', {'query': 'query { viewer { login } }'})['status'] == 200


def test_a_malformed_default_repo_is_a_result_where_it_picks_the_credential(github):
    with real_node({'credentialMap': {'acme/*': 'tok-owner'}, 'defaultRepo': 'acme'}) as inst:
        from tool_github.credentials import BAD_REPOSITORY

        result = dispatch(inst, 'user_get', {})
    assert result['status'] is None
    assert result['message'] == BAD_REPOSITORY
    assert github.calls == []


def test_installation_repos_reads_the_installation_once_before_the_request(github, rsa_private_key_pem):
    github.installations = {'beta/web': 22}
    github.routes[('GET', '/installation/repositories')] = response({'total_count': 0, 'repositories': []})
    with real_node(app_config(rsa_private_key_pem)) as inst:
        reads = []
        original = inst.IGlobal.installation_id_for

        def counted(repo=None):
            reads.append(len(github.calls))
            return original(repo)

        inst.IGlobal.installation_id_for = counted
        result = dispatch(inst, 'installation_repos', {'repo': 'beta/web'})
    assert result['data']['installation_id'] == 22
    # Once, and before the listing request was sent.
    assert len(reads) == 1
    assert reads[0] < len(github.calls)
    assert github.calls[reads[0] :][-1].path == '/installation/repositories'


def test_a_transport_failure_in_a_legacy_call_never_quotes_the_header(monkeypatch):
    # requests refuses a header value with a line break and quotes it in its error.
    def prepare(method, url, headers=None, **kwargs):
        return requests.Request(method, url, headers=headers).prepare()

    monkeypatch.setattr(requests, 'request', prepare)
    from ._stubs import scoped_stubs

    with scoped_stubs():
        from tool_github.github_client import call

        with pytest.raises(ValueError) as error:
            call(f'{SENTINEL_PAT}\nsecond-half', 'GET', '/repos/acme/api')
    shown = f'{error.value} {error.value!r}'
    assert SENTINEL_PAT not in shown
    assert 'second-half' not in shown
    assert str(error.value) == 'GitHub request failed before an answer arrived. Check connectivity and retry.'
    assert error.value.__cause__ is None
    assert error.value.__context__ is None


# ---------------------------------------------------------------------------
# Every token a slot minted stays a secret (CodeRabbit), and the wrapper is the one layer
# ---------------------------------------------------------------------------


def test_a_dropped_token_and_its_replacement_are_both_redacted(github, rsa_private_key_pem):
    # mint, drop (GitHub answers 401), mint again: an answer echoing both must show neither.
    github.installations = {'acme/api': 11}

    def answer(call):
        if call.bearer == 'ghs_fake_11_1':
            return response({'message': 'Bad credentials'}, 401)
        return response({'echo': 'ghs_fake_11_1 and ghs_fake_11_2'})

    github.routes[LANGUAGES] = answer
    with real_node(app_config(rsa_private_key_pem)) as inst:
        inst.IGlobal.get_token('acme/api')
        result = dispatch(inst, 'repo_languages', {'repo': 'acme/api'})
        secrets = set(inst.IGlobal.secrets())
    assert result['status'] == 200
    assert result['data'] == {'echo': '[REDACTED] and [REDACTED]'}
    assert {'ghs_fake_11_1', 'ghs_fake_11_2'} <= secrets


def test_the_app_jwt_is_redacted_from_a_successful_result(github, rsa_private_key_pem):
    # Only the wrapper redacts a success body, and the JWT is not a stored secret: it is
    # noted as a token the call used.
    github.routes[('GET', '/app')] = lambda call: response({'slug': f'app-{call.bearer}'})
    with real_node(app_config(rsa_private_key_pem, installationId='456')) as inst:
        result = dispatch(inst, 'user_get', {})
    jwt_token = github.bearer_for('/app')
    assert result['data'] == {'login': 'app-[REDACTED]', 'type': 'App'}
    assert jwt_token not in json.dumps(result)


# ---------------------------------------------------------------------------
# One compiled pattern for every secret: the same output as the per-secret loop it replaced
# ---------------------------------------------------------------------------


def _redact_with_the_old_loop(value, secrets):
    """The per-secret replace loop the compiled pattern replaced, kept as the reference."""
    ordered = sorted({s for s in secrets if s}, key=len, reverse=True)

    def scrub(item):
        if isinstance(item, str):
            for secret in ordered:
                if secret in item:
                    item = item.replace(secret, '[REDACTED]')
            return item
        if isinstance(item, dict):
            return {scrub(k): scrub(v) for k, v in item.items()}
        if isinstance(item, list):
            return [scrub(v) for v in item]
        return item

    return scrub(value) if ordered else value


def test_many_secrets_over_many_strings_are_redacted_as_before():
    import random

    from ._stubs import scoped_stubs

    rng = random.Random(2592)
    # 150 tokens of distinct lengths, one of them containing another, plus PEM-like text
    # with characters a regular expression would read as syntax.
    secrets = [f'ghs_{rng.getrandbits(64 + 4 * n):x}{"x" * n}' for n in range(150)]
    secrets.append(secrets[10] + '-suffix')
    secrets.append('-----BEGIN KEY-----\n(a+b)*[c]?{d}|e.f$^\\\n-----END KEY-----')
    secrets += ['', '']

    def text(i):
        picks = [secrets[(i * 37 + k) % len(secrets)] for k in range(1 + i % 4)]
        return ' '.join([f'path/{i}', *picks, 'plain'])

    result = {
        'status': 200,
        'data': {
            'tree': [{'path': text(i), 'sha': f'{i:040x}', 'size': i, 'mode': '100644'} for i in range(5000)],
            text(5001): [text(5002), [text(5003), {text(5004): text(5005)}]],
        },
        'message': text(5006),
        # The longer secret that contains a shorter one must go whole.
        'overlap': f'{secrets[150]} then {secrets[10]} then {secrets[151]}',
    }
    with scoped_stubs():
        from tool_github import github_client

        redacted = github_client.redact_result(result, tuple(secrets))
        assert redacted == _redact_with_the_old_loop(result, tuple(secrets))
        assert redacted['overlap'] == '[REDACTED] then [REDACTED] then [REDACTED]'
        dumped = json.dumps(redacted)
        assert all(secret not in dumped for secret in secrets if secret)
        assert dumped.count('[REDACTED]') > 4000
        # The pattern is compiled once per secret set, not once per call.
        before = github_client._secret_pattern.cache_info()
        github_client.redact_result({'again': text(1)}, tuple(reversed(secrets)))
        assert github_client._secret_pattern.cache_info().hits == before.hits + 1
        assert github_client.redact_result(result, ()) is result
