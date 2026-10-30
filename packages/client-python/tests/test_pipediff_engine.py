# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

"""Unit tests for the RocketRide pipe-diff engine, model, and config deep-diff."""

import copy
import json
import pickle
import sys
import tracemalloc
from pathlib import Path

import pytest

from rocketride.pipediff import EdgeChange, PipeDiffError, deep_diff_config, diff_pipes, load_pipe, render_json


# ---------------------------------------------------------------------------
# Fixtures / builders
# ---------------------------------------------------------------------------


@pytest.fixture
def examples_dir():
    """Path to the repo's bundled ``examples/`` directory of ``.pipe`` files."""
    # tests/ -> client-python/ -> packages/ -> repo root -> examples/
    return Path(__file__).resolve().parents[3] / 'examples'


def _node(component_id, provider, config=None, inputs=None, control=None, ui=None):
    """Build a single component dict, omitting empty optional blocks."""
    component = {'id': component_id, 'provider': provider, 'config': config or {}}
    if inputs is not None:
        component['input'] = inputs
    if control is not None:
        component['control'] = control
    component['ui'] = ui if ui is not None else {'position': {'x': 0, 'y': 0}}
    return component


def _pipe(components, version=1, viewport=None):
    """Build a top-level pipe dict."""
    pipe = {'components': components, 'project_id': 'p', 'version': version}
    if viewport is not None:
        pipe['viewport'] = viewport
    return pipe


def _sample_pipe():
    """A small but representative two-node RAG-ish pipeline."""
    return _pipe(
        [
            _node('webhook_1', 'webhook', {'mode': 'Source', 'type': 'webhook'}),
            _node(
                'parse_1',
                'parse',
                {'profile': 'default', 'default': {'strlen': 512}},
                inputs=[{'lane': 'text', 'from': 'webhook_1'}],
            ),
        ]
    )


def _changes_by_kind(diff, kind):
    return [change for change in diff.node_changes if change.kind == kind]


# ---------------------------------------------------------------------------
# Identity / no-change
# ---------------------------------------------------------------------------


def test_identical_pipes_produce_empty_diff():
    pipe = _sample_pipe()
    diff = diff_pipes(pipe, copy.deepcopy(pipe))
    assert diff.node_changes == []
    assert diff.edge_changes == []
    assert diff.version_change is None
    assert diff.layout_changed is False
    assert diff.has_semantic_changes is False


# ---------------------------------------------------------------------------
# Nodes
# ---------------------------------------------------------------------------


def test_added_node_is_reported_with_provider():
    old = _sample_pipe()
    new = copy.deepcopy(old)
    new['components'].append(_node('llm_1', 'llm_openai', inputs=[{'lane': 'questions', 'from': 'parse_1'}]))
    diff = diff_pipes(old, new)

    added = _changes_by_kind(diff, 'added')
    assert [c.id for c in added] == ['llm_1']
    assert added[0].provider_new == 'llm_openai'
    assert added[0].provider_old is None
    assert diff.has_semantic_changes is True


def test_removed_node_is_reported_with_provider():
    old = _sample_pipe()
    new = copy.deepcopy(old)
    new['components'] = [c for c in new['components'] if c['id'] != 'parse_1']
    diff = diff_pipes(old, new)

    removed = _changes_by_kind(diff, 'removed')
    assert [c.id for c in removed] == ['parse_1']
    assert removed[0].provider_old == 'parse'
    assert removed[0].provider_new is None


def test_provider_change_is_reported_separately_from_config():
    old = _sample_pipe()
    new = copy.deepcopy(old)
    # Same id, different provider *and* a config change.
    new['components'][1]['provider'] = 'parse_v2'
    new['components'][1]['config']['default']['strlen'] = 1024
    diff = diff_pipes(old, new)

    provider_changes = _changes_by_kind(diff, 'provider')
    assert len(provider_changes) == 1
    assert provider_changes[0].id == 'parse_1'
    assert provider_changes[0].provider_old == 'parse'
    assert provider_changes[0].provider_new == 'parse_v2'

    config_changes = _changes_by_kind(diff, 'config')
    assert len(config_changes) == 1
    assert config_changes[0].id == 'parse_1'
    paths = {fc.path for fc in config_changes[0].field_changes}
    assert paths == {'config.default.strlen'}


@pytest.mark.parametrize(
    ('before', 'after'), [(0, False), (1, True), (False, 0)], ids=['0-to-false', '1-to-true', 'false-to-0']
)
def test_provider_change_is_type_sensitive(before, after):
    # Python treats ``0 == False`` and ``1 == True``; JSON does not, and neither
    # does the version or config comparison.
    old = _pipe([_node('n1', before)])
    new = _pipe([_node('n1', after)])
    diff = diff_pipes(old, new)
    provider_changes = _changes_by_kind(diff, 'provider')
    assert [(c.id, c.provider_old, c.provider_new) for c in provider_changes] == [('n1', before, after)]
    assert diff.has_semantic_changes is True


# ---------------------------------------------------------------------------
# Config deep-diff
# ---------------------------------------------------------------------------


def test_deep_diff_config_handles_nested_dicts_added_removed_changed():
    old = {'profile': 'a', 'default': {'strlen': 512, 'gone': True}}
    new = {'profile': 'b', 'default': {'strlen': 1024, 'added_key': 7}}
    changes = {(fc.path, fc.kind): (fc.old, fc.new) for fc in deep_diff_config(old, new)}

    assert changes[('config.profile', 'changed')] == ('a', 'b')
    assert changes[('config.default.strlen', 'changed')] == (512, 1024)
    assert changes[('config.default.gone', 'removed')] == (True, None)
    assert changes[('config.default.added_key', 'added')] == (None, 7)


def test_deep_diff_config_handles_list_element_change():
    old = {'instructions': ['Answer accurately.', 'Be terse.']}
    new = {'instructions': ['Answer accurately and cite sources.', 'Be terse.']}
    changes = deep_diff_config(old, new)

    assert len(changes) == 1
    change = changes[0]
    assert change.path == 'config.instructions[0]'
    assert change.kind == 'changed'
    assert change.old == 'Answer accurately.'
    assert change.new == 'Answer accurately and cite sources.'


def test_deep_diff_config_handles_list_growth_and_shrink():
    grow = deep_diff_config({'xs': [1]}, {'xs': [1, 2, 3]})
    assert {(c.path, c.kind, c.new) for c in grow} == {
        ('config.xs[1]', 'added', 2),
        ('config.xs[2]', 'added', 3),
    }

    shrink = deep_diff_config({'xs': [1, 2, 3]}, {'xs': [1]})
    assert {(c.path, c.kind, c.old) for c in shrink} == {
        ('config.xs[1]', 'removed', 2),
        ('config.xs[2]', 'removed', 3),
    }


