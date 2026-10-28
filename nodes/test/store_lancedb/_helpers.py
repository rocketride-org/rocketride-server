# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Shared helpers for the store_lancedb tests.

LanceDB is embedded, so these tests run the real driver against a real LanceDB
table in a temporary directory: no mocks and no Docker. The Doc models and
DocumentStoreBase are real too. Run them with the built engine, which installs
the node's requirements when the driver is imported.
"""

from __future__ import annotations

import math
import random
from typing import List, Optional

import pytest

pytest.importorskip('rocketlib', reason='Run these tests with the built engine')

from ai.common.schema import Doc, DocMetadata, QuestionText  # noqa: E402

DIM = 16
MODEL = 'test-model'


def unit(values: List[float]) -> List[float]:
    """Scale a vector to length 1."""
    norm = math.sqrt(sum(value * value for value in values)) or 1.0
    return [value / norm for value in values]


def random_vector(rng: random.Random) -> List[float]:
    """A random unit vector of the test dimension."""
    return unit([rng.uniform(-1.0, 1.0) for _ in range(DIM)])


def nearby(vector: List[float], rng: random.Random, spread: float = 0.05) -> List[float]:
    """A unit vector close to the given one."""
    return unit([value + rng.uniform(-spread, spread) for value in vector])


def chunk(
    objectId: str,
    chunkId: int,
    text: str,
    vector: List[float],
    *,
    parent: str = '/docs/a.txt',
    nodeId: str = 'node-1',
    permissionId: int = 1,
    isTable: bool = False,
    tableId: Optional[int] = None,
    isDeleted: bool = False,
    model: str = MODEL,
) -> Doc:
    """Build an embedded document chunk."""
    fields = {
        'objectId': objectId,
        'chunkId': chunkId,
        'parent': parent,
        'nodeId': nodeId,
        'permissionId': permissionId,
        'isTable': isTable,
        'isDeleted': isDeleted,
    }
    # DocMetadata accepts a missing tableId but not an explicit None
    if tableId is not None:
        fields['tableId'] = tableId
    metadata = DocMetadata(**fields)
    doc = Doc(page_content=text, metadata=metadata)
    doc.embedding = list(vector)
    doc.embedding_model = model
    return doc


def question(text: str, vector: Optional[List[float]] = None, model: str = MODEL) -> QuestionText:
    """Build a question with an optional embedding."""
    query = QuestionText(text=text)
    if vector is not None:
        query.embedding = list(vector)
        query.embedding_model = model
    return query
