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
import random
import re
import sys
import types

import pytest

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

        for sub in ('formatters', 'run_state', 'executor'):
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
    Rows are shown whole or not at all, so the rows here are sized for two to fit
    the budget and a third not to.
    """
    executor = _load_executor()
    wide = [{f'field_{k}': f'value for field {k}' for k in range(40)} for _ in range(10)]

    summary = executor._describe(wide)

    assert summary.count('row[') == 2
    assert '(showing 2 of 10)' in summary
    assert len(summary) <= executor._SUMMARY_BUDGET


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

    assert len(summary) <= executor._SUMMARY_HARD_CAP
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

    entry = executor._store_and_preview('drive.list', 'wave-0.r0', result, context, agent.seen_results)

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

    first = executor._store_and_preview('drive.list', 'wave-0.r0', result, context, agent.seen_results)
    second = executor._store_and_preview('drive.list', 'wave-1.r0', result, context, agent.seen_results)

    assert 'deduplicated' not in first
    assert second['deduplicated'] is True
    assert 'wave-0.r0' in second['note']


def test_a_result_with_unorderable_keys_is_not_reported_as_an_error():
    """sort_keys raises TypeError on keys it cannot order, which default= never covers.

    A dict keyed by both an int and a string comes back from any tool that returns row
    indexes beside named metadata. As with a cycle, memory.put has already succeeded,
    so raising here would report a working tool as failed.
    """
    executor = _load_executor()
    result = {1: 'first', 'name': 'mixed'}
    context, agent = _FakeContext(), _FakeAgent()

    entry = executor._store_and_preview('db.query', 'wave-0.r0', result, context, agent.seen_results)

    assert 'error' not in entry
    assert context.memory.store['wave-0.r0'] is result
    assert agent.seen_results == {}, 'an unfingerprintable result must not claim a slot'


def test_a_result_with_an_unencodable_key_is_not_reported_as_an_error():
    """The other TypeError from sort_keys: a key json cannot encode at all."""
    executor = _load_executor()
    result = {(1, 2): 'tuple key'}
    context, agent = _FakeContext(), _FakeAgent()

    entry = executor._store_and_preview('db.query', 'wave-0.r0', result, context, agent.seen_results)

    assert 'error' not in entry
    assert context.memory.store['wave-0.r0'] is result
    assert agent.seen_results == {}


def test_many_list_fields_cannot_exceed_the_summary_cap():
    """Each list used to get its own budget, so a result with twenty of them paid twenty times.

    The summary is resent in every planning prompt, so this is charged once per wave.
    """
    executor = _load_executor()
    wide = {f'field_{i}': _drive_files(200) for i in range(20)}

    summary = executor._describe(wide)

    assert len(summary) <= executor._SUMMARY_HARD_CAP, (
        f'summary is {len(summary)} chars; a per-list budget lets a wide result grow without bound'
    )


def test_summary_does_not_depend_on_key_order():
    """A noisy field must not spend the budget a later field needs to be answerable."""
    executor = _load_executor()
    noise = [{'ts': f'10:{i:02d}', 'msg': 'x' * 60} for i in range(300)]
    files = _drive_files(25, target_index=17)

    noise_first = executor._describe({'log': noise, 'files': files})
    files_first = executor._describe({'files': files, 'log': noise})

    assert ('Email Template.docx' in noise_first) == ('Email Template.docx' in files_first), (
        'the same result answers the lookup or not depending on key order'
    )
    assert len(noise_first) == len(files_first)


def test_a_page_token_beside_a_list_costs_the_list_only_its_length():
    """A Drive search with a next page: {files, nextPageToken}.

    An equal split gave the token half the budget, so a 25-file result showed 5 rows
    instead of 11 and the find-by-name window #2072 tuned shrank. A text that needs less
    than its equal share now takes only what it needs.
    """
    executor = _load_executor()
    files = _drive_files(25, target_index=17)
    next_page = 'page-2-of-the-search-results-' * 6

    alone = executor._describe({'files': files})
    beside = executor._describe({'files': files, 'nextPageToken': next_page})

    assert f'nextPageToken: "{next_page}"' in beside, 'the token itself is shown whole'
    assert beside.count('row[') >= alone.count('row[') - 1, 'the token took more than its length'
    assert 'Email Template.docx' in beside


def test_a_long_item_in_a_plain_list_cannot_push_out_the_exit_code():
    """A plain list's sample is cut to its share like any text.

    One 5,000-character warning beside a long stdout used to print whole, and the
    hard cap then cut exit_code.
    """
    executor = _load_executor()
    result = {'stdout': 'o' * 10_000, 'warnings': ['w' * 5_000], 'exit_code': 1}

    summary = executor._describe(result)

    assert 'exit_code: 1' in summary
    assert 'peek the key for the rest' not in summary, 'nothing was left out'
    assert len(summary) <= executor._SUMMARY_HARD_CAP


def test_wide_rows_beside_a_long_output_cannot_push_out_the_status():
    """A list always shows its first two rows, so it can go past its share.

    The dict then lists its short fields first, so the cap cuts the rows, not stderr
    or exit_code.
    """
    executor = _load_executor()
    row = {f'k{i:02d}': 'd' * 80 for i in range(28)}
    stderr = 'PermissionError: ' + 'e' * 103
    result = {'stdout': 'o' * 10_000, 'details': [row, row, row], 'stderr': stderr, 'exit_code': 1}

    summary = executor._describe(result)

    assert 'exit_code: 1' in summary
    assert f'stderr: "{stderr}"' in summary, 'a stderr longer than a row still gets all it needs'
    assert len(summary) <= executor._SUMMARY_HARD_CAP


def test_a_nested_status_cannot_be_pushed_out_by_a_payload_that_went_over():
    """A container that goes past its share is cut there, so a status after it still fits.

    Inside the status dict the same rule holds: its exit code is short and stays.
    """
    executor = _load_executor()
    row = {f'k{i:02d}': 'd' * 80 for i in range(28)}
    rows = [row, row, row]

    small = executor._describe({'payload': {'stdout': 'o' * 10_000, 'details': rows}, 'status': {'exit_code': 1}})
    wide = executor._describe(
        {'payload': {'stdout': 'o' * 10_000, 'details': rows}, 'status': {'exit_code': 1, 'details': rows}}
    )

    for summary in (small, wide):
        assert 'exit_code: 1' in summary
        assert 'peek the key for the rest' not in summary, 'each container kept to its share'
        assert len(summary) <= executor._SUMMARY_HARD_CAP


def test_a_small_status_among_many_long_fields_keeps_its_exit_code():
    """A dict is never cut to its share: its fields are short, and cutting would drop the exit code."""
    executor = _load_executor()
    result = {f'out{i:02d}': 'x' * 81 for i in range(50)}
    result['status'] = {'stderr': 'Permission denied', 'exit_code': 1}

    summary = executor._describe(result)

    assert 'exit_code: 1' in summary
    assert 'stderr: "Permission denied"' in summary


def test_a_status_longer_than_a_row_keeps_its_short_fields():
    """A status dict too big to be a fixed cost still keeps its short fields when it is cut."""
    executor = _load_executor()
    result = {f'out{i:02d}': 'x' * 81 for i in range(50)}
    result['status'] = {'stderr': 'e' * 70, 'exit_code': 1}

    summary = executor._describe(result)

    assert 'exit_code: 1' in summary
    assert f'stderr: "{"e" * 70}"' in summary


@pytest.mark.parametrize('nested', [False, True])
def test_a_sampled_list_shows_the_rows_its_header_counts(nested):
    """The header, its notice and the newlines between rows count against the list's budget."""
    executor = _load_executor()
    rows = [{'a': 1}] * 400
    value = {'rows': rows, 'note': 'x' * 300} if nested else rows

    summary = executor._describe(value)

    shown = int(re.search(r'\(showing (\d+) of 400\)', summary).group(1))
    assert len(re.findall(r'^\s*row\[\d+\]:$', summary, flags=re.M)) == shown
    assert 'cut at' not in summary