def test_deep_diff_config_handles_list_of_dicts_index_paths():
    old = {'steps': [{'name': 'a', 'n': 1}]}
    new = {'steps': [{'name': 'a', 'n': 2}]}
    changes = deep_diff_config(old, new)
    assert len(changes) == 1
    assert changes[0].path == 'config.steps[0].n'
    assert (changes[0].old, changes[0].new) == (1, 2)


def test_deep_diff_config_equal_returns_empty():
    cfg = {'a': {'b': [1, 2, {'c': 3}]}}
    assert deep_diff_config(cfg, copy.deepcopy(cfg)) == []


def test_deep_diff_config_treats_none_as_empty():
    assert deep_diff_config(None, {'a': 1}) == [
        # single added key
        *deep_diff_config({}, {'a': 1})
    ]
    assert deep_diff_config(None, None) == []


# ---------------------------------------------------------------------------
# Edges (input + control)
# ---------------------------------------------------------------------------


def test_edge_added_and_removed():
    old = _sample_pipe()
    new = copy.deepcopy(old)
    # Rewire parse_1 to read from a new lane/source, and add a fresh node+edge.
    new['components'][1]['input'] = [{'lane': 'raw', 'from': 'webhook_1'}]
    diff = diff_pipes(old, new)

    added = [e for e in diff.edge_changes if e.kind == 'added']
    removed = [e for e in diff.edge_changes if e.kind == 'removed']
    assert added == [EdgeChange(from_id='webhook_1', lane='raw', to_id='parse_1', kind='added')]
    assert removed == [EdgeChange(from_id='webhook_1', lane='text', to_id='parse_1', kind='removed')]


def test_edge_rewire_shows_as_added_and_removed_pair():
    old = _pipe(
        [
            _node('a', 'src'),
            _node('b', 'src'),
            _node('c', 'sink', inputs=[{'lane': 'x', 'from': 'a'}]),
        ]
    )
    new = copy.deepcopy(old)
    # Rewire c's lane x from a -> b (same to/lane, different from).
    new['components'][2]['input'] = [{'lane': 'x', 'from': 'b'}]
    diff = diff_pipes(old, new)

    assert EdgeChange('b', 'x', 'c', 'added') in diff.edge_changes
    assert EdgeChange('a', 'x', 'c', 'removed') in diff.edge_changes
    assert len(diff.edge_changes) == 2


def test_control_edges_are_diffed():
    old = _pipe(
        [
            _node('agent_1', 'agent_rocketride'),
            _node('llm_1', 'llm_openai', control=[{'classType': 'llm', 'from': 'agent_1'}]),
            _node('tool_1', 'tool_python', control=[{'classType': 'tool', 'from': 'agent_1'}]),
        ]
    )
    new = copy.deepcopy(old)
    # Detach the tool from the agent (remove its control wire).
    new['components'][2].pop('control')
    diff = diff_pipes(old, new)

    removed = [e for e in diff.edge_changes if e.kind == 'removed']
    assert removed == [EdgeChange(from_id='agent_1', lane='tool', to_id='tool_1', kind='removed')]
    # The surviving llm control wire produces no change.
    assert not [e for e in diff.edge_changes if e.kind == 'added']


# ---------------------------------------------------------------------------
# Version
# ---------------------------------------------------------------------------


def test_version_change_is_reported_and_is_semantic():
    old = _sample_pipe()
    new = copy.deepcopy(old)
    new['version'] = 2
    diff = diff_pipes(old, new)
    assert diff.version_change == (1, 2)
    assert diff.has_semantic_changes is True


def test_version_int_to_bool_is_reported_as_a_change():
    """``1`` -> ``true`` is a real JSON change although Python evaluates ``1 == True``."""
    old = _sample_pipe()
    new = copy.deepcopy(old)
    new['version'] = True
    diff = diff_pipes(old, new)
    # `== (1, True)` would also hold for `(1, 1)`, so assert the types too.
    assert diff.version_change is not None
    old_version, new_version = diff.version_change
    assert old_version == 1 and not isinstance(old_version, bool)
    assert new_version is True
    assert diff.has_semantic_changes is True


def test_version_zero_to_false_is_reported_as_a_change():
    """The falsy half of the same trap: ``0`` -> ``false``."""
    old = _pipe(_sample_pipe()['components'], version=0)
    new = _pipe(copy.deepcopy(old['components']), version=False)
    diff = diff_pipes(old, new)
    assert diff.version_change is not None
    old_version, new_version = diff.version_change
    assert old_version == 0 and not isinstance(old_version, bool)
    assert new_version is False
    assert diff.has_semantic_changes is True


def test_equal_int_version_is_still_not_a_change():
    """The bool-aware comparison must not start flagging genuinely equal ints."""
    old = _sample_pipe()
    new = copy.deepcopy(old)
    new['components'][1]['config']['profile'] = 'fast'
    diff = diff_pipes(old, new)
    assert old['version'] == 1 and new['version'] == 1
    assert diff.version_change is None
    # The unrelated config edit is still picked up, so the diff is not a no-op.
    assert _changes_by_kind(diff, 'config')


# ---------------------------------------------------------------------------
# Top-level key contract
# ---------------------------------------------------------------------------


def test_unknown_top_level_keys_are_ignored():
    # `diff_pipes` reads exactly three top-level keys: `components`, `version`,
    # and `viewport`. Everything else a .pipe carries -- `project_id`,
    # `isLocked`, and any key a future schema adds -- is ignored, because none
    # of it changes what the pipeline does.
    old = _pipe([_node('a', 'src')], viewport={'x': 0, 'y': 0, 'zoom': 1})
    new = copy.deepcopy(old)
    new['project_id'] = 'a-different-project'
    new['isLocked'] = not old.get('isLocked', False)
    new['name'] = 'renamed in the editor'
    new['someFutureKey'] = {'nested': [1, 2, 3]}

    for include_layout in (False, True):
        diff = diff_pipes(old, new, include_layout=include_layout)
        assert diff.node_changes == []
        assert diff.edge_changes == []
        assert diff.version_change is None
        assert diff.viewport_changes == []
        assert diff.layout_changed is False
        assert diff.has_semantic_changes is False


def test_version_is_compared_but_viewport_only_under_include_layout():
    # Of the three keys that are read, `version` always counts, while `viewport`
    # is enumerated and counted only when the caller opts layout in.
    old = _pipe([_node('a', 'src')], version=1, viewport={'x': 0, 'y': 0, 'zoom': 1})

    version_edit = copy.deepcopy(old)
    version_edit['version'] = 2
    assert diff_pipes(old, version_edit).version_change == (1, 2)
    assert diff_pipes(old, version_edit).has_semantic_changes is True

    viewport_edit = copy.deepcopy(old)
    viewport_edit['viewport'] = {'x': 99, 'y': 0, 'zoom': 1}
    assert diff_pipes(old, viewport_edit).has_semantic_changes is False
    assert diff_pipes(old, viewport_edit).viewport_changes == []
    with_layout = diff_pipes(old, viewport_edit, include_layout=True)
    assert [fc.path for fc in with_layout.viewport_changes] == ['viewport.x']
    assert with_layout.has_semantic_changes is True


