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

"""Make the node importable as the top-level ``media_render`` package."""

import sys
from pathlib import Path

# Point at nodes/src/nodes, not nodes/src: importing through the `nodes` package
# would execute nodes/src/nodes/__init__.py, which pulls the engine-only `depends`.
_NODES_DIR = str(Path(__file__).resolve().parents[2] / 'src' / 'nodes')
if _NODES_DIR not in sys.path:
    sys.path.insert(0, _NODES_DIR)

# Import native PyAV before individual tests patch process/import helpers.
# A missing optional decoder must not prevent pure algorithm/FFmpeg tests.
try:
    from av import open as av_open
except ImportError:
    av_open = None
