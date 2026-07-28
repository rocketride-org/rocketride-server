# =============================================================================
# RocketRide Engine
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

"""Base classes for graph database nodes.

``graph_falkordb`` was the reference the abstraction was extracted from, and
``graph_neo4j`` derives from it too. Those are the graph-query nodes the repo
has: ``db_arango`` is multi-model and ``db_hydradb`` retrieves natively, so
neither follows the natural-language-to-query loop this base implements.
"""

from .cypher_safety import is_cypher_safe
from .graph_global_base import DEFAULT_MAX_EXECUTE_ROWS, GraphGlobalBase
from .graph_instance_base import DEFAULT_ROW_LIMIT, GraphInstanceBase

__all__ = [
    'DEFAULT_MAX_EXECUTE_ROWS',
    'DEFAULT_ROW_LIMIT',
    'GraphGlobalBase',
    'GraphInstanceBase',
    'is_cypher_safe',
]