# ---------------------------------------------------------------------------
# Layout
# ---------------------------------------------------------------------------


def test_layout_only_change_is_not_semantic_by_default():
    old = _sample_pipe()
    new = copy.deepcopy(old)
    new['components'][1]['ui']['position'] = {'x': 999, 'y': 42}
    diff = diff_pipes(old, new)

    assert diff.node_changes == []
    assert diff.edge_changes == []
    assert diff.layout_changed is True
    assert diff.has_semantic_changes is False


def test_viewport_only_change_sets_layout_flag_but_is_not_semantic():
    old = _pipe([_node('a', 'src')], viewport={'x': 0, 'y': 0, 'zoom': 1})
    new = copy.deepcopy(old)
    new['viewport'] = {'x': 10, 'y': 20, 'zoom': 2}
    diff = diff_pipes(old, new)

    assert diff.layout_changed is True
    assert diff.has_semantic_changes is False


def test_include_layout_surfaces_ui_field_changes():
    old = _sample_pipe()
    new = copy.deepcopy(old)
    new['components'][1]['ui']['position']['x'] = 999
    diff = diff_pipes(old, new, include_layout=True)

    config_changes = _changes_by_kind(diff, 'config')
    assert len(config_changes) == 1
    paths = {fc.path for fc in config_changes[0].field_changes}
    assert 'ui.position.x' in paths
    # With layout opted in, the ui move now counts as a change.
    assert diff.has_semantic_changes is True
    # The flag is still set regardless of the include_layout mode.
    assert diff.layout_changed is True
    # A ui-only edit says nothing about the top-level viewport.
    assert diff.viewport_changes == []


def test_include_layout_enumerates_top_level_viewport():
    # --help and the docs promise that --include-layout enumerates "each node's ui
    # block and the top-level viewport"; a viewport-only edit must therefore
    # produce concrete viewport.* paths and count as a change (exit 1).
    old = _pipe([_node('a', 'src')], viewport={'x': 0, 'y': 0, 'zoom': 1})
    new = copy.deepcopy(old)
    new['viewport'] = {'x': 10, 'y': 0, 'zoom': 2}

    without = diff_pipes(old, new)
    assert without.viewport_changes == []
    assert without.has_semantic_changes is False

    with_layout = diff_pipes(old, new, include_layout=True)
    paths = [fc.path for fc in with_layout.viewport_changes]
    assert paths == ['viewport.x', 'viewport.zoom']
    assert all(path.startswith('viewport.') for path in paths)
    assert with_layout.has_semantic_changes is True
    assert with_layout.layout_changed is True


def test_include_layout_with_unchanged_viewport_reports_nothing():
    old = _pipe([_node('a', 'src')], viewport={'x': 0, 'y': 0, 'zoom': 1})
    new = copy.deepcopy(old)
    diff = diff_pipes(old, new, include_layout=True)

    assert diff.viewport_changes == []
    assert diff.has_semantic_changes is False


@pytest.mark.parametrize('null_viewport', [True, False], ids=['null', 'omitted'])
def test_absent_viewport_equals_empty_viewport(null_viewport):
    # An omitted or null viewport is the same canvas as {}: no layout change is
    # flagged, and none is enumerated under include_layout.
    old = _pipe([_node('a', 'src')], viewport={})
    new = _pipe([_node('a', 'src')])
    if null_viewport:
        new['viewport'] = None

    diff = diff_pipes(old, new)
    assert diff.layout_changed is False
    assert diff.has_semantic_changes is False

    with_layout = diff_pipes(old, new, include_layout=True)
    assert with_layout.viewport_changes == []
    assert with_layout.layout_changed is False
    assert with_layout.has_semantic_changes is False


@pytest.mark.parametrize('falsy', [False, 0, ''], ids=['false', 'zero', 'empty-string'])
def test_falsy_non_null_viewport_is_not_an_empty_viewport(falsy):
    # Only None normalizes to {}: false, 0 and "" are values `load_pipe` accepts,
    # and each differs from {}.
    old = _pipe([_node('a', 'src')], viewport={})
    new = _pipe([_node('a', 'src')])
    new['viewport'] = falsy

    diff = diff_pipes(old, new)
    assert diff.layout_changed is True

    with_layout = diff_pipes(old, new, include_layout=True)
    assert with_layout.layout_changed is True
    assert [(change.path, change.old, change.new) for change in with_layout.viewport_changes] == [
        ('viewport', {}, falsy)
    ]
    assert with_layout.has_semantic_changes is True


@pytest.mark.parametrize('falsy', [False, 0, ''], ids=['false', 'zero', 'empty-string'])
def test_falsy_non_null_node_ui_is_not_an_empty_ui(falsy):
    # Same for a node's ui block: false/0/"" are real values, not "no layout".
    old = _pipe([_node('a', 'src', ui={})])
    new = _pipe([_node('a', 'src', ui={})])
    new['components'][0]['ui'] = falsy

    diff = diff_pipes(old, new)
    assert diff.layout_changed is True
    # Layout is still not semantic until the caller opts in.
    assert diff.node_changes == []
    assert diff.has_semantic_changes is False

    with_layout = diff_pipes(old, new, include_layout=True)
    config_changes = _changes_by_kind(with_layout, 'config')
    assert len(config_changes) == 1
    assert [(change.path, change.old, change.new) for change in config_changes[0].field_changes] == [('ui', {}, falsy)]
    assert with_layout.has_semantic_changes is True


@pytest.mark.parametrize(
    ('before', 'after'), [(False, 0), (True, 1), (0, False)], ids=['false-to-0', 'true-to-1', '0-to-false']
)
def test_viewport_scalar_type_change_is_a_layout_change(before, after):
    # Python treats False == 0 and True == 1; equality here is JSON-typed.
    old = _pipe([_node('a', 'src')])
    old['viewport'] = before
    new = _pipe([_node('a', 'src')])
    new['viewport'] = after

    diff = diff_pipes(old, new)
    assert diff.layout_changed is True

    with_layout = diff_pipes(old, new, include_layout=True)
    assert [(change.path, change.old, change.new) for change in with_layout.viewport_changes] == [
        ('viewport', before, after)
    ]
    assert with_layout.has_semantic_changes is True


@pytest.mark.parametrize(('before', 'after'), [(False, 0), (True, 1)], ids=['false-to-0', 'true-to-1'])
def test_node_ui_scalar_type_change_is_a_layout_change(before, after):
    old = _pipe([_node('a', 'src', ui={})])
    new = _pipe([_node('a', 'src', ui={})])
    old['components'][0]['ui'] = before
    new['components'][0]['ui'] = after

    diff = diff_pipes(old, new)
    assert diff.layout_changed is True

    with_layout = diff_pipes(old, new, include_layout=True)
    config_changes = _changes_by_kind(with_layout, 'config')
    assert len(config_changes) == 1
    assert [(change.path, change.old, change.new) for change in config_changes[0].field_changes] == [
        ('ui', before, after)
    ]


