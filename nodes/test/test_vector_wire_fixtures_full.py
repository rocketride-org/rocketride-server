# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""The committed vector wire captures (``apps/vector-ui/tests/fixtures/v1/live``) still match the tools.

The captures are regenerated live (``vector_wire_fixtures.live_fixtures``: the
engine, the shipped templates and the live test databases, as
``test_vector_toolpath_full.py`` runs them) and compared with the committed
files in their canonical form (floats to 4 decimal places, run-specific values
scrubbed; the floats of embedding-derived answers within
``FLOAT_TOLERANCE``). A tool answering a capture with another outcome than the
one it is for fails generation. Registered as a live database suite
(``nodes/scripts/db-lanes/vector.js``); skips without the engine or the
databases unless ``RR_REQUIRE_DB_TESTS`` is set, and never runs under
``ROCKETRIDE_MOCK`` (NOT RUN).
"""

from __future__ import annotations

import json
import os

from pathlib import Path

import pytest

from . import vector_wire_fixtures as gen

FIXTURES = Path(__file__).resolve().parents[2] / 'apps' / 'vector-ui' / 'tests' / 'fixtures' / 'v1' / 'live'
_REQUIRED = bool(os.environ.get('RR_REQUIRE_DB_TESTS'))


def _committed():
    return gen.committed(FIXTURES) if FIXTURES.is_dir() else {}


# ---------------------------------------------------------------------------
# The canonical form (no engine needed)
# ---------------------------------------------------------------------------


def test_canonical_form_rounds_floats_and_scrubs_run_specific_values():
    answer = {
        'success': True,
        'score': 0.123456789,
        'tiny': -0.00001,
        'computed_at': '2026-10-08T18:31:03Z',
        'items': [{'pointId': 'a3f', 'sim': 0.987654321, 'objectId': '060f'}],
        'caller': {'auth': 'account', 'userId': 'u-1', 'teamId': None},
    }
    out = gen.stored(answer)
    assert out['__scrub__'] == ['computed_at', 'pointId', 'userId']
    assert out['score'] == 0.1235 and out['tiny'] == 0.0
    assert out['computed_at'] == gen.SCRUBBED and out['items'][0]['pointId'] == gen.SCRUBBED
    assert out['items'][0]['objectId'] == '060f' and out['items'][0]['sim'] == 0.9877
    assert out['caller'] == {'auth': 'account', 'userId': gen.SCRUBBED, 'teamId': None}


def test_canonical_form_ignores_only_run_specific_values():
    a = {'took_ms': 12, 'ingestedAt': '2026-01-01', 'path': 'C:/demo/a.md', 'values': [0.11111111, 0.2]}
    b = {'took_ms': 99, 'ingestedAt': '2027-01-01', 'path': 'C:/demo/a.md', 'values': [0.11111119, 0.2]}
    assert gen.stored(a) == gen.stored(b)
    changed = dict(b, path='C:/demo/b.md')
    assert gen.stored(a) != gen.stored(changed)
    assert gen.stored(a) != gen.stored(dict(b, values=[0.1112, 0.2]))


def test_stored_form_is_idempotent_and_valid_json():
    once = gen.stored({'x': 1.234567, 'computed_at': 'now', 'nan': float('nan')})
    assert gen.stored(once) == once
    json.dumps(once, allow_nan=False)


def test_opaque_cursors_and_sample_ids_are_scrubbed_but_their_absence_is_kept():
    out = gen.stored({'items': [], 'next_cursor': 'eyJvIjoyfQ', 'sample_id': 's-7-a1b2c3d4'})
    assert out['next_cursor'] == gen.SCRUBBED and out['sample_id'] == gen.SCRUBBED
    # The end of a listing (no cursor) is part of the answer.
    assert gen.stored({'items': [], 'next_cursor': None})['next_cursor'] is None


def test_an_unsorted_list_documents_page_compares_as_a_set_of_documents():
    a = {'objectId': 'a', 'path': 'C:/demo/a.md', 'chunks': 2}
    b = {'objectId': 'b', 'path': 'C:/demo/b.md', 'chunks': 1}
    on_disk = {'qdrant/list_documents.legacy.json': gen.stored({'items': [a, b], 'sorted': False})}
    # A backend that lists in storage order may return the same page in another order.
    assert gen.differences({'qdrant/list_documents.legacy.json': {'items': [b, a], 'sorted': False}}, on_disk) == []
    # Another page, or a sorted listing in another order, is a difference.
    c = dict(b, objectId='c')
    assert gen.differences({'qdrant/list_documents.legacy.json': {'items': [c, a], 'sorted': False}}, on_disk) == [
        'qdrant/list_documents.legacy.json'
    ]
    sorted_disk = {'pgvector/list_documents.json': gen.stored({'items': [a, b], 'sorted': True})}
    assert gen.differences({'pgvector/list_documents.json': {'items': [b, a], 'sorted': True}}, sorted_disk) == [
        'pgvector/list_documents.json'
    ]


def test_file_names_and_differences():
    assert gen.file_name('pgvector', 'stats') == 'pgvector/stats.json'
    assert gen.file_name('qdrant', 'stats', 'quick.legacy') == 'qdrant/stats.quick.legacy.json'
    regenerated = {'a/x.json': {'v': 1.000001}, 'a/y.json': {'v': 2}}
    on_disk = {'a/x.json': gen.stored({'v': 1.0}), 'a/z.json': {}}
    assert gen.differences(regenerated, on_disk) == ['a/y.json', 'a/z.json']


def test_similarity_answers_compare_within_a_tolerance_and_the_rest_exactly():
    sample = {'success': True, 'n': 2, 'points': {'x': [0.1234, -0.5], 'doc': [0, 1]}, 'knn': {'sims': [0.91, 0.88]}}
    nearby = {
        'success': True,
        'n': 2,
        'points': {'x': [0.1237, -0.5003], 'doc': [0, 1]},
        'knn': {'sims': [0.9104, 0.88]},
    }
    on_disk = {'qdrant/sample.json': gen.stored(sample), 'qdrant/stats.json': gen.stored({'avg_chunks': 0.5})}
    # Another CPU's BLAS moves the last digits of similarity-derived floats: not a difference.
    assert gen.differences({'qdrant/sample.json': nearby, 'qdrant/stats.json': {'avg_chunks': 0.5}}, on_disk) == []
    # Beyond the tolerance, or anything that is not a float, is.
    far = dict(nearby, points={'x': [0.1334, -0.5], 'doc': [0, 1]})
    assert gen.differences({'qdrant/sample.json': far, 'qdrant/stats.json': {'avg_chunks': 0.5}}, on_disk) == [
        'qdrant/sample.json'
    ]
    moved = dict(nearby, points={'x': [0.1234, -0.5], 'doc': [1, 0]})
    assert gen.differences({'qdrant/sample.json': moved, 'qdrant/stats.json': {'avg_chunks': 0.5}}, on_disk) == [
        'qdrant/sample.json'
    ]
    extra = dict(nearby, extra=True)
    assert gen.differences({'qdrant/sample.json': extra, 'qdrant/stats.json': {'avg_chunks': 0.5}}, on_disk) == [
        'qdrant/sample.json'
    ]
    # Exact answers (stats, list_documents, refusals, ...) stay exact.
    assert gen.differences({'qdrant/sample.json': sample, 'qdrant/stats.json': {'avg_chunks': 0.5003}}, on_disk) == [
        'qdrant/stats.json'
    ]


def test_an_answer_with_another_outcome_than_expected_is_reported():
    assert gen.outcome_problem({'success': True, 'items': []}, gen.OK) is None
    assert gen.outcome_problem({'results': [], 'total': 0}, gen.OK) is None  # the legacy search answer has no success
    assert gen.outcome_problem({'success': False, 'code': 'WRITES_SOURCE'}, 'WRITES_SOURCE') is None
    assert gen.outcome_problem({'success': False, 'code': 'NOT_FOUND', 'error': 'x'}, gen.OK)
    assert gen.outcome_problem({'success': True, 'removed': {'chunks': 3}}, 'WRITES_SOURCE')
    assert gen.outcome_problem({'success': False, 'code': 'WRITES_DISABLED'}, 'WRITES_SOURCE')
    assert gen.outcome_problem(None, gen.OK)


TEMPLATES = Path(__file__).resolve().parents[2] / 'apps' / 'vector-ui' / 'templates'


def _template(name):
    """A shipped template's pipeline, as the toolpath suite starts it."""
    raw = json.loads((TEMPLATES / f'{name}.pipe').read_text(encoding='utf-8'))
    return raw.get('pipeline', raw)


