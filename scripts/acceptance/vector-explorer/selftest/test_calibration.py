# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""Self-tests for the chunking calibration (G0-6) and the templates it writes.

No engine is needed: the measurement helpers are pure, and the writer is run
against copies of the templates in a temporary directory.

Run: python3 -m unittest discover -s scripts/acceptance/vector-explorer/selftest -v
"""

import importlib.util
import json
import shutil
import sys
import tempfile
import unittest

from pathlib import Path

ACC = Path(__file__).resolve().parent.parent
REPO = ACC.parent.parent.parent
TEMPLATES = REPO / 'apps' / 'vector-ui' / 'templates'
CHUNKING = REPO / 'apps' / 'vector-ui' / 'tests' / 'fixtures' / 'chunking.json'


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


cal = _load('vx_calibrate_chunking', ACC / 'calibrate_chunking.py')


class SummaryTests(unittest.TestCase):
    def test_summary_counts_and_median(self):
        lengths = {'a.md': [100, 900, 800], 'b.md': [700], 'manuals/long_manual.md': [600] * 70}
        s = cal.summarise(lengths, 'manuals/long_manual.md')
        self.assertEqual(s['documents'], 3)
        self.assertEqual(s['chunks'], 74)
        self.assertEqual(s['median_chars'], 600)
        self.assertEqual(s['single_chunk_documents'], 1)
        self.assertEqual(s['long_document_chunks'], 70)
        self.assertEqual(s['max_chars'], 900)

    def test_target_is_a_median_of_400_to_1200_characters(self):
        self.assertTrue(cal.in_target({'median_chars': 400}))
        self.assertTrue(cal.in_target({'median_chars': 1200}))
        self.assertFalse(cal.in_target({'median_chars': 399}))
        self.assertFalse(cal.in_target({'median_chars': 3409}))
        self.assertFalse(cal.in_target({}))

    def test_identical_results_for_different_lengths_mean_the_setting_is_ignored(self):
        same = {'documents': 40, 'chunks': 81, 'median_chars': 3409}
        self.assertTrue(cal.setting_ignored({'512': dict(same), '1000': dict(same)}))
        self.assertFalse(cal.setting_ignored({'512': dict(same), '1000': {**same, 'chunks': 306}}))
        # One candidate proves nothing either way.
        self.assertFalse(cal.setting_ignored({'1000': dict(same)}))


# The keyword filter preprocessor_langchain had when the calibration was made, and one that walks the MRO.
FILTER_OWN_INIT = """
class Node:
    def _filter_kwargs_for(self, cls, kwargs: Dict[str, Any]) -> Dict[str, Any]:
        params = set(inspect.signature(cls.__init__).parameters.keys())
        params.discard('self')
        return {k: v for k, v in kwargs.items() if k in params}
"""
FILTER_MRO = """
class Node:
    def _filter_kwargs_for(self, cls, kwargs: Dict[str, Any]) -> Dict[str, Any]:
        params = set()
        for klass in cls.__mro__:
            if '__init__' in vars(klass):
                params |= set(inspect.signature(klass.__init__).parameters)
        params -= {'self', 'args', 'kwargs'}
        return {k: v for k, v in kwargs.items() if k in params}
"""


class NodeProbeTests(unittest.TestCase):
    """node_passes_chunk_size runs the node's own keyword filter against LangChain's splitter."""

    def setUp(self):
        if cal.node_splitter_kwargs({}) is None:
            self.skipTest('NOT RUN: langchain_text_splitters is not importable here (run with the engine python)')

    def test_a_filter_on_the_splitters_own_init_drops_the_length(self):
        kept = cal.node_splitter_kwargs({'chunk_size': 1000, 'chunk_overlap': 200, 'separators': None}, FILTER_OWN_INIT)
        self.assertEqual(kept, {'separators': None})

    def test_a_filter_over_the_mro_keeps_it(self):
        kept = cal.node_splitter_kwargs({'chunk_size': 1000, 'chunk_overlap': 200, 'separators': None}, FILTER_MRO)
        self.assertEqual(kept, {'chunk_size': 1000, 'chunk_overlap': 200, 'separators': None})

    def test_a_node_without_the_filter_is_reported(self):
        with self.assertRaises(RuntimeError):
            cal.node_splitter_kwargs({'chunk_size': 1000}, 'class Node:\n    pass\n')


class WriterTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.templates = self.tmp / 'templates'
        shutil.copytree(TEMPLATES, self.templates)
        self.chunking = self.tmp / 'chunking.json'
        shutil.copy(CHUNKING, self.chunking)
        self._saved = (cal.TEMPLATES, cal.CHUNKING)
        cal.TEMPLATES, cal.CHUNKING = self.templates, self.chunking

    def tearDown(self):
        cal.TEMPLATES, cal.CHUNKING = self._saved
        shutil.rmtree(self.tmp)

    def test_write_records_the_choice_and_sets_every_template(self):
        summary = {'documents': 40, 'chunks': 306, 'median_chars': 806, 'in_target': True}
        cal.write_choice(1000, summary, {'1000': summary}, '40 documents')
        record = json.loads(self.chunking.read_text(encoding='utf-8'))
        self.assertIs(record['calibrated'], True)
        self.assertEqual(record['measured'], summary)
        self.assertEqual(record['chunk_1']['config']['default']['strlen'], 1000)
        pipes = sorted(self.templates.glob('*.pipe'))
        self.assertEqual(len(pipes), 9)
        for path in pipes:
            pipe = json.loads(path.read_text(encoding='utf-8'))
            (chunker,) = [c for c in pipe['components'] if c['id'] == 'chunk_1']
            self.assertEqual(chunker['config'], record['chunk_1']['config'], path.name)
            self.assertEqual(chunker['provider'], record['chunk_1']['provider'], path.name)
            # The template formatting is kept (2-space JSON, trailing newline).
            self.assertEqual(path.read_text(encoding='utf-8'), json.dumps(pipe, indent=2) + '\n')

    def _write_with_node(self, passes: bool) -> dict:
        saved = cal.node_passes_chunk_size
        cal.node_passes_chunk_size = lambda: passes
        try:
            cal.write_choice(1000, {'median_chars': 806}, {}, '40 documents')
        finally:
            cal.node_passes_chunk_size = saved
        return json.loads(self.chunking.read_text(encoding='utf-8'))

    def test_write_records_that_the_setting_has_no_effect_while_the_node_drops_it(self):
        record = self._write_with_node(False)
        self.assertIs(record['effective'], False)
        self.assertEqual(record['known_issue'], cal.KNOWN_ISSUE)
        for path in sorted(self.templates.glob('*.pipe')):
            self.assertIn(cal.chunk_sentence(record), _annotation(path), path.name)
            self.assertIn('until it does', cal.chunk_sentence(record))

    def test_write_drops_the_known_issue_once_the_node_passes_the_length(self):
        record = self._write_with_node(True)
        self.assertIs(record['effective'], True)
        self.assertNotIn('known_issue', record)
        for path in sorted(self.templates.glob('*.pipe')):
            text = _annotation(path)
            self.assertIn(cal.chunk_sentence(record), text, path.name)
            # Exactly one chunk paragraph, whatever was there before.
            self.assertEqual(sum(1 for p in text.split('\n\n') if p.startswith('`chunk_1`')), 1, path.name)


def _annotation(path: Path) -> str:
    """The text of a template's "Read this first" note."""
    pipe = json.loads(path.read_text(encoding='utf-8'))
    (note,) = [c for c in pipe['components'] if c['id'] == 'annotation_1']
    return note['config']['content']


