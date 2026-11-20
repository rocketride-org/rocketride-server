# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Live wire captures of the vector store tools for vector-ui's tests (``apps/vector-ui/tests/fixtures/v1/live``).

The app's unit tests run on these answers, so its parsing is pinned to what
the tools really return, not to a hand-written guess. Each capture is one tool
answer from a template started in a real engine (the machinery of
``test_vector_toolpath_full.py``: no mocks, the broker stand-in, the LLM test
stub), on a new collection and on a legacy-shaped copy of it, written to
``<out>/<backend>/<tool>[.<case>].json``.

Answers are stored in a canonical form: floats are rounded to 4 decimal
places, and the values of the keys in ``SCRUB_KEYS`` (times, durations, point
ids, caller ids, sizes, cursors, sample ids) are replaced by ``"<scrubbed>"``
(a null stays null); every file lists the keys it scrubbed in ``__scrub__``.
The upload names are fixed (``C:/demo/<folder>/<file>``), so objectIds are
too, and the legacy copy's point ids are derived, not random, so a listing in
point-id order is the same on every run. A ``list_documents`` page that says
``sorted: false`` is compared as a set of documents; the samples ask for more
points than the corpus has chunks (``WIRE_SAMPLE_N``), and generation fails
when a sample holds fewer, because a partial sample may be filled at random.
The comparison is exact,
except that the floats of the embedding-derived answers (``SIMILARITY_TOOLS``:
PCA coordinates, similarities, scores) may differ by ``FLOAT_TOLERANCE``,
because their last digits depend on the CPU and BLAS build; their shapes,
keys, integers and strings are still compared exactly (a near-tie that orders
two neighbours differently on another machine is reported as a difference).

Every capture is taken for an expected outcome (``EXPECTED``: success, or the
refusal code), and generation stops with ``CaptureMismatch`` when a tool
answers otherwise, so a broken gate is never committed as the reference. The
writes that must be refused run after every read and target an objectId
nothing was uploaded under (``disposable_id``). The writes that succeed run
last on each side, in one chain on one document: ``soft_delete``, the
``chunks`` refusal of a trashed document (``IN_TRASH``), ``restore``, then
``delete {deleted_only}`` of it with a live document beside it (``kept_live``),
and a plain ``delete`` of a third document.

``test_vector_wire_fixtures_full.py`` regenerates the captures and compares
them with the committed files. To regenerate, from ``nodes/`` (unmocked, with
the live test databases up)::

    ../dist/server/engine test/vector_wire_fixtures.py ../apps/vector-ui/tests/fixtures/v1/live [--only qdrant,chroma]