class _FakeSide:
    """A running copy of a template as test_vector_toolpath_full._Side holds it.

    It has what the real side has (engine, template, kind, collection, pipe and
    the sources it was started for) and answers every call as the tools should
    for its pipe's switches, except the outcomes overridden by (tool, source,
    node). A store whose allow_write is off has no write tools, so the engine
    finds no handler; allow_writes off refuses a Tools-source write with
    WRITES_DISABLED; any other source gets WRITES_SOURCE.
    """

    def __init__(
        self,
        wrong=None,
        *,
        engine='engine',
        template='qdrant',
        kind='new',
        collection='vx_wire',
        pipe=None,
        sources=('tools_1', 'chat_1', 'ingest_1'),
    ):
        self.engine, self.template, self.kind, self.collection = engine, template, kind, collection
        self.pipe = pipe if pipe is not None else _template(template)
        self.sources = tuple(sources)
        self.calls = []
        self.wrong = wrong or {}
        self.stopped = False
        self.trashed = set()

    def settings(self, node):
        comp = next(c for c in self.pipe['components'] if c['id'] == node)
        return comp['config'][comp['config']['profile']]

    def tool(self, name, inp=None, *, source='tools_1', node='store_1'):
        if source not in self.sources:
            raise KeyError(f'{source} was not started for this side')
        inp = inp or {}
        self.calls.append((name, inp, source, node))
        key = (name, source, node)
        if key in self.wrong:
            return self.wrong[key]
        if name == 'chunks' and inp.get('object_id') == 'schema':
            return {'success': False, 'code': 'NOT_FOUND', 'error': 'no such document'}
        if name == 'search' and len(inp.get('vector') or []) == 10:
            return {'success': False, 'code': 'DIMENSION_MISMATCH', 'error': 'dimension'}
        if name in ('delete', 'soft_delete', 'restore'):
            settings = self.settings(node)
            if not settings.get('allow_write', True):
                return {'success': False, 'error': f'no handler for {name} on {node}'}
            if inp.get('object_ids') == ['schema']:
                return {'success': False, 'code': 'RESERVED_ID', 'error': 'control record'}
            if not settings.get('allow_writes', False):
                return {'success': False, 'code': 'WRITES_DISABLED', 'error': 'switch'}
            if source != 'tools_1':
                return {'success': False, 'code': 'WRITES_SOURCE', 'error': 'source'}
            ids = list(inp.get('object_ids') or [])
            if name == 'soft_delete':
                self.trashed.update(ids)
            elif name == 'restore':
                self.trashed.difference_update(ids)
            elif inp.get('deleted_only'):
                return {'success': True, 'kept_live': [oid for oid in ids if oid not in self.trashed]}
        if name == 'chunks' and inp.get('object_id') in self.trashed:
            return {'success': False, 'code': 'IN_TRASH', 'error': 'in the trash', 'object_id': inp['object_id']}
        if name == 'sample':
            return {'success': True, 'sample_id': 's-7-0000aaaa', 'n': 12, 'of': {'chunks': 12, 'documents': 8}}
        return {'success': True}

    def stop(self):
        self.stopped = True