def test_a_status_nested_two_levels_down_keeps_its_exit_code():
    """A small dict inside a dict that gets cut is one of its short fields, so the cut keeps it."""
    executor = _load_executor()
    result = {f'out{i:02d}': 'x' * 81 for i in range(50)}
    result['payload'] = {'stderr': 'e' * 70, 'status': {'exit_code': 1}}

    summary = executor._describe(result)

    assert 'exit_code: 1' in summary


def test_a_list_cut_by_its_parent_counts_only_the_rows_it_shows():
    """Wide rows beside a long output: the list is shown again within its room, one row at least."""
    executor = _load_executor()
    row = {f'k{i:02d}': 'x' * 80 for i in range(28)}

    summary = executor._describe({'rows': [row, row, row], 'stdout': 'o' * 10_000, 'exit_code': 1})

    shown = int(re.search(r'\(showing (\d+) of 3\)', summary).group(1))
    assert len(re.findall(r'^\s*row\[\d+\]:$', summary, flags=re.M)) == shown
    assert 'exit_code: 1' in summary


def test_a_short_field_a_cut_left_out_is_still_listed():
    """However the result is nested, a short field of a dict that no cut kept is listed at the end."""
    executor = _load_executor()
    row = {f'k{i:02d}': 'x' * 80 for i in range(40)}
    deep = {'run': {'job': {'step': {'rows': [row] * 30, 'exit_code': 3}}}}
    result = {f'blob{i}': {'rows': [row] * 30} for i in range(6)} | {'deep': deep}

    summary = executor._describe(result)

    assert 'exit_code: 3' in summary
    assert len(summary) <= executor._SUMMARY_HARD_CAP


def test_a_nested_dict_does_not_pay_for_its_short_fields_twice():
    """Its short fields are paid for once, by its parent, so its rows keep the room they had."""
    executor = _load_executor()
    metadata = {f'meta{i:02d}': 'm' * 70 for i in range(20)}
    rows = [{'id': i, 'name': str(i) + 'n' * 69} for i in range(10)]

    summary = executor._describe({'result': metadata | {'rows': rows}})

    assert '(showing' not in summary, 'every row fits'
    assert 'id: 9' in summary


