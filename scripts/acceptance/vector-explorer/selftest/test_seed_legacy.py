# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""Self-tests for the legacy seed's own logic (no engine, database or network).

They check that its verification cannot pass a collection that is not what the
driver suites expect (one control record, exactly the planted document without
chunk 0, on pgvector exactly the planted soft-deleted row, every document
present, the calibrated chunk shape, and the old
drivers' shape: random point ids, only the old metadata keys, only the old
columns), that a seed is refused before any collection is dropped when the
engine it ingests through would cut the corpus without the chunk length or
write the new drivers' shape (whatever this checkout's own files say), that it
only ever drops the legacy names, and that the control row matches the old
driver's columns. The engine is a stand-in here.

Run: python3 -m unittest discover -s scripts/acceptance/vector-explorer/selftest -v
"""

import asyncio
import importlib.util
import re
import sys
import tempfile
import unittest
import uuid

from pathlib import Path

ACC = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ACC))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_calibration import FILTER_MRO, FILTER_OWN_INIT  # noqa: E402 - the two keyword filters, one source


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


seed = _load('vx_seed_legacy', ACC / 'seed_legacy.py')

# The shape an old-driver collection has: pgvector's columns, and on Qdrant/Chroma random ids and the old keys.
OLD_PG_SHAPE = {'columns': sorted(seed.LEGACY_COLUMNS), 'rows': 1, 'meta_rows': 0}
OLD_META = {
    'objectId': 'o',
    'chunkId': 1,
    'nodeId': 'n',
    'parent': 'srv/legacy/a.md',
    'permissionId': 0,
    'isDeleted': False,
    'isTable': False,
    'tableId': 0,
    'signature': 's',
}
# What the explorer's drivers add to every chunk's metadata.
NEW_META = {'ingestedAt': '2026-10-14T23:00:00Z', 'size': 1234, 'modifyTime': 1760000000}


def corpus_points(ids='random', extra_meta=None, extra_payload=None):
    """Qdrant-like (point id, payload) records of a seeded corpus: a control record, every document, the orphan.

    ``ids='derived'`` gives the new drivers' ids; ``extra_meta``/``extra_payload`` add keys to every chunk.
    """
    orphan = seed.fx.object_id(seed.PREFIX + seed.ORPHAN_REL)
    control = {'objectId': 'schema', 'chunkId': 0, 'isDeleted': True, 'vectorSize': 384, 'modelName': 'm'}
    points = [(str(uuid.uuid4()), {'content': '', 'meta': control})]
    for name in seed.corpus_names(seed._corpus()):
        oid = seed.fx.object_id(name)
        for cid in range(1, 70) if oid == orphan else range(3):
            meta = dict(OLD_META, objectId=oid, chunkId=cid, parent=name[1:], **(extra_meta or {}))
            pid = seed.derived_id(oid, cid) if ids == 'derived' else str(uuid.uuid4())
            points.append((pid, {'content': 'x' * 800, 'meta': meta, **(extra_payload or {})}))
    return points


def as_chroma(points):
    """The same records the way Chroma returns them: (id, metadata, document)."""
    return [(pid, payload['meta'], payload['content']) for pid, payload in points]


class OrphanTests(unittest.TestCase):
    def test_a_document_without_chunk_0_is_an_orphan(self):
        rows = [('schema', 0), ('a', 0), ('a', 1), ('b', 1), ('b', 2), ('c', 0)]
        self.assertEqual(seed.orphans(rows), ['b'])

    def test_the_control_record_is_never_an_orphan(self):
        self.assertEqual(seed.orphans([('schema', 3)]), [])


class VerdictTests(unittest.TestCase):
    def ok(self, **overrides):
        args = dict(
            control=1,
            orphan_ids=['x'],
            expected_orphan='x',
            documents=40,
            expected_documents=40,
            long_manual_chunks=159,
            median_chunk_chars=806,
            shape=OLD_PG_SHAPE,
            soft_deleted=[('s', 1)],
            expected_soft_deleted=('s', 1),
        )
        args.update(overrides)
        return seed.verdict('pgvector', **args)

    def test_the_promised_collection_passes(self):
        self.assertEqual(self.ok(), [])

    def test_each_broken_promise_is_a_problem(self):
        self.assertTrue(self.ok(control=0))
        self.assertTrue(self.ok(control=2))
        self.assertTrue(self.ok(orphan_ids=[]))
        self.assertTrue(self.ok(orphan_ids=['x', 'y']))
        self.assertTrue(self.ok(orphan_ids=['y']))
        self.assertTrue(self.ok(expected_orphan=None, orphan_ids=[]))
        self.assertTrue(self.ok(documents=39))
        self.assertTrue(self.ok(missing=['a-missing-document']))
        with_meta = dict(OLD_PG_SHAPE, columns=sorted(seed.LEGACY_COLUMNS | {'meta'}))
        self.assertTrue(self.ok(shape=with_meta, seeded_now=True))

    def test_pgvector_needs_exactly_the_planted_soft_deleted_row(self):
        # The health fields' live case: one soft-deleted row of a document that keeps its other rows.
        for soft in ([], [('s', 1), ('s', 2)], [('s', 2)], [('t', 1)], None):
            problems = self.ok(soft_deleted=soft)
            self.assertTrue(any('soft-deleted' in p for p in problems), (soft, problems))
        self.assertEqual(self.ok(soft_deleted=[['s', 1]]), [])  # rows read back as lists
        # Qdrant and Chroma report no soft-deleted chunks, so their verdict asks for none.
        self.assertEqual(self.ok(soft_deleted=None, expected_soft_deleted=None), [])

    def test_the_soft_deleted_row_is_a_middle_chunk_of_a_corpus_document_other_than_the_orphan(self):
        names = seed.corpus_names(seed._corpus())
        self.assertIn(seed.PREFIX + seed.SOFT_DELETED_REL, names)
        self.assertNotEqual(seed.SOFT_DELETED_REL, seed.ORPHAN_REL)
        self.assertGreater(seed.SOFT_DELETED_CHUNK, 0)

    def test_a_collection_whose_shape_was_not_read_fails(self):
        # No backend can pass without its shape being checked.
        self.assertTrue(self.ok(shape=None))
        self.assertTrue(self.ok(shape={}))

    def test_a_collection_chunked_without_the_calibrated_length_fails(self):
        # A seed on an engine whose chunker ignores strlen: about 36 chunks of up to 4,000 characters.
        self.assertTrue(self.ok(long_manual_chunks=33))
        self.assertTrue(self.ok(median_chunk_chars=3409))
        self.assertTrue(self.ok(median_chunk_chars=399))
        self.assertTrue(self.ok(median_chunk_chars=None))
        # The long manual keeps more than 64 chunks: at least 64 rows once chunk 0 is gone.
        self.assertTrue(self.ok(long_manual_chunks=63))
        self.assertEqual(self.ok(long_manual_chunks=64, median_chunk_chars=1200), [])

    def test_the_median_skips_the_control_record(self):
        self.assertEqual(seed.median_length(['', 'abcd', 'ab', 'abcdef']), 4)
        self.assertIsNone(seed.median_length([]))

    def test_object_ids_follow_the_engine(self):
        # Observed on the engine: an upload named '/srv/legacy/ops/memo_q2.txt' is stored with
        # parent 'srv/legacy/ops/memo_q2.txt' and this objectId (derived from the name as sent).
        self.assertEqual(seed.fx.object_id('/srv/legacy/ops/memo_q2.txt'), '9f2bee29-b134-547e-9ba8-2ff9f8dd0f42')


class ShapeTests(unittest.TestCase):
    """A collection in the explorer drivers' shape is not a legacy collection, whatever its counts say."""

    @staticmethod
    def shape(points):
        return seed.point_shape((pid, payload.get('meta') or {}, payload.keys()) for pid, payload in points)

    def test_the_old_drivers_points_pass(self):
        shape = self.shape(corpus_points())
        self.assertEqual(seed.shape_problems('qdrant', shape), [])
        self.assertEqual(seed.shape_problems('chroma', shape), [])
        self.assertEqual(shape['derived_ids'], 0)
        self.assertEqual(shape['id_versions'], {'4': len(corpus_points())})

    def test_the_new_drivers_derived_ids_fail(self):
        shape = self.shape(corpus_points(ids='derived'))
        self.assertEqual(shape['derived_ids'], len(corpus_points()) - 1)  # every chunk but the control record
        for backend in ('qdrant', 'chroma'):
            problems = seed.shape_problems(backend, shape)
            self.assertTrue(any('derived' in p for p in problems), problems)
            self.assertTrue(any('random' in p for p in problems), problems)

    def test_ids_that_are_not_random_uuids_fail(self):
        for odd in (7, str(uuid.uuid1()), 'not-a-uuid'):
            points = corpus_points()
            points[1] = (odd, points[1][1])
            self.assertTrue(seed.shape_problems('qdrant', self.shape(points)), odd)

    def test_each_metadata_key_the_new_drivers_add_fails(self):
        for key, value in NEW_META.items():
            problems = seed.shape_problems('chroma', self.shape(corpus_points(extra_meta={key: value})))
            self.assertTrue(any(key in p for p in problems), (key, problems))

    def test_a_top_level_payload_key_fails_on_qdrant(self):
        problems = seed.shape_problems('qdrant', self.shape(corpus_points(extra_payload={'pointId': 'x'})))
        self.assertTrue(any('pointId' in p for p in problems), problems)

    def test_the_control_records_own_keys_are_legacy(self):
        self.assertEqual(seed.CONTROL_META_KEYS, {'vectorSize', 'modelName'})
        self.assertFalse(seed.LEGACY_META_KEYS & set(NEW_META))

    def test_a_collection_without_chunks_has_no_shape_to_pass(self):
        # A probe whose upload wrote nothing but the driver's control record proves nothing either.
        self.assertTrue(seed.shape_problems('qdrant', seed.point_shape([])))
        control_only = corpus_points()[:1]
        self.assertTrue(seed.shape_problems('chroma', self.shape(control_only)))
        self.assertTrue(seed.shape_problems('pgvector', dict(OLD_PG_SHAPE, rows=0)))

    def test_pgvector_has_exactly_the_old_columns(self):
        self.assertEqual(seed.shape_problems('pgvector', OLD_PG_SHAPE), [])
        missing = dict(OLD_PG_SHAPE, columns=sorted(seed.LEGACY_COLUMNS - {'signature'}))
        self.assertTrue(seed.shape_problems('pgvector', missing))
        extra = dict(OLD_PG_SHAPE, columns=sorted(seed.LEGACY_COLUMNS | {'pointid'}))
        self.assertTrue(seed.shape_problems('pgvector', extra))

    def test_a_meta_column_is_new_only_right_after_a_seed_and_never_holds_corpus_rows(self):
        with_meta = dict(OLD_PG_SHAPE, columns=sorted(seed.LEGACY_COLUMNS | {'meta'}))
        # A newer driver adds the column when it first opens the table ...
        self.assertEqual(seed.shape_problems('pgvector', with_meta), [])
        # ... but a seed that ends with one ran through a newer driver ...
        self.assertTrue(seed.shape_problems('pgvector', with_meta, seeded_now=True))
        # ... and rows that carry meta were written by one, whenever that was.
        self.assertTrue(seed.shape_problems('pgvector', dict(with_meta, meta_rows=3)))

    def test_the_legacy_columns_are_the_old_ddls(self):
        ddl_columns = re.findall(r'(\w+) (?:bigserial|text|int|boolean|vector)', seed.LEGACY_DDL)
        self.assertEqual({c.lower() for c in ddl_columns}, seed.LEGACY_COLUMNS)

    def test_the_derived_id_is_the_new_drivers(self):
        # store_qdrant / store_chroma after the explorer: uuid5(NAMESPACE_URL, 'objectId#chunkId').
        self.assertEqual(seed.derived_id('o', 3), str(uuid.uuid5(uuid.NAMESPACE_URL, 'o#3')))