def test_config_scalar_type_change_is_reported():
    # A config flag flipping from false to 0 is a real change; equal typed values,
    # nested ones included, still compare equal.
    old = _pipe([_node('a', 'src', config={'flag': False, 'nested': {'n': 1, 'items': [True]}})])
    new = _pipe([_node('a', 'src', config={'flag': 0, 'nested': {'n': 1, 'items': [True]}})])

    config_changes = _changes_by_kind(diff_pipes(old, new), 'config')
    assert len(config_changes) == 1
    assert [(change.path, change.old, change.new) for change in config_changes[0].field_changes] == [
        ('config.flag', False, 0)
    ]
    assert diff_pipes(old, old).has_semantic_changes is False


@pytest.mark.parametrize('null_ui', [True, False], ids=['null', 'omitted'])
def test_absent_node_ui_equals_empty_ui(null_ui):
    # Same normalization for a node's ui block: null/omitted vs {}.
    old = _pipe([_node('a', 'src', ui={})])
    new = _pipe([_node('a', 'src', ui={})])
    if null_ui:
        new['components'][0]['ui'] = None
    else:
        del new['components'][0]['ui']

    diff = diff_pipes(old, new)
    assert diff.layout_changed is False

    with_layout = diff_pipes(old, new, include_layout=True)
    assert with_layout.node_changes == []
    assert with_layout.layout_changed is False
    assert with_layout.has_semantic_changes is False


# ---------------------------------------------------------------------------
# Determinism
# ---------------------------------------------------------------------------


def test_node_change_ordering_is_deterministic():
    old = _pipe([_node('keep', 'src'), _node('zeta', 'src'), _node('alpha', 'src')])
    new = _pipe([_node('keep', 'src'), _node('beta', 'src'), _node('gamma', 'src')])
    diff = diff_pipes(old, new)

    added = [c.id for c in diff.node_changes if c.kind == 'added']
    removed = [c.id for c in diff.node_changes if c.kind == 'removed']
    assert added == ['beta', 'gamma']  # sorted
    assert removed == ['alpha', 'zeta']  # sorted


# ---------------------------------------------------------------------------
# load_pipe validation
# ---------------------------------------------------------------------------


def test_load_pipe_from_path_roundtrip(tmp_path):
    pipe = _sample_pipe()
    path = tmp_path / 'pipeline.pipe'
    path.write_text(json.dumps(pipe), encoding='utf-8')
    assert load_pipe(str(path)) == pipe


def test_load_pipe_accepts_dict_passthrough():
    pipe = _sample_pipe()
    assert load_pipe(pipe) is pipe


def test_load_pipe_missing_file_raises():
    with pytest.raises(PipeDiffError, match='not found'):
        load_pipe('/nonexistent/path/to/file.pipe')


def test_load_pipe_malformed_json_raises(tmp_path):
    path = tmp_path / 'bad.pipe'
    path.write_text('{ not valid json', encoding='utf-8')
    with pytest.raises(PipeDiffError, match='Invalid JSON'):
        load_pipe(str(path))


def test_load_pipe_non_object_raises(tmp_path):
    path = tmp_path / 'list.pipe'
    path.write_text('[1, 2, 3]', encoding='utf-8')
    with pytest.raises(PipeDiffError, match='must be a JSON object'):
        load_pipe(str(path))


def test_load_pipe_missing_components_raises():
    with pytest.raises(PipeDiffError, match="missing a 'components' list"):
        load_pipe({'project_id': 'p', 'version': 1})


def test_load_pipe_components_not_a_list_raises():
    with pytest.raises(PipeDiffError, match="missing a 'components' list"):
        load_pipe({'components': {'id': 'x'}})


def test_load_pipe_component_missing_id_raises():
    with pytest.raises(PipeDiffError, match="index 0 is missing a string 'id'"):
        load_pipe({'components': [{'provider': 'webhook'}]})


def test_load_pipe_component_not_object_raises():
    with pytest.raises(PipeDiffError, match='index 0 is not an object'):
        load_pipe({'components': ['not-a-dict']})


def test_load_pipe_duplicate_component_id_raises():
    # Components are matched by id, so a duplicate would hide a node and every
    # change to it: it is an error, not a quietly wrong diff.
    with pytest.raises(PipeDiffError, match="duplicate component id 'a' at index 2"):
        load_pipe(
            {
                'components': [
                    {'id': 'a', 'provider': 'src'},
                    {'id': 'b', 'provider': 'src'},
                    {'id': 'a', 'provider': 'other'},
                ]
            }
        )


def test_load_pipe_rejects_unsupported_type():
    with pytest.raises(PipeDiffError, match='expects a path or dict'):
        load_pipe(12345)


def test_load_pipe_invalid_utf8_raises_pipediff_error(tmp_path):
    path = tmp_path / 'bad-utf8.pipe'
    path.write_bytes(b'\xff\xfe{"components": []}')
    with pytest.raises(PipeDiffError, match='not valid UTF-8'):
        load_pipe(str(path))


@pytest.mark.parametrize('literal', ['NaN', 'Infinity', '-Infinity', '1e309', '-1e309', '1e-400', '-1e-400'])
def test_load_pipe_rejects_unsupported_json_numbers_with_file_context(tmp_path, literal):
    path = tmp_path / 'numeric.pipe'
    path.write_text('{"components": [{"id": "a", "config": {"value": ' + literal + '}}]}', encoding='utf-8')

    with pytest.raises(PipeDiffError, match='Invalid JSON') as error:
        load_pipe(path)

    assert str(path) in str(error.value)
    assert literal in str(error.value)


@pytest.mark.parametrize('field', ['version', 'viewport', 'project_id'])
def test_load_pipe_rejects_nonfinite_numbers_outside_config(tmp_path, field):
    path = tmp_path / 'numeric.pipe'
    path.write_text('{"components": [], "' + field + '": 1e309}', encoding='utf-8')
    with pytest.raises(PipeDiffError, match='finite float range'):
        load_pipe(path)


@pytest.mark.parametrize('literal', ['0e9999', '-0.0e-9999', '5e-324', '-5e-324', '1.7976931348623157e308'])
def test_load_pipe_preserves_supported_finite_float_values(tmp_path, literal):
    path = tmp_path / 'finite.pipe'
    path.write_text('{"components": [{"id": "a", "config": {"value": ' + literal + '}}]}', encoding='utf-8')
    pipe = load_pipe(path)
    assert pipe['components'][0]['config']['value'] == float(literal)
    json.dumps(pipe, allow_nan=False)


@pytest.mark.parametrize('number', [float('nan'), float('inf'), float('-inf')], ids=['nan', 'inf', '-inf'])
@pytest.mark.parametrize('field', ['config', 'ui', 'viewport', 'version', 'project_id'])
def test_load_pipe_dict_rejects_nonfinite_numbers_in_all_fields(number, field):
    pipe = {'components': [{'id': 'a', 'config': {}}]}
    if field in ['config', 'ui']:
        pipe['components'][0][field] = {'nested': [{'value': number}]}
    else:
        pipe[field] = {'nested': [number]}

    with pytest.raises(PipeDiffError, match='non-finite number') as error:
        load_pipe(pipe)

    assert '<dict>' in str(error.value)
    assert field in str(error.value)


