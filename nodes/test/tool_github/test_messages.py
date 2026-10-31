# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""No message text the node supplies contains '*': the engine splits error text on it.

The engine writes an error as ``code*message*location`` (engLib/monitor/App.hpp) and the
shell splits it with ``split('*')``, so an asterisk in a message cuts it short in the UI
(the rule in ai/common/config.py, checked by test_credential_resolved.py). Two scans:

- every string literal the node's source passes to an exception, a failure result, a
  warning or a walk stop, or assigns to a result's ``message``, and every module-level
  message constant;
- every message the credential, configuration and new-tool paths actually produce, for
  inputs full of asterisks (wildcard map keys, ``tools: ["*"]``, ``authType: "*"``).

GitHub's own error text is passed on as GitHub sent it and is not the node's to change.
Neither is the caller's input that two legacy messages repeat (``file_get`` and
``file_list`` name the path they were given), which is develop's code.
"""

import ast
import json
import types
from pathlib import Path

import pytest
import requests

from ._fake_github import FakeGitHub, app, app_config, dispatch, real_node
from ._stubs import scoped_stubs

NODE = Path(__file__).resolve().parents[2] / 'src' / 'nodes' / 'tool_github'
MESSAGE_CALLS = {
    'ValueError',
    'CredentialError',
    'UnsafePathError',
    'GitHubAPIError',
    'RateLimitExhausted',
    'RateLimitError',
    '_WalkStopped',
    'failure_result',
    'shape_failure',
    'warning',
}


def _literals(node):
    for child in ast.walk(node):
        if isinstance(child, ast.Constant) and isinstance(child.value, str):
            yield child.value


def _messages_in_source():
    for path in sorted(NODE.glob('*.py')):
        tree = ast.parse(path.read_text(encoding='utf-8'))
        for node in ast.walk(tree):
            if isinstance(node, ast.Call):
                name = node.func.id if isinstance(node.func, ast.Name) else getattr(node.func, 'attr', '')
                if name in MESSAGE_CALLS:
                    for part in [*node.args, *(keyword.value for keyword in node.keywords)]:
                        for text in _literals(part):
                            yield path.name, node.lineno, text
            elif isinstance(node, (ast.Assign, ast.AugAssign)):
                # result['message'] = ... and result['message'] += ...
                targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                if any(
                    isinstance(target, ast.Subscript)
                    and isinstance(target.slice, ast.Constant)
                    and target.slice.value == 'message'
                    for target in targets
                ):
                    for text in _literals(node.value):
                        yield path.name, node.lineno, text
        for node in tree.body:
            if isinstance(node, ast.Assign) and all(isinstance(t, ast.Name) for t in node.targets):
                names = [t.id for t in node.targets]
                if all(n.lstrip('_').isupper() for n in names):
                    for text in _literals(node.value):
                        if ' ' in text:
                            yield path.name, node.lineno, text


def test_no_message_literal_in_the_node_contains_an_asterisk():
    found = [(name, line, text) for name, line, text in _messages_in_source() if '*' in text]
    assert found == []
    # The scan sees the node's messages at all, the walk stops and the result messages too.
    assert sum(1 for _ in _messages_in_source()) > 100
    texts = [text for _, _, text in _messages_in_source()]
    assert any(text.startswith('Tree walk reached max_requests') for text in texts)
    assert any('over the 1 MB Contents API limit' in text for text in texts)


def _start_error(cfg):
    with scoped_stubs(cfg):
        from tool_github.IGlobal import IGlobal, warning

        glb = IGlobal()
        glb.IEndpoint = types.SimpleNamespace(endpoint=types.SimpleNamespace(openMode='open'))
        glb.glb = types.SimpleNamespace(logicalType='tool_github', connConfig={})
        with pytest.raises(ValueError) as error:
            glb.beginGlobal()
        glb.validateConfig()
        return [str(error.value), *(str(call.args[0]) for call in warning.call_args_list)]


START_CONFIGS = [
    {'authType': '*', 'token': 'x'},
    {'token': 'x', 'tools': ['*', 'repo_tree*', 'no_such_tool']},
    {'credentialMap': ['*']},
    {'credentialMap': '["*"]'},
    {'credentialMap': {'*/x': 'tok'}},
    {'credentialMap': {'Acme/*': 'tok-1', 'acme/*': 'tok-2'}},
    {'credentialMap': {'*': 'tok'}, 'token': 'node'},
    {'credentialMap': {'*': 'tok'}, 'authType': 'app', 'appId': '1'},
    {'credentialMap': {'acme/*': ''}},
    {'credentialMap': {'acme/*': 'a b'}},
    {'credentialMap': {'acme/*': 5}},
    {'credentialMap': {'*': {'appId': '1'}}},
    {'credentialMap': {'*': {'appId': True, 'privateKey': 'x'}}},
    {'credentialMap': {'*': {'appId': '1', 'privateKey': 'not a pem'}}},
    {'credentialMap': {'*': {'appId': '1', 'privateKey': 'x', '*': 1}}},
    {'credentialMap': {'*': {'appId': '1', 'privateKey': 'x', 'installationId': '1*2'}}},
    {'credentialMap': {'acme/*': '${ROCKETRIDE_A'}},
    {'credentialMap': {'acme/*': '${ROCKETRIDE_MISSING}'}},
    {'credentialMap': json.dumps({'acme/*': '${ROCKETRIDE_MISSING}'})},
    {'credentialMap': {'acme/*': '<REDACTED>'}},
    {'credentialMap': '${ROCKETRIDE_MAP}'},
    {'credentialMap': '{"acme/*": '},
    {'token': 'a*b c'},
]


@pytest.mark.parametrize('cfg', START_CONFIGS, ids=range(len(START_CONFIGS)))
def test_no_start_error_or_warning_contains_an_asterisk(cfg):
    for message in _start_error(cfg):
        assert '*' not in message, message


@pytest.fixture
def github(monkeypatch):
    fake = FakeGitHub()
    monkeypatch.setattr(requests, 'request', fake)
    return fake


def _outcome(inst, tool, args):
    """The text a tool call returns or raises: the result's message, or the error."""
    try:
        result = dispatch(inst, tool, args)
    except Exception as exc:  # noqa: BLE001 - the error text is what is checked
        return str(exc)
    return result.get('message', '') if isinstance(result, dict) else ''