class VerifyShapeTests(unittest.TestCase):
    """verify() reads the shape of every backend: the new drivers' shape fails with every count right."""

    def setUp(self):
        names = ('qdrant_exists', 'chroma_exists', '_qdrant_records', '_chroma_records')
        self.saved = {n: getattr(seed, n) for n in names}
        seed.qdrant_exists = seed.chroma_exists = lambda name: True

    def tearDown(self):
        for n, f in self.saved.items():
            setattr(seed, n, f)

    def verify(self, points):
        seed._qdrant_records = lambda name: points
        seed._chroma_records = lambda name: as_chroma(points)
        return seed.verify(['qdrant', 'chroma'])

    def test_an_old_driver_collection_passes(self):
        facts, problems = self.verify(corpus_points())
        self.assertEqual(problems, [])
        self.assertEqual(facts['qdrant']['shape']['id_versions'], {'4': len(corpus_points())})

    def test_a_copy_in_the_new_drivers_shape_fails(self):
        # The counterexample: the same documents and chunks, written with derived ids and the new keys.
        new = corpus_points(ids='derived', extra_meta=NEW_META, extra_payload={'pointId': 'x'})
        facts, problems = self.verify(new)
        self.assertEqual(facts['qdrant']['documents'], 40)
        self.assertEqual(facts['qdrant']['orphans'], [seed.fx.object_id(seed.PREFIX + seed.ORPHAN_REL)])
        for backend in ('qdrant', 'chroma'):
            mine = [p for p in problems if p.startswith(backend)]
            self.assertTrue(any('derived' in p for p in mine), mine)
            self.assertTrue(any('ingestedAt' in p for p in mine), mine)
        self.assertTrue(any(p.startswith('qdrant') and 'pointId' in p for p in problems), problems)


