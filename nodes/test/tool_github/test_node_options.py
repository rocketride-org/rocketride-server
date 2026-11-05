# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""The tools allowlist and the integer options, parsed at pipeline start."""

import re
import types
from pathlib import Path
from types import SimpleNamespace

import pytest

from ._stubs import scoped_stubs

ALLOWED = ['graphql', 'repo_tree', 'label_list']


def _begin(cfg):
    """Run beginGlobal on ``cfg`` (a PAT is added) and return the IGlobal."""
    with scoped_stubs({'token': 'ghp_options', **cfg}):
        from tool_github.IGlobal import IGlobal

        glb = IGlobal()
        glb.IEndpoint = types.SimpleNamespace(endpoint=types.SimpleNamespace(openMode='open'))
        glb.glb = types.SimpleNamespace(logicalType='tool_github', connConfig={})
        glb.beginGlobal()
        return glb


def _published(tools):
    with scoped_stubs():
        from tool_github.IInstance import IInstance, tool_names

        inst = IInstance()
        inst.IGlobal = SimpleNamespace(tools=frozenset(tools))
        return set(inst._collect_tool_methods()), tool_names()


def test_allowlist_registers_only_the_named_tools():
    published, _ = _published(ALLOWED)
    assert published == set(ALLOWED)


def test_empty_allowlist_registers_every_tool():
    published, names = _published([])
    assert published == names
    assert {'graphql', 'repo_tree', 'file_get', 'issue_create', 'commit_get'} <= names
    assert '_collect_tool_methods' not in names
    assert len(names) > 40


@pytest.mark.parametrize(
    ('raw', 'expected'),
    [
        (ALLOWED, frozenset(ALLOWED)),
        (' graphql , repo_tree,label_list ', frozenset(ALLOWED)),
        (['graphql', ' graphql ', ''], frozenset({'graphql'})),
        ([], frozenset()),
        ('', frozenset()),
        (None, frozenset()),
    ],
    ids=['list', 'comma-string', 'duplicates-and-blanks', 'empty-list', 'empty-string', 'none'],
)
def test_begin_global_reads_the_allowlist(raw, expected):
    assert _begin({'tools': raw}).tools == expected


def test_absent_allowlist_means_every_tool():
    assert _begin({}).tools == frozenset()


def test_unknown_allowlist_name_fails_at_start_naming_it_and_the_valid_names():
    with pytest.raises(ValueError) as error:
        _begin({'tools': ['graphql', 'repo_trees', 'delete_everything']})
    message = str(error.value)
    assert 'unknown tool name(s) in tools: delete_everything, repo_trees.' in message
    valid = message.split('Valid names: ', 1)[1].split(', ')
    assert valid == sorted(valid)
    assert {'graphql', 'repo_tree', 'label_list', 'file_get'} <= set(valid)
    assert 'repo_trees' not in valid


@pytest.mark.parametrize('raw', [5, {'graphql': True}, ['graphql', 7]])
def test_allowlist_of_the_wrong_shape_fails_at_start(raw):
    with pytest.raises(ValueError, match='tools must be a list of tool names'):
        _begin({'tools': raw})


def test_validate_config_warns_about_an_unknown_tool_without_raising():
    with scoped_stubs({'token': 'ghp_options', 'tools': ['no_such_tool']}):
        from tool_github.IGlobal import IGlobal, warning

        glb = IGlobal()
        glb.glb = types.SimpleNamespace(logicalType='tool_github', connConfig={})
        glb.validateConfig()
        messages = [call.args[0] for call in warning.call_args_list]
    assert len(messages) == 1
    assert 'no_such_tool' in messages[0]


def test_validate_config_warns_about_a_bad_integer_without_raising():
    with scoped_stubs({'token': 'ghp_options', 'rateLimitBudgetSeconds': 'soon'}):
        from tool_github.IGlobal import IGlobal, warning

        glb = IGlobal()
        glb.glb = types.SimpleNamespace(logicalType='tool_github', connConfig={})
        glb.validateConfig()
        messages = [call.args[0] for call in warning.call_args_list]
    assert messages == ['tool_github: rateLimitBudgetSeconds must be an integer from 0 to 3600']


