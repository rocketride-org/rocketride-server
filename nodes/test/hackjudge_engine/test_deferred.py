# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""A deferred gather must leave the node as a retry signal, never as a verdict.

`IInstance._verdict` uses no instance state, so the unbound method runs with
``self=None`` against the real vendored engine and a stubbed fetch module.
The property under test is the review finding on #2137: a failed file fetch
previously flowed on as ``tag: 'None', score: 0.0`` and was persisted and
settled downstream as if it were a real verdict.
"""

from __future__ import annotations

import json
import sys
import types
import unittest
from pathlib import Path

from ..hackjudge_common_stubs import import_node_module

inst = import_node_module('hackjudge_engine', 'IInstance')

_NODE_DIR = Path(__file__).resolve().parents[2] / 'src' / 'nodes' / 'hackjudge_engine'
while str(_NODE_DIR) in sys.path:
    sys.path.remove(str(_NODE_DIR))
sys.path.insert(0, str(_NODE_DIR))
from _engine import engine as eng  # noqa: E402

_META = {'default_branch': 'main', 'created_at': '2026-01-05T00:00:00Z'}
_TREE = {
    'tree': [
        {'path': 'package.json', 'type': 'blob'},
        {'path': 'src/app.js', 'type': 'blob'},
    ]
}
_MANIFEST = json.dumps({'dependencies': {'rocketride': '^1.0.0'}})
_APP_JS = 'const c = new RocketRideClient();\nclient.use({});\nclient.chat({});\n'


def _fetch_stub(broken_paths=()):
    def gh(url):
        if url.endswith('/repos/acme/demo'):
            return 200, json.dumps(_META)
        if 'git/trees/' in url:
            return 200, json.dumps(_TREE)
        for path, body in (('package.json', _MANIFEST), ('src/app.js', _APP_JS)):
            if url.endswith('/main/' + path):
                if path in broken_paths:
                    return 500, ''
                return 200, body
        return 404, ''

    return types.SimpleNamespace(
        repo_missing=lambda url: False,
        parse_repo=lambda url: ('acme', 'demo'),
        _gh=gh,
    )


def _run_verdict(fetch):
    return inst.IInstance._verdict(
        None, eng, fetch, 'https://github.com/acme/demo', None, 'RocketRide', None, 0, 'demo'
    )


class Deferred(unittest.TestCase):
    def test_failed_fetch_returns_retry_signal_not_verdict(self):
        res = _run_verdict(_fetch_stub(broken_paths=('src/app.js',)))
        self.assertTrue(res.get('deferred'))
        self.assertIn('retry', res.get('error', ''))
        # no verdict keys at all: downstream cannot persist or settle this by accident
        for key in ('tag', 'score', 'backbone', 'breakdown'):
            self.assertNotIn(key, res, key)
        self.assertEqual(res.get('kb_processed'), 0.0, 'thrown-away work must not be billed')

    def test_healthy_fetch_still_returns_full_verdict(self):
        res = _run_verdict(_fetch_stub())
        self.assertNotIn('deferred', res)
        self.assertIn(res['tag'], ('Significant', 'Moderate', 'Less', 'None'))
        self.assertGreater(res['kb_processed'], 0.0)


if __name__ == '__main__':
    unittest.main()