class ChunkerPreflightTests(unittest.TestCase):
    """What a chunker node file would cut (the seed reports it for this checkout's node; no engine call)."""

    def setUp(self):
        if seed.cal.node_splitter_kwargs({}) is None:
            self.skipTest('NOT RUN: langchain_text_splitters is not importable here (run with the engine python)')

    def test_a_chunker_that_drops_the_length_is_refused(self):
        preview = seed.chunker_preview(seed.corpus_texts(), 1000, FILTER_OWN_INIT)
        self.assertFalse(preview['passes_chunk_size'])
        # LangChain's own 4,000-character default: about 35 chunks for the manual.
        self.assertLess(preview['long_manual_chunks'], seed.LONG_MANUAL_MIN_ROWS)
        problems = seed.chunking_problems(preview)
        self.assertTrue(any('long manual' in p for p in problems), problems)
        self.assertTrue(any('median' in p for p in problems), problems)

    def test_a_chunker_that_passes_the_length_gives_the_calibrated_shape(self):
        preview = seed.chunker_preview(seed.corpus_texts(), 1000, FILTER_MRO)
        self.assertTrue(preview['passes_chunk_size'])
        # More than 64 chunks, so at least 64 rows stay once chunk 0 is deleted.
        self.assertGreater(preview['long_manual_chunks'], seed.LONG_MANUAL_MIN_ROWS)
        self.assertEqual(seed.chunking_problems(preview), [])

    def test_a_shape_just_short_of_the_promise_is_refused(self):
        ok = {'long_manual_chunks': seed.LONG_MANUAL_MIN_ROWS + 1, 'median_chunk_chars': 806}
        self.assertEqual(seed.chunking_problems(ok), [])
        self.assertTrue(seed.chunking_problems(dict(ok, long_manual_chunks=seed.LONG_MANUAL_MIN_ROWS)))
        self.assertTrue(seed.chunking_problems(dict(ok, median_chunk_chars=1201)))


