# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Sample-window tests for agent_rocketride structural summaries (#2032).

Tool results are injected into the planning prompt as a structural summary. For a
list of dicts that summary showed a fixed two rows, so a find-by-name task over a
larger result could never see its target: the planner re-ran the search, saw two
of N again, and looped to max_waves. One observed run made 26 drive.file_search
calls and burned roughly 400k tokens without converging.

The window is now driven by a character budget, so narrow rows are listed in full
while wide rows still stop at two, and the header reports a partial sample so the
planner knows to peek rather than search again.

executor.py is loaded from source with rocketlib and ai.common.* stubbed, so no
engine, model or key is involved.
"""

import importlib.util
import os
import sys
import types

_HERE = os.path.dirname(os.path.abspath(__file__))
_NODE_DIR = os.path.join(_HERE, '..', '..', 'src', 'nodes', 'agent_rocketride')
_PKG = 'agent_rocketride'


def _load_executor():
    """Load the node's executor module with its engine dependencies stubbed.

    Returns:
        The executor module. sys.modules is left as it was found.
    """
    stubs = {
        'rocketlib': types.ModuleType('rocketlib'),
        'ai': types.ModuleType('ai'),
        'ai.common': types.ModuleType('ai.common'),
        'ai.common.agent': types.ModuleType('ai.common.agent'),
        'ai.common.schema': types.ModuleType('ai.common.schema'),
    }
    stubs['rocketlib'].debug = lambda *a, **kw: None
    stubs['rocketlib'].error = lambda *a, **kw: None
    stubs['ai.common.agent'].AgentBase = type('AgentBase', (), {})
    stubs['ai.common.agent'].AgentContext = type('AgentContext', (), {})
    stubs['ai.common.schema'].Question = type('Question', (), {})

    saved = {name: sys.modules.get(name) for name in stubs}
    saved_pkg = {k: v for k, v in sys.modules.items() if k == _PKG or k.startswith(_PKG + '.')}
    sys.modules.update(stubs)

    try:
        pkg_spec = importlib.util.spec_from_file_location(
            _PKG, os.path.join(_NODE_DIR, '__init__.py'), submodule_search_locations=[_NODE_DIR]
        )
        # Registered but not executed: the relative imports only need the package to exist.
        sys.modules[_PKG] = importlib.util.module_from_spec(pkg_spec)

        for sub in ('formatters', 'executor'):
            spec = importlib.util.spec_from_file_location(f'{_PKG}.{sub}', os.path.join(_NODE_DIR, f'{sub}.py'))
            mod = importlib.util.module_from_spec(spec)
            sys.modules[f'{_PKG}.{sub}'] = mod
            spec.loader.exec_module(mod)

        return sys.modules[f'{_PKG}.executor']
    finally:
        for name in stubs:
            if saved[name] is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = saved[name]
        for mod_name in [k for k in sys.modules if k == _PKG or k.startswith(_PKG + '.')]:
            sys.modules.pop(mod_name, None)
        sys.modules.update(saved_pkg)


def _drive_files(count, target_index=None, target_name='Email Template.docx'):
    """Build a Drive-style file listing, optionally naming one row as the lookup target.

    Args:
        count: How many files to generate.
        target_index: Index to give target_name, or None for none.
        target_name: The name a find-by-name task is looking for.

    Returns:
        A list of {id, name, mimeType} dicts.
    """
    rows = []
    for i in range(count):
        name = target_name if i == target_index else f'Document {i}.docx'
        rows.append(
            {
                'id': f'1AbCdEfGhIjKlMnOpQrStUvWxYz{i:04d}',
                'name': name,
                'mimeType': 'application/vnd.google-apps.document',
            }
        )
    return rows


def test_narrow_rows_are_listed_in_full():
    """A default-sized Drive page is fully visible, which is what lets a lookup converge.

    file_search defaults to pageSize 25. Showing two of those was the #2032 loop.
    """
    executor = _load_executor()
    files = _drive_files(25, target_index=17)

    summary = executor._describe(files)

    assert '25 items' in summary
    assert 'Email Template.docx' in summary, (
        'the target sits at row 17 of 25 and is absent from the summary, so the planner '
        'cannot answer the lookup and will search again'
    )
    assert 'showing' not in summary, 'nothing was omitted, so the header should not claim a partial sample'


def test_wide_rows_still_stop_at_two():
    """Context economy is preserved: two wide rows exhaust the budget between them.

    Width here means field count, not value length. Long strings are already
    truncated to 80 characters by _describe, so they cost little on their own.
    """
    executor = _load_executor()
    wide = [{f'field_{k}': f'value for field {k}' for k in range(80)} for _ in range(10)]

    summary = executor._describe(wide)

    assert summary.count('row[') == 2
    assert '(showing 2 of 10)' in summary


def test_partial_sample_is_labelled():
    """When rows are omitted the header says so, so the planner knows to peek."""
    executor = _load_executor()
    rows = [{'body': 'y' * 500, 'index': i} for i in range(40)]

    summary = executor._describe(rows)

    shown = summary.count('row[')
    assert shown < 40
    assert f'(showing {shown} of 40)' in summary


def test_small_result_is_unchanged():
    """A two-row result renders exactly as before, with no partial-sample header."""
    executor = _load_executor()
    rows = [{'a': 1}, {'a': 2}]

    summary = executor._describe(rows)

    assert summary.count('row[') == 2
    assert 'showing' not in summary


def test_row_budget_bounds_the_summary():
    """A large narrow result stays bounded rather than inlining every row."""
    executor = _load_executor()
    files = _drive_files(5000)

    summary = executor._describe(files)

    assert len(summary) < executor._SUMMARY_ROW_BUDGET * 2
    assert summary.count('row[') < 5000
    assert '5000 items' in summary


def test_field_names_and_item_count_survive():
    """The schema header the LLM uses to build a JMESPath is still emitted."""
    executor = _load_executor()

    summary = executor._describe(_drive_files(3))

    assert summary.startswith("3 items, fields: ['id', 'name', 'mimeType']")


def test_empty_and_non_dict_lists_are_untouched():
    """Only the list-of-dicts branch changed."""
    executor = _load_executor()

    assert executor._describe([]) == '[] (0 items)'
    assert executor._describe([1, 2, 3, 4]) == '4 items, sample: [1, 2, 3]'


def test_a_scalar_after_the_first_row_does_not_crash():
    """The list-of-dicts branch is chosen from the first item alone.

    A scalar later in the list used to be out of reach because only two rows were
    ever rendered. Widening the window made it reachable, so it has to be handled.
    """
    executor = _load_executor()

    summary = executor._describe([{'a': 1}, {'a': 2}, 42, {'a': 4}])

    assert '4 items' in summary
    assert '42' in summary, 'the scalar row should still be described, not dropped'


def test_a_self_referential_result_is_summarised_rather_than_lost():
    """A cycle used to recurse until RecursionError, which cost the tool its result.

    The executor catches it, so the run survived, but the planner saw a recursion
    error instead of the data the tool actually returned.
    """
    executor = _load_executor()
    result = {'rows': [{'a': 1}]}
    result['self'] = result

    summary = executor._describe(result)

    assert 'rows' in summary
    assert '...' in summary, 'the cycle should terminate in a marker, not an exception'


def test_a_pathologically_deep_result_terminates():
    """The same cap covers depth that is legitimate but far past useful."""
    executor = _load_executor()
    deep = cursor = {}
    for _ in range(2000):
        cursor['n'] = {}
        cursor = cursor['n']

    summary = executor._describe(deep)

    assert summary.count('n:') <= executor._SUMMARY_MAX_DEPTH + 1
    assert summary.endswith('...')


def test_ordinary_nesting_is_untouched_by_the_cap():
    """The cap must not truncate the shapes real results actually have."""
    executor = _load_executor()

    summary = executor._describe([{'id': 'x', 'meta': {'name': 'y', 'tags': ['a']}}])

    assert '...' not in summary
    assert '"y"' in summary


class _RecordingMemory:
    """Memory channel that records what was stored, mirroring the {ok} contract."""

    def __init__(self):
        self.store = {}

    def put(self, key, value):
        self.store[key] = value
        return {'ok': True}


class _FakeContext:
    def __init__(self):
        self.memory = _RecordingMemory()


class _FakeAgent:
    def __init__(self):
        self.seen_results = {}


def test_a_cyclic_result_is_not_reported_as_an_error():
    """A cycle survived the summary but was still lost when it reached the fingerprint.

    memory.put has already succeeded by then, so raising here would tell the planner
    the tool failed while its result sat in memory, unreachable.
    """
    executor = _load_executor()
    result = {'rows': [{'a': 1}]}
    result['self'] = result
    context, agent = _FakeContext(), _FakeAgent()

    entry = executor._store_and_preview('drive.list', 'wave-0.r0', result, context, agent)

    assert 'error' not in entry
    assert entry['key'] == 'wave-0.r0'
    assert 'rows' in entry['summary']
    assert context.memory.store['wave-0.r0'] is result
    assert agent.seen_results == {}, 'an unfingerprintable result must not claim a slot'


def test_fingerprinting_still_flags_a_repeat_of_an_encodable_result():
    """Skipping the cycle must not disable detection for everything after it."""
    executor = _load_executor()
    context, agent = _FakeContext(), _FakeAgent()
    result = {'rows': [{'a': 1}]}

    first = executor._store_and_preview('drive.list', 'wave-0.r0', result, context, agent)
    second = executor._store_and_preview('drive.list', 'wave-1.r0', result, context, agent)

    assert 'deduplicated' not in first
    assert second['deduplicated'] is True
    assert 'wave-0.r0' in second['note']
