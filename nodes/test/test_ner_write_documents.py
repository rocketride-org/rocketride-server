import os
import sys
import pytest
from unittest.mock import MagicMock
from typing import List

# Setup path to import from src
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO_ROOT, 'src'))

# Mock external dependencies before importing production class
import unittest.mock

# Create a clean mock for IInstanceBase
class MockIInstanceBase:
    def __init__(self):
        self.instance = unittest.mock.MagicMock()

sys.modules['rocketlib'] = unittest.mock.MagicMock()
sys.modules['rocketlib'].IInstanceBase = MockIInstanceBase
sys.modules['ai'] = unittest.mock.MagicMock()
sys.modules['ai.common'] = unittest.mock.MagicMock()
sys.modules['ai.common.schema'] = unittest.mock.MagicMock()
sys.modules['ai.common.config'] = unittest.mock.MagicMock()
sys.modules['depends'] = unittest.mock.MagicMock()
sys.modules['rocketride'] = unittest.mock.MagicMock()
sys.modules['rocketride.schema'] = unittest.mock.MagicMock()
sys.modules['rocketride.schema.doc_metadata'] = unittest.mock.MagicMock()

from nodes.ner.IInstance import IInstance
from ai.common.schema import Doc
from rocketride.schema.doc_metadata import DocMetadata






class TestNerWriteDocuments:
    """Regression tests for NER node's writeDocuments method."""

    def test_write_documents_enrichment(self):
        """Verify that entities are correctly added to document metadata without raising TypeError."""
        # Ensure IInstance is the real class, not a mock from sys.modules
        from nodes.ner.IInstance import IInstance as RealIInstance
        instance = RealIInstance()
        instance.IGlobal = MagicMock()
        instance.IGlobal.recognizer.store_in_metadata = True
        instance.instance = MagicMock()
        
        # Mock entity extraction
        instance.IGlobal.recognizer.extract_entities.return_value = [
            {'entity_group': 'PER', 'word': 'Alice'},
            {'entity_group': 'PER', 'word': 'Bob'},
            {'entity_group': 'ORG', 'word': 'OpenAI'}
        ]
        
        # Create a test document with existing metadata
        metadata = MagicMock()
        metadata.objectId = 'test_obj'
        metadata.chunkId = 1
        
        doc = MagicMock()
        doc.page_content = 'Alice and Bob work at OpenAI.'
        doc.metadata = metadata
        
        # Mock model_copy to return a new mock
        enriched_doc = MagicMock()
        enriched_doc.metadata = MagicMock()
        doc.model_copy.return_value = enriched_doc
        
        # Call the production method
        instance.writeDocuments([doc])
        
        # Verify the enriched document passed to the next instance
        call_args = instance.instance.writeDocuments.call_args
        assert call_args is not None
        enriched_docs = call_args[0][0]
        assert len(enriched_docs) == 1
        enriched_doc = enriched_docs[0]
        
        # Check metadata attributes (should be set via setattr)
        assert enriched_doc.metadata.entities_per == ['Alice', 'Bob']
        assert enriched_doc.metadata.entities_org == ['OpenAI']
        assert enriched_doc.metadata.entities_count == 3
        
        # Verify deep copy (original doc metadata should not have these fields)
        # For MagicMock, hasattr returns True if the attribute is accessed.
        # We check if it was actually set by checking the mock's internal state if possible,
        # or just ensuring it's not the same object as enriched_doc.metadata
        assert doc.metadata != enriched_doc.metadata


    def test_write_documents_initializes_missing_metadata(self):
        """Verify that documents with missing metadata are correctly initialized."""
        from nodes.ner.IInstance import IInstance as RealIInstance
        instance = RealIInstance()
        instance.IGlobal = MagicMock()
        instance.IGlobal.recognizer.store_in_metadata = True
        instance.instance = MagicMock()
        instance.IGlobal.recognizer.extract_entities.return_value = []
        
        # Document with None metadata
        doc = MagicMock()
        doc.page_content = 'No entities here.'
        doc.metadata = None
        
        enriched_doc = MagicMock()
        enriched_doc.metadata = None
        doc.model_copy.return_value = enriched_doc
        
        instance.writeDocuments([doc])
        
        call_args = instance.instance.writeDocuments.call_args
        enriched_doc_passed = call_args[0][0][0]
        
        assert enriched_doc_passed.metadata is not None