"""

from __future__ import annotations

import json
import math
import os
import sys
import uuid

from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

SCRUB_KEYS = frozenset(
    {
        'computed_at',
        'counts_as_of',
        'ingestedAt',
        'modifyTime',
        'took_ms',
        'ms',
        'pointId',
        'expires_in_s',
        'size_bytes',
        'userId',
        'teamId',
        'orgId',
        'backend_version',
        'retry_after_s',
        # Opaque handles: a cursor may be a point id, a sample id hashes the sampled keys.
        'next_cursor',
        'sample_id',
    }
)
SCRUBBED = '<scrubbed>'
FLOAT_DIGITS = 4

# Fixed names, so the objectIds in the captures are the same on every run.
WIRE_PREFIX = 'C:/demo/'
WIRE_COLLECTION = 'vx_tp_wire'
WIRE_LEGACY = 'vx_tp_wire_legacy'

# The wire samples ask for more points than the wire corpus has chunks, so every
# chunk is in the sample: a partial sample may be filled at random (Qdrant's
# native RANDOM), which no committed capture could match on the next run.
WIRE_SAMPLE_N = 500

# The tools every backend has a capture of, on the new and on the legacy side.
REQUIRED_TOOLS = ('dialect', 'stats', 'list_documents', 'chunks', 'sample', 'search', 'delete')

# The corpus's one keyword token (demo/gen_corpus.py KEYWORD_TOKEN, in ops/memo_q3.txt).
WIRE_KEYWORD = 'KX4471'


# Answers derived from embeddings (similarities, PCA coordinates, scores): their
# last digits depend on the CPU and BLAS build, so their floats are compared
# within FLOAT_TOLERANCE; everything else, and every non-float, exactly.
SIMILARITY_TOOLS = frozenset(
    {'sample', 'project', 'neighbors', 'search', 'embed', 'vectors', 'recommend', 'similarity_matrix'}
)
FLOAT_TOLERANCE = 1e-3

# The outcome each capture is for: OK, or the refusal code it must carry.
OK = 'ok'
EXPECTED: Dict[Tuple[str, Optional[str]], str] = {
    ('dialect', None): OK,
    ('stats', None): OK,
    ('stats', 'quick'): OK,
    ('list_documents', None): OK,
    ('chunks', None): OK,
    ('chunks', 'not_found'): 'NOT_FOUND',
    ('chunks', 'in_trash'): 'IN_TRASH',
    ('vectors', None): OK,
    ('sample', None): OK,
    ('sample', 'light'): OK,
    ('project', None): OK,
    ('neighbors', None): OK,
    ('search', None): OK,
    ('search', 'below_floor'): OK,
    ('search', 'dimension_mismatch'): 'DIMENSION_MISMATCH',
    ('delete', None): OK,
    ('delete', 'deleted_only'): OK,
    ('delete', 'reserved_id'): 'RESERVED_ID',
    ('delete', 'writes_source'): 'WRITES_SOURCE',
    ('delete', 'writes_disabled'): 'WRITES_DISABLED',
    ('soft_delete', None): OK,
    ('restore', None): OK,
    # The additive surface (contract section 4.4); see ENRICHED below.
    ('dialect', 'enriched'): OK,
    ('list_documents', 'filter'): OK,
    ('sample', 'clusters'): OK,
    ('search', 'keyword'): OK,
    ('recommend', None): OK,
    ('recommend', 'best_score'): OK,
    ('similarity_matrix', None): OK,
}

# Captures whose outcome depends on the backend: (tool, case) -> {backend: outcome}, else EXPECTED.
BACKEND_EXPECTED: Dict[Tuple[str, Optional[str]], Dict[str, str]] = {
    # Only Qdrant ranks recommendations by best score itself; every other store refuses it.
    ('recommend', 'best_score'): {
        'pgvector': 'UNSUPPORTED',
        'rocketride_vector': 'UNSUPPORTED',
        'chroma': 'UNSUPPORTED',
    },
}

# The additive captures, by the code that answers them: each group is captured only once that
# code is on the branch (the tool-path suite's NEEDS flags, read from the branch's own source),
# so captures regenerate on a lane branch before the merge and gain the new files after it.
ENRICHED: Dict[str, Tuple[Tuple[str, Optional[str]], ...]] = {
    '_NEEDS_DIALECT': (('dialect', 'enriched'), ('search', 'keyword')),
    '_NEEDS_DOCUMENTS': (('list_documents', 'filter'),),
    '_NEEDS_SAMPLE_EXT': (('sample', 'clusters'),),
    '_NEEDS_EXT_TOOLS': (('recommend', None), ('recommend', 'best_score'), ('similarity_matrix', None)),
}


# A capture a store refuses is named by the refusal it is for, as every refusal capture is
# (``<tool>.<code>``, which vector-ui's live tests hold the file names to): where best score is
# refused, ``recommend.unsupported``.
BACKEND_CASE: Dict[Tuple[str, Optional[str]], Dict[str, str]] = {
    ('recommend', 'best_score'): {
        'pgvector': 'unsupported',
        'rocketride_vector': 'unsupported',
        'chroma': 'unsupported',
    },
}


def expected_for(tool: str, case: Optional[str], backend: str) -> str:
    """The outcome a capture is for on ``backend``."""
    return BACKEND_EXPECTED.get((tool, case), {}).get(backend, EXPECTED[(tool, case)])


def case_for(tool: str, case: Optional[str], backend: str) -> Optional[str]:
    """The case a capture's file is named by on ``backend`` (the refusal code's, where the store refuses it)."""
    return BACKEND_CASE.get((tool, case), {}).get(backend, case)


def enriched_captures(tp) -> List[Tuple[str, Optional[str]]]:
    """The additive captures whose code is on this branch (a module without the flags has none)."""
    return [
        capture for flag, captures in ENRICHED.items() if getattr(tp, flag, 'absent') is None for capture in captures
    ]


class CaptureMismatch(AssertionError):
    """A tool answered a capture with another outcome than the one the capture is for.

    Committing such an answer would pin a bug as the app's reference, so
    generation stops instead (an AssertionError: the suite fails, never skips).
    """


def outcome_problem(answer: Any, expected: str) -> Optional[str]:
    """Why ``answer`` is not the ``expected`` outcome (OK or a refusal code); None when it is."""
    if not isinstance(answer, dict):
        return f'expected {expected}, got {answer!r:.200}'
    refused = answer.get('success') is False
    if expected == OK:
        return f'expected success, got {answer.get("code")}: {answer.get("error")}' if refused else None
    if not refused:
        return f'expected the refusal {expected}, got a success: {json.dumps(answer, default=str)[:200]}'
    if answer.get('code') != expected:
        return f'expected the refusal {expected}, got {answer.get("code")}: {answer.get("error")}'
    return None


def disposable_id(tp) -> str:
    """An objectId nothing was uploaded under: the target of every write that must be refused.

    If the gate wrongly let such a write through, it would remove nothing.
    """
    return tp.object_id(WIRE_PREFIX + 'never-uploaded/refusal-probe.md')


def live_blocker() -> Optional[str]:
    """Why the live captures cannot run in this process (None when they can).

    Under ROCKETRIDE_MOCK this process imports nodes/test/mocks' qdrant_client,
    chromadb and psycopg2 while the engine it starts talks to the real servers;
    the live suites run in nodes:test-db's unmocked pass instead.
    """
    if os.environ.get('ROCKETRIDE_MOCK'):
        return 'NOT RUN: a live database suite does not run under ROCKETRIDE_MOCK (nodes:test-db runs it unmocked)'
    return None


def canonical(value: Any, scrubbed: Optional[set] = None) -> Any:
    """The stable form of an answer: floats rounded, run-specific values replaced (keys collected in scrubbed)."""
    if isinstance(value, dict):
        out = {}
        for key, item in value.items():
            if key == '__scrub__':
                continue
            if key in SCRUB_KEYS and item is not None:
                if scrubbed is not None:
                    scrubbed.add(key)
                out[key] = SCRUBBED
            else:
                out[key] = canonical(item, scrubbed)
        return out
    if isinstance(value, list):
        return [canonical(item, scrubbed) for item in value]
    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            return str(value)
        rounded = round(value, FLOAT_DIGITS)
        return 0.0 if rounded == 0 else rounded
    return value


def stored(value: Any) -> Any:
    """The committed form: canonical, plus the sorted list of keys it scrubbed."""
    scrubbed: set = set()
    out = canonical(value, scrubbed)
    if isinstance(out, dict):
        out = {'__scrub__': sorted(scrubbed), **out}
    return out


def file_name(backend: str, tool: str, case: Optional[str] = None) -> str:
    """``<backend>/<tool>[.<case>].json``."""
    return f'{backend}/{tool}{"." + case if case else ""}.json'


def required_captures(backend: str) -> List[str]:
    """The capture files every backend must have: each REQUIRED_TOOLS answer, new and legacy."""
    return [file_name(backend, tool, case) for tool in REQUIRED_TOOLS for case in (None, 'legacy')]


def sample_problem(answer: Any) -> Optional[str]:
    """Why a successful sample answer is not reproducible (it holds fewer points than the collection has chunks)."""
    if not isinstance(answer, dict) or answer.get('success') is False:
        return None
    total = (answer.get('of') or {}).get('chunks')
    if answer.get('n') is None or total is None or answer['n'] != total:
        return (
            f'the sample holds {answer.get("n")} of {total} chunks: a wire sample must hold every chunk '
            f'(n={WIRE_SAMPLE_N}) or its capture is not reproducible'
        )
    return None


def _write(out_dir: Path, captures: Dict[str, Any]) -> None:
    for name, value in sorted(captures.items()):
        target = out_dir / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(stored(value), indent=2, allow_nan=False) + '\n', encoding='utf-8')


# ---------------------------------------------------------------------------
# Live capture (needs the engine, the test databases and the explorer tools)
# ---------------------------------------------------------------------------


def _captures_for(
    tp, deployment_side, kind: str, backend: str, multi: str, water: List[float], unrelated: List[float]
) -> Dict[str, Any]:
    """Every capture of one side (``kind`` 'new' or 'legacy'), each checked against EXPECTED."""
    side = deployment_side
    case = (lambda c: c) if kind == 'new' else (lambda c: f'{c}.legacy' if c else 'legacy')
    out: Dict[str, Any] = {}
    problems: List[str] = []

    def put(tool: str, c: Optional[str], answer: Any) -> None:
        name = file_name(backend, tool, case(case_for(tool, c, backend)))
        problem = outcome_problem(answer, expected_for(tool, c, backend)) or (
            sample_problem(answer) if tool == 'sample' else None
        )
        if problem:
            problems.append(f'{name}: {problem}')
        out[name] = answer

    put('dialect', None, side.tool('dialect'))
    put('stats', None, side.tool('stats', {'mode': 'full'}))
    put('stats', 'quick', side.tool('stats', {'mode': 'quick'}))
    put(
        'list_documents',
        None,
        side.tool('list_documents', {'cursor': None, 'limit': 3, 'deleted': 'active', 'sort': 'path'}),
    )
    put('chunks', None, side.tool('chunks', {'object_id': multi, 'after_chunk': -1, 'limit': 2, 'deleted': 'active'}))
    put('chunks', 'not_found', side.tool('chunks', {'object_id': 'schema'}))
    put('vectors', None, side.tool('vectors', {'keys': [[multi, 0]]}))
    sample = side.tool('sample', {'n': WIRE_SAMPLE_N, 'seed': 7, 'mode': 'detailed', 'knn_k': 5})
    put('sample', None, sample)
    put('sample', 'light', side.tool('sample', {'n': WIRE_SAMPLE_N, 'seed': 7, 'mode': 'light', 'knn_k': 5}))
    if isinstance(sample, dict) and sample.get('sample_id'):
        put(
            'project',
            None,
            side.tool(
                'project', {'sample_id': sample['sample_id'], 'vector': water, 'm': 3, 'with_similarities': True}
            ),
        )
    put('neighbors', None, side.tool('neighbors', {'key': [multi, 0], 'k': 3, 'exclude_self': True}))
    put('search', None, side.tool('search', {'vector': water, 'top_k': 3}))
    put(
        'search',
        'below_floor',
        side.tool(
            'search', {'vector': unrelated, 'top_k': 3, 'include_below_floor': True, 'include_below_threshold': True}
        ),
    )
    put('search', 'dimension_mismatch', side.tool('search', {'vector': water[:10], 'top_k': 3}))
    enriched = set(enriched_captures(tp))
    if ('dialect', 'enriched') in enriched:
        # dialect.json already carries the new keys (size_bytes, keyword_match, the new capabilities);
        # this capture pins them on their own so a change of one names itself.
        d = side.tool('dialect')
        keys = ('size_bytes', 'keyword_match', 'capabilities')
        put(
            'dialect',
            'enriched',
            {'success': d.get('success'), **{k: d.get(k) for k in keys}} if isinstance(d, dict) else d,
        )
    if ('search', 'keyword') in enriched:
        put('search', 'keyword', side.tool('search', {'query': WIRE_KEYWORD, 'mode': 'keyword', 'top_k': 3}))
    if ('list_documents', 'filter') in enriched:
        prefix = WIRE_PREFIX + 'handbooks/'
        put(
            'list_documents',
            'filter',
            side.tool(
                'list_documents',
                {'cursor': None, 'limit': 3, 'deleted': 'active', 'sort': 'path', 'filter': {'path_prefix': prefix}},
            ),
        )
    if ('sample', 'clusters') in enriched:
        cluster = {'method': 'knn-components', 'labels': True}
        put(
            'sample',
            'clusters',
            side.tool('sample', {'n': WIRE_SAMPLE_N, 'seed': 7, 'mode': 'detailed', 'knn_k': 5, 'cluster': cluster}),
        )
    if ('recommend', None) in enriched:
        other = tp.object_id(WIRE_PREFIX + 'greenhouse/orchid_notes.txt')
        examples = {'positive': [[multi, 0]], 'negative': [[other, 0]], 'k': 3}
        put('recommend', None, side.tool('recommend', examples))
        put('recommend', 'best_score', side.tool('recommend', {**examples, 'strategy': 'best_score'}))
        keys = [[multi, 0], [multi, 1], [other, 0]]
        put('similarity_matrix', None, side.tool('similarity_matrix', {'keys': keys}))
    # Last, and on an id nothing was uploaded under: writes that must be refused.
    nobody = disposable_id(tp)
    put('delete', 'writes_source', side.tool('delete', {'object_ids': [nobody]}, source='chat_1'))
    put('delete', 'writes_disabled', _writes_disabled_answer(tp, side, nobody))
    put('delete', 'reserved_id', side.tool('delete', {'object_ids': ['schema']}))
    if problems:
        raise CaptureMismatch('; '.join(problems))
    return out


def _writes_disabled_answer(tp, side, nobody: str) -> Any:
    """The WRITES_DISABLED refusal: a Tools-source ``delete`` on a store whose allow_writes is off.

    Every template's store_2 answers it, except rocketride_vector's. There store_2 keeps
    allow_write off, which hides its write tools (the engine finds no handler), because
    allow_write is the one barrier against agent writes on that node. For it the refusal
    is taken from the generator's own copy of the pipeline: store_1 with allow_write on,
    allow_writes off and no agent wired, run as a side of its own and stopped afterwards.
    """
    if side.template != 'rocketride_vector':
        return side.tool('delete', {'object_ids': [nobody]}, node='store_2')
    pipe = json.loads(json.dumps(side.pipe))
    pipe['project_id'] = str(uuid.uuid4())
    pipe['name'] = f'{pipe.get("name", "vx-wire")} (writes off)'
    for comp in pipe['components']:
        if comp['id'] == 'store_1':
            profile = comp['config']['profile']
            comp['config'][profile] = {**comp['config'][profile], 'allow_write': True, 'allow_writes': False}
    assert not any(str(comp.get('provider', '')).startswith('agent') for comp in pipe['components'])
    variant = tp._Side(side.engine, side.template, f'{side.kind}-writes-off', side.collection, pipe, ('tools_1',))
    try:
        return variant.tool('delete', {'object_ids': [nobody]})
    finally:
        variant.stop()


#: The third document of the wire corpus, removed by the plain ``delete`` capture.
WIRE_THIRD = 'greenhouse/orchid_notes.txt'


def _trash_captures(tp, side, backend: str, kind: str, live: str, second: str) -> Dict[str, Any]:
    """The successful writes of one side, last (they change the data), in one chain on ``second``.

    ``soft_delete`` moves it to the trash, ``chunks`` then refuses it with ``IN_TRASH``,
    ``restore`` takes it back; moved to the trash again, ``delete {deleted_only}`` of it and
    of ``live`` (a document with live chunks) removes it and keeps ``live`` (``kept_live``);
    a plain ``delete`` removes the third document.
    """
    case = (lambda c: c) if kind == 'new' else (lambda c: f'{c}.legacy' if c else 'legacy')
    out: Dict[str, Any] = {}

    def put(tool: str, c: Optional[str], answer: Any) -> None:
        name = file_name(backend, tool, case(c))
        problem = outcome_problem(answer, expected_for(tool, c, backend))
        if problem:
            raise CaptureMismatch(f'{name}: {problem}')
        out[name] = answer

    put('soft_delete', None, side.tool('soft_delete', {'object_ids': [second]}))
    put('chunks', 'in_trash', side.tool('chunks', {'object_id': second}))
    put('restore', None, side.tool('restore', {'object_ids': [second]}))
    again = side.tool('soft_delete', {'object_ids': [second]})
    problem = outcome_problem(again, OK)
    if problem:
        raise CaptureMismatch(f'{backend} {kind}: soft_delete before delete.deleted_only: {problem}')
    put('delete', 'deleted_only', side.tool('delete', {'object_ids': [second, live], 'deleted_only': True}))
    put('delete', None, side.tool('delete', {'object_ids': [tp.object_id(WIRE_PREFIX + WIRE_THIRD)]}))
    return out


def _backend_captures(
    tp, new, legacy, backend: str, multi: str, second: str, water: List[float], unrelated: List[float]
) -> Dict[str, Any]:
    """Both sides' captures, then on each side the trash and removal chain (it changes the data, so it goes last)."""
    out = _captures_for(tp, new, 'new', backend, multi, water, unrelated)
    out.update(_captures_for(tp, legacy, 'legacy', backend, second, water, unrelated))
    for side, kind in ((new, 'new'), (legacy, 'legacy')):
        out.update(_trash_captures(tp, side, backend, kind, multi, second))
    return out


