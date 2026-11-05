# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""Self-tests for the demo corpus generator (no engine, database or network).

The seeded stores, the map lanes and the legacy recipes rely on what the
corpus promises: forty documents, one long document well past 64 chunks at the
calibrated chunking, two near-duplicate pairs, one boilerplate paragraph in
exactly six files, one OCR-junk file and one table file, written the same way
on every run.

Run: python3 -m unittest discover -s scripts/acceptance/vector-explorer/selftest -v
"""

import difflib
import importlib.util
import io
import json
import re
import sys
import tempfile
import unittest

from contextlib import redirect_stdout
from pathlib import Path

ACC = Path(__file__).resolve().parent.parent
REPO = ACC.parent.parent.parent
CHUNKING = REPO / 'apps' / 'vector-ui' / 'tests' / 'fixtures' / 'chunking.json'


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


gen = _load('vx_gen_corpus', ACC / 'demo' / 'gen_corpus.py')


def _chunk_chars() -> int:
    """The calibrated chunk length (characters), or the largest the calibration allows."""
    chunking = json.loads(CHUNKING.read_text(encoding='utf-8'))
    if not chunking.get('calibrated'):
        return 1200
    config = chunking['chunk_1']['config']
    return int(config[config['profile']]['strlen'])


class CorpusTests(unittest.TestCase):
    def setUp(self):
        self.corpus = gen.build_corpus()

    def test_forty_documents_in_eleven_folders(self):
        self.assertEqual(len(self.corpus), 40)
        folders = {path.split('/')[0] for path in self.corpus}
        self.assertEqual(
            folders,
            {
                'archive',
                'field',
                'greenhouse',
                'handbooks',
                'kitchen',
                'manuals',
                'observatory',
                'ops',
                'reports',
                'scans',
                'tables',
            },
        )

    def test_every_document_has_text_and_a_known_type(self):
        for path, text in self.corpus.items():
            self.assertRegex(path, r'^[a-z]+/[a-z0-9_]+\.(md|txt|html)$')
            self.assertGreater(len(text.strip()), 200, path)

    def test_the_same_bytes_on_every_run(self):
        self.assertEqual(self.corpus, gen.build_corpus())

    def test_the_long_manual_is_well_past_64_chunks(self):
        text = self.corpus[gen.LONG_MANUAL]
        # A splitter that fills chunks to the limit still needs this many.
        self.assertGreater(len(text) / _chunk_chars(), 64 * 1.5)
        self.assertEqual(len(re.findall(r'^## Procedure \d+:', text, re.M)), 160)

    def test_two_near_duplicate_pairs(self):
        for original, copy in gen.NEAR_DUPLICATES:
            a, b = self.corpus[original], self.corpus[copy]
            self.assertNotEqual(a, b)
            self.assertGreater(difflib.SequenceMatcher(None, a, b).ratio(), 0.9, (original, copy))

    def test_the_boilerplate_paragraph_ends_exactly_six_files(self):
        holders = sorted(path for path, text in self.corpus.items() if gen.BOILERPLATE in text)
        self.assertEqual(holders, sorted(gen.BOILERPLATE_FILES))
        self.assertEqual(len(holders), 6)
        for path in holders:
            self.assertTrue(self.corpus[path].rstrip().endswith(gen.BOILERPLATE), path)

    def test_one_ocr_junk_file_and_one_table_file(self):
        junk = self.corpus[gen.OCR_FILE]
        words = re.findall(r'\S+', junk)
        dictionary_like = [w for w in words if re.fullmatch(r'[A-Za-z]{3,}', w)]
        self.assertLess(len(dictionary_like) / len(words), 0.2)
        table = self.corpus[gen.TABLE_FILE]
        self.assertIn('<table>', table)
        self.assertEqual(table.count('<tr><td>EQ-'), 60)
        self.assertEqual([p for p in self.corpus if p.endswith('.html')], [gen.TABLE_FILE])

    def test_check_mode_reports_a_changed_or_extra_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            with redirect_stdout(io.StringIO()):
                self.assertEqual(gen.main([str(out)]), 0)
                self.assertEqual(gen.main([str(out), '--check']), 0)
            (out / 'ops' / 'memo_q1.txt').write_text('changed\n', encoding='utf-8')
            (out / 'ops' / 'stray.txt').write_text('extra\n', encoding='utf-8')
            self.assertEqual(sorted(gen.differences(out)), ['ops/memo_q1.txt', 'ops/stray.txt'])


if __name__ == '__main__':
    unittest.main()


class BrowserLaneFactsTests(unittest.TestCase):
    """env.cjs names the planted documents the map lane checks; they must be the generator's."""

    def setUp(self):
        self.env = (ACC / 'env.cjs').read_text(encoding='utf-8')
        block = re.search(r'const DEMO_CORPUS = \{(.*?)\n\};', self.env, re.S)
        self.assertIsNotNone(block, 'env.cjs has no DEMO_CORPUS')
        self.block = block.group(1)

    def _quoted(self, key: str):
        m = re.search(rf'{key}: (\[\s*\[.*?\]\s*,?\s*\]|\'[^\']*\')', self.block, re.S)
        self.assertIsNotNone(m, f'DEMO_CORPUS has no {key}')
        return re.findall(r"'([^']*)'", m.group(1))

    def test_the_planted_pairs_outlier_and_long_document_match_the_generator(self):
        pairs = self._quoted('nearDuplicates')
        self.assertEqual([tuple(pairs[i : i + 2]) for i in range(0, len(pairs), 2)], list(gen.NEAR_DUPLICATES))
        self.assertEqual(self._quoted('outlier'), [gen.OCR_FILE])
        self.assertEqual(self._quoted('longManual'), [gen.LONG_MANUAL])

    def test_the_demo_prefix_is_the_seeders(self):
        seed = (ACC / 'demo' / 'seed_demo.py').read_text(encoding='utf-8')
        prefix = re.search(r"^DEMO_PREFIX = '([^']*)'", seed, re.M).group(1)
        self.assertIn(f"const DEMO_PREFIX = '{prefix}';", self.env)
