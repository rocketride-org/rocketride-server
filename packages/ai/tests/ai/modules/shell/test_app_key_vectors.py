# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE

"""``label_of`` against the shared app-key vector file (#1022 PR2a-1, test T50).

The shell's ``appKeyOf`` (``packages/shell/src/isolation/appKey.ts``) must equal
the server's ``label_of`` for every id. Both are pinned to
``packages/shell/src/isolation/__fixtures__/appkey_vectors.json``. Run with
``RR_UPDATE_VECTORS=1`` to (re)write the file from ``label_of``.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from ai.modules.shell.app_origin import label_of

REPO = Path(__file__).resolve().parents[6]
VECTORS = REPO / 'packages' / 'shell' / 'src' / 'isolation' / '__fixtures__' / 'appkey_vectors.json'

IDS = [
    'acme.alpha',
    'acme.x_foo',
    'acme_x.foo',
    'rocketride.home',
    'a' * 128,
    'my-app.sub-part',
    'my_app.sub_part',
    'a-b_c.d-e_f',
]


def test_label_of_matches_the_vector_file():
    if os.environ.get('RR_UPDATE_VECTORS') == '1':
        VECTORS.parent.mkdir(parents=True, exist_ok=True)
        VECTORS.write_text(json.dumps([{'id': i, 'label': label_of(i)} for i in IDS], indent=2) + '\n')
    assert VECTORS.exists(), f'vector file missing: {VECTORS}'
    rows = json.loads(VECTORS.read_text())
    assert [r['id'] for r in rows] == IDS, 'the vector file must list the fixed id set in order'
    for row in rows:
        assert label_of(row['id']) == row['label'], row['id']