def live_fixtures(only: Optional[Sequence[str]] = None) -> Dict[str, Any]:
    """Every live capture, by file name (starts its own engine; requires the services of the toolpath suite)."""
    import tempfile

    blocker = live_blocker()
    if blocker:
        raise RuntimeError(blocker)

    from . import test_vector_toolpath_full as tp

    corpus = tp.gen_corpus.build_corpus()
    names = [(rel, WIRE_PREFIX + rel) for rel in tp.CORPUS_DOCS]
    out: Dict[str, Any] = {}
    with tempfile.TemporaryDirectory(prefix='vx-wire-') as tmp:
        root = Path(tmp)
        files = []
        for rel, name in names:
            path = root / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(corpus[rel], encoding='utf-8')
            files.append((path, name))
        broker = tp._Broker(tp._PgVector('rocketride_vector').broker_dsn())
        stub = tp._Stub(root)
        engine = tp._Engine(root / 'store', broker)
        try:
            for provider in tp.SUPPORTED:
                if only and provider not in only:
                    continue
                service = tp._service(provider)
                if service.unavailable():
                    raise RuntimeError(service.unavailable())
                backend = provider if provider != 'postgres' else 'pgvector'
                sides = []
                try:
                    new = tp._Side(
                        engine,
                        provider,
                        'new',
                        WIRE_COLLECTION,
                        tp._pipeline(provider, service, WIRE_COLLECTION, stub.url),
                        ('tools_1', 'chat_1', 'ingest_1'),
                    )
                    sides.append(new)
                    results = new.upload(files)
                    failed = [r.get('filepath') for r in results if r.get('action') != 'complete']
                    if failed:
                        raise RuntimeError(f'{provider}: uploads failed: {failed}')
                    multi = tp.object_id(WIRE_PREFIX + tp.MULTI_DOC)
                    (water,) = new.tool('embed', {'texts': [tp.WATER_QUESTION], 'kind': 'query'}, node='embed_1')[
                        'vectors'
                    ]
                    embed_answer = new.tool('embed', {'texts': [tp.WATER_QUESTION], 'kind': 'query'}, node='embed_1')
                    (unrelated,) = new.tool(
                        'embed', {'texts': [tp.UNRELATED_QUESTION], 'kind': 'query'}, node='embed_1'
                    )['vectors']
                    problem = outcome_problem(embed_answer, OK)
                    if problem:
                        raise CaptureMismatch(f'{file_name(backend, "embed")}: {problem}')
                    out[file_name(backend, 'embed')] = embed_answer
                    service.make_legacy(WIRE_COLLECTION, WIRE_LEGACY, multi)
                    legacy = tp._Side(
                        engine,
                        provider,
                        'legacy',
                        WIRE_LEGACY,
                        tp._pipeline(provider, service, WIRE_LEGACY, stub.url),
                        ('tools_1', 'chat_1', 'ingest_1'),
                    )
                    sides.append(legacy)
                    second = tp.object_id(WIRE_PREFIX + 'field/kestrel_field_guide.md')
                    out.update(_backend_captures(tp, new, legacy, backend, multi, second, water, unrelated))
                finally:
                    for side in sides:
                        side.stop()
                    for collection in (WIRE_COLLECTION, WIRE_LEGACY):
                        try:
                            service.drop(collection)
                        except Exception:  # noqa: BLE001 - best-effort clean-up
                            pass
        finally:
            engine.stop()
            stub.close()
            broker.close()
    return out


