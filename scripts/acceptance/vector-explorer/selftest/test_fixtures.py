# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""Self-tests for the fixture pipelines (vx_fixtures.py, start_fixtures.py, env.cjs).

No engine is needed: the builders are pure, and env.cjs is read with Node.

Run: python3 -m unittest discover -s scripts/acceptance/vector-explorer/selftest -v
"""

import json
import shutil
import subprocess
import sys
import unittest

from pathlib import Path

ACC = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ACC))

import start_fixtures  # noqa: E402
import vx_fixtures as fx  # noqa: E402


def _by_id(pipe):
    return {c['id']: c for c in pipe['components']}


def _sources(pipe):
    return sorted(c['id'] for c in pipe['components'] if (c.get('config') or {}).get('mode') == 'Source')


class FixtureTableTests(unittest.TestCase):
    def test_project_ids_and_names_are_unique_and_fixed(self):
        ids = [f.project_id for f in fx.FIXTURES.values()]
        names = [f.name for f in fx.FIXTURES.values()]
        self.assertEqual(len(set(ids)), len(ids))
        self.assertEqual(len(set(names)), len(names))
        self.assertTrue(all(i.startswith('00000000-0000-4000-8000-00000000d1a') for i in ids))

    def test_defaults_are_the_four_templates_and_the_stock_rag_shape(self):
        self.assertEqual(set(fx.DEFAULT_FIXTURES), {'postgres', 'rocketride_vector', 'qdrant', 'chroma', 'stock_rag'})
        self.assertIn('qdrant_pager', fx.FIXTURES)


class TemplateFixtureTests(unittest.TestCase):
    def test_each_template_fixture_points_both_stores_at_its_server(self):
        for key in ('postgres', 'rocketride_vector', 'qdrant', 'chroma', 'qdrant_pager'):
            fixture = fx.FIXTURES[key]
            pipe = fx.build_pipeline(key)
            comps = _by_id(pipe)
            self.assertEqual(pipe['project_id'], fixture.project_id, key)
            self.assertEqual(pipe['name'], fixture.name, key)
            self.assertEqual(_sources(pipe), ['chat_1', 'ingest_1', 'tools_1'], key)
            for sid in ('store_1', 'store_2'):
                cfg = comps[sid]['config']
                for name, value in fixture.connection.items():
                    self.assertEqual(cfg[cfg['profile']][name], value, (key, sid, name))
            # The templates' write switches are kept: on for store_1, off for store_2.
            s1, s2 = comps['store_1']['config'], comps['store_2']['config']
            self.assertIs(s1[s1['profile']]['allow_writes'], True, key)
            self.assertIs(s2[s2['profile']]['allow_writes'], False, key)

    def test_the_pager_fixture_has_its_own_collection(self):
        pipe = fx.build_pipeline('qdrant_pager')
        cfg = _by_id(pipe)['store_1']['config']
        self.assertEqual(cfg[cfg['profile']]['collection'], fx.PAGER_COLLECTION)
        self.assertNotEqual(fx.PAGER_COLLECTION, fx.COLLECTION)

    def test_stub_llm_replaces_the_placeholder_key(self):
        stubbed = _by_id(fx.build_pipeline('postgres', 'stub'))['llm_1']
        self.assertEqual(stubbed['name'], fx.STUB_LLM_NODE_NAME)
        self.assertEqual(stubbed['config']['custom']['base_url'], fx.STUB_LLM_URL)
        self.assertNotEqual(stubbed['config']['custom']['apikey'], 'replace-with-your-key')
        kept = _by_id(fx.build_pipeline('postgres', 'template'))['llm_1']
        self.assertEqual(kept['config']['custom']['apikey'], 'replace-with-your-key')
        self.assertEqual(kept['config']['custom']['base_url'], '')

    def test_overrides_for_the_legacy_seed(self):
        pipe = fx.build_pipeline('qdrant', collection='vx_legacy_docs', project_id='p', name='n')
        cfg = _by_id(pipe)['store_2']['config']
        self.assertEqual(cfg[cfg['profile']]['collection'], 'vx_legacy_docs')
        self.assertEqual((pipe['project_id'], pipe['name']), ('p', 'n'))
        # The fixture table itself is not changed by an override.
        self.assertEqual(fx.FIXTURES['qdrant'].connection['collection'], fx.COLLECTION)


class StockRagTests(unittest.TestCase):
    def setUp(self):
        self.pipe = fx.build_pipeline('stock_rag')
        self.comps = _by_id(self.pipe)

    def test_webhook_and_chat_and_no_tools_source(self):
        self.assertEqual(_sources(self.pipe), ['chat_1', 'webhook_1'])
        self.assertFalse(any(c.get('provider') == 'tools' for c in self.pipe['components']))
        self.assertFalse(any(c.get('control') for c in self.pipe['components']))

    def test_two_store_nodes_like_the_rag_example(self):
        self.assertEqual([c['id'] for c in fx.store_nodes(self.pipe)], ['store_1', 'store_2'])
        self.assertEqual(self.comps['store_1']['input'], [{'lane': 'documents', 'from': 'embed_1'}])
        self.assertEqual(self.comps['store_2']['input'], [{'lane': 'questions', 'from': 'embed_2'}])
        for sid in ('store_1', 'store_2'):
            local = self.comps[sid]['config']['local']
            self.assertEqual(local['collection'], fx.STOCK_RAG_TABLE)
            # Writes on: a write through the chat source then shows the source check, not the switch.
            self.assertIs(local['allow_writes'], True)

    def test_uses_the_calibrated_chunker(self):
        self.assertEqual(self.comps['chunk_1']['config'], fx.calibrated_chunker())


class StartFixturesTests(unittest.TestCase):
    def test_selection_defaults_and_unknown_keys(self):
        self.assertEqual(start_fixtures.select(''), list(fx.DEFAULT_FIXTURES))
        self.assertEqual(start_fixtures.select('qdrant_pager, postgres'), ['qdrant_pager', 'postgres'])
        with self.assertRaises(ValueError):
            start_fixtures.select('postgres,nope')


@unittest.skipUnless(shutil.which('node'), 'node is not installed')
class EnvCjsTests(unittest.TestCase):
    def test_env_cjs_lists_the_same_fixtures(self):
        out = subprocess.run(
            [
                'node',
                '-e',
                'process.stdout.write(JSON.stringify(require(process.argv[1]).FIXTURES))',
                str(ACC / 'env.cjs'),
            ],
            capture_output=True,
            text=True,
            check=True,
        ).stdout
        cjs = json.loads(out)
        self.assertEqual(
            {k: (v['name'], v['projectId']) for k, v in cjs.items()},
            {k: (f.name, f.project_id) for k, f in fx.FIXTURES.items()},
        )


if __name__ == '__main__':
    unittest.main()