class ChunkerLocationTests(unittest.TestCase):
    """The checkout's node file the seed reports is the one an engine started from this checkout imports."""

    def setUp(self):
        self.saved_path = list(sys.path)
        self.saved_nodes = sys.modules.pop('nodes', None)

    def tearDown(self):
        sys.path[:] = self.saved_path
        sys.modules.pop('nodes', None)
        if self.saved_nodes is not None:
            sys.modules['nodes'] = self.saved_nodes

    @staticmethod
    def _node(root: Path) -> Path:
        node = root / 'nodes' / 'preprocessor_langchain' / 'langchain.py'
        node.parent.mkdir(parents=True)
        (root / 'nodes' / '__init__.py').write_text('raise RuntimeError("never imported")\n', encoding='utf-8')
        node.write_text('# a chunker node\n', encoding='utf-8')
        return node

    def test_the_nodes_package_on_the_path_wins_over_the_dist_copy(self):
        # An engine puts the checkout's nodes/src ahead of dist/server on its path: that copy runs.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            imported = self._node(root / 'src')
            self._node(root / 'dist')
            sys.path.insert(0, str(root / 'src'))
            self.assertEqual(seed.checkout_chunker(str(root / 'dist' / 'engine')), imported)

    def test_without_an_importable_nodes_package_the_copy_next_to_the_engine_is_checked(self):
        sys.path[:] = [p for p in sys.path if not (Path(p) / 'nodes' / '__init__.py').is_file()]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            self.assertEqual(seed.checkout_chunker(str(root / 'engine')), seed.REPO_CHUNKER)
            copy = self._node(root)
            self.assertEqual(seed.checkout_chunker(str(root / 'engine')), copy)

    def test_the_seed_uses_the_templates_chunk_length(self):
        self.assertEqual(seed.template_strlen(), 1000)


