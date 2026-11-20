# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""Self-tests for the demo seeding plan (no engine, database or network).

Run: python3 -m unittest discover -s scripts/acceptance/vector-explorer/selftest -v
"""

import importlib.util
import sys
import tempfile
import unittest

from pathlib import Path

ACC = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ACC))


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


seed = _load('vx_seed_demo', ACC / 'demo' / 'seed_demo.py')


class DemoNamesTests(unittest.TestCase):
    def test_every_document_is_named_under_c_demo(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            files = seed.corpus_files(root)
            self.assertEqual(len(files), 40)
            for path, name in files:
                rel = path.relative_to(root).as_posix()
                self.assertEqual(name, 'C:/demo/' + rel)
                self.assertTrue(path.is_file())

    def test_the_stock_rag_fixture_gets_a_distinct_subset(self):
        with tempfile.TemporaryDirectory() as tmp:
            files = seed.corpus_files(Path(tmp), folders=seed.STOCK_RAG_FOLDERS)
            folders = {name.split('/')[2] for _, name in files}
            self.assertEqual(folders, set(seed.STOCK_RAG_FOLDERS))
            self.assertLess(len(files), 40)


class IfEmptyTests(unittest.TestCase):
    """--if-empty must not skip a store that holds only its control record."""

    def test_documents_from_the_stats_answer(self):
        # The explorer's stats counts documents (control record excluded).
        self.assertEqual(seed.stored_documents({'success': True, 'documents': 0, 'count': 1}), 0)
        self.assertEqual(seed.stored_documents({'success': True, 'documents': 40, 'count': 307}), 40)
        # The legacy stats count is every row, the control record included.
        self.assertEqual(seed.stored_documents({'count': 1}), 0)
        self.assertEqual(seed.stored_documents({'count': 0}), 0)
        self.assertEqual(seed.stored_documents({'count': 82}), 81)
        self.assertIsNone(seed.stored_documents(None))
        self.assertIsNone(seed.stored_documents({'success': False, 'code': 'COLLECTION_MISSING'}))

    def test_a_store_with_only_its_control_record_is_seeded(self):
        self.assertTrue(seed.is_empty({'count': 1}))
        self.assertTrue(seed.is_empty({'success': True, 'documents': 0, 'count': 1}))
        self.assertTrue(seed.is_empty(None))
        self.assertFalse(seed.is_empty({'count': 2}))
        self.assertFalse(seed.is_empty({'success': True, 'documents': 1, 'count': 2}))


class PagerTests(unittest.TestCase):
    def test_1500_unique_one_chunk_documents(self):
        docs = seed.pager_documents()
        self.assertEqual(len(docs), 1500)
        names = [name for name, _ in docs]
        self.assertEqual(len(set(names)), 1500)
        self.assertTrue(all(name.startswith('C:/pager/') for name in names))
        # One chunk each at any chunk length the calibration allows.
        self.assertTrue(all(0 < len(text) < 400 for _, text in docs))
        # Spread over folders, so the directory tree has more than one level.
        self.assertGreater(len({name.rsplit('/', 1)[0] for name in names}), 10)

    def test_the_same_documents_every_run(self):
        self.assertEqual(seed.pager_documents(), seed.pager_documents())

    def test_batches_cover_everything_once(self):
        items = list(range(103))
        batches = list(seed.batches(items, 25))
        self.assertEqual([len(b) for b in batches], [25, 25, 25, 25, 3])
        self.assertEqual([x for b in batches for x in b], items)


if __name__ == '__main__':
    unittest.main()