class _FakeToolpath:
    """What the generator uses of test_vector_toolpath_full: object ids, and _Side to start a copy."""

    def __init__(self, wrong=None):
        self.started = []
        self.wrong = wrong

    @staticmethod
    def object_id(name):
        return f'oid:{name}'

    def _Side(self, eng, template, kind, collection, pipe, sources):
        side = _FakeSide(
            self.wrong, engine=eng, template=template, kind=kind, collection=collection, pipe=pipe, sources=sources
        )
        self.started.append(side)
        return side


_TP = _FakeToolpath()


def test_every_capture_states_its_expected_outcome_and_writes_go_last():
    side = _FakeSide()
    out = gen._captures_for(_TP, side, 'new', 'qdrant', 'multi', [0.1] * 384, [0.2] * 384)
    assert out and all(name.startswith('qdrant/') for name in out)
    names = [c[0] for c in side.calls]
    first_write = names.index('delete')
    assert set(names[first_write:]) == {'delete'}, 'every refused write comes after the reads'
    # A refused write that the gate wrongly let through must not remove a real document.
    for name, inp, source, node in side.calls:
        if name == 'delete' and (source, node) != ('tools_1', 'store_1'):
            assert inp['object_ids'] == [gen.disposable_id(_TP)], (source, node, inp)