class FakeEngine:
    """An engine stand-in at ENGINE_URL: a chunk probe answers fixed-size slices of each uploaded file."""

    def __init__(self, size: int) -> None:
        self.size = size
        self.used = []
        self.uploads = []
        self.terminated = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def use(self, *, pipeline, source, ttl=None, **kwargs):
        self.used.append((pipeline, source, ttl))
        return {'token': f'task-{len(self.used)}'}

    async def send_files(self, files, token):
        out = []
        for path, info in files:
            self.uploads.append(info['name'])
            text = Path(path).read_text(encoding='utf-8')
            pieces = [text[i : i + self.size] for i in range(0, len(text), self.size)]
            out.append({'result': {'documents': [{'page_content': piece} for piece in pieces]}})
        return out

    async def terminate(self, token):
        self.terminated.append(token)


def run_check(engine):
    """chunker_check on the corpus against ``engine``."""
    corpus = seed._corpus()
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        return asyncio.run(seed.chunker_check(engine, root, corpus.write_corpus(root)))


class EnginePreflightTests(unittest.TestCase):
    """The chunker preflight asks the engine the seed ingests through (ENGINE_URL), not this checkout's file."""

    def test_the_probe_runs_the_templates_parse_and_chunk_lanes_on_the_engine(self):
        engine = FakeEngine(900)
        preview = run_check(engine)
        ((pipeline, source, ttl),) = engine.used
        self.assertEqual(source, 'ingest_1')
        self.assertEqual(ttl, 0)
        parts = {c['id']: c for c in pipeline['components']}
        template = {c['id']: c for c in seed.fx.load_template('postgres')['components']}
        for cid in ('ingest_1', 'parse_1', 'chunk_1'):
            self.assertEqual(parts[cid]['provider'], template[cid]['provider'], cid)
            self.assertEqual(parts[cid]['config'], template[cid]['config'], cid)
        self.assertEqual(parts['response_1']['provider'], 'response_documents')
        self.assertEqual(parts['response_1']['input'], [{'lane': 'documents', 'from': 'chunk_1'}])
        self.assertNotIn('embed_1', parts)
        self.assertEqual(len(engine.uploads), 40)
        self.assertEqual(engine.terminated, ['task-1'])
        self.assertEqual(preview['engine'], seed.fx.ENGINE_URL)
        self.assertEqual((preview['long_manual_chunks'], preview['median_chunk_chars']), (145, 900))
        self.assertEqual(preview['problems'], [])

    def test_an_engine_that_cuts_4000_character_chunks_is_refused(self):
        preview = run_check(FakeEngine(4000))
        self.assertEqual(preview['long_manual_chunks'], 33)
        self.assertTrue(any('long manual' in p for p in preview['problems']), preview['problems'])
        self.assertTrue(any('median' in p for p in preview['problems']), preview['problems'])

    def test_an_engine_that_answers_no_chunks_is_refused(self):
        preview = run_check(FakeEngine(10**9))
        self.assertTrue(preview['problems'])