def test_a_status_in_a_one_row_list_keeps_its_exit_code():
    """A short list is a whole result: its rows' short fields are kept like a dict's."""
    executor = _load_executor()
    result = {f'out{i:02d}': 'x' * 10_000 for i in range(20)}
    result['status'] = [{'stdout': 'o' * 70, 'exit_code': 1}]

    summary = executor._describe(result)

    assert 'exit_code: 1' in summary


def test_the_same_status_shown_elsewhere_does_not_hide_a_missing_one():
    """Two fields can render the same line. One shown does not mean both are."""
    executor = _load_executor()
    result = {f'out{i:02d}': 'x' * 81 for i in range(50)}
    result['previous'] = {'exit_code': 1}
    result['current'] = {'padding': 'p' * 70, 'run': {'status': {'exit_code': 1, 'stdout': 'x' * 10_000}}}

    summary = executor._describe(result)

    assert summary.count('exit_code: 1') >= 2


def test_a_status_in_a_top_level_short_list_is_kept():
    """A reply that is a list of two rows: the first too wide for the cap, the second a status."""
    executor = _load_executor()
    result = [{f'k{i:02d}': 'x' * 80 for i in range(80)}, {'exit_code': 1}]

    summary = executor._describe(result)

    assert 'exit_code: 1' in summary
    assert len(summary) <= executor._SUMMARY_HARD_CAP


def test_a_status_shown_inline_is_not_counted_as_missing():
    """A dict with one field shows it after its key ("status:   exit_code: 1"). That counts as shown."""
    executor = _load_executor()
    result = {f'k{i:05d}': {'item_code': 0} for i in range(255)}
    result['status'] = {'exit_code': 1}

    summary = executor._describe(result)

    assert 'exit_code: 1' in summary
    assert 'a cut may have hidden' not in summary
    assert 'peek the key for the rest' not in summary


def test_a_list_cut_to_its_header_says_it_shows_no_rows():
    """When the room ends before the first row, the header counts none, and the stdout beside the list keeps its share."""
    executor = _load_executor()
    row = {f'k{i:02d}': 'x' * 80 for i in range(28)}
    result = {'rows': [row] * 3, 'stdout': 'o' * 10_000 + 'END', 'exit_code': 1}

    summary = executor._describe(result)

    assert '(showing 0 of 3)' in summary
    assert 'row[' not in summary
    assert 'END' in summary
    assert 'exit_code: 1' in summary


def test_the_walk_for_hidden_fields_is_bounded_in_a_wide_dict():
    """One dict wider than the bound: the walk remembers the bound's worth of fields and that there were more."""
    executor = _load_executor()
    omitted = executor._Omitted()

    executor._collect_short({f'k{i}': i for i in range(100_000)}, (), 1, omitted)

    assert len(omitted.fields) == executor._SUMMARY_MISSING_FIELDS
    assert omitted.more


def test_counters_do_not_crowd_an_exit_code_off_the_last_line():
    """Status-like names come first on the line of fields a cut may have hidden."""
    executor = _load_executor()
    result = {f'out{i:02d}': 'x' * 81 for i in range(50)}
    result['current'] = {'padding': 'p' * 70, 'run': {f'k{i:02d}': 0 for i in range(40)} | {'exit_code': 1}}

    summary = executor._describe(result)

    assert 'exit_code: 1' in summary


def test_a_cut_list_counts_only_its_own_rows():
    """Rows of a list nested in a row do not count as rows of the outer list."""
    executor = _load_executor()
    result = {f'out{i:02d}': 'x' * 81 for i in range(40)}
    result['rows'] = [{'meta': [{'a': 1}]}] * 300

    summary = executor._describe(result)

    shown = int(re.search(r"300 items, fields: \['meta'\] \(showing (\d+) of 300\)", summary).group(1))
    assert 0 < shown < 300
    assert len(re.findall(r'^    row\[\d+\]:$', summary, flags=re.M)) == shown


@pytest.mark.parametrize('stdout_first', [False, True])
def test_a_cut_container_keeps_to_its_room_so_its_parent_does_not_cut_again(stdout_first):
    """A cut's notice fits inside the room, so a nested stdout keeps its start, end and length note."""
    executor = _load_executor()
    stdout = 'o' * 10_000 + '\nFAILED'
    inner = (
        {'stdout': stdout, 'warnings': ['w' * 5000]} if stdout_first else {'warnings': ['w' * 5000], 'stdout': stdout}
    )

    summary = executor._describe({'result': inner})

    assert '"ooooo' in summary
    assert 'FAILED' in summary
    assert f'({len(stdout)} chars, middle omitted)' in summary


