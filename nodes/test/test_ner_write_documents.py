import os
import sys
from unittest.mock import MagicMock

import pytest

# Derive paths relative to this file to avoid hardcoded paths
TEST_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(os.path.dirname(TEST_DIR))
SRC_PATH = os.path.join(REPO_ROOT, "nodes", "src")
AI_PATH = os.path.join(REPO_ROOT, "packages", "ai", "src")
CLIENT_PATH = os.path.join(REPO_ROOT, "packages", "client-python", "src")
ENGINE_PATH = os.path.join(REPO_ROOT, "packages", "server", "engine-lib", "rocketlib-python", "lib")

# Add necessary paths to sys.path
for path in [SRC_PATH, AI_PATH, CLIENT_PATH, ENGINE_PATH]:
    if path not in sys.path:
        sys.path.insert(0, path)

# Save original sys.modules to prevent leaks
_ORIGINAL_MODULES = sys.modules.copy()

@pytest.fixture(autouse=True)
def restore_sys_modules():
    """Fixture to restore sys.modules after each test."""
    yield
    # We don't want to clear EVERYTHING because it might break pytest's own imports,
    # but we should remove the mocks we added.
    for mod in ["rocketlib", "engLib", "depends"]:
        if mod in sys.modules:
            del sys.modules[mod]

def setup_mocks():
    """Mock external dependencies before importing production classes."""
    sys.modules["rocketlib"] = MagicMock()
    sys.modules["engLib"] = MagicMock()
    sys.modules["depends"] = MagicMock()
    # Mock IInstanceBase so IInstance can inherit from it
    class MockIInstanceBase:
        def __init__(self):
            self.instance = MagicMock()
    sys.modules["rocketlib"].IInstanceBase = MockIInstanceBase

setup_mocks()

from nodes.ner.IInstance import IInstance
from ai.common.schema import Doc, DocMetadata

class TestNerWriteDocuments:
    """Regression tests for NER node's writeDocuments method."""

    def test_write_documents_enrichment(self):
        """
        Verify that entities are correctly added to document metadata.
        
        This test ensures that the NER extraction results are correctly mapped to
        document metadata attributes and that a deep copy is performed to preserve
        the original document state.
        """
        instance = IInstance()
        instance.IGlobal = MagicMock()
        instance.IGlobal.recognizer.store_in_metadata = True
        
        # Mock entity extraction
        instance.IGlobal.recognizer.extract_entities.return_value = [
            {"entity_group": "PER", "word": "Alice"},
            {"entity_group": "PER", "word": "Bob"},
            {"entity_group": "ORG", "word": "OpenAI"},
        ]

        # Create a real Doc with real DocMetadata
        metadata = DocMetadata(objectId="test_obj", chunkId=1)
        doc = Doc(page_content="Alice and Bob work at OpenAI.", metadata=metadata)

        # Call the production method
        instance.writeDocuments([doc])

        # Verify the enriched document passed to the next instance
        call_args = instance.instance.writeDocuments.call_args
        assert call_args is not None
        enriched_docs = call_args[0][0]
        assert len(enriched_docs) == 1
        enriched_doc = enriched_docs[0]

        # Check metadata attributes
        assert getattr(enriched_doc.metadata, "entities_per") == ["Alice", "Bob"]
        assert getattr(enriched_doc.metadata, "entities_org") == ["OpenAI"]
        assert enriched_doc.metadata.entities_count == 3

        # Verify deep copy
        assert not hasattr(doc.metadata, "entities_per")
        assert enriched_doc.metadata is not doc.metadata

    def test_write_documents_initializes_missing_metadata(self):
        """
        Verify that documents with missing metadata are correctly initialized.
        
        This test ensures that if a document has no metadata, a new DocMetadata
        object is created and initialized with default values before enrichment.
        """
        instance = IInstance()
        instance.IGlobal = MagicMock()
        instance.IGlobal.recognizer.store_in_metadata = True
        instance.IGlobal.recognizer.extract_entities.return_value = []

        # Document with None metadata
        doc = Doc(page_content="No entities here.", metadata=None)

        instance.writeDocuments([doc])

        call_args = instance.instance.writeDocuments.call_args
        assert call_args is not None
        enriched_doc_passed = call_args[0][0][0]
        assert enriched_doc_passed.metadata is not None
        assert isinstance(enriched_doc_passed.metadata, DocMetadata)
        assert enriched_doc_passed.metadata.objectId == "unknown"
        assert enriched_doc_passed.metadata.chunkId == 0