def committed(directory: Path) -> Dict[str, Any]:
    """The committed captures under directory, by relative file name."""
    return {
        p.relative_to(directory).as_posix(): json.loads(p.read_text(encoding='utf-8'))
        for p in sorted(directory.rglob('*.json'))
    }


def _tool_of(name: str) -> str:
    """``<backend>/<tool>[.<case>].json`` -> tool."""
    return name.split('/', 1)[-1].split('.', 1)[0]


def _close(a: Any, b: Any, tolerance: float) -> bool:
    """Same shape, keys, integers and strings; floats within tolerance."""
    if isinstance(a, float) and isinstance(b, float):
        return abs(a - b) <= tolerance
    if type(a) is not type(b):
        return False
    if isinstance(a, dict):
        return a.keys() == b.keys() and all(_close(a[k], b[k], tolerance) for k in a)
    if isinstance(a, list):
        return len(a) == len(b) and all(_close(x, y, tolerance) for x, y in zip(a, b))
    return a == b


def _comparable(name: str, value: Any) -> Any:
    """A list_documents page that says ``sorted: false`` compared as a set: its items ordered by objectId.

    Such a backend lists in storage order (Qdrant: point-id order), which the
    answer itself declares unordered; the page's members are still compared.
    """
    if _tool_of(name) == 'list_documents' and isinstance(value, dict) and value.get('sorted') is False:
        items = value.get('items')
        if isinstance(items, list) and all(isinstance(i, dict) for i in items):
            return {**value, 'items': sorted(items, key=lambda i: (str(i.get('objectId')), str(i.get('path'))))}
    return value