def test_a_long_mcp_text_block_keeps_its_end():
    """The list header and row label are paid for first, so the text's end and length note survive."""
    executor = _load_executor()
    text = 'x' * 10_000 + '\nFAILED'

    summary = executor._describe({'content': [{'type': 'text', 'text': text}], 'isError': False})

    assert 'FAILED' in summary
    assert f'({len(text)} chars, middle omitted)' in summary
    assert len(summary) <= executor._SUMMARY_HARD_CAP


def test_a_status_survives_any_mix_of_long_fields():
    """Seeded random results: long texts, wide rows, MCP blocks and nested dicts around one status.

    However the budget is split, the exit code (at the top or in a status dict) is
    shown and the summary stays within the cap.
    """
    executor = _load_executor()
    rnd = random.Random(2072)

    def text():
        return rnd.choice(['x' * rnd.randint(0, 200), 'y' * rnd.randint(81, 400), 'z' * rnd.randint(400, 20_000)])

    def rows():
        row = {f'k{i:02d}': 'd' * rnd.choice([10, 80, 300]) for i in range(rnd.randint(1, 40))}
        return [dict(row) for _ in range(rnd.randint(1, 30))]

    def value(depth):
        kind = rnd.choice(['text', 'rows', 'plist', 'mcp', 'many'] + (['dict'] if depth < 3 else []))
        if kind == 'text':
            return text()
        if kind == 'rows':
            return rows()
        if kind == 'plist':
            return [text() for _ in range(rnd.randint(1, 5))]
        if kind == 'mcp':
            return [{'type': 'text', 'text': text()}]
        if kind == 'many':
            return {f'o{i:02d}': 'x' * rnd.randint(81, 300) for i in range(rnd.randint(10, 80))}
        return {f'f{i}': value(depth + 1) for i in range(rnd.randint(1, 6))}

    statuses = [
        {'exit_code': 7},
        {'status': {'exit_code': 7}},
        {'status': {'stderr': 'Permission denied', 'exit_code': 7}},
        {'status': {'stderr': 'e' * 70, 'exit_code': 7}},
        {'status': {'exit_code': 7, 'details': rows()}},
        {'payload': {'stderr': 'e' * 70, 'status': {'exit_code': 7}}},
        {'payload': {'run': {'log': text(), 'status': {'exit_code': 7, 'details': rows()}}}},
        {'status': [{'stdout': 'o' * 70, 'exit_code': 7}]},
        {'result': {'meta': 'm' * 70, 'runs': [{'log': text(), 'exit_code': 7}]}},
    ]
    for case in range(300):
        result = {f'f{i}': value(1) for i in range(rnd.randint(1, 8))}
        result.update(rnd.choice(statuses))
        keys = list(result)
        rnd.shuffle(keys)

        summary = executor._describe({k: result[k] for k in keys})

        assert 'exit_code: 7' in summary, f'case {case} lost the exit code'
        assert len(summary) <= executor._SUMMARY_HARD_CAP


def test_a_short_list_inside_a_sampled_row_stays_narrow():
    """The whole-text rule is for a short list on its own, not one inside a sampled row.

    Expanding it there would widen every row and shrink the window #2072 tuned.
    """
    executor = _load_executor()
    rows = [{'name': f'Document {i}', 'content': [{'text': 'x' * 1000}]} for i in range(10)]

    summary = executor._describe(rows)

    assert summary.splitlines()[0] == "10 items, fields: ['name', 'content']", 'every row is shown'
    assert 'Document 9' in summary


def test_an_mcp_text_block_is_shown_whole():
    """MCP tools reply with content blocks: a list of one dict whose text is the result.

    A list that short is not a sample to keep narrow, so its text gets the budget.
    """
    executor = _load_executor()
    content = ''.join(f'line {i}: some source text\n' for i in range(100)) + 'IMPORTANT_END'

    summary = executor._describe({'content': [{'type': 'text', 'text': content}], 'isError': False})

    assert 'IMPORTANT_END' in summary
    assert 'line 99: some source text' in summary


def test_file_content_is_shown_whole():
    """A file read is one long string; the planner must see all of it, not its first line.

    Cutting it at 80 characters made the model guess the rest or spend a round peeking.
    """
    executor = _load_executor()
    content = ''.join(f'line {i}: some source text\n' for i in range(100))

    summary = executor._describe({'path': 'src/App.css', 'content': content})

    assert 'line 99: some source text' in summary
    assert 'omitted' not in summary


def test_text_past_the_budget_keeps_its_start_and_end():
    """Past the budget the middle goes, so a traceback's final error line survives."""
    executor = _load_executor()
    log = 'Traceback (most recent call last):\n' + 'x' * 20_000 + '\nValueError: bad header'

    summary = executor._describe(log)

    assert summary.startswith('"Traceback (most recent call last):')
    assert 'ValueError: bad header' in summary
    assert f'({len(log)} chars, middle omitted)' in summary
    assert len(summary) <= executor._SUMMARY_HARD_CAP


def test_long_text_fields_share_the_budget():
    """Two long outputs split the budget, so the fields after them are still shown."""
    executor = _load_executor()
    result = {'stdout': 'o' * 10_000, 'stderr': 'e' * 10_000, 'exit_code': 1}

    summary = executor._describe(result)

    assert 'exit_code: 1' in summary
    assert 'o' * 1000 in summary, 'stdout got no share of the budget'
    assert 'e' * 1000 in summary, 'stderr got no share of the budget'
    assert len(summary) <= executor._SUMMARY_HARD_CAP


