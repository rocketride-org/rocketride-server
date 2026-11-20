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

"""Defaults of the vector store write switch and tool limits: the single source.

The store nodes read the write switch when ``vector.allow_writes``
(``rrvector.allow_writes`` on rocketride_vector) is not set in the node
configuration. Agents have no switch here: the node's ``allow_write`` (the
outer gate) alone decides whether they write. The templates test and the live
tool-path expectation table read the same values (the app reads them from
``apps/vector-ui/tests/fixtures/defaults.json``, generated from this file by
``apps/vector-ui/scripts/gen_defaults.py``), so changing a default is one line
here plus a regeneration.

This module must stay free of imports: the generator loads it by path.
"""

#: Whether DAP tool calls (``client.tool()`` from a Tools source) may remove or upsert documents.
#: Off by default; turn it on per store node with ``allow_writes``.
VECTOR_ALLOW_WRITES_DEFAULT = False

#: The most object_ids an agent may send ``soft_delete``, ``restore`` or ``delete`` with
#: ``deleted_only`` in one call (each id may cost the store a count). Callers other than
#: agents send at most ``write_ids_max``; an agent's plain ``delete`` keeps develop's open
#: list. Not a ``dialect`` limit: the explorer writes as a DAP caller (contract section 4.5).
AGENT_WRITE_IDS_MAX = 1000

#: Node-enforced limits, reported verbatim in ``dialect.limits`` (contract section 4.1).
#: Page sizes and counts are maxima; the ``*_default`` keys are the defaults.
#: ``statement_timeout_ms`` applies to pgvector; other drivers report None.
#: The last three belong to the additive extensions (contract section 4.4):
#: ``recommend_examples_max`` keys per side of a ``recommend`` call, ``matrix_keys_max``
#: keys of a ``similarity_matrix`` call, and ``max_components`` clusters a ``sample``
#: answer keeps (the rest are folded into noise).
VECTOR_TOOL_LIMITS = {
    'documents_page': 500,
    'chunks_page': 200,
    'vectors_keys_max': 2,
    'sample_default': 1000,
    'sample_max': 2000,
    'sample_max_light': 5000,
    'snippet_chars': 120,
    'knn_k_max': 30,
    'neighbors_k_max': 50,
    'project_keys_max': 200,
    'scope_keys_max': 2000,
    'top_k_max': 100,
    'write_ids_max': 100,
    'sample_budget_ms': 60000,
    'statement_timeout_ms': 30000,
    'counts_cached_s': 60,
    'recommend_examples_max': 10,
    'matrix_keys_max': 100,
    'max_components': 200,
}

#: Defaults applied when a tool call leaves the value out (contract section 4.1).
VECTOR_TOOL_DEFAULTS = {
    'documents_page': 200,
    'chunks_page': 100,
    'neighbors_k': 12,
    'knn_k': 15,
    'knn_k_max_light': 10,
    'duplicate_threshold': 0.97,
    'sample_cache_entries': 2,
    'sample_cache_ttl_s': 600,
    'sample_light_max_bytes': 64 * 1024 * 1024,
}

#: Limits of the ``embed`` tool on the embedding nodes (contract section 4.3).
EMBED_TOOL_LIMITS = {
    'embed_texts_max': 8,
    'embed_text_chars_max': 8000,
    'embed_per_minute': 30,
    'embed_burst': 5,
}