def test_load_pipe_dict_numeric_validation_handles_deep_nesting_without_recursion():
    nested = float('inf')
    for _ in range(2000):
        nested = [nested]
    with pytest.raises(PipeDiffError, match='non-finite number'):
        load_pipe({'components': [{'id': 'a', 'config': {'nested': nested}}]})


def _wide_deep_config(depth=200, siblings=50, key_length=200):
    """A config whose every level carries many long keys: deep paths, wide levels."""
    root = current = {}
    for _level in range(depth):
        for sibling in range(siblings - 1):
            current[f'{sibling:03d}' + 'k' * (key_length - 3)] = 1
        current['n' * key_length] = current = {}
    return {'components': [{'id': 'a', 'provider': 'p', 'config': root}], 'version': 1}


@pytest.mark.parametrize('source', ['dict', 'file'])
def test_load_pipe_validation_memory_is_linear_in_input_size(tmp_path, source):
    # Peak memory stays proportional to the size of the input.
    pipe = _wide_deep_config()
    path = tmp_path / 'wide.pipe'
    path.write_text(json.dumps(pipe), encoding='utf-8')
    tracemalloc.start()
    try:
        load_pipe(pipe if source == 'dict' else str(path))
        peak = tracemalloc.get_traced_memory()[1]
    finally:
        tracemalloc.stop()
    assert peak < 40_000_000, f'peak {peak / 1e6:.1f} MB'


def test_load_pipe_validation_memory_grows_linearly_with_depth():
    # The absolute bound above depends on the allocator; this one does not. Doubling
    # the depth of the same wide, long-keyed shape should about double the peak, not
    # quadruple it.
    peaks = []
    for depth in (100, 200):
        pipe = _wide_deep_config(depth=depth, siblings=20, key_length=100)
        tracemalloc.start()
        try:
            load_pipe(pipe)
            peaks.append(tracemalloc.get_traced_memory()[1])
        finally:
            tracemalloc.stop()
    assert peaks[1] / peaks[0] < 3, f'peak {peaks[0] / 1e6:.2f} MB -> {peaks[1] / 1e6:.2f} MB when depth doubled'


def test_load_pipe_dict_nonfinite_error_names_the_full_path():
    pipe = {'components': [{'id': 'a', 'provider': 'p', 'config': {'outer': [{'x': 1}, {'inner': float('nan')}]}}]}
    with pytest.raises(
        PipeDiffError, match=r'<dict>: non-finite number at \$\.components\[0\]\.config\.outer\[1\]\.inner'
    ):
        load_pipe(pipe)


@pytest.mark.parametrize('shape', ['deep', 'cyclic'])
def test_diff_pipes_reports_unsupported_nesting_as_pipediff_error(shape):
    # load_pipe accepts these in-memory configs; diff_pipes must fail with the
    # library's own error, not a raw RecursionError, for library callers too.
    def build(leaf):
        if shape == 'cyclic':
            config = {'leaf': leaf}
            config['self'] = config
            return {'components': [{'id': 'a', 'provider': 'p', 'config': config}]}
        config = current = {}
        for _ in range(5000):
            current['n'] = current = {}
        current['leaf'] = leaf
        return {'components': [{'id': 'a', 'provider': 'p', 'config': config}]}

    with pytest.raises(PipeDiffError, match='too deep'):
        diff_pipes(load_pipe(build(1)), load_pipe(build(2)))


def _unsupported_nesting(shape, leaf):
    """A config that nests too deeply to compare: 5000 levels, or a cycle."""
    if shape == 'cyclic':
        config = {'leaf': leaf}
        config['self'] = config
        return config
    config = current = {}
    for _ in range(5000):
        current['n'] = current = {}
    current['leaf'] = leaf
    return config


@pytest.mark.parametrize('shape', ['deep', 'cyclic'])
def test_deep_diff_config_reports_unsupported_nesting_as_pipediff_error(shape):
    # deep_diff_config is public and recurses just like diff_pipes does, so it owes
    # library callers the same error rather than a raw RecursionError.
    with pytest.raises(PipeDiffError, match='too deep'):
        deep_diff_config(_unsupported_nesting(shape, 1), _unsupported_nesting(shape, 2))


def _unreportable(shape):
    """A value no report could serialise: it contains itself, or nests past the recursion limit."""
    if shape == 'cyclic':
        value = {}
        value['self'] = value
        return value
    return _nested(sys.getrecursionlimit() + 1)


def _nested(levels, leaf=1):
    """``leaf`` wrapped in ``levels`` lists, built without recursion."""
    for _ in range(levels):
        leaf = [leaf]
    return leaf


# Why the diff refuses each shape: the wording tells a cycle from nesting past the limit.
_REFUSAL = {'cyclic': 'refers to itself', 'deep': 'nested too deeply to report'}


# Where a value that exists on one side only ends up stored in the diff: each entry
# builds the (old, new, include_layout) a comparison needs. The value itself is never
# compared (it has no counterpart), so only the diff's own check can refuse it.
_ONE_SIDED_PLACEMENTS = {
    'config removed': lambda v: (_pipe([_node('a', 'p', {'x': v})]), _pipe([_node('a', 'p', {})]), False),
    'config added': lambda v: (_pipe([_node('a', 'p', {})]), _pipe([_node('a', 'p', {'x': v})]), False),
    'config retyped': lambda v: (_pipe([_node('a', 'p', {'x': v})]), _pipe([_node('a', 'p', {'x': 5})]), False),
    'list tail removed': lambda v: (
        _pipe([_node('a', 'p', {'x': [1, v]})]),
        _pipe([_node('a', 'p', {'x': [1]})]),
        False,
    ),
    'node removed': lambda v: (_pipe([_node('a', v)]), _pipe([]), False),
    'node added': lambda v: (_pipe([]), _pipe([_node('a', v)]), False),
    'provider changed': lambda v: (_pipe([_node('a', v)]), _pipe([_node('a', 'p')]), False),
    'version changed': lambda v: (_pipe([], version=v), _pipe([], version=2), False),
    'ui removed': lambda v: (_pipe([_node('a', 'p', ui={'x': v})]), _pipe([_node('a', 'p', ui={})]), True),
    'viewport removed': lambda v: (_pipe([], viewport={'x': v}), _pipe([], viewport={}), True),
}