class SeedRefusalTests(unittest.TestCase):
    """A seed the engine would get wrong is refused before any legacy collection is touched."""

    TOUCH = (
        'pg_create',
        'pg_drop',
        'qdrant_drop',
        'chroma_drop',
        'pg_plant_orphan',
        'pg_plant_soft_deleted',
        'qdrant_plant_orphan',
        'chroma_plant_orphan',
    )

    def setUp(self):
        self.calls = []
        names = self.TOUCH + ('ingest', 'pg_chunk_ids', 'collection_shape', 'checkout_chunker', 'engine_client')
        self.saved = {n: getattr(seed, n) for n in names + ('pg_exists', 'qdrant_exists', 'chroma_exists')}
        for n in self.TOUCH:
            setattr(seed, n, lambda name, *a, _n=n, **k: self.calls.append((_n, name)))

        async def ingest(client, key, collection, files):
            self.calls.append(('ingest', key, collection))

        seed.ingest = ingest
        seed.pg_chunk_ids = lambda name, object_id: list(range(160))
        for n in ('pg_exists', 'qdrant_exists', 'chroma_exists'):
            setattr(seed, n, lambda *a: False)
        self.engine = FakeEngine(900)
        seed.engine_client = lambda: self.engine
        self.shape = self.old_shape

    def tearDown(self):
        for n, f in self.saved.items():
            setattr(seed, n, f)

    @staticmethod
    def old_shape(backend, name):
        return (
            OLD_PG_SHAPE
            if backend == 'pgvector'
            else seed.point_shape([(str(uuid.uuid4()), OLD_META, ('content', 'meta'))])
        )

    @staticmethod
    def new_shape(backend, name):
        if backend == 'pgvector':
            return {'columns': sorted(seed.LEGACY_COLUMNS | {'meta'}), 'meta_rows': 1}
        return seed.point_shape([(seed.derived_id('o', 1), dict(OLD_META, **NEW_META), ('content', 'meta'))])

    def run_seed(self, recreate=True):
        seed.collection_shape = lambda backend, name: self.shape(backend, name)
        return asyncio.run(seed.seed(list(seed.BACKENDS), recreate=recreate))

    def legacy_calls(self):
        return [c for c in self.calls if seed.LEGACY in c]

    def node_file(self, source):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        node = Path(tmp.name) / 'langchain.py'
        node.write_text(source, encoding='utf-8')
        seed.checkout_chunker = lambda *a: node

    def test_an_engine_that_ignores_the_length_is_refused_although_this_checkouts_node_passes_it(self):
        self.engine.size = 4000
        self.node_file(FILTER_MRO)
        with self.assertRaises(seed.ChunkerRefused) as refused:
            self.run_seed()
        self.assertEqual(refused.exception.preview['engine'], seed.fx.ENGINE_URL)
        self.assertEqual(self.calls, [])

    def test_an_engine_that_cuts_the_calibrated_shape_seeds_although_this_checkouts_node_drops_the_length(self):
        self.node_file(FILTER_OWN_INIT)
        notes = self.run_seed()
        self.assertEqual(sorted(notes), sorted(seed.BACKENDS))
        self.assertIn(('pg_create', seed.LEGACY), self.calls)
        self.assertIn(('ingest', 'qdrant', seed.LEGACY), self.calls)
        # The soft-deleted row is planted after the ingest, on pgvector only.
        planted = [c for c in self.calls if c[0].endswith('_plant_soft_deleted')]
        self.assertEqual(planted, [('pg_plant_soft_deleted', seed.LEGACY)])
        self.assertGreater(self.calls.index(planted[0]), self.calls.index(('ingest', 'postgres', seed.LEGACY)))
        chunker = notes['pgvector']['chunker']
        self.assertEqual((chunker['engine'], chunker['long_manual_chunks']), (seed.fx.ENGINE_URL, 145))
        # This checkout's node is reported, not obeyed.
        self.assertIn(chunker['checkout_node']['passes_chunk_size'], (False, None))

    def test_an_engine_whose_drivers_write_the_new_shape_is_refused_before_a_legacy_name_is_touched(self):
        self.node_file(FILTER_MRO)
        self.shape = self.new_shape
        with self.assertRaises(seed.DriverRefused) as refused:
            self.run_seed()
        problems = refused.exception.preview['problems']
        for backend in seed.BACKENDS:
            self.assertTrue(any(p.startswith(backend) for p in problems), (backend, problems))
        self.assertEqual(self.legacy_calls(), [])
        # Only the probe collection was written, through every driver the seed uses, and it is gone again.
        written = {(c[1], c[2]) for c in self.calls if c[0] == 'ingest'}
        self.assertEqual(written, {(k, seed.PROBE) for k in ('postgres', 'rocketride_vector', 'qdrant', 'chroma')})
        for drop in ('pg_drop', 'qdrant_drop', 'chroma_drop'):
            self.assertEqual(self.calls[-3:].count((drop, seed.PROBE)), 1, (drop, self.calls[-3:]))

    def test_the_driver_probe_runs_before_the_seed_and_cleans_up(self):
        self.node_file(FILTER_MRO)
        notes = self.run_seed()
        first_legacy = self.calls.index(self.legacy_calls()[0])
        probe = [c for c in self.calls[:first_legacy] if seed.PROBE in c]
        self.assertTrue(probe)
        self.assertFalse([c for c in self.calls[first_legacy:] if seed.PROBE in c])
        self.assertEqual(notes['qdrant']['drivers']['id_versions'], {'4': 1})

    def test_nothing_to_seed_needs_no_preflight(self):
        for n in ('pg_exists', 'qdrant_exists', 'chroma_exists'):
            setattr(seed, n, lambda *a: True)
        seed.engine_client = lambda: self.fail('the engine was asked although nothing is seeded')
        self.assertEqual(asyncio.run(seed.seed(list(seed.BACKENDS), recreate=False)), {})
        self.assertEqual(self.calls, [])


