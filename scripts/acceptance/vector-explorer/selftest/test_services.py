# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""Self-tests for the local stand-ins: the fake DB broker and the stub LLM.

Both run in this process on a free port; no engine or database is needed.

Run: python3 -m unittest discover -s scripts/acceptance/vector-explorer/selftest -v
"""

import importlib.util
import json
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

from http.server import HTTPServer
from pathlib import Path

ACC = Path(__file__).resolve().parent.parent


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


broker = _load('vx_fake_broker', ACC / 'fake_broker.py')
stub = _load('vx_stub_llm', ACC / 'stub_llm.py')


def _post(url: str, body: dict, headers: dict = None):
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        method='POST',
        headers={'Content-Type': 'application/json', **(headers or {})},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


class _Serving:
    def __init__(self, server):
        self.server = server
        self.thread = threading.Thread(target=server.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class BrokerTests(unittest.TestCase):
    def test_default_dsns_name_the_containers_without_tls(self):
        # The local containers serve no TLS.
        for dsn in (broker.DIRECT_DSN, broker.POOLER_DSN):
            self.assertIn('sslmode=disable', dsn)
            self.assertIn('@127.0.0.1:', dsn)
        self.assertIn(':55432/', broker.DIRECT_DSN)
        self.assertIn(':56434/', broker.POOLER_DSN)

    def test_answers_only_the_expected_token(self):
        serving = _Serving(
            HTTPServer(('127.0.0.1', 0), broker.make_handler('tok', 'postgresql://u:p@127.0.0.1:1/db?sslmode=disable'))
        )
        try:
            url = f'http://127.0.0.1:{serving.server.server_port}/provision'
            status, body = _post(url, {'tenant_id': 't1'}, {'Authorization': 'Bearer tok'})
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(body)['dsn'], 'postgresql://u:p@127.0.0.1:1/db?sslmode=disable')
            status, _ = _post(url, {'tenant_id': 't1'}, {'Authorization': 'Bearer nope'})
            self.assertEqual(status, 401)
            status, _ = _post(url, {'tenant_id': 't1'})
            self.assertEqual(status, 401)
        finally:
            serving.close()


class StubLlmTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.serving = _Serving(stub.StubServer(0, Path(self.tmp.name) / 'log.jsonl', '', '{}'))
        self.url = f'http://127.0.0.1:{self.serving.server.server_port}/v1/chat/completions'

    def tearDown(self):
        self.serving.close()
        self.tmp.cleanup()

    def test_plain_answer_is_tagged_and_quotes_the_prompt(self):
        status, body = _post(self.url, {'messages': [{'role': 'user', 'content': 'Glassbrook spring context'}]})
        self.assertEqual(status, 200)
        content = json.loads(body)['choices'][0]['message']['content']
        self.assertTrue(content.startswith(stub.PREFIX))
        self.assertIn('Glassbrook spring context', content)

    def test_streamed_answer_reassembles_to_the_same_text(self):
        status, body = _post(self.url, {'stream': True, 'messages': [{'role': 'user', 'content': 'question'}]})
        self.assertEqual(status, 200)
        parts = []
        for line in body.decode().splitlines():
            if line.startswith('data: ') and line != 'data: [DONE]':
                delta = json.loads(line[6:])['choices'][0]['delta']
                parts.append(delta.get('content') or '')
        self.assertEqual(''.join(parts), stub.answer_for([{'role': 'user', 'content': 'question'}]))


if __name__ == '__main__':
    unittest.main()
