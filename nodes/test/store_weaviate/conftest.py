# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Fixtures shared by the Weaviate store tests."""

from __future__ import annotations

import pytest

from nodes.store_weaviate import weaviate as weaviate_store

# The shared mock, imported as part of this test package: the real weaviate
# package the driver imports is left in place
from ..mocks import weaviate as weaviate_mock
from ..mocks.weaviate import exceptions as weaviate_mock_exceptions
from ..mocks.weaviate.classes import config as weaviate_mock_config


@pytest.fixture(autouse=True)
def _driver_on_the_mock(monkeypatch):
    """
    Point the driver's query and config builders and its error classes at the mock's.

    The driver imports the real weaviate package, but these tests hand it a mock
    collection or client. Those evaluate the mock's Filter and Sort, take the
    mock's config dicts, and raise the mock's errors, so the driver has to build
    and catch those for the duration of a test. VectorDistances stays real: the
    driver's similarity tables are built from it when the class is defined.
    """
    monkeypatch.setattr(weaviate_store, 'Filter', weaviate_mock.Filter)
    monkeypatch.setattr(weaviate_store, 'Sort', weaviate_mock.Sort)
    monkeypatch.setattr(weaviate_store, 'wc', weaviate_mock_config)
    monkeypatch.setattr(weaviate_store, 'WeaviateBaseError', weaviate_mock_exceptions.WeaviateBaseError)
    monkeypatch.setattr(weaviate_store, 'UnexpectedStatusCodeError', weaviate_mock_exceptions.UnexpectedStatusCodeError)