class TopUpTests(unittest.TestCase):
    """A pgvector table seeded before the soft-deleted row existed gets it in place: no engine, no re-ingest."""

    def setUp(self):
        self.calls = []
        names = ('pg_exists', 'pg_soft_deleted', 'pg_plant_soft_deleted', 'engine_client', 'seed', 'verify')
        self.saved = {n: getattr(seed, n) for n in names}
        seed.pg_exists = lambda name: True
        seed.pg_soft_deleted = lambda name: list(self.present)
        seed.pg_plant_soft_deleted = lambda name, oid, chunk: self.calls.append((name, oid, chunk)) or 1
        seed.engine_client = lambda: self.fail('the top-up asked the engine')
        self.present = []

    def tearDown(self):
        for n, f in self.saved.items():
            setattr(seed, n, f)

    def test_a_table_without_the_row_gets_it(self):
        notes = seed.top_up(['pgvector'])
        soft_id = seed.fx.object_id(seed.PREFIX + seed.SOFT_DELETED_REL)
        self.assertEqual(self.calls, [(seed.LEGACY, soft_id, seed.SOFT_DELETED_CHUNK)])
        self.assertEqual(notes, {'pgvector': {'soft_deleted_rows': 1}})

    def test_nothing_is_planted_twice_or_over_other_soft_deletes(self):
        self.present = [('someone', 3)]
        self.assertEqual(seed.top_up(['pgvector']), {})
        self.assertEqual(self.calls, [])

    def test_a_table_this_run_seeded_or_not_selected_is_left_alone(self):
        self.assertEqual(seed.top_up(['pgvector'], seeded=['pgvector']), {})
        self.assertEqual(seed.top_up(['qdrant', 'chroma']), {})
        seed.pg_exists = lambda name: False
        self.assertEqual(seed.top_up(['pgvector']), {})
        self.assertEqual(self.calls, [])

    def run_main(self, *argv):
        async def no_seed(backends, recreate):
            return {}

        seed.seed = no_seed
        seed.verify = lambda backends, seeded_now=(): ({}, [])
        saved_argv = sys.argv
        sys.argv = ['seed_legacy.py', *argv]
        try:
            import contextlib
            import io

            with contextlib.redirect_stdout(io.StringIO()):
                return seed.main()
        finally:
            sys.argv = saved_argv

    def test_main_tops_up_but_verify_only_never_writes(self):
        self.assertEqual(self.run_main('--only', 'pgvector', '--verify-only'), 0)
        self.assertEqual(self.calls, [])
        self.assertEqual(self.run_main('--only', 'pgvector'), 0)
        self.assertEqual(len(self.calls), 1)


