# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""The tools allowlist and the integer options, parsed at pipeline start."""

import json
import re
import types
from pathlib import Path
from types import SimpleNamespace

import pytest

from rocketlib.config import ConfigError

from ._stubs import conn_config, scoped_stubs

ALLOWED = ['graphql', 'repo_tree', 'label_list']


def _begin(cfg):
    """Run beginGlobal on the stored config ``cfg`` (a PAT is added) and return the IGlobal."""
    with scoped_stubs({'token': 'ghp_options', **cfg}):
        from tool_github.IGlobal import IGlobal

        glb = IGlobal()
        glb.glb = types.SimpleNamespace(logicalType='tool_github', connConfig=conn_config())
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
        (['graphql', 'graphql'], frozenset({'graphql'})),
        ([], frozenset()),
        (None, frozenset()),
    ],
    ids=['list', 'duplicates', 'empty-list', 'none'],
)
def test_begin_global_reads_the_allowlist(raw, expected):
    assert _begin({'tools': raw}).tools == expected


@pytest.mark.parametrize('raw', [[' '], ['', '  ']], ids=['blank-item', 'blank-items'])
def test_an_allowlist_of_blank_entries_is_a_schema_error(raw):
    """The schema types the entries as the known names; a blank is not one of them."""
    with pytest.raises(ConfigError, match='"tools\\[\\d\\]" must be one of'):
        _begin({'tools': raw})


def test_absent_allowlist_means_every_tool():
    assert _begin({}).tools == frozenset()


def test_unknown_allowlist_name_fails_at_start_naming_it():
    """The schema's item enum refuses a name it does not list, naming the entry."""
    with pytest.raises(ConfigError) as error:
        _begin({'tools': ['graphql', 'repo_trees', 'delete_everything']})
    message = str(error.value)
    assert '"tools[1]" must be one of' in message
    assert "'repo_trees'" in message
    assert "'delete_everything'" in message


def test_validate_tool_names_names_the_unknown_tools_and_the_valid_names():
    """The node-side check behind the schema enum keeps its teaching message."""
    with scoped_stubs():
        from tool_github.IInstance import validate_tool_names

        with pytest.raises(ValueError) as error:
            validate_tool_names(frozenset({'graphql', 'repo_trees', 'delete_everything'}))
    message = str(error.value)
    assert 'unknown tool name(s) in tools: delete_everything, repo_trees.' in message
    valid = message.split('Valid names: ', 1)[1].split(', ')
    assert valid == sorted(valid)
    assert {'graphql', 'repo_tree', 'label_list', 'file_get'} <= set(valid)
    assert 'repo_trees' not in valid


@pytest.mark.parametrize('raw', [5, {'graphql': True}, ['graphql', 7]])
def test_allowlist_of_the_wrong_shape_fails_at_start(raw):
    with pytest.raises(ConfigError, match='tools'):
        _begin({'tools': raw})


def test_integer_options_default():
    glb = _begin({})
    assert glb.graphql_max_bytes == 4 * 1024 * 1024
    assert glb.retry_policy.budget_seconds == 60
    assert glb.retry_policy.max_retries == 3
    assert glb.retry_policy.sleep is None


def test_unset_integer_options_mean_the_default():
    """None is "unset" in the stored tree, so the declared default applies."""
    glb = _begin({'graphqlMaxResponseBytes': None, 'rateLimitBudgetSeconds': None, 'rateLimitMaxRetries': None})
    assert (glb.graphql_max_bytes, glb.retry_policy.budget_seconds, glb.retry_policy.max_retries) == (4194304, 60, 3)


def test_integer_options_are_read_as_stored():
    glb = _begin({'rateLimitBudgetSeconds': 30, 'rateLimitMaxRetries': 0, 'graphqlMaxResponseBytes': 2048})
    assert glb.retry_policy.budget_seconds == 30
    assert glb.retry_policy.max_retries == 0
    assert glb.graphql_max_bytes == 2048


@pytest.mark.parametrize(
    ('key', 'value'),
    [
        ('rateLimitBudgetSeconds', -1),
        ('rateLimitBudgetSeconds', 601),
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
    """The schema's type and range checks replace the node's own: the resolver names the leaf."""
    with pytest.raises(ConfigError, match=f'"{key}"'):
        _begin({key: value})


def test_graphql_mutations_are_off_by_default():
    assert _begin({}).graphql_allow_mutations is False


@pytest.mark.parametrize(('raw', 'expected'), [(True, True), (False, False), (None, False)])
def test_graphql_allow_mutations_reads_the_stored_boolean(raw, expected):
    assert _begin({'graphqlAllowMutations': raw}).graphql_allow_mutations is expected


@pytest.mark.parametrize('raw', ['yes', 1, 0, 'on', [True], 'true'])
def test_a_bad_graphql_allow_mutations_fails_at_start_naming_the_field(raw):
    """The leaf is a boolean; the resolver refuses every other spelling."""
    with pytest.raises(ConfigError, match='"graphqlAllowMutations" expects boolean'):
        _begin({'graphqlAllowMutations': raw})


def test_end_global_resets_the_options():
    glb = _begin(
        {'tools': ALLOWED, 'rateLimitBudgetSeconds': 5, 'graphqlMaxResponseBytes': 2048, 'graphqlAllowMutations': True}
    )
    glb.endGlobal()
    assert glb.tools == frozenset()
    assert glb.graphql_allow_mutations is False
    assert glb.graphql_max_bytes == 4 * 1024 * 1024
    assert glb.retry_policy.budget_seconds == 60


def test_services_json_offers_exactly_the_registered_tools_as_choices():
    # The canvas renders the allowlist as checkboxes from this list, so it must not drift.
    with scoped_stubs():
        from tool_github.IInstance import tool_names

        registered = tool_names()
    text = (Path(__file__).resolve().parents[2] / 'src' / 'nodes' / 'tool_github' / 'services.json').read_text(
        encoding='utf-8'
    )
    services = json.loads('\n'.join(line for line in text.splitlines() if not line.lstrip().startswith('//')))
    field = services['propertyDefinitions']['github.tools']
    choices = field['items']['enum']
    assert field['uniqueItems'] is True and field['default'] == []
    assert 'ui' not in field  # the same select the canvas draws for tool_pipedrive's tool groups
    values = [value for value, _label in choices]
    assert len(values) == len(set(values))
    assert set(values) == registered
    for value, label in choices:
        assert value in label and label.split(':')[0].strip()


def test_readme_tool_tables_list_exactly_the_registered_tools():
    readme_path = Path(__file__).resolve().parents[2] / 'src' / 'nodes' / 'tool_github' / 'README.md'
    readme = readme_path.read_text(encoding='utf-8')
    section = readme.split('\n## As a tool\n', 1)[1].split('\n## Configuration\n', 1)[0]
    documented = re.findall(r'^\| `([a-z_]+)` +\|', section, re.M)
    _, registered = _published([])
    assert len(documented) == len(set(documented)), 'a tool is listed twice'
    assert set(documented) == registered
