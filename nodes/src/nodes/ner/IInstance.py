# =============================================================================
# MIT License
# Copyright (c) 2026 RocketRide, Inc.
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

from typing import List
from rocketlib import Entry, IInstanceBase
from ai.common.schema import Doc
from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    """
    Instance handler for NER node.
    
    Processes individual documents and text, extracting named entities
    and adding them to document metadata.
    """
    
    IGlobal: IGlobal  # Reference to global context with NER recognizer
    
    # Current object context
    current_text: str = ''
    current_entities: List[dict] = []
    
    def open(self, obj: Entry):
        """Initialize instance for a new object."""
        self.current_text = ''
        self.current_entities = []
    
    def writeText(self, text: str):
        """
        Process text and extract named entities.
        
        Args:
            text: Text to process
        """
        # Store the text
        self.current_text += text
        
        # Extract entities from the text
        entities = self.IGlobal.recognizer.extract_entities(text)
        self.current_entities.extend(entities)
        
        # Pass through the original text
        self.instance.writeText(text)
    
    def writeDocuments(self, documents: List[Doc]):
        """
        Process documents and extract named entities.
        
        Args:
            documents: List of documents to process
        """
        enriched_docs = []
        
        for doc in documents:
            # Extract entities from document content
            entities = self.IGlobal.recognizer.extract_entities(doc.page_content)
            
            # Create a copy to avoid modifying the original
            enriched_doc = doc.model_copy()
            
            # Store entities in metadata if configured
            if self.IGlobal.recognizer.store_in_metadata:
                if enriched_doc.metadata is None:
                    enriched_doc.metadata = {}
                
                # Group entities by type
                entities_by_type = {}
                for entity in entities:
                    entity_type = entity['entity_group']
                    if entity_type not in entities_by_type:
                        entities_by_type[entity_type] = []
                    entities_by_type[entity_type].append(entity['word'])
                
                # Add to metadata (deduplicate and sort)
                for entity_type, words in entities_by_type.items():
                    unique_words = sorted(list(set(words)))
                    enriched_doc.metadata[f'entities_{entity_type.lower()}'] = unique_words
                
                # Also store total count
                enriched_doc.metadata['entities_count'] = len(entities)
            
            enriched_docs.append(enriched_doc)
        
        # Write enriched documents
        self.instance.writeDocuments(enriched_docs)
    
    def closing(self):
        """Called before close, finalize any pending operations."""
        pass
    
    def close(self):
        """Clean up instance state."""
        self.current_text = ''
        self.current_entities = []