CALLS = [
    ('label_list', {'repo': 'other/x'}),
    ('issue_get', {'repo': 'other/x', 'issue_number': 1}),
    ('org_list_repos', {'org': 'zeta'}),
    ('org_list_repos', {'org': '*'}),
    ('issue_get', {'repo': 'acme/*', 'issue_number': 1}),
    ('issue_get', {'repo': '*/x', 'issue_number': 1}),
    ('graphql', {'query': 'query { viewer { login } }'}),
    ('graphql', {'query': 'query { viewer { login } }', 'repo': '*'}),
    ('user_get', {}),
    ('installation_repos', {}),
    ('user_get_repos', {'affiliation': '*'}),
    ('user_get_repos', {'visibility': '*'}),
    ('issue_add_labels', {'repo': 'acme/*', 'issue_number': 1, 'labels': ['*']}),
    ('file_get', {'repo': 'acme/app', 'path': '../*'}),
    ('pr_request_reviewers', {'repo': 'acme/*', 'pr_number': 1, 'reviewers': ['*']}),
    ('pr_remove_requested_reviewers', {'repo': 'acme/*', 'pr_number': 1, 'reviewers': ['*']}),
    ('repo_tree', {'repo': 'acme/*'}),
    ('repo_tree', {'repo': 'acme/app', 'walk': True, 'max_requests': '*'}),
]


@pytest.mark.parametrize(('tool', 'args'), CALLS, ids=[f'{t}-{i}' for i, (t, _) in enumerate(CALLS)])
def test_no_credential_or_input_error_contains_an_asterisk(github, rsa_private_key_pem, tool, args):
    configs = [
        {'credentialMap': {'acme/*': 'tok-acme'}},
        app_config(rsa_private_key_pem),
        {'credentialMap': {'acme/*': app(rsa_private_key_pem, '1')}},
    ]
    for cfg in configs:
        with real_node(cfg) as inst:
            message = _outcome(inst, tool, args)
        assert '*' not in message, (cfg, message)


def test_credential_errors_from_github_answers_contain_no_asterisk(github, rsa_private_key_pem):
    github.installations = {'acme/api': 11}
    with real_node(app_config(rsa_private_key_pem)) as inst:
        messages = [_outcome(inst, 'label_list', {'repo': 'gamma/x'})]
        github.mint_missing = {'11'}
        messages.append(_outcome(inst, 'label_list', {'repo': 'acme/api'}))
        github.lookup_status = 500
        messages.append(_outcome(inst, 'label_list', {'repo': 'beta/y'}))
    assert all(messages)
    assert [m for m in messages if '*' in m] == []
