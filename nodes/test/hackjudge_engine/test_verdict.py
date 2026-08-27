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

"""The vendored verdict engine, exercised fully offline against a fake GitHub.

The `_engine` subpackage is self-contained (no rocketlib / ai imports), so these
tests drive the REAL gather + evaluate code with a stubbed `gh(url) -> (status,
text)` callable. Two properties matter most:

- a deterministic verdict from controlled evidence, and
- the fetch-failure guard: a failed file download must defer the repository
  (`fetch_incomplete`), never score it on partial evidence.
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

# Import `_engine` with the node directory itself on sys.path: going through the
# `hackjudge_engine` package would execute its __init__, which pulls rocketlib.
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
        {'path': 'src/api.js', 'type': 'blob'},
        {'path': 'src/My Component.js', 'type': 'blob'},
    ]
}
_MANIFEST = json.dumps({'dependencies': {'rocketride': '^1.0.0'}})
_APP_JS = (
    "const { RocketRideClient } = require('rocketride');\n"
    'const client = new RocketRideClient();\n'
    "client.use({ pipeline: 'verify' });\n"
    'client.chat({ token: t, question: q });\n'
)
_API_JS = "import { RocketRideClient } from 'rocketride';\nconst c = new RocketRideClient();\n"


def _fake_gh(broken_paths=()):
    """A gh(url) -> (status, text) stub serving one tiny fake repository."""

    def gh(url):
        if url.endswith('/repos/acme/demo'):
            return 200, json.dumps(_META)
        if 'git/trees/' in url:
            return 200, json.dumps(_TREE)
        for path, body in (
            ('package.json', _MANIFEST),
            ('src/app.js', _APP_JS),
            ('src/api.js', _API_JS),
            ('src/My%20Component.js', 'const x = new RocketRideClient();\n'),
        ):
            if url.endswith('/main/' + path):
                if path in broken_paths:
                    return 500, ''
                return 200, body
        return 404, ''

    return gh


class VerdictOffline(unittest.TestCase):
    def test_deterministic_verdict_from_controlled_evidence(self):
        ev = eng.gather('https://github.com/acme/demo', _fake_gh())
        self.assertTrue(ev.get('accessible'))
        self.assertFalse(ev.get('fetch_incomplete', False))
        self.assertTrue(ev.get('dependency'), 'manifest dependency must be found')
        self.assertGreaterEqual(ev['sdk']['callsites'], 3)
        self.assertGreaterEqual(ev['sdk']['file_spread'], 2)

        res = eng.evaluate(ev)
        self.assertIn(res['tag'], ('Significant', 'Moderate', 'Less', 'None'))
        self.assertGreaterEqual(res['score'], 1.0)

        again = eng.evaluate(eng.gather('https://github.com/acme/demo', _fake_gh()))
        self.assertEqual((res['tag'], res['score']), (again['tag'], again['score']))

    def test_failed_file_fetch_defers_instead_of_scoring(self):
        ev = eng.gather('https://github.com/acme/demo', _fake_gh(broken_paths=('src/app.js',)))
        self.assertTrue(ev.get('accessible'))
        self.assertTrue(
            ev.get('fetch_incomplete'),
            'a failed file fetch must defer the repo, not shrink its evidence',
        )
        self.assertNotIn('sdk', ev, 'no partial evidence may escape a deferred gather')

    def test_paths_with_spaces_are_url_encoded_not_deferred(self):
        # 'src/My Component.js' is only served at its percent-encoded URL; an
        # unencoded fetch 404s on every attempt and would wrongly defer the repo
        # forever. file_spread proves the file was really fetched and scanned.
        ev = eng.gather('https://github.com/acme/demo', _fake_gh())
        self.assertFalse(ev.get('fetch_incomplete', False))
        self.assertGreaterEqual(ev['sdk']['file_spread'], 3)

    def test_unreachable_repo_is_inaccessible_not_deferred(self):
        ev = eng.gather('https://github.com/acme/demo', lambda url: (404, ''))
        self.assertFalse(ev.get('accessible'))


if __name__ == '__main__':
    unittest.main()