class SafetyTests(unittest.TestCase):
    def test_only_legacy_names_are_dropped(self):
        self.assertEqual(seed._guard('vx_legacy_docs'), 'vx_legacy_docs')
        for name in ('vx_demo_docs', 'rocketride', 'legacy', 'vx_legacy'):
            with self.assertRaises(ValueError):
                seed._guard(name)

    def test_the_control_row_has_the_old_drivers_columns(self):
        ddl_columns = re.findall(r'(\w+) (?:bigserial|text|int|boolean|vector)', seed.LEGACY_DDL)
        self.assertEqual(sorted(c.lower() for c in ddl_columns if c != 'id'), sorted(seed.control_row()))

    def test_the_control_row_is_createCollections(self):
        row = seed.control_row(model='m', dim=3)
        self.assertEqual(row['objectid'], 'schema')
        self.assertIs(row['isdeleted'], True)
        self.assertEqual(row['chunkid'], 0)
        self.assertEqual((row['vectorsize'], row['modelname'], row['content']), (3, 'm', ''))
        self.assertEqual(row['embedding'], '[0,0,0]')
        self.assertEqual(
            [k for k, v in row.items() if v is None],
            ['nodeid', 'parent', 'permissionid', 'istable', 'tableid', 'signature'],
        )

    def test_the_driver_probe_is_a_legacy_name_and_one_small_corpus_file(self):
        self.assertEqual(seed._guard(seed.PROBE), seed.PROBE)
        self.assertNotEqual(seed.PROBE, seed.LEGACY)
        texts = seed.corpus_texts()
        self.assertIn(seed.PROBE_REL, texts)
        self.assertLess(len(texts[seed.PROBE_REL]), seed.template_strlen())  # a single chunk

    def test_paths_are_posix_under_the_legacy_prefix(self):
        corpus = seed._corpus()
        names = seed.corpus_names(corpus)
        self.assertEqual(len(names), 40)
        self.assertTrue(all(n.startswith('/srv/legacy/') for n in names))
        self.assertIn(seed.PREFIX + seed.ORPHAN_REL, names)
        kitchen = seed.corpus_names(corpus, seed.RR_PREFIX, seed.RR_FOLDER)
        self.assertTrue(kitchen and all(n.startswith('/srv/legacy-rr/kitchen/') for n in kitchen))


if __name__ == '__main__':
    unittest.main()
