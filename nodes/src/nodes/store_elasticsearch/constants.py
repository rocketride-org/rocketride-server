# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Shared constants for the index_search node (Elasticsearch and OpenSearch).

Single source of truth for field names, default values, and backend/mode identifiers
so that code stays consistent and easy to change.
"""

# -----------------------------------------------------------------------------
# Field names (Elasticsearch/OpenSearch index mapping and query DSL)
# -----------------------------------------------------------------------------
CONTENT_FIELD = 'content'
"""Document text field name in index mapping and search bodies."""

VECTOR_FIELD = 'vector'
"""Vector field name in OpenSearch k-NN indices (Elasticsearch uses 'embedding')."""

# -----------------------------------------------------------------------------
# Default values
# -----------------------------------------------------------------------------
DEFAULT_INDEX_NAME = 'rocketlib'
"""Default index/collection name when none is configured."""

DEFAULT_HIGHLIGHT_FRAGMENT_SIZE = 250
"""Default character size for search highlight snippets."""

DEFAULT_SCROLL = '1m'
"""Default scroll duration for scan/scroll text search."""

DEFAULT_TEXT_BATCH_SIZE = 500
"""Default batch size for scroll/scan text search."""

ELASTICSEARCH_DEFAULT_PORT = 9200
"""Default Elasticsearch port (self-managed)."""

# -----------------------------------------------------------------------------
# Backend and mode identifiers (used in config and IGlobal)
# -----------------------------------------------------------------------------
BACKEND_ELASTICSEARCH = 'elasticsearch'
BACKEND_OPENSEARCH = 'opensearch'

MODE_INDEX = 'index'
"""Text-only mode: BM25/index search, no vector store."""

MODE_VSTORE = 'vstore'
"""Vector store mode: embeddings and vector search."""

# -----------------------------------------------------------------------------
# Validation
# -----------------------------------------------------------------------------
VALID_MATCH_OPERATORS = ('and', 'or', 'exact')
"""Allowed values for text search match operator (and/or/exact phrase)."""