class CommittedTemplatesTests(unittest.TestCase):
    """The committed templates carry the committed calibration (what L7's templates test pins too)."""

    def test_calibrated_and_in_target(self):
        record = json.loads(CHUNKING.read_text(encoding='utf-8'))
        self.assertIs(record['calibrated'], True, 'chunking.json is not calibrated yet')
        self.assertTrue(cal.in_target(record['measured']))
        self.assertGreater(record['measured']['long_document_chunks'], 64)

    def test_every_template_carries_the_calibrated_chunker(self):
        record = json.loads(CHUNKING.read_text(encoding='utf-8'))
        for path in sorted(TEMPLATES.glob('*.pipe')):
            pipe = json.loads(path.read_text(encoding='utf-8'))
            (chunker,) = [c for c in pipe['components'] if c['id'] == 'chunk_1']
            self.assertEqual(chunker['provider'], record['chunk_1']['provider'], path.name)
            self.assertEqual(chunker['config'], record['chunk_1']['config'], path.name)

    def test_effective_says_whether_the_node_passes_the_length_to_its_splitter(self):
        """chunking.json must not claim an effect the chunker node does not have (and must say so once it does)."""
        passes = cal.node_passes_chunk_size()
        if passes is None:
            self.skipTest('NOT RUN: langchain_text_splitters is not importable here (run with the engine python)')
        record = json.loads(CHUNKING.read_text(encoding='utf-8'))
        self.assertIs(
            record.get('effective'),
            passes,
            'chunking.json "effective" disagrees with preprocessor_langchain: run calibrate_chunking.py --sync',
        )
        self.assertEqual('known_issue' in record, not passes)

    def test_every_template_says_what_the_chunker_does(self):
        record = json.loads(CHUNKING.read_text(encoding='utf-8'))
        for path in sorted(TEMPLATES.glob('*.pipe')):
            self.assertIn(cal.chunk_sentence(record), _annotation(path), path.name)


# The calibration takes effect because preprocessor_langchain hands chunk_size, chunk_overlap and
# length_function to its splitter (its keyword filter reads every __init__ along the splitter's MRO).
# `calibrate_chunking.py --sync` keeps chunking.json and the templates' notes in step with the node.
class CalibrationInEffectTests(unittest.TestCase):
    """The shipped templates cut the calibrated chunks: no caveat left in chunking.json or in any template."""

    def test_the_chunker_node_hands_the_length_to_its_splitter(self):
        passes = cal.node_passes_chunk_size()
        if passes is None:
            self.skipTest('NOT RUN: langchain_text_splitters is not importable here (run with the engine python)')
        self.assertIs(passes, True, 'preprocessor_langchain drops chunk_size: chunks stay at up to 4,000 characters')

    def test_chunking_json_says_the_setting_takes_effect(self):
        record = json.loads(CHUNKING.read_text(encoding='utf-8'))
        self.assertIs(record.get('effective'), True, 'run calibrate_chunking.py --sync once the node passes the length')
        self.assertNotIn('known_issue', record)

    def test_no_template_carries_the_caveat(self):
        for path in sorted(TEMPLATES.glob('*.pipe')):
            self.assertNotIn('does not pass `strlen`', _annotation(path), path.name)


if __name__ == '__main__':
    unittest.main()