@pytest.mark.parametrize('count', [20, 60, 100])
def test_many_long_text_fields_stay_within_the_cap(count):
    """Long fields split what is left of the budget once every key and notice is paid for.

    So the field after them still shows. Sixty fields used to get at least 80 characters
    each, and the hard cap then cut exit_code. From about sixty on, each gets too little to
    show any text, so each shows its length instead.
    """
    executor = _load_executor()
    result = {f'out{i:02d}': chr(97 + i % 26) * 5_000 for i in range(count)}
    result['exit_code'] = 1

    summary = executor._describe(result)

    assert 'exit_code: 1' in summary
    assert 'peek the key for the rest' not in summary, 'every field is shown, at least as a length note'
    assert len(summary) <= executor._SUMMARY_HARD_CAP


def test_hundreds_of_long_fields_cannot_push_out_a_short_one():
    """Past a few hundred long fields even their length notes pass the cap.

    The fields that fit are kept whole, exit_code before any length note, and the
    notice says how many were left out; nothing is cut mid-field.
    """
    executor = _load_executor()
    result = {f'out{i:03d}': 'x' * 5_000 for i in range(300)}
    result['exit_code'] = 1

    summary = executor._describe(result)

    assert 'exit_code: 1\n' in summary
    assert 'out000: (5000 chars, peek the key to read it)' in summary
    assert re.search(r'^\.\.\. \(showing \d+ of 301 fields, peek the key for the rest\)$', summary, flags=re.M)
    shown = len(re.findall(r'^out\d+: ', summary, flags=re.M)) + 1
    assert shown == int(re.search(r'showing (\d+) of 301', summary).group(1))
    assert len(summary) <= executor._SUMMARY_HARD_CAP


def test_text_inside_list_rows_is_still_cut_at_80():
    """Rows stay narrow, so a sample of many rows still fits: the #2032 window is unchanged."""
    executor = _load_executor()
    rows = [{'name': f'Document {i}', 'description': 'd' * 500} for i in range(5)]

    summary = executor._describe(rows)

    assert f'"{"d" * 80}..." (500 chars)' in summary
    assert summary.count('row[') == 5


# ---------------------------------------------------------------------------
# Regressions from the final review of #2517. Each container keeps to its room by
# leaving out whole fields or rows, and what it leaves out is recorded by path.
# ---------------------------------------------------------------------------

_NOISE = {f'out{i:02d}': 'x' * 81 for i in range(50)}
# Enough long fields that their length notes alone pass the cap, so later fields are left out.
_OVERFLOW = {f'out{i:03d}': 'x' * 81 for i in range(140)}


def _hidden(fields):
    """A status dict behind a long stdout, two levels down."""
    return {'padding': 'p' * 70, 'run': dict(fields, stdout='x' * 10_000)}


def _last_line(summary):
    return summary.splitlines()[-1]


def test_a_dict_past_the_cap_keeps_whole_fields_and_its_status():
    """Finding 1: the cap cut "exit_code: 127" to "exit_code: 1" and then listed 127 as hidden.

    Fields are now left out whole, status names last, so the status is shown once, right.
    """
    executor = _load_executor()
    result = (
        {f'k{i:02d}': 'x' * 80 for i in range(62)}
        | {'padding__': 'p' * 75, 'exit_code': 127}
        | {f'end{i}': 'z' * 80 for i in range(10)}
    )

    summary = executor._describe(result)

    assert 'exit_code: 127' in summary
    assert not re.search(r'exit_code: 1\b', summary)
    assert 'peek the key for the rest' in summary
    assert re.search(r'end\d: "zzz', _last_line(summary)), 'a short field left out is listed on the last line'
    assert re.search(r'; and \d+ more\)$', _last_line(summary))
    assert len(summary) <= executor._SUMMARY_HARD_CAP


def test_a_text_beside_wide_rows_keeps_its_end_whatever_the_key_order():
    """Finding 2: a list's header could pass its room, and the parent then cut the text after it.

    A list keeps to its room, with rows left out whole, so the text gets the same share in both orders.
    """
    executor = _load_executor()
    row = {f'column_{i:02d}_' + 'k' * 50: 1 for i in range(32)}
    inner = {'rows': [row] * 3, 'stdout': 'X' * 10_000 + 'ENDMARK'}

    rows_first = executor._describe({'result': inner})
    text_first = executor._describe({'result': dict(reversed(list(inner.items())))})

    assert 'ENDMARK' in rows_first and 'ENDMARK' in text_first
    assert len(rows_first) == len(text_first)
    assert 'cut at' not in rows_first