@pytest.mark.parametrize('shape', ['cyclic', 'deep'])
@pytest.mark.parametrize('placement', sorted(_ONE_SIDED_PLACEMENTS))
def test_diff_pipes_refuses_a_stored_value_it_could_not_serialise(placement, shape):
    # load_pipe accepts a cyclic or deeply nested in-memory value. A comparison that
    # finds it on one side only never recurses into it, but the diff would store it
    # and every report built from it would fail, so the diff refuses it.
    old, new, include_layout = _ONE_SIDED_PLACEMENTS[placement](_unreportable(shape))
    with pytest.raises(PipeDiffError, match=_REFUSAL[shape]):
        diff_pipes(load_pipe(old), load_pipe(new), include_layout=include_layout)


@pytest.mark.parametrize('shape', ['cyclic', 'deep'])
def test_deep_diff_config_refuses_a_stored_value_it_could_not_serialise(shape):
    with pytest.raises(PipeDiffError, match=_REFUSAL[shape]):
        deep_diff_config({'x': _unreportable(shape)}, {})


def test_diff_pipes_reports_shared_and_deeply_nested_one_sided_values():
    # The check refuses cycles and nesting past the recursion limit, not repeated
    # references or deep-but-serialisable values. A 600-deep value (a valid .pipe file
    # can hold one, and the CLI reports it) is well inside the limit.
    shared = [1, 2]
    deep = _nested(600)
    old = _pipe([_node('a', 'p', {'x': {'first': shared, 'second': shared}, 'y': deep})])
    new = _pipe([_node('a', 'p', {})])

    diff = diff_pipes(load_pipe(old), load_pipe(new))

    assert [(f.path, f.kind) for f in diff.node_changes[0].field_changes] == [
        ('config.x', 'removed'),
        ('config.y', 'removed'),
    ]
    json.dumps(render_json(diff), sort_keys=True)


def test_a_shared_value_counts_at_every_depth_it_is_reached_from():
    # A container met a second time is not walked again, but its height still counts
    # where it is met now: the same chain is fine beside itself and too deep once one
    # reference sits a few levels further down.
    chain = _nested(sys.getrecursionlimit() - 5)

    def removed(value):
        return diff_pipes(load_pipe(_pipe([_node('a', 'p', {'x': value})])), load_pipe(_pipe([_node('a', 'p', {})])))

    assert removed([chain, chain]).node_changes  # reported, both references fit
    with pytest.raises(PipeDiffError, match=_REFUSAL['deep']):
        removed([chain, _nested(5, chain)])


def test_load_pipe_reports_unparseably_deep_json_file_as_pipediff_error(tmp_path):
    # The JSON scanner gives up with a RecursionError long before 100,000 levels.
    path = tmp_path / 'deep.pipe'
    path.write_text('{"components": [{"id": "a", "config": ' + '[' * 100_000 + ']' * 100_000 + '}]}', encoding='utf-8')
    with pytest.raises(PipeDiffError, match='Invalid JSON') as error:
        load_pipe(path)
    assert str(path) in str(error.value)


@pytest.mark.skipif(
    not getattr(sys, 'get_int_max_str_digits', lambda: 0)(), reason='this interpreter has no integer digit limit'
)
def test_load_pipe_reports_an_integer_beyond_the_decoder_limit_as_pipediff_error(tmp_path):
    path = tmp_path / 'huge.pipe'
    digits = sys.get_int_max_str_digits() + 1
    path.write_text('{"components": [{"id": "a", "config": {"value": ' + '1' * digits + '}}]}', encoding='utf-8')
    with pytest.raises(PipeDiffError, match='Invalid JSON') as error:
        load_pipe(path)
    assert str(path) in str(error.value)


def test_load_pipe_dict_preserves_large_exact_integers():
    value = 10**400
    pipe = {'components': [{'id': 'a', 'config': {'value': value}}]}
    assert load_pipe(pipe)['components'][0]['config']['value'] == value


def test_load_pipe_keeps_normal_binary64_rounding(tmp_path):
    old_path, new_path = tmp_path / 'old.pipe', tmp_path / 'new.pipe'
    for path, literal in [(old_path, '0.1'), (new_path, '0.10000000000000001')]:
        path.write_text('{"components": [{"id": "a", "config": {"value": ' + literal + '}}]}', encoding='utf-8')
    assert diff_pipes(load_pipe(old_path), load_pipe(new_path)).has_semantic_changes is False


def test_a_repeated_json_key_means_its_last_value(tmp_path):
    # Python's json, JSON.parse and the engine's own reader (jsoncpp, with
    # rejectDupKeys off) all keep the last value of a repeated key, so the diff
    # compares exactly what the engine would run.
    path = tmp_path / 'repeated.pipe'
    path.write_text(
        '{"components": [{"id": "a", "provider": "x", "provider": "y", "config": {"k": 1, "k": 2}}]}',
        encoding='utf-8',
    )
    component = load_pipe(str(path))['components'][0]
    assert component['provider'] == 'y'
    assert component['config'] == {'k': 2}


# ---------------------------------------------------------------------------
# Wire (input/control) validation
# ---------------------------------------------------------------------------


def test_load_pipe_input_not_a_list_raises():
    with pytest.raises(PipeDiffError, match="field 'input' must be a list"):
        load_pipe({'components': [{'id': 'a', 'input': {'from': 'b', 'lane': 'text'}}]})


def test_load_pipe_control_not_a_list_raises():
    with pytest.raises(PipeDiffError, match="field 'control' must be a list"):
        load_pipe({'components': [{'id': 'a', 'control': 'llm_1'}]})


def test_load_pipe_wire_not_an_object_raises():
    with pytest.raises(PipeDiffError, match=r'input\[0\] is not an object'):
        load_pipe({'components': [{'id': 'a', 'input': ['b']}]})


def test_load_pipe_wire_missing_from_raises():
    with pytest.raises(PipeDiffError, match=r"input\[0\] is missing a string 'from'"):
        load_pipe({'components': [{'id': 'a', 'input': [{'lane': 'text'}]}]})


def test_load_pipe_wire_from_is_a_list_raises():
    with pytest.raises(PipeDiffError, match=r"input\[0\] is missing a string 'from'"):
        load_pipe({'components': [{'id': 'a', 'input': [{'from': ['b'], 'lane': 'text'}]}]})


def test_load_pipe_wire_missing_lane_raises():
    with pytest.raises(PipeDiffError, match=r"input\[1\] is missing a string 'lane'"):
        load_pipe(
            {
                'components': [
                    {
                        'id': 'a',
                        'input': [{'from': 'b', 'lane': 'text'}, {'from': 'c'}],
                    }
                ]
            }
        )


def test_load_pipe_control_wire_missing_classtype_raises():
    with pytest.raises(PipeDiffError, match=r"control\[0\] is missing a string 'classType'"):
        load_pipe({'components': [{'id': 'a', 'control': [{'from': 'b'}]}]})


def test_load_pipe_accepts_absent_wire_collections():
    pipe = {'components': [{'id': 'a'}, {'id': 'b', 'input': [], 'control': []}]}
    assert load_pipe(pipe) is pipe


# ---------------------------------------------------------------------------
# Canvas groups
# ---------------------------------------------------------------------------


