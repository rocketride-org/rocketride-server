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
DeepAgent framework node package for RocketRide Engine.

This package does not directly export `IInstance` / `IGlobal` — each of the
two DeepAgent logical types lives in its own sub-package and the engine loads
them via the `path` field in their respective services.json files:

- `nodes.agent_deepagent.deepagent_agent`    — `agent_deepagent` (standalone or hierarchical orchestrator)
- `nodes.agent_deepagent.deepagent_subagent` — `agent_deepagent_subagent` (managed sub-agent)

The shared DeepAgent framework code that both sub-packages import lives at
this package level: `deepagent.py` and the shared `requirements.txt`.
"""

__all__: list[str] = []