def test_generation_fails_when_a_refusal_is_answered_as_success():
    side = _FakeSide(wrong={('delete', 'chat_1', 'store_1'): {'success': True, 'removed_chunks': 0}})
    with pytest.raises(gen.CaptureMismatch, match='delete.writes_source'):
        gen._captures_for(_TP, side, 'new', 'qdrant', 'multi', [0.1] * 384, [0.2] * 384)


def test_a_wire_sample_must_hold_every_chunk_so_its_capture_is_reproducible():
    side = _FakeSide()
    gen._captures_for(_TP, side, 'new', 'qdrant', 'multi', [0.1] * 384, [0.2] * 384)
    asked = [inp['n'] for name, inp, _, _ in side.calls if name == 'sample']
    assert asked and all(n == gen.WIRE_SAMPLE_N for n in asked)
    # A backend that fills a partial sample at random (Qdrant's native RANDOM) answers differently each run.
    partial = {'success': True, 'sample_id': 's-7-0000bbbb', 'n': 40, 'of': {'chunks': 80, 'documents': 8}}
    with pytest.raises(gen.CaptureMismatch, match='sample'):
        gen._captures_for(
            _TP, _FakeSide(wrong={('sample', 'tools_1', 'store_1'): partial}), 'new', 'qdrant', 'multi', [0.1], [0.2]
        )


def test_every_required_capture_is_generated_for_both_sides():
    new, legacy = _FakeSide(), _FakeSide()
    out = gen._backend_captures(_TP, new, legacy, 'qdrant', 'multi', 'second', [0.1] * 384, [0.2] * 384)
    missing = sorted(set(gen.required_captures('qdrant')) - set(out))
    assert missing == [], f'the coverage test demands captures the generator never writes: {missing}'
    # Each side ends with its trash chain on 'second' and a plain delete, after every read of that side.
    for side in (new, legacy):
        tail = [(c[0], c[1]) for c in side.calls[-6:]]
        assert tail == [
            ('soft_delete', {'object_ids': ['second']}),
            ('chunks', {'object_id': 'second'}),
            ('restore', {'object_ids': ['second']}),
            ('soft_delete', {'object_ids': ['second']}),
            ('delete', {'object_ids': ['second', 'multi'], 'deleted_only': True}),
            ('delete', {'object_ids': [_TP.object_id(gen.WIRE_PREFIX + gen.WIRE_THIRD)]}),
        ], side.calls[-6:]
    for name in ('soft_delete', 'restore', 'chunks.in_trash', 'delete', 'delete.deleted_only'):
        assert f'qdrant/{name}.json' in out and f'qdrant/{name}.legacy.json' in out, name
    assert out['qdrant/chunks.in_trash.json']['code'] == 'IN_TRASH'
    assert out['qdrant/delete.deleted_only.json']['kept_live'] == ['multi']


def test_a_trash_write_that_fails_stops_generation():
    new = _FakeSide(wrong={('restore', 'tools_1', 'store_1'): {'success': False, 'code': 'STORE_ERROR', 'error': 'x'}})
    with pytest.raises(gen.CaptureMismatch, match='restore'):
        gen._backend_captures(_TP, new, _FakeSide(), 'qdrant', 'multi', 'second', [0.1] * 384, [0.2] * 384)


