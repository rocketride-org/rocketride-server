# =============================================================================
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

"""
Vendor resolution for cloud_* multi-vendor nodes.

This is the single home of ``resolve_vendor``. cloud_tts and cloud_stt (and any
future cloud_* node with more than one vendor) resolve the active vendor from
the node's ``logicalType`` the same way -- there is no duplicate copy of the
longest-id-first matching rule anywhere else in the codebase.
"""

from __future__ import annotations

from typing import Any, Mapping


def resolve_vendor(engines: Mapping[str, Any], logical_type: Any, *, kind: str) -> str:
    """Pick the vendor whose id appears in the node logicalType.

    Longest id first so a vendor id that is a substring of another still
    resolves to the most specific match.
    """
    lt = str(logical_type).lower()
    for engine in sorted(engines, key=len, reverse=True):
        if engine in lt:
            return engine
    raise Exception(f'Unknown {kind} engine for logicalType: {logical_type}')