def test_a_short_list_gives_its_small_row_only_what_it_needs():
    """Finding 3: two rows split the room equally, so a wide first row pushed the second out.

    Each row's own fixed costs are paid first, and a row that needs less than its share leaves the rest.
    """
    executor = _load_executor()
    wide_then_text = {'content': [{f'k{i}': 'v' * 70 for i in range(24)}, {'text': 'X' * 2500 + 'TAIL'}]}
    tiny_then_text = {'content': [{'type': 'text', 'text': 'hi'}, {'type': 'text', 'text': 'x' * 2500 + 'END'}]}

    first = executor._describe(wide_then_text)
    second = executor._describe(tiny_then_text)

    assert 'row[1]' in first and 'TAIL' in first
    assert 'END' in second and 'middle omitted' not in second, 'the room the short row left was enough for all of it'


@pytest.mark.parametrize(
    'extra',
    [
        {'log': 'previous run\nexit_code: 7\nfinished'},
        {'old_runs': [{'exit_code': 7}] * 3},
        {'record: exit_code': 7},
    ],
)
def test_a_status_shown_elsewhere_does_not_hide_the_one_a_cut_left_out(extra):
    """Finding 4: the same text in a log, a sampled row or another key passed for the hidden status.

    What a cut left out is known by path, not found by searching the text.
    """
    executor = _load_executor()
    result = _OVERFLOW | {'current': _hidden({'exit_code': 7})} | extra

    summary = executor._describe(result)

    assert 'current.run.exit_code: 7' in _last_line(summary)


def test_visible_statuses_are_not_repeated_on_the_last_line():
    """Finding 5: thirty visible "exit_code: 0" lines filled the last line and the hidden one never fit."""
    executor = _load_executor()
    result = (
        {f'prior{i}': {'exit_code': 0} for i in range(30)}
        | _OVERFLOW
        | {'current': _hidden({'exit_code': 0, 'ok': False})}
    )

    summary = executor._describe(result)

    assert summary.count('exit_code: 0') >= 30
    assert 'current.run.exit_code: 0' in _last_line(summary)
    assert 'current.run.ok: false' in _last_line(summary)
    assert 'prior' not in _last_line(summary)


@pytest.mark.parametrize(
    'value, shown', [('Permission denied\n', '"Permission denied\\n"'), ([], '[] (0 items)'), ({}, '{}')]
)
def test_a_short_multiline_error_or_an_empty_container_is_listed_when_left_out(value, shown):
    """Finding 6: a string with a newline and an empty container were paid for as short fields but never listed."""
    executor = _load_executor()
    result = _OVERFLOW | {'current': _hidden({'stderr': value})}

    summary = executor._describe(result)

    assert f'current.run.stderr: {shown}' in _last_line(summary)


def test_an_entry_too_long_for_the_last_line_is_skipped_not_the_ones_after_it():
    """Finding 7: one 364-character path stopped the line, which then came out empty."""
    executor = _load_executor()
    result = _OVERFLOW | {'L' * 350: _hidden({'exit_code': 1}), 'current': _hidden({'ok': False})}

    summary = executor._describe(result)

    line = _last_line(summary)
    assert 'current.run.ok: false' in line
    assert 'L' * 20 not in line
    assert re.search(r'; and \d+ more\)$', line), 'the line says what it could not list'
    assert len(line) <= executor._SUMMARY_MISSING_CHARS


def test_a_status_in_a_short_list_inside_a_short_list_is_shown():
    """Finding 8: a queued list row was dropped by the walk, so [1][0][0].exit_code was never listed."""
    executor = _load_executor()

    summary = executor._describe(['x' * 10_000, [[{'exit_code': 7}]]])

    assert 'exit_code: 7' in summary
    assert len(summary) <= executor._SUMMARY_HARD_CAP


def test_a_token_shown_whole_is_not_charged_for_a_note():
    """Finding 9: every long text reserved 40 characters, so 25 files that fit the budget showed 24."""
    executor = _load_executor()
    result = {'files': _drive_files(25, target_index=24), 'nextPageToken': 'p' * 500}

    summary = executor._describe(result)

    assert 'Email Template.docx' in summary
    assert 'showing' not in summary
    assert len(summary) <= executor._SUMMARY_BUDGET


@pytest.mark.parametrize('kind', ['datetime', 'cycle'])
def test_a_plain_list_that_json_cannot_encode_is_summarised_rather_than_lost(kind):
    """Finding 10: json.dumps raised on a datetime or a cycle, and the stored result was reported as an error."""
    import datetime

    executor = _load_executor()
    result = [datetime.datetime(2026, 1, 1)]
    if kind == 'cycle':
        result = []
        result.append(result)
    agent = _FakeAgent()
    agent.call_tool = lambda *args: result

    entries = executor.execute_wave([{'tool': 'test', 'args': {}}], agent_base=agent, context=_FakeContext())

    assert 'error' not in entries[0]
    assert '1 items' in entries[0]['summary']


def test_a_plain_list_inside_a_row_is_cut_at_the_row_width():
    """Finding 10: a plain list's JSON sample showed a 1,000-character string inside a sampled row."""
    executor = _load_executor()
    rows = [{'name': f'Doc {i}', 'tags': ['x' * 1000]} for i in range(10)]

    summary = executor._describe(rows)

    assert max(map(len, re.findall('x+', summary))) == executor._ROW_TEXT_CHARS
    assert 'Doc 9' in summary