def test_writes_disabled_is_store_2s_refusal_except_on_rocketride_vector():
    disabled = gen.file_name('qdrant', 'delete', 'writes_disabled')
    tp, side = _FakeToolpath(), _FakeSide(template='qdrant')
    out = gen._captures_for(tp, side, 'new', 'qdrant', 'multi', [0.1] * 384, [0.2] * 384)
    assert out[disabled]['code'] == 'WRITES_DISABLED'
    assert ('delete', {'object_ids': [gen.disposable_id(tp)]}, 'tools_1', 'store_2') in side.calls
    assert tp.started == []

    # rocketride_vector's store_2 keeps allow_write off, so it has no write tools to refuse with:
    # the refusal comes from a copy of the side's pipeline, store_1 with allow_writes off.
    disabled = gen.file_name('rocketride_vector', 'delete', 'writes_disabled.legacy')
    tp, side = _FakeToolpath(), _FakeSide(template='rocketride_vector', kind='legacy', collection='vx_legacy')
    assert side.settings('store_2')['allow_write'] is False
    pipe_before = json.dumps(side.pipe, sort_keys=True)
    out = gen._captures_for(tp, side, 'legacy', 'rocketride_vector', 'multi', [0.1] * 384, [0.2] * 384)
    assert not [c for c in side.calls if c[0] == 'delete' and c[3] == 'store_2']
    (copy,) = tp.started
    assert (copy.engine, copy.template, copy.kind, copy.collection) == (
        side.engine,
        'rocketride_vector',
        'legacy-writes-off',
        'vx_legacy',
    )
    assert copy.sources == ('tools_1',)
    assert copy.settings('store_1') == {**side.settings('store_1'), 'allow_write': True, 'allow_writes': False}
    assert copy.pipe['project_id'] != side.pipe.get('project_id') and copy.pipe['name'].endswith('(writes off)')
    assert json.dumps(side.pipe, sort_keys=True) == pipe_before, "the side's own pipeline is not changed"
    assert copy.calls == [('delete', {'object_ids': [gen.disposable_id(tp)]}, 'tools_1', 'store_1')]
    assert copy.stopped
    assert out[disabled]['code'] == 'WRITES_DISABLED'


def test_a_writes_off_copy_that_removes_fails_generation_and_is_still_stopped():
    tp = _FakeToolpath(wrong={('delete', 'tools_1', 'store_1'): {'success': True, 'removed_chunks': 0}})
    with pytest.raises(gen.CaptureMismatch, match='delete.writes_disabled'):
        gen._captures_for(
            tp, _FakeSide(template='rocketride_vector'), 'new', 'rocketride_vector', 'multi', [0.1] * 384, [0.2] * 384
        )
    (copy,) = tp.started
    assert copy.stopped


def test_a_live_suite_does_not_run_under_mocks(monkeypatch):
    monkeypatch.setenv('ROCKETRIDE_MOCK', '/somewhere/mocks')
    assert gen.live_blocker().startswith('NOT RUN: ')
    monkeypatch.delenv('ROCKETRIDE_MOCK')
    assert gen.live_blocker() is None


# ---------------------------------------------------------------------------
# Live: regenerate and compare
# ---------------------------------------------------------------------------


def test_captures_are_committed_for_every_supported_backend():
    names = set(_committed())
    for backend in ('pgvector', 'rocketride_vector', 'qdrant', 'chroma'):
        missing = sorted(set(gen.required_captures(backend)) - names)
        assert missing == [], f'missing {missing}'


@pytest.fixture(scope='module')
def live():
    blocker = gen.live_blocker()
    if blocker:
        pytest.skip(blocker)
    try:
        return gen.live_fixtures()
    except RuntimeError as e:
        if _REQUIRED:
            pytest.fail(f'RR_REQUIRE_DB_TESTS is set but the live captures failed: {e}', pytrace=False)
        pytest.skip(f'NOT RUN: live captures not possible here: {e}')


def test_the_generator_covers_every_committed_capture(live):
    assert sorted(_committed()) == sorted(live)


def test_live_captures_match_the_tools(live):
    diff = gen.differences(live, _committed())
    assert diff == [], (
        f'apps/vector-ui/tests/fixtures/v1/live: {diff} no longer match the tools; regenerate them '
        '(see nodes/test/vector_wire_fixtures.py)'
    )