def test_integer_options_default():
    glb = _begin({})
    assert glb.graphql_max_bytes == 4 * 1024 * 1024
    assert glb.retry_policy.budget_seconds == 60
    assert glb.retry_policy.max_retries == 3
    assert glb.retry_policy.sleep is None


@pytest.mark.parametrize('blank', [None, '', '  '])
def test_blank_integer_options_mean_the_default(blank):
    glb = _begin({'graphqlMaxResponseBytes': blank, 'rateLimitBudgetSeconds': blank, 'rateLimitMaxRetries': blank})
    assert (glb.graphql_max_bytes, glb.retry_policy.budget_seconds, glb.retry_policy.max_retries) == (4194304, 60, 3)


@pytest.mark.parametrize('value', [30, 30.0, '30', ' 30 '])
def test_integer_options_accept_whole_numbers_in_any_spelling(value):
    glb = _begin({'rateLimitBudgetSeconds': value, 'rateLimitMaxRetries': 0, 'graphqlMaxResponseBytes': 2048})
    assert glb.retry_policy.budget_seconds == 30
    assert glb.retry_policy.max_retries == 0
    assert glb.graphql_max_bytes == 2048


@pytest.mark.parametrize(
    ('key', 'value'),
    [
        ('rateLimitBudgetSeconds', -1),
        ('rateLimitBudgetSeconds', 3601),
        ('rateLimitBudgetSeconds', 'soon'),
        ('rateLimitBudgetSeconds', 1.5),
        ('rateLimitMaxRetries', 11),
        ('rateLimitMaxRetries', True),
        ('rateLimitMaxRetries', '\u00b2'),
        ('graphqlMaxResponseBytes', 512),
        ('graphqlMaxResponseBytes', 200 * 1024 * 1024),
    ],
)
def test_out_of_range_integer_options_fail_at_start_naming_the_field(key, value):
    with pytest.raises(ValueError, match=f'{key} must be an integer from'):
        _begin({key: value})


def test_graphql_mutations_are_off_by_default():
    assert _begin({}).graphql_allow_mutations is False


@pytest.mark.parametrize(
    ('raw', 'expected'),
    [(True, True), (False, False), ('true', True), ('False', False), (' TRUE ', True), ('', False), (None, False)],
)
def test_graphql_allow_mutations_reads_booleans_and_their_spellings(raw, expected):
    assert _begin({'graphqlAllowMutations': raw}).graphql_allow_mutations is expected


@pytest.mark.parametrize('raw', ['yes', 1, 0, 'on', [True]])
def test_a_bad_graphql_allow_mutations_fails_at_start_naming_the_field(raw):
    with pytest.raises(ValueError, match='graphqlAllowMutations must be true or false'):
        _begin({'graphqlAllowMutations': raw})


def test_validate_config_warns_about_a_bad_flag_without_raising():
    with scoped_stubs({'token': 'ghp_options', 'graphqlAllowMutations': 'maybe'}):
        from tool_github.IGlobal import IGlobal, warning

        glb = IGlobal()
        glb.glb = types.SimpleNamespace(logicalType='tool_github', connConfig={})
        glb.validateConfig()
        messages = [call.args[0] for call in warning.call_args_list]
    assert messages == ['tool_github: graphqlAllowMutations must be true or false']


def test_end_global_resets_the_options():
    glb = _begin(
        {'tools': ALLOWED, 'rateLimitBudgetSeconds': 5, 'graphqlMaxResponseBytes': 2048, 'graphqlAllowMutations': True}
    )
    glb.endGlobal()
    assert glb.tools == frozenset()
    assert glb.graphql_allow_mutations is False
    assert glb.graphql_max_bytes == 4 * 1024 * 1024
    assert glb.retry_policy.budget_seconds == 60


def test_readme_tool_tables_list_exactly_the_registered_tools():
    readme_path = Path(__file__).resolve().parents[2] / 'src' / 'nodes' / 'tool_github' / 'README.md'
    readme = readme_path.read_text(encoding='utf-8')
    section = readme.split('\n## As a tool\n', 1)[1].split('\n## Configuration\n', 1)[0]
    documented = re.findall(r'^\| `([a-z_]+)` +\|', section, re.M)
    _, registered = _published([])
    assert len(documented) == len(set(documented)), 'a tool is listed twice'
    assert set(documented) == registered