def test_a_huge_string_in_a_plain_list_is_not_copied():
    """Finding 10: json.dumps serialised the whole item before the cut, 22 MB for a 10 MB string."""
    import tracemalloc

    executor = _load_executor()
    result = ['x' * 10_000_000]

    tracemalloc.start()
    summary = executor._describe(result)
    _, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()

    assert len(summary) <= executor._SUMMARY_HARD_CAP
    assert 'middle omitted' in summary
    assert peak < 100_000


@pytest.mark.parametrize(
    'value',
    [
        [{f'k{i:03d}': 'x' * 80 for i in range(90)}] * 3,
        {'r': {'r': [{f'k{i}': 'v' * 80 for i in range(40)}] * 2}},
        {f'out{i:02d}': 'x' * 81 for i in range(30)} | {'rows': [{'id': 'a', 'name': 'x' * 80}] * 3},
        {'rows': [{f'k{i:02d}': 'x' * 80 for i in range(28)}] * 3, 'stdout': 'o' * 10_000, 'exit_code': 1},
    ],
)
def test_a_list_header_counts_the_whole_rows_under_it(value):
    """Finding 11: an outer cut removed rows after the header was written, and a bare row label counted as a row."""
    executor = _load_executor()

    summary = executor._describe(value)

    labels = len(re.findall(r'^\s*row\[\d+\]:$', summary, flags=re.M))
    partial = re.search(r'\(showing (\d+) of \d+\)', summary)
    assert (int(partial.group(1)) if partial else labels) == labels
    assert not re.search(r'row\[\d+\]:(\n\s*row\[\d+\]:|$)', summary), 'no row label without a row'


def test_text_that_looks_like_a_row_label_is_not_counted_as_a_row():
    """Finding 12: the recount matched "row[99]:" inside a message."""
    executor = _load_executor()
    row = {'message': 'log start\n    row[99]:\nlog end'} | {f'k{i}': 'v' * 80 for i in range(20)}
    result = {f'out{i}': 'x' * 10_000 for i in range(3)} | {'rows': [row] * 3}

    summary = executor._describe(result)

    shown = re.search(r'\(showing (\d+) of 3\)', summary)
    real = [i for i in range(3) if f'  row[{i}]:\n' in summary]
    assert (int(shown.group(1)) if shown else 3) == len(real)


def test_a_list_that_fits_the_budget_whole_shows_every_row():
    """Finding 13: a partial-sample notice was reserved even for the last row, so 39 rows that fit showed 38."""
    executor = _load_executor()

    summary = executor._describe([{'name': 'x' * 80} for _ in range(39)])

    assert 'showing' not in summary
    assert summary.count('row[') == 39
    assert len(summary) <= executor._SUMMARY_BUDGET


def test_a_key_with_a_colon_or_a_dot_is_quoted_on_the_last_line():
    """Finding 14: "HTTP: status: 503" was split at the first colon, and job.part and job > part read the same."""
    executor = _load_executor()
    colon = _OVERFLOW | {'current': _hidden({'HTTP: status': 503})}
    dotted = _OVERFLOW | {
        'job.part': _hidden({'exit_code': 7}),
        'job': {'padding': 'p' * 70, 'part': {'run': {'exit_code': 9, 'stdout': 'x' * 10_000}}},
    }

    colon_line = _last_line(executor._describe(colon))
    dotted_line = _last_line(executor._describe(dotted))

    assert 'current.run."HTTP: status": 503' in colon_line
    assert '"job.part".run.exit_code: 7' in dotted_line
    assert 'job.part.run.exit_code: 9' in dotted_line


def test_a_wide_flat_dict_costs_a_bounded_walk():
    """Finding 15: a regex per short field over the whole summary took 0.8 s for 5,000 fields."""
    import time

    executor = _load_executor()
    result = {f'k{i:06d}': i for i in range(5000)}

    start = time.perf_counter()
    summary = executor._describe(result)
    elapsed = time.perf_counter() - start

    assert len(summary) <= executor._SUMMARY_HARD_CAP
    assert 'k000000: 0' in summary
    assert elapsed < 0.5, f'{elapsed:.3f}s for 5,000 fields'


def test_a_list_given_all_it_wants_shows_a_last_row_shorter_than_the_notice():
    """Each row reserved room for "(showing k of n)", so a trailing null left rows out of a list that fit."""
    executor = _load_executor()
    rows = [{'k': 'v' * 50}, {'k': 'v' * 50}, None]
    _, _, want = executor._cost(rows, 0, False, executor._SUMMARY_HARD_CAP)

    rendered = executor._render(rows, 0, want)

    assert len(rendered) == want
    assert 'showing' not in rendered
    assert executor._describe({'rows': rows, 'ok': True}).count('row[') == 3


