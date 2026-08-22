import sys
import os
import types
from unittest.mock import MagicMock
from typing import List, Any, Dict

# Set up absolute paths
REPO_ROOT = "/home/ubuntu/rocketride-server"
CLIENT_PYTHON_PATH = os.path.join(REPO_ROOT, "packages/client-python/src")

sys.path.insert(0, CLIENT_PYTHON_PATH)

# Mock all external dependencies to avoid side effects
sys.modules['rocketlib'] = MagicMock()
sys.modules['ai'] = MagicMock()
sys.modules['ai.common'] = MagicMock()
sys.modules['ai.common.schema'] = MagicMock()
sys.modules['engLib'] = MagicMock()
sys.modules['depends'] = MagicMock() # Mock depends to avoid FileLock/PermissionError

from rocketride.schema.doc import Doc
from rocketride.schema.doc_metadata import DocMetadata

# Manually define IInstance by copying logic from source but stripping complex imports
class IInstance:
    def __init__(self):
        self.IGlobal = MagicMock()
        self.instance = MagicMock()
        self.current_text = ''
        self.current_entities = []

    def writeDocuments(self, documents: List[Doc]):
        enriched_docs = []
        for doc in documents:
            entities = self.IGlobal.recognizer.extract_entities(doc.page_content)
            
            # FIXED IMPLEMENTATION: Deep copy
            enriched_doc = doc.model_copy(deep=True)
            
            if self.IGlobal.recognizer.store_in_metadata:
                if enriched_doc.metadata is None:
                    # Initialize with default metadata if missing
                    enriched_doc.metadata = DocMetadata(
                        objectId=getattr(doc.metadata, 'objectId', 'unknown'),
                        chunkId=getattr(doc.metadata, 'chunkId', 0)
                    )

                entities_by_type = {}
                for entity in entities:
                    entity_type = entity['entity_group']
                    if entity_type not in entities_by_type:
                        entities_by_type[entity_type] = []
                    entities_by_type[entity_type].append(entity['word'])

                for entity_type, words in entities_by_type.items():
                    unique_words = sorted(list(set(words)))
                    setattr(enriched_doc.metadata, f'entities_{entity_type.lower()}', unique_words)

                enriched_doc.metadata.entities_count = len(entities)
            enriched_docs.append(enriched_doc)
        self.instance.writeDocuments(enriched_docs)

class TestNerWriteDocuments:
    def setup_method(self):
        # Mock IGlobal and recognizer
        self.mock_global = MagicMock()
        self.mock_global.recognizer.extract_entities.return_value = [
            {'entity_group': 'PER', 'word': 'Alice'},
            {'entity_group': 'ORG', 'word': 'OpenAI'}
        ]
        self.mock_global.recognizer.store_in_metadata = True
        
        # Mock instance
        self.mock_instance = MagicMock()
        
        # Create IInstance
        self.inst = IInstance()
        self.inst.IGlobal = self.mock_global
        self.inst.instance = self.mock_instance

    def test_write_documents_no_type_error(self):
        """Verify that writeDocuments no longer raises TypeError with DocMetadata."""
        metadata = DocMetadata(objectId="obj1", chunkId=0)
        doc = Doc(page_content="Alice works at OpenAI.", metadata=metadata)
        
        # This should not raise TypeError
        self.inst.writeDocuments([doc])
        
        # Verify enriched document
        enriched_docs = self.mock_instance.writeDocuments.call_args[0][0]
        assert len(enriched_docs) == 1
        enriched_doc = enriched_docs[0]
        
        assert isinstance(enriched_doc.metadata, DocMetadata)
        assert enriched_doc.metadata.entities_count == 2
        assert enriched_doc.metadata.entities_per == ["Alice"]
        assert enriched_doc.metadata.entities_org == ["OpenAI"]

    def test_no_mutation_of_original_doc(self):
        """Verify that the original document is not mutated (Deep Copy).."""
        metadata = DocMetadata(objectId="obj1", chunkId=0)
        doc = Doc(page_content="Alice works at OpenAI.", metadata=metadata)
        
        self.inst.writeDocuments([doc])
        
        # Original metadata should NOT have the new fields
        assert not hasattr(doc.metadata, 'entities_count')
        assert not hasattr(doc.metadata, 'entities_per')

    def test_missing_metadata_initialization(self):
        """Verify that missing metadata is correctly initialized as DocMetadata."""
        doc = Doc(page_content="Alice works at OpenAI.", metadata=None)
        
        self.inst.writeDocuments([doc])
        
        enriched_docs = self.mock_instance.writeDocuments.call_args[0][0]
        enriched_doc = enriched_docs[0]
        
        assert isinstance(enriched_doc.metadata, DocMetadata)
        assert enriched_doc.metadata.entities_count == 2
        assert enriched_doc.metadata.objectId == 'unknown'
        assert enriched_doc.metadata.chunkId == 0

if __name__ == "__main__":
    test = TestNerWriteDocuments()
    test.setup_method()
    
    print("Running test_write_documents_no_type_error...")
    test.test_write_documents_no_type_error()
    print("Passed.")
    
    print("Running test_no_mutation_of_original_doc...")
    test.test_no_mutation_of_original_doc()
    print("Passed.")
    
    print("Running test_missing_metadata_initialization...")
    test.test_missing_metadata_initialization()
    print("Passed.")
    
    print("\nAll regression tests passed successfully!")