def _group(group_id, children, config=None, ui=None):
    """Build a canvas group the way the editor saves one.

    ``getProjectComponents`` (apps/shared canvas util/graph.ts) nests a group's
    children under the group's ``config.pipeline.components``, each with its own
    ``ui`` block (position relative to the group, plus ``parentId``), and omits
    ``config.pipeline`` entirely when the group is empty.
    """
    group_config = dict(config or {})
    if children:
        group_config['pipeline'] = {'components': children}
    return {
        'id': group_id,
        'provider': 'default',
        'config': group_config,
        'ui': ui if ui is not None else {'position': {'x': 100, 'y': 340}, 'nodeType': 'group'},
    }


def _child(component_id, provider, parent, x=20, **kwargs):
    """Build a grouped child component whose ui records its parent group."""
    return _node(
        component_id, provider, ui={'position': {'x': x, 'y': 40}, 'nodeType': 'default', 'parentId': parent}, **kwargs
    )


def _grouped_pipe(
    child_x=20, lane='questions', provider='llm_openai', child_config=None, extra_children=(), group_config=None
):
    """A source node feeding an llm that lives inside ``group_1``."""
    llm = _child(
        'llm_1', provider, 'group_1', x=child_x, config=child_config, inputs=[{'lane': lane, 'from': 'chat_1'}]
    )
    return _pipe(
        [
            _node('chat_1', 'chat', {'mode': 'Source'}),
            _group('group_1', [*extra_children, llm], config=group_config),
        ]
    )


def test_drag_inside_a_group_is_layout_only():
    diff = diff_pipes(_grouped_pipe(child_x=20), _grouped_pipe(child_x=60))
    assert diff.node_changes == []
    assert diff.edge_changes == []
    assert diff.layout_changed is True
    assert diff.has_semantic_changes is False


def test_include_layout_reports_a_grouped_child_ui_on_the_child():
    diff = diff_pipes(_grouped_pipe(child_x=20), _grouped_pipe(child_x=60), include_layout=True)
    assert [(c.id, c.kind, [f.path for f in c.field_changes]) for c in diff.node_changes] == [
        ('llm_1', 'config', ['ui.position.x'])
    ]


def test_grouped_child_wiring_is_diffed_as_edges():
    diff = diff_pipes(_grouped_pipe(lane='questions'), _grouped_pipe(lane='text'))
    assert diff.node_changes == []
    assert diff.edge_changes == [
        EdgeChange(from_id='chat_1', lane='text', to_id='llm_1', kind='added'),
        EdgeChange(from_id='chat_1', lane='questions', to_id='llm_1', kind='removed'),
    ]


def test_grouped_child_provider_and_config_changes_are_reported_on_the_child():
    old = _grouped_pipe(provider='llm_openai', child_config={'model': 'a'})
    new = _grouped_pipe(provider='llm_anthropic', child_config={'model': 'b'})
    diff = diff_pipes(old, new)
    assert [(c.id, c.provider_old, c.provider_new) for c in _changes_by_kind(diff, 'provider')] == [
        ('llm_1', 'llm_openai', 'llm_anthropic')
    ]
    assert [(c.id, [f.path for f in c.field_changes]) for c in _changes_by_kind(diff, 'config')] == [
        ('llm_1', ['config.model'])
    ]


def test_child_inserted_into_a_group_is_an_added_node():
    # Children are matched by id, not by their index in config.pipeline.components.
    memory = _child('memory_1', 'memory_internal', 'group_1', x=200)
    diff = diff_pipes(_grouped_pipe(), _grouped_pipe(extra_children=[memory]))
    assert [(c.id, c.kind, c.provider_new) for c in diff.node_changes] == [('memory_1', 'added', 'memory_internal')]
    assert diff.edge_changes == []


def test_moving_a_node_into_a_group_is_layout_only():
    # Group membership is the child's ``ui.parentId``: a canvas attribute.
    llm_top_level = _node(
        'llm_1', 'llm_openai', inputs=[{'lane': 'questions', 'from': 'chat_1'}], ui={'position': {'x': 120, 'y': 380}}
    )
    memory = _child('memory_1', 'memory_internal', 'group_1', x=200)
    old = _pipe([_node('chat_1', 'chat'), llm_top_level, _group('group_1', [memory])])
    llm_grouped = _child('llm_1', 'llm_openai', 'group_1', inputs=[{'lane': 'questions', 'from': 'chat_1'}])
    new = _pipe([_node('chat_1', 'chat'), _group('group_1', [memory, llm_grouped])])
    diff = diff_pipes(old, new)
    assert diff.node_changes == []
    assert diff.edge_changes == []
    assert diff.layout_changed is True


def test_emptying_a_group_reports_only_the_removed_children():
    # The editor omits config.pipeline once a group has no children.
    old = _grouped_pipe()
    new = _pipe([_node('chat_1', 'chat', {'mode': 'Source'}), _group('group_1', [])])
    diff = diff_pipes(old, new)
    assert [(c.id, c.kind) for c in diff.node_changes] == [('llm_1', 'removed')]
    assert diff.edge_changes == [EdgeChange(from_id='chat_1', lane='questions', to_id='llm_1', kind='removed')]


def test_group_container_config_outside_its_children_is_still_diffed():
    old = _grouped_pipe(group_config={'label': 'a'})
    new = _grouped_pipe(group_config={'label': 'b'})
    new['components'][1]['config']['pipeline']['source'] = 'llm_1'
    diff = diff_pipes(old, new)
    assert [(c.id, [(f.path, f.kind, f.new) for f in c.field_changes]) for c in _changes_by_kind(diff, 'config')] == [
        ('group_1', [('config.label', 'changed', 'b'), ('config.pipeline', 'added', {'source': 'llm_1'})])
    ]


def test_nested_groups_are_flattened():
    def build(x, lane):
        llm = _child('llm_1', 'llm_openai', 'inner', x=x, inputs=[{'lane': lane, 'from': 'chat_1'}])
        inner = _group('inner', [llm], ui={'position': {'x': 10, 'y': 10}, 'nodeType': 'group', 'parentId': 'outer'})
        return _pipe([_node('chat_1', 'chat'), _group('outer', [inner])])

    moved = diff_pipes(build(20, 'questions'), build(60, 'questions'))
    assert moved.has_semantic_changes is False
    assert moved.layout_changed is True
    rewired = diff_pipes(build(20, 'questions'), build(20, 'text'))
    assert [(e.lane, e.kind) for e in rewired.edge_changes] == [('text', 'added'), ('questions', 'removed')]


def test_deeply_nested_groups_do_not_hit_the_recursion_limit():
    def build(x):
        node = _child('leaf', 'llm_openai', 'g2999', x=x)
        for level in reversed(range(3000)):
            node = _group(f'g{level}', [node])
        return {'components': [node], 'version': 1}

    diff = diff_pipes(load_pipe(build(20)), load_pipe(build(60)))
    assert diff.has_semantic_changes is False
    assert diff.layout_changed is True


