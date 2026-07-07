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

"""
Landing.ai Agentic Document Extraction (ADE) node package for RocketRide Engine.

This package does not directly export `IInstance` / `IGlobal` — each ADE
capability lives in its own sub-package and the engine loads it via the `path`
field in the matching services.json:

- `nodes.landing_ai.parse`    — `landing_ai_parse` (document -> markdown + tables)
- `nodes.landing_ai.extract`  — `landing_ai_extract` (parsed markdown + JSON Schema -> fields)

Shared code that the sub-packages import lives at this package level:
`landing_ai_base.py` and the shared `requirements.txt`. Future ADE capabilities
(Split, Section, Classify) drop in as new sub-packages + services.<name>.json.
"""

__all__: list[str] = []