def differences(regenerated: Dict[str, Any], on_disk: Dict[str, Any]) -> List[str]:
    """File names whose canonical form differs, is missing on disk or is not regenerated."""
    out = []
    for name in sorted(set(regenerated) | set(on_disk)):
        if name not in on_disk or name not in regenerated:
            out.append(name)
            continue
        fresh = _comparable(name, stored(regenerated[name]))
        tolerance = FLOAT_TOLERANCE if _tool_of(name) in SIMILARITY_TOOLS else 0.0
        if not _close(fresh, _comparable(name, on_disk[name]), tolerance):
            out.append(name)
    return out


def _parse(argv: Iterable[str]) -> Tuple[Optional[str], Optional[List[str]]]:
    args = list(argv)
    only = None
    if '--only' in args:
        i = args.index('--only')
        only = [x.strip() for x in args[i + 1].split(',') if x.strip()]
        del args[i : i + 2]
    return (args[0] if len(args) == 1 else None), only


def main(argv) -> int:
    target, only = _parse(argv)
    if target is None:
        print(__doc__)
        return 2
    captures = live_fixtures(only)
    _write(Path(target), captures)
    print('\n'.join(sorted(captures)))
    return 0


if __name__ == '__main__':
    if not __package__:
        # Run as a script: import this module as part of the test package so
        # its relative import of the tool-path suite resolves.
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from test.vector_wire_fixtures import main as package_main

        sys.exit(package_main(sys.argv[1:]))
    sys.exit(main(sys.argv[1:]))
