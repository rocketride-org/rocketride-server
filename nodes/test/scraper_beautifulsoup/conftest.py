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

"""Install this node's dependencies before the tests import them.

Node tests run under the built engine's interpreter, where ``beautifulsoup4``
is only installed when the engine imports the node (``depends()`` at the
top of ``IGlobal.py``). Load it here, as ``nodes/test/media_inspect`` does, so a
missing dependency fails the run instead of skipping every test.
"""

from pathlib import Path

import pytest

# Capture the real loader before sibling test modules are collected (some
# stock tests replace sys.modules['depends'] with a no-op mock).
from depends import load_depends

_NODE_DIR = Path(__file__).resolve().parents[2] / 'src' / 'nodes' / 'scraper_beautifulsoup'

# Module-level so it runs before collection imports bs4 in the test modules.
load_depends(str(_NODE_DIR / 'IGlobal.py'))


@pytest.fixture(scope='session', autouse=True)
def scraper_dependencies():
    """Fail loudly if the node's dependencies are still missing."""
    import bs4  # noqa: F401
    import requests  # noqa: F401