def test_diff_pipes_neither_mutates_nor_remembers_its_inputs():
    # The id index and edge set are built per comparison. Nothing is cached on the
    # caller's dicts or between calls, so an edit is seen by the next comparison.
    old, new = _grouped_pipe(lane='questions'), _grouped_pipe(lane='questions')
    old_before, new_before = copy.deepcopy(old), copy.deepcopy(new)

    assert diff_pipes(old, new).edge_changes == []
    assert (old, new) == (old_before, new_before)

    new['components'][1]['config']['pipeline']['components'][0]['input'][0]['lane'] = 'text'
    assert [(e.lane, e.kind) for e in diff_pipes(old, new).edge_changes] == [
        ('text', 'added'),
        ('questions', 'removed'),
    ]
    assert old == old_before


def test_control_wiring_of_a_grouped_child_is_diffed_as_edges():
    def build(class_type):
        agent = _child('agent_1', 'agent_crewai', 'group_1', control=[{'classType': class_type, 'from': 'llm_1'}])
        return _pipe([_node('llm_1', 'llm_openai'), _group('group_1', [agent])])

    diff = diff_pipes(build('llm'), build('tool'))
    assert diff.node_changes == []
    assert diff.edge_changes == [
        EdgeChange(from_id='llm_1', lane='tool', to_id='agent_1', kind='added'),
        EdgeChange(from_id='llm_1', lane='llm', to_id='agent_1', kind='removed'),
    ]


def test_diff_pipes_terminates_on_an_unvalidated_group_that_contains_itself():
    # load_pipe rejects this; diff_pipes takes whatever dicts it is given and must
    # still end, expanding the group once.
    def build(provider):
        group = _group('group_1', [])
        group['provider'] = provider
        group['config']['pipeline'] = {'components': [group]}
        return _pipe([group])

    diff = diff_pipes(build('a'), build('b'))
    assert [(c.id, c.kind) for c in diff.node_changes] == [('group_1', 'provider')]


def test_a_group_that_contains_itself_is_rejected_not_looped():
    group = _group('group_1', [])
    group['config']['pipeline'] = {'components': [group]}
    with pytest.raises(PipeDiffError, match="duplicate component id 'group_1'"):
        load_pipe(_pipe([group]))


def test_grouped_child_ids_must_be_unique_across_levels():
    pipe = _pipe([_node('llm_1', 'llm_openai'), _group('group_1', [_child('llm_1', 'llm_openai', 'group_1')])])
    with pytest.raises(PipeDiffError, match="duplicate component id 'llm_1'.*group_1"):
        load_pipe(pipe)


@pytest.mark.parametrize(
    ('child', 'message'),
    [
        ('not-an-object', "'group_1' config.pipeline.components\\[0\\] is not an object"),
        ({'provider': 'x'}, "'group_1' config.pipeline.components\\[0\\] is missing a string 'id'"),
        ({'id': 'c', 'input': 'oops'}, "component 'c' field 'input' must be a list"),
    ],
    ids=['non-object', 'missing-id', 'bad-wires'],
)
def test_malformed_grouped_children_are_rejected(child, message):
    with pytest.raises(PipeDiffError, match=message):
        load_pipe(_pipe([_group('group_1', [child])]))


def test_duplicate_id_message_names_both_locations_at_every_nesting_level():
    pipe = _pipe([_group('g1', [_child('x', 'p', 'g1')]), _group('g2', [_child('x', 'p', 'g2')])])
    with pytest.raises(PipeDiffError) as error:
        load_pipe(pipe)
    assert str(error.value) == (
        "<dict>: duplicate component id 'x' at 'g2' config.pipeline.components[0] "
        "(already used at 'g1' config.pipeline.components[0])"
    )
    pipe = _pipe([_node('x', 'p'), _node('y', 'p'), _node('x', 'p')])
    with pytest.raises(PipeDiffError) as error:
        load_pipe(pipe)
    assert str(error.value) == "<dict>: duplicate component id 'x' at index 2 (already used at index 0)"


def test_components_are_checked_in_document_order_through_nested_groups():
    # A group comes before its children, which come before the next top-level component
    inner = _group('inner', [_child('c', 'p', 'inner'), _child('d', 'p', 'inner')])
    outer = _group('outer', [_child('a', 'p', 'outer'), inner, _child('b', 'p', 'outer')])

    for repeated, first_seen, later in [
        ('first', 'index 0', 'index 3'),
        ('c', "'inner' config.pipeline.components[0]", 'index 3'),
        ('b', "'outer' config.pipeline.components[2]", 'index 3'),
    ]:
        pipe = _pipe([_node('first', 'p'), outer, _node('last', 'p'), _node(repeated, 'p')])
        with pytest.raises(PipeDiffError) as error:
            load_pipe(pipe)
        assert str(error.value) == (
            f"<dict>: duplicate component id '{repeated}' at {later} (already used at {first_seen})"
        )


def test_a_long_group_id_is_not_repeated_for_every_child():
    # A group with a very long id and many children must not cost memory in
    # proportion to the product of the two: the group id is not repeated per child.
    group_id = 'g' * 100_000
    pipe = _pipe([_group(group_id, [{'id': f'c{index}', 'provider': 'p'} for index in range(2_000)])])
    tracemalloc.start()
    try:
        loaded = load_pipe(pipe)
        diff_pipes(loaded, loaded)
        peak = tracemalloc.get_traced_memory()[1]
    finally:
        tracemalloc.stop()
    assert peak < 20_000_000, f'peak {peak / 1e6:.1f} MB'


def test_a_long_group_id_in_a_file_is_not_repeated_for_every_child(tmp_path):
    group_id = 'g' * 100_000
    path = tmp_path / 'wide-group.pipe'
    path.write_text(
        json.dumps(_pipe([_group(group_id, [{'id': f'c{index}', 'provider': 'p'} for index in range(2_000)])])),
        encoding='utf-8',
    )
    tracemalloc.start()
    try:
        load_pipe(str(path))
        peak = tracemalloc.get_traced_memory()[1]
    finally:
        tracemalloc.stop()
    assert peak < 20_000_000, f'peak {peak / 1e6:.1f} MB'


# ---------------------------------------------------------------------------
# Public error type, and a real bundled example
# ---------------------------------------------------------------------------


def test_pipediff_error_is_reported_under_its_public_name_and_pickles():
    assert PipeDiffError.__module__ == 'rocketride.pipediff'
    restored = pickle.loads(pickle.dumps(PipeDiffError('boom')))
    assert type(restored) is PipeDiffError
    assert str(restored) == 'boom'


def test_diff_of_real_example_against_itself_is_empty(examples_dir):
    path = examples_dir / 'rag-pipeline.pipe'
    if not path.exists():
        pytest.skip('bundled example not available')
    pipe = load_pipe(str(path))
    diff = diff_pipes(pipe, copy.deepcopy(pipe))
    assert diff.has_semantic_changes is False
    assert diff.layout_changed is False


if __name__ == '__main__':
    raise SystemExit(pytest.main([__file__, '-v']))
