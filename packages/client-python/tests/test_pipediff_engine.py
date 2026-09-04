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
from pathlib import Path

import pytest

from rocketride.pipediff import (
    EdgeChange,
    PipeDiffError,
    deep_diff_config,
    diff_pipes,
    load_pipe,
)


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
    # `_layout_changed` and the viewport field diff must normalize identically:
    # an omitted or null viewport is the same canvas as {}. Comparing the raw
    # values set layout_changed while producing no viewport.* paths, so
    # --include-layout claimed a layout change yet exited 0 with nothing to show.
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
    # Only None normalizes to {}. A blanket `or {}` also folded the non-null
    # falsy JSON values false/0/"" into {} -- all of which `load_pipe` accepts --
    # so `viewport: false` vs `viewport: {}` reported no change and exited 0 even
    # under --include-layout.
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
    # Python treats False == 0 and True == 1, so a plain `!=` missed a JSON
    # false -> 0 edit: layout_changed stayed False, no viewport change was
    # reported, and --include-layout exited 0. Equality must be JSON-typed.
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
    # _diff_value is shared with the config diff, so the same rule applies there:
    # a config flag flipping from false to 0 is a real change, and equal typed
    # values (including nested ones) still compare equal.
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
    # Components are matched by id, and indexing by id keeps only the last one.
    # A duplicate would therefore hide the first node and every change to it, so
    # it has to be an actionable error rather than a quietly wrong diff.
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
    # UnicodeDecodeError is a ValueError, not an OSError, so without an explicit
    # handler it escaped load_pipe() as a raw traceback for library callers.
    path = tmp_path / 'bad-utf8.pipe'
    path.write_bytes(b'\xff\xfe{"components": []}')
    with pytest.raises(PipeDiffError, match='not valid UTF-8'):
        load_pipe(str(path))


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
    # An unhashable 'from' used to blow up inside set.add during edge extraction.
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
# End-to-end against a real bundled example
# ---------------------------------------------------------------------------


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
