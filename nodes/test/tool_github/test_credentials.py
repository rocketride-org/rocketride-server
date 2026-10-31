# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Credential resolution in IGlobal.

credentialMap parsing and matching, per-repository GitHub App installations and the
token cache per installation. Only HTTP is faked.
"""

import base64
import json
import types
from unittest.mock import Mock, patch

import pytest
import requests

from ._fake_github import FakeGitHub, app, app_config, claims, dispatch, real_node
from ._stubs import scoped_stubs

SENTINEL = 'ghp_sentinel_never_echo_2592pr3'


@pytest.fixture
def github(monkeypatch):
    fake = FakeGitHub()
    monkeypatch.setattr(requests, 'request', fake)
    return fake


def _begin_error(cfg) -> str:
    """The message beginGlobal raises for ``cfg``."""
    with scoped_stubs(cfg):
        from tool_github.IGlobal import IGlobal

        glb = IGlobal()
        glb.IEndpoint = types.SimpleNamespace(endpoint=types.SimpleNamespace(openMode='open'))
        glb.glb = types.SimpleNamespace(logicalType='tool_github', connConfig={})
        with pytest.raises(ValueError) as error:
            glb.beginGlobal()
        return str(error.value)


# ---------------------------------------------------------------------------
# credentialMap: matching
# ---------------------------------------------------------------------------

MAP = {'acme/payments': 'tok-exact', 'acme/*': 'tok-owner', '*': 'tok-default'}


@pytest.mark.parametrize('form', ['object', 'json-text'])
def test_map_precedence_exact_then_owner_then_default(github, form):
    raw = MAP if form == 'object' else json.dumps(MAP)
    with real_node({'credentialMap': raw}) as inst:
        glb = inst.IGlobal
        assert glb.get_token('acme/payments') == 'tok-exact'
        assert glb.get_token('acme/web') == 'tok-owner'
        assert glb.get_token('other/repo') == 'tok-default'
        assert glb.get_token(None) == 'tok-default'
        assert glb.get_token(owner='acme') == 'tok-owner'
        assert glb.get_token(owner='zeta') == 'tok-default'
    assert github.calls == []


def test_map_matching_ignores_case_like_github(github):
    with real_node({'credentialMap': {'Acme/Payments': 'tok-exact', 'ACME/*': 'tok-owner'}}) as inst:
        assert inst.IGlobal.get_token('acme/PAYMENTS') == 'tok-exact'
        assert inst.IGlobal.get_token('aCmE/other') == 'tok-owner'


@pytest.mark.parametrize(
    ('call', 'named'),
    [
        ({'repo': 'other/repo'}, 'other/repo'),
        ({'owner': 'zeta'}, 'zeta'),
        ({}, 'a call without a repository'),
    ],
)
def test_no_match_without_default_names_the_repository_never_the_map(github, call, named):
    with real_node({'credentialMap': {'acme/*': SENTINEL, 'acme/payments': 'tok-exact'}}) as inst:
        from tool_github.github_client import CredentialError

        with pytest.raises(CredentialError) as error:
            inst.IGlobal.get_token(call.get('repo'), owner=call.get('owner'))
    message = str(error.value)
    assert named in message
    assert SENTINEL not in message
    assert 'acme' not in message
    assert 'tok-exact' not in message


# ---------------------------------------------------------------------------
# credentialMap: validated at pipeline start
# ---------------------------------------------------------------------------


@pytest.mark.parametrize('key', ['acme', 'acme/*/x', '*/repo', 'ac me/x', '../x', 'acme/..', '', SENTINEL, 'a/b/c'])
def test_bad_map_key_fails_at_start_naming_its_position_not_its_text(key):
    message = _begin_error({'credentialMap': {'acme/*': 'tok', key: 'tok-2'}})
    assert message == (
        'tool_github: credentialMap key 2 is not a repository (owner/repo), an owner entry '
        '(the owner, a slash and an asterisk) or the default entry (a single asterisk)'
    )
    if key:
        assert key not in message.split('key 2', 1)[1]
    assert 'tok-2' not in message


@pytest.mark.parametrize(
    ('value', 'expected'),
    [
        ('', 'must be a non-empty token'),
        (f'{SENTINEL} trailing', 'must be a non-empty token without spaces or line breaks'),
        (5, 'must be a token string or an object'),
        (None, 'must be a token string or an object'),
        ([SENTINEL], 'must be a token string or an object'),
        ({'appId': '1'}, 'private key required for GitHub App auth'),
        ({'privateKey': 'x'}, 'App ID required for GitHub App auth'),
        ({'appId': '1', 'privateKey': SENTINEL, 'installationID': '5'}, 'has 1 unknown field(s)'),
        ({'appId': '1', 'privateKey': 'x', SENTINEL: '5', 'other': 1}, 'has 2 unknown field(s)'),
        ({'appId': True, 'privateKey': SENTINEL}, ': appId must be a string or a number'),
        ({'appId': '1', 'privateKey': 5}, ': privateKey must be a string'),
        (
            {'appId': '1', 'privateKey': SENTINEL, 'installationId': 4.5},
            ': installationId must be a string or a number',
        ),
    ],
)
def test_bad_map_value_fails_at_start_without_echoing_it(value, expected):
    message = _begin_error({'credentialMap': {'acme/*': value}})
    assert message.startswith('tool_github: the credentialMap entry for owner acme')
    if expected:
        assert expected in message
    assert SENTINEL not in message


def test_a_token_with_a_trailing_line_break_is_trimmed(github):
    with real_node({'credentialMap': {'*': f'{SENTINEL}\n'}}) as inst:
        assert inst.IGlobal.get_token('a/b') == SENTINEL


def test_non_numeric_installation_id_in_the_map_fails_at_start(rsa_private_key_pem):
    message = _begin_error({'credentialMap': {'acme/*': app(rsa_private_key_pem, installation_id='12x')}})
    assert message == (
        'tool_github: the credentialMap entry for owner acme: installation ID must be numeric for GitHub App auth'
    )


@pytest.mark.parametrize(
    ('key', 'expected'),
    [
        ('not a pem', 'invalid GitHub App private key'),
        ('ec', 'must be an RSA key'),
        ('data:application/x-pem-file;base64,QUJDRA', 'invalid GitHub App private key upload'),
    ],
)
def test_bad_private_key_in_the_map_fails_at_start(rsa_private_key_pem, ec_private_key_pem, key, expected):
    pem = ec_private_key_pem if key == 'ec' else key
    message = _begin_error({'credentialMap': {'*': 'tok', 'beta/*': app(pem)}})
    assert message.startswith('tool_github: the credentialMap entry for owner beta: ')
    assert expected in message
    assert '-----BEGIN' not in message


def test_map_private_key_upload_is_decoded_like_the_node_key(github, rsa_private_key_pem):
    upload = 'data:application/x-pem-file;base64,' + base64.b64encode(rsa_private_key_pem.encode()).decode()
    with real_node({'credentialMap': {'acme/*': app(upload, installation_id='5')}}) as inst:
        inst.IGlobal.get_token('acme/x')
        assert claims(github.bearer_for('/app/installations/5/access_tokens'), rsa_private_key_pem)['iss'] == '111'
        secrets = inst.IGlobal.secrets()
    assert upload in secrets
    assert rsa_private_key_pem in secrets


def test_map_json_text_that_does_not_parse_fails_without_echoing_it():
    message = _begin_error({'credentialMap': '{"acme/*": ' + SENTINEL + '}'})
    assert message == 'tool_github: credentialMap is not valid JSON (line 1, column 12)'


@pytest.mark.parametrize('raw', [[SENTINEL], '["acme/*"]', 7])
def test_map_that_is_not_an_object_fails_at_start(raw):
    message = _begin_error({'credentialMap': raw})
    assert 'credentialMap must be a JSON object' in message
    assert SENTINEL not in message


@pytest.mark.parametrize(
    ('raw', 'expected'),
    [
        ('${ROCKETRIDE_GITHUB_MAP}', 'credentialMap is set to ${ROCKETRIDE_GITHUB_MAP}, but no variable'),
        ({'acme/*': '${ROCKETRIDE_ACME_TOKEN}'}, 'entry for owner acme is set to ${ROCKETRIDE_ACME_TOKEN}, but no'),
        ({'acme/*': {'appId': '1', 'privateKey': '${ROCKETRIDE_KEY}'}}, 'entry for owner acme: privateKey is set to'),
        ({'*': 'pre-${ROCKETRIDE_TOKEN}'}, 'default entry uses the placeholder ${ROCKETRIDE_TOKEN}, but no'),
        ({'acme/*': '<REDACTED>'}, 'does not start with ROCKETRIDE_'),
    ],
)
def test_unfilled_placeholders_fail_at_start_naming_the_variable(raw, expected):
    message = _begin_error({'credentialMap': raw})
    assert expected in message
    assert 'user-owned run' in message or 'ROCKETRIDE_<name>' in message


@pytest.mark.parametrize(
    ('node', 'fields'),
    [
        ({'token': SENTINEL}, 'token'),
        ({'authType': 'app', 'appId': '1', 'privateKey': SENTINEL}, 'appId, privateKey'),
    ],
)
def test_a_map_default_and_a_node_credential_together_fail_at_start(node, fields):
    message = _begin_error({**node, 'credentialMap': {'acme/*': 'tok-acme', '*': 'tok-default'}})
    assert message == (
        f'tool_github: credentialMap has a default entry and the node has its own credential ({fields}); '
        f'remove one of them: the default entry from credentialMap, or {fields} from the node settings'
    )
    assert SENTINEL not in message


def test_the_node_token_is_the_default_when_the_map_has_no_star(github):
    with real_node({'token': SENTINEL, 'credentialMap': {'acme/*': 'tok-acme'}}) as inst:
        glb = inst.IGlobal
        assert glb.get_token('acme/api') == 'tok-acme'
        assert glb.get_token('other/repo') == SENTINEL
        assert glb.get_token(None) == SENTINEL
        assert glb.get_token(owner='zeta') == SENTINEL
        assert glb.auth_type_for('other/repo') == 'pat'
        assert {SENTINEL, 'tok-acme'} <= set(glb.secrets())
    assert github.calls == []


def test_the_node_app_is_the_default_when_the_map_has_no_star(github, rsa_private_key_pem):
    github.installations = {'beta/web': 22}
    with real_node({**app_config(rsa_private_key_pem), 'credentialMap': {'acme/*': 'tok-acme'}}) as inst:
        assert inst.IGlobal.get_token('acme/api') == 'tok-acme'
        assert inst.IGlobal.get_token('beta/web') == 'ghs_fake_22_1'
        assert inst.IGlobal.auth_type_for('beta/web') == 'app'
    assert claims(github.bearer_for('/repos/beta/web/installation'), rsa_private_key_pem)['iss'] == '111'


def test_with_a_map_an_incomplete_node_credential_still_fails_at_start():
    message = _begin_error({'authType': 'app', 'installationId': '5', 'credentialMap': {'acme/*': 'tok'}})
    assert message == 'tool_github: App ID, private key required for GitHub App auth'


def _begin_and_warning(cfg) -> tuple[str, list[str]]:
    """The beginGlobal error and the validateConfig warnings for ``cfg``."""
    message = _begin_error(cfg)
    with scoped_stubs(cfg):
        from tool_github.IGlobal import IGlobal, warning

        glb = IGlobal()
        glb.glb = types.SimpleNamespace(logicalType='tool_github', connConfig={})
        glb.validateConfig()
        warnings = [str(call.args[0]) for call in warning.call_args_list]
    return message, warnings


INCOMPLETE = 'has a "${" that does not start a complete ${ROCKETRIDE_<name>} placeholder'


@pytest.mark.parametrize('form', ['object', 'json-text'])
@pytest.mark.parametrize('after', ['token', 'pem'])
def test_an_unterminated_placeholder_never_prints_what_follows(rsa_private_key_pem, form, after):
    following = {'*': SENTINEL} if after == 'token' else {'beta/*': app(rsa_private_key_pem, '1', '5')}
    credential_map = {'acme/*': '${ROCKETRIDE_A', **following}
    raw = credential_map if form == 'object' else json.dumps(credential_map)
    message, warnings = _begin_and_warning({'credentialMap': raw})
    assert (
        message
        == f'tool_github: the credentialMap entry for owner acme {INCOMPLETE} (only ROCKETRIDE_ variables resolve); check the braces and the variable name'
    )
    assert warnings == [message]
    body = rsa_private_key_pem.split('\n')[1]
    for text in (message, *warnings):
        assert SENTINEL not in text
        assert body not in text
        assert 'BEGIN' not in text


@pytest.mark.parametrize(
    'value', ['${ROCKETRIDE_A', '${not a name}', '${ROCKETRIDE-X}', '${}', f'{SENTINEL}${{', '${ghp_secret_look}']
)
def test_any_other_dollar_brace_is_refused_without_the_value(value):
    message, warnings = _begin_and_warning({'credentialMap': {'*': value, 'x/y': SENTINEL}})
    assert message.startswith(f'tool_github: the credentialMap default entry {INCOMPLETE}')
    assert warnings == [message]
    assert SENTINEL not in message
    assert 'ghp_secret_look' not in message


def test_an_unterminated_placeholder_in_an_app_field_is_refused(rsa_private_key_pem):
    entry = {'appId': '${ROCKETRIDE_APP', 'privateKey': rsa_private_key_pem}
    message, _ = _begin_and_warning({'credentialMap': {'acme/api': entry}})
    assert message.startswith(f'tool_github: the credentialMap entry for acme/api: appId {INCOMPLETE}')
    assert 'BEGIN' not in message


def test_a_whole_map_text_that_is_not_json_names_only_a_line_and_column():
    message, warnings = _begin_and_warning({'credentialMap': '${ROCKETRIDE_A {"*": "' + SENTINEL + '"}'})
    assert message == 'tool_github: credentialMap is not valid JSON (line 1, column 1)'
    assert warnings == [message]


def test_placeholders_inside_a_map_given_as_json_text_say_they_are_not_resolved():
    # The variable held the whole map; its own placeholders were never scanned again.
    raw = json.dumps({'acme/*': '${ROCKETRIDE_PAYMENTS}', '*': 'literal-token'})
    message, _ = _begin_and_warning({'credentialMap': raw})
    assert message.startswith(
        'tool_github: the credentialMap entry for owner acme still holds the placeholder ${ROCKETRIDE_PAYMENTS}. '
        'Placeholders inside a credentialMap given as JSON text'
    )
    assert 'literal-token' not in message


@pytest.mark.parametrize('token', [f'{SENTINEL}\nsecond-half', f'{SENTINEL} second-half', f'{SENTINEL}\tsecond-half'])
def test_a_node_token_with_inner_whitespace_fails_at_start_without_the_token(token):
    message, warnings = _begin_and_warning({'token': token})
    assert message == 'tool_github: token must not contain spaces or line breaks'
    assert warnings == [message]
    assert SENTINEL not in message
    assert 'second-half' not in message


def test_a_map_token_with_a_line_break_fails_at_start_without_the_token():
    message = _begin_error({'credentialMap': {'acme/api': f'{SENTINEL}\nsecond-half'}})
    assert message == (
        'tool_github: the credentialMap entry for acme/api must be a non-empty token without spaces or line breaks'
    )


def test_unknown_app_fields_are_counted_never_named(rsa_private_key_pem):
    entry = {'appId': '1', 'privateKey': rsa_private_key_pem, SENTINEL: 'x', 'installationID': '5'}
    message = _begin_error({'credentialMap': {'acme/api': entry}})
    assert message == (
        'tool_github: the credentialMap entry for acme/api has 2 unknown field(s); '
        'expected appId, privateKey and an optional installationId'
    )


def test_concurrent_calls_share_one_token_per_installation(github, rsa_private_key_pem):
    import threading

    github.installations = {'acme/api': 11}
    github.mint_delay = 0.05
    tokens = []
    with real_node(app_config(rsa_private_key_pem)) as inst:
        threads = [threading.Thread(target=lambda: tokens.append(inst.IGlobal.get_token('acme/api'))) for _ in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
    assert tokens == ['ghs_fake_11_1'] * 8
    # One token for the installation; racing lookups are allowed and harmless.
    assert len(github.requests_to('/app/installations/11/access_tokens')) == 1
    assert 1 <= len(github.requests_to('/repos/acme/api/installation')) <= 8


def test_keys_that_differ_only_in_case_fail_at_start():
    message = _begin_error({'credentialMap': {'Acme/*': 'tok-1', 'acme/*': 'tok-2'}})
    assert message == 'tool_github: the credentialMap entry for owner acme appears twice (keys are not case sensitive)'


@pytest.mark.parametrize('raw', ['', '   ', {}, None, '{}'])
def test_an_empty_map_means_the_node_credential(github, raw):
    assert _begin_error({'credentialMap': raw}) == 'tool_github: token is required'
    with real_node({'credentialMap': raw, 'token': 'ghp_node'}) as inst:
        assert inst.IGlobal.credential_map is None
        assert inst.IGlobal.get_token('a/b') == 'ghp_node'


def test_validate_config_warns_with_the_start_message_without_raising():
    with scoped_stubs({'credentialMap': {'acme': SENTINEL}}):
        from tool_github.IGlobal import IGlobal, warning

        glb = IGlobal()
        glb.glb = types.SimpleNamespace(logicalType='tool_github', connConfig={})
        glb.validateConfig()
        messages = [call.args[0] for call in warning.call_args_list]
    assert len(messages) == 1
    assert messages[0].startswith('tool_github: credentialMap key 1 is not a repository (owner/repo)')


# ---------------------------------------------------------------------------
# GitHub App without installationId: the installation per repository
# ---------------------------------------------------------------------------


def test_app_without_installation_id_starts_without_a_request(github, rsa_private_key_pem):
    with real_node(app_config(rsa_private_key_pem)) as inst:
        assert inst.IGlobal.installation_id == ''
    assert github.calls == []


def test_installation_is_found_per_repository_across_organizations_and_cached(github, rsa_private_key_pem):
    github.installations = {'acme/api': 11, 'beta/web': 22}
    with real_node(app_config(rsa_private_key_pem)) as inst:
        glb = inst.IGlobal
        assert glb.get_token('acme/api') == 'ghs_fake_11_1'
        assert glb.get_token('beta/web') == 'ghs_fake_22_1'
        assert [(c.method, c.path) for c in github.calls] == [
            ('GET', '/repos/acme/api/installation'),
            ('POST', '/app/installations/11/access_tokens'),
            ('GET', '/repos/beta/web/installation'),
            ('POST', '/app/installations/22/access_tokens'),
        ]
        # The lookups are signed with the App JWT, never a token.
        for call in github.requests_to('/repos/'):
            assert claims(call.bearer, rsa_private_key_pem)['iss'] == '111'
        # Cache hits: same repository (any case), and the installation ID for it.
        assert glb.get_token('acme/api') == 'ghs_fake_11_1'
        assert glb.get_token('ACME/Api') == 'ghs_fake_11_1'
        assert glb.installation_id_for('beta/web') == '22'
        assert len(github.calls) == 4


def test_two_repositories_of_one_installation_share_its_token(github, rsa_private_key_pem):
    github.installations = {'acme/api': 11, 'acme/web': 11}
    with real_node(app_config(rsa_private_key_pem)) as inst:
        assert inst.IGlobal.get_token('acme/api') == inst.IGlobal.get_token('acme/web') == 'ghs_fake_11_1'
    assert len(github.requests_to('/app/installations/11/')) == 1
    assert len(github.requests_to('/repos/')) == 2


def test_app_not_installed_names_the_repository_and_is_looked_up_again(github, rsa_private_key_pem):
    with real_node(app_config(rsa_private_key_pem)) as inst:
        from tool_github.github_client import CredentialError

        for _ in range(2):
            with pytest.raises(CredentialError, match='The GitHub App is not installed on gamma/tool') as error:
                inst.IGlobal.get_token('gamma/tool')
            assert 'eyJ' not in str(error.value)
        github.installations['gamma/tool'] = 33
        assert inst.IGlobal.get_token('gamma/tool') == 'ghs_fake_33_1'
    assert len(github.requests_to('/repos/gamma/tool/installation')) == 3


@pytest.mark.parametrize(
    ('failure', 'expected'),
    [
        (401, 'GitHub rejected the GitHub App credential (HTTP 401) while finding the installation for acme/api'),
        (500, 'GitHub answered HTTP 500 while finding the GitHub App installation for acme/api'),
        ('transport', 'Could not reach GitHub to find the GitHub App installation for acme/api'),
        ('body', 'GitHub returned an unexpected answer while finding the GitHub App installation for acme/api'),
    ],
)
def test_installation_lookup_failures_name_the_repository_never_the_jwt(
    monkeypatch, github, rsa_private_key_pem, failure, expected
):
    if failure == 'transport':
        monkeypatch.setattr(requests, 'request', Mock(side_effect=requests.ConnectionError('dns down')))
    elif failure == 'body':
        github.routes[('GET', '/repos/acme/api/installation')] = None
        github.installations['acme/api'] = 'not-an-id'
    else:
        github.lookup_status = failure
    with real_node(app_config(rsa_private_key_pem)) as inst:
        from tool_github.github_client import CredentialError

        with pytest.raises(CredentialError) as error:
            inst.IGlobal.get_token('acme/api')
    assert str(error.value).startswith(expected)
    assert 'eyJ' not in str(error.value)
    assert 'refused' not in str(error.value)


@pytest.mark.parametrize('call', [{}, {'owner': 'acme'}])
def test_a_call_without_a_repository_needs_an_installation_id(github, rsa_private_key_pem, call):
    with real_node(app_config(rsa_private_key_pem)) as inst:
        from tool_github.credentials import NO_ORGANIZATION_INSTALLATION, NO_REPOSITORY
        from tool_github.github_client import CredentialError

        with pytest.raises(CredentialError) as error:
            inst.IGlobal.get_token(None, owner=call.get('owner'))
    # An organization call cannot be helped by defaultRepo, so its message does not suggest it.
    assert str(error.value) == (NO_ORGANIZATION_INSTALLATION if call else NO_REPOSITORY)
    assert ('defaultRepo' in str(error.value)) is not bool(call)
    assert github.calls == []


@pytest.mark.parametrize(
    'repo', ['acme/api/../../evil/x', 'acme', 'acme/api?x=1', '../acme/api', 'acme/api/', '/acme/api', 'acme//api']
)
def test_a_malformed_repository_is_refused_before_the_lookup(github, rsa_private_key_pem, repo):
    with real_node(app_config(rsa_private_key_pem)) as inst:
        from tool_github.credentials import BAD_REPOSITORY
        from tool_github.github_client import CredentialError

        with pytest.raises(CredentialError) as error:
            inst.IGlobal.get_token(repo)
    assert str(error.value) == BAD_REPOSITORY
    assert github.calls == []


def test_a_configured_installation_id_is_used_without_a_lookup(github, rsa_private_key_pem):
    with real_node(app_config(rsa_private_key_pem, installationId='456')) as inst:
        assert inst.IGlobal.get_token('acme/api') == 'ghs_fake_456_1'
        assert inst.IGlobal.get_token('beta/web') == 'ghs_fake_456_1'
        assert inst.IGlobal.get_token() == 'ghs_fake_456_1'
    assert [c.path for c in github.calls] == ['/app/installations/456/access_tokens']


def test_map_app_entries_find_installations_with_their_own_app(github, rsa_private_key_pem):
    github.installations = {'beta/web': 22}
    credential_map = {'acme/*': app(rsa_private_key_pem, '111', '5'), 'beta/*': app(rsa_private_key_pem, '222')}
    with real_node({'credentialMap': credential_map}) as inst:
        assert inst.IGlobal.get_token('acme/api') == 'ghs_fake_5_1'
        assert inst.IGlobal.get_token('beta/web') == 'ghs_fake_22_1'
    assert claims(github.bearer_for('/app/installations/5/access_tokens'), rsa_private_key_pem)['iss'] == '111'
    assert claims(github.bearer_for('/repos/beta/web/installation'), rsa_private_key_pem)['iss'] == '222'
    assert claims(github.bearer_for('/app/installations/22/access_tokens'), rsa_private_key_pem)['iss'] == '222'


@pytest.mark.parametrize('line_breaks', ['escaped', 'raw'])
def test_map_app_entries_given_as_json_text_work_like_objects(github, rsa_private_key_pem, line_breaks):
    # The canvas form edits every value as text, so an App entry arrives as its JSON text. A
    # placeholder resolved into it puts the PEM's line breaks in the string as they are.
    github.installations = {'beta/web': 22}
    text = json.dumps(app(rsa_private_key_pem, '222'))
    if line_breaks == 'raw':
        text = text.replace('\\n', '\n')
        assert '\n' in text
    credential_map = {'acme/*': json.dumps(app(rsa_private_key_pem, '111', '5')), 'beta/*': text}
    with real_node({'credentialMap': credential_map}) as inst:
        assert inst.IGlobal.get_token('acme/api') == 'ghs_fake_5_1'
        assert inst.IGlobal.get_token('beta/web') == 'ghs_fake_22_1'
    assert claims(github.bearer_for('/app/installations/22/access_tokens'), rsa_private_key_pem)['iss'] == '222'


@pytest.mark.parametrize(
    ('value', 'expected'),
    [
        (
            '{"appId": "1", "privateKey": ' + SENTINEL,
            'the credentialMap entry for owner acme is not valid JSON (line 1',
        ),
        ('{"appId": "1", "extra": "' + SENTINEL + '"}', 'has 1 unknown field(s)'),
    ],
    ids=['not-json', 'unknown-field'],
)
def test_a_bad_app_entry_given_as_json_text_fails_at_start_without_echoing_it(value, expected):
    message = _begin_error({'credentialMap': {'acme/*': value}})
    assert expected in message
    assert SENTINEL not in message


def test_services_json_lets_the_canvas_edit_the_map_as_entries_of_masked_text():
    # RJSF picks the first member of a type list; ["object", "string"] rendered no controls at all.
    from pathlib import Path

    text = (Path(__file__).resolve().parents[2] / 'src' / 'nodes' / 'tool_github' / 'services.json').read_text(
        encoding='utf-8'
    )
    services = json.loads('\n'.join(line for line in text.splitlines() if not line.lstrip().startswith('//')))
    field = services['fields']['github.credentialMap']
    assert field['type'] == 'object'
    assert field['additionalProperties'] == {'type': 'string'}
    assert field['default'] == {}
    assert field['secure'] is True
    assert field['ui'] == {'additionalProperties': {'ui:widget': 'ApiKeyWidget'}}
    assert services['preconfig']['profiles']['default']['credentialMap'] == {}


# ---------------------------------------------------------------------------
# A cached installation GitHub no longer knows: looked up once more
# ---------------------------------------------------------------------------


def _expired_tokens(github):
    """Every minted token is already expired, so each call mints again."""
    github.expires_in = -10


def test_a_cached_installation_github_no_longer_knows_is_looked_up_once_more(github, rsa_private_key_pem):
    _expired_tokens(github)
    github.installations = {'acme/api': 11}
    with real_node(app_config(rsa_private_key_pem)) as inst:
        assert inst.IGlobal.get_token('acme/api') == 'ghs_fake_11_1'
        # The App was reinstalled: the old installation is gone and the repository has a new one.
        github.installations['acme/api'] = 12
        github.mint_missing = {'11'}
        assert inst.IGlobal.get_token('acme/api') == 'ghs_fake_12_1'
        assert inst.IGlobal.installation_id_for('acme/api') == '12'
    assert [(c.method, c.path) for c in github.calls] == [
        ('GET', '/repos/acme/api/installation'),
        ('POST', '/app/installations/11/access_tokens'),
        ('POST', '/app/installations/11/access_tokens'),
        ('GET', '/repos/acme/api/installation'),
        ('POST', '/app/installations/12/access_tokens'),
    ]


def test_a_second_404_is_a_structured_error_and_the_installation_is_forgotten(github, rsa_private_key_pem):
    _expired_tokens(github)
    github.installations = {'acme/api': 11}
    with real_node(app_config(rsa_private_key_pem)) as inst:
        from tool_github.github_client import CredentialError

        inst.IGlobal.get_token('acme/api')
        github.mint_missing = {'11'}
        with pytest.raises(CredentialError) as error:
            inst.IGlobal.get_token('acme/api')
        assert str(error.value).startswith('GitHub no longer has the GitHub App installation found for acme/api')
        # The envelope tools return it as a result naming the repository.
        result = dispatch(inst, 'repo_languages', {'repo': 'acme/api'})
        assert result['status'] is None
        assert result['message'].startswith('GitHub no longer has the GitHub App installation found for acme/api')
        assert not github.requests_to('/repos/acme/api/languages')
        # Forgotten: once the App is installed again, the next call starts with a fresh lookup.
        github.installations['acme/api'] = 12
        before = len(github.calls)
        assert inst.IGlobal.get_token('acme/api') == 'ghs_fake_12_1'
    assert [(c.method, c.path) for c in github.calls[before:]] == [
        ('GET', '/repos/acme/api/installation'),
        ('POST', '/app/installations/12/access_tokens'),
    ]


def test_a_404_right_after_a_fresh_lookup_is_not_looked_up_again(github, rsa_private_key_pem):
    github.installations = {'acme/api': 11}
    github.mint_missing = {'11'}
    with real_node(app_config(rsa_private_key_pem)) as inst:
        from tool_github.github_client import CredentialError

        with pytest.raises(CredentialError, match='no longer has the GitHub App installation found for acme/api'):
            inst.IGlobal.get_token('acme/api')
    assert len(github.requests_to('/repos/acme/api/installation')) == 1


def test_a_configured_installation_404_keeps_githubs_error_without_a_lookup(github, rsa_private_key_pem):
    github.mint_missing = {'456'}
    with real_node(app_config(rsa_private_key_pem, installationId='456')) as inst:
        from tool_github.github_client import CredentialError, GitHubAPIError

        with pytest.raises(GitHubAPIError) as error:
            inst.IGlobal.get_token('acme/api')
    assert not isinstance(error.value, CredentialError)
    assert error.value.status_code == 404
    assert not github.requests_to('/repos/')


# ---------------------------------------------------------------------------
# Token cache per installation, with the early-refresh margin
# ---------------------------------------------------------------------------


def test_tokens_are_cached_and_refreshed_per_installation(rsa_private_key_pem):
    with scoped_stubs(app_config(rsa_private_key_pem)):
        from tool_github.IGlobal import IGlobal

        glb = IGlobal()
        glb.IEndpoint = types.SimpleNamespace(endpoint=types.SimpleNamespace(openMode='open'))
        glb.glb = types.SimpleNamespace(logicalType='tool_github', connConfig={})
        glb.beginGlobal()
        installations = {'acme/api': '11', 'beta/web': '22'}
        expiries = {'11': [2000.0, 5000.0], '22': [3000.0]}
        minted = []

        def mint(app_id, pem, installation):
            minted.append(installation)
            return f'tok-{installation}-{len(minted)}', expiries[installation].pop(0)

        with (
            patch(
                'tool_github.credentials.github_client.find_repo_installation',
                side_effect=lambda a, p, r: installations[r],
            ),
            patch('tool_github.credentials.github_client.mint_installation_token', side_effect=mint),
            patch('tool_github.credentials.time.time') as clock,
        ):
            clock.return_value = 1000.0
            assert glb.get_token('acme/api') == 'tok-11-1'
            assert glb.get_token('beta/web') == 'tok-22-2'
            # t=1500: both cached.
            clock.return_value = 1500.0
            assert glb.get_token('acme/api') == 'tok-11-1'
            assert glb.get_token('beta/web') == 'tok-22-2'
            assert minted == ['11', '22']
            # t=1945: within 60 s of installation 11's expiry (2000) only.
            clock.return_value = 1945.0
            assert glb.get_token('acme/api') == 'tok-11-3'
            assert glb.get_token('beta/web') == 'tok-22-2'
            assert minted == ['11', '22', '11']
            # The replaced token stays a secret: a request may still carry it.
            assert {'tok-11-1', 'tok-11-3', 'tok-22-2'} <= set(glb.secrets())


def test_two_refreshes_keep_every_token_a_secret(rsa_private_key_pem):
    with scoped_stubs(app_config(rsa_private_key_pem, installationId='456')):
        from tool_github.IGlobal import IGlobal

        glb = IGlobal()
        glb.IEndpoint = types.SimpleNamespace(endpoint=types.SimpleNamespace(openMode='open'))
        glb.glb = types.SimpleNamespace(logicalType='tool_github', connConfig={})
        glb.beginGlobal()
        expiries = iter([2000.0, 3000.0, 4000.0])
        minted = []

        def mint(app_id, pem, installation):
            minted.append(f'tok-{len(minted) + 1}')
            return minted[-1], next(expiries)

        with (
            patch('tool_github.credentials.github_client.mint_installation_token', side_effect=mint),
            patch('tool_github.credentials.time.time') as clock,
        ):
            for now in (1000.0, 1945.0, 2945.0):
                clock.return_value = now
                glb.get_token()
        assert minted == ['tok-1', 'tok-2', 'tok-3']
        # Both replaced tokens may still be in flight: they stay secrets.
        assert {'tok-1', 'tok-2', 'tok-3'} <= set(glb.secrets())


def test_a_slot_keeps_its_last_64_tokens_for_redaction():
    with scoped_stubs():
        from tool_github.credentials import MINTED_KEPT, _TokenSlot

        slot = _TokenSlot()
        for number in range(MINTED_KEPT + 6):
            slot.drop(slot.token)
            slot.get(lambda number=number: (f'tok-{number}', 9e9))
    assert MINTED_KEPT == 64
    assert len(slot.minted) == 64
    assert slot.minted[0] == 'tok-6'
    assert slot.minted[-1] == f'tok-{MINTED_KEPT + 5}'


def test_map_entries_keep_their_own_token_caches(github, rsa_private_key_pem):
    credential_map = {'acme/*': app(rsa_private_key_pem, '111', '5'), 'beta/*': app(rsa_private_key_pem, '111', '5')}
    with real_node({'credentialMap': credential_map}) as inst:
        inst.IGlobal.get_token('acme/api')
        inst.IGlobal.get_token('acme/web')
        inst.IGlobal.get_token('beta/web')
        inst.IGlobal.get_token('beta/api')
    # One token per entry, each reused within its entry.
    assert len(github.requests_to('/app/installations/5/access_tokens')) == 2


def test_secrets_cover_every_credential_and_minted_token(github, rsa_private_key_pem):
    github.installations = {'beta/web': 22}
    credential_map = {'acme/payments': SENTINEL, 'beta/*': app(rsa_private_key_pem, '222'), '*': 'tok-default'}
    with real_node({'credentialMap': credential_map}) as inst:
        inst.IGlobal.get_token('beta/web')
        secrets = set(inst.IGlobal.secrets())
    assert {SENTINEL, 'tok-default', rsa_private_key_pem.strip(), 'ghs_fake_22_1'} <= secrets
    assert '' not in secrets