def test_a_list_of_very_wide_records_is_cut_at_the_cap():
    """A list's field names are written in full, so 1,500 keys per record go past any room; the cap still holds."""
    executor = _load_executor()
    result = [{f'field_{i:04d}': i for i in range(1500)} for _ in range(3)]

    summary = executor._describe(result)

    assert len(summary) == executor._SUMMARY_HARD_CAP
    assert summary.endswith(executor._SUMMARY_TRUNCATED)


def test_the_cap_keeps_the_line_of_hidden_short_fields():
    """The field names fill the room, so neither row is shown; the cut keeps the line that lists the exit code."""
    executor = _load_executor()
    result = [{f'field_{i:04d}': i for i in range(1500)}, {'exit_code': 127}]

    summary = executor._describe(result)

    assert len(summary) <= executor._SUMMARY_HARD_CAP
    assert executor._SUMMARY_TRUNCATED in summary
    assert '[1].exit_code: 127' in _last_line(summary)


@pytest.mark.parametrize('value', [b'\x00' * 1_000_000, tuple(range(200_000))], ids=['bytes', 'tuple'])
def test_a_value_that_is_not_json_is_cut_at_the_cap(value):
    """A value that is not JSON is written with str(): 1 MB of bytes gave a 1 MB summary, resent every wave."""
    executor = _load_executor()

    summary = executor._describe(value)

    assert len(summary) == executor._SUMMARY_HARD_CAP
    assert summary.endswith(executor._SUMMARY_TRUNCATED)


def _sheet(columns, rows, cell):
    """A Google Sheets values_get result: a header row of column names, then rows of cells."""
    header = [f'Column {c:02d} name' for c in range(columns)]
    return {
        'range': f'Sheet1!A1:Z{rows + 1}',
        'majorDimension': 'ROWS',
        'values': [header] + [[cell(r, c) for c in range(columns)] for r in range(rows)],
    }


def test_a_spreadsheet_header_row_is_shown_whole():
    """values_get: a row inside the plain list of rows showed 3 column names, with most of the budget unused."""
    executor = _load_executor()
    result = _sheet(20, 500, lambda r, c: f'r{r}c{c}')

    summary = executor._describe(result)

    header = ', '.join(f'"Column {c:02d} name"' for c in range(20))
    assert f'501 items, sample: [20 items, sample: [{header}]' in summary
    assert '20 items, sample: ["r0c0", "r0c1", "r0c2", "r0c3"' in summary, 'data rows fill their room too'
    assert len(summary) <= executor._SUMMARY_BUDGET


def test_a_row_too_wide_for_its_room_shows_the_cells_that_fit():
    """Rows wider than their share show their first cells in order and end in "...", within the room."""
    executor = _load_executor()
    result = _sheet(400, 50, lambda r, c: f'cell {r}-{c}')

    summary = executor._describe(result)

    assert '"Column 00 name", "Column 01 name"' in summary
    assert '"Column 399 name"' not in summary
    assert summary.count(', ...]') == 3, 'each of the three rows says it was cut'
    assert len(summary) <= executor._SUMMARY_HARD_CAP


def test_every_container_keeps_to_the_room_it_is_given():
    """The invariant behind the review's design: a container given at least its least room never passes it.

    Seeded random results at random rooms. A parent relies on this, so no parent cuts a child again.
    """
    executor = _load_executor()
    rnd = random.Random(2517)

    def text():
        return rnd.choice(['x' * rnd.randint(0, 200), 'y' * rnd.randint(81, 400), 'z' * rnd.randint(400, 20_000)])

    def value(depth):
        kind = rnd.choice(['text', 'rows', 'plist', 'grid', 'mcp', 'many', 'num'] + (['dict'] if depth < 4 else []))
        if kind == 'text':
            return text()
        if kind == 'num':
            return rnd.randint(0, 9)
        if kind == 'rows':
            row = {f'k{i:02d}': 'd' * rnd.choice([10, 80, 300]) for i in range(rnd.randint(1, 40))}
            return [dict(row) for _ in range(rnd.randint(1, 30))]
        if kind == 'plist':
            return [text() for _ in range(rnd.randint(1, 5))]
        if kind == 'grid':
            width = rnd.randint(1, 300)
            return [[rnd.choice([text(), rnd.randint(0, 999)]) for _ in range(width)] for _ in range(rnd.randint(1, 5))]
        if kind == 'mcp':
            return [{'type': 'text', 'text': text()} for _ in range(rnd.randint(1, 2))]
        if kind == 'many':
            return {f'o{i:02d}': 'x' * rnd.randint(81, 300) for i in range(rnd.randint(10, 80))}
        return {f'f{i}': value(depth + 1) for i in range(rnd.randint(1, 6))}

    for case in range(300):
        result = value(1)
        room = rnd.randint(60, 6000)
        least, floor, want = executor._cost(result, 0, False, room)

        rendered = executor._render(result, 0, room)

        if room >= least:
            assert len(rendered) <= room, f'case {case}: {len(rendered)} chars in a room of {room}'
        if room >= want:
            assert len(rendered) == want, f'case {case}: the full rendering is {len(rendered)}, not {want} as costed'
