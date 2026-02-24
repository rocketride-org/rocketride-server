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

"""
NER Recognizer using HuggingFace transformers via model server.

This module provides named entity recognition capabilities using the
RocketRide model server's transformers pipeline support.
"""

from typing import Dict, Any, List
from ai.common.config import Config
from ai.common.models.transformers import pipeline


class NERRecognizer:
    """
    Named Entity Recognition using transformers pipeline.

    This class wraps a HuggingFace NER pipeline and provides entity
    extraction with confidence thresholding and result formatting.
    """

    def __init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]):
        """
        Initialize NER recognizer.

        Args:
            provider: Node provider name
            connConfig: Node configuration
            bag: Additional context bag
        """
        # Get configuration
        config = Config.getNodeConfig(provider, connConfig)

        # Extract settings
        self.model_name = config.get('model', 'dbmdz/bert-large-cased-finetuned-conll03-english')
        self.aggregation_strategy = config.get('aggregation_strategy', 'simple')
        self.min_confidence = config.get('min_confidence', 0.9)
        self.store_in_metadata = config.get('store_in_metadata', True)

        # Initialize the NER pipeline
        # The pipeline will automatically use the model server if available,
        # or fall back to local execution
        self.ner_pipeline = pipeline(task='ner', model=self.model_name, aggregation_strategy=self.aggregation_strategy)

        print(f'[NER] Initialized with model: {self.model_name}')
        print(f'[NER] Aggregation strategy: {self.aggregation_strategy}')
        print(f'[NER] Minimum confidence: {self.min_confidence}')

    def extract_entities(self, text: str) -> List[Dict[str, Any]]:
        """
        Extract named entities from text.

        Args:
            text: Input text to process

        Returns:
            List of entity dictionaries with keys:
                - entity_group: Entity type (PER, ORG, LOC, etc.)
                - word: The entity text
                - score: Confidence score
                - start: Start position in text
                - end: End position in text
        """
        if not text or not text.strip():
            return []

        try:
            # Run NER pipeline
            # The pipeline automatically handles:
            # - Tokenization
            # - Model inference
            # - Post-processing
            raw_entities = self.ner_pipeline(text)

            # Filter by confidence threshold
            filtered_entities = [entity for entity in raw_entities if entity.get('score', 0) >= self.min_confidence]

            # Format results
            formatted_entities = []
            for entity in filtered_entities:
                formatted_entities.append({'entity_group': entity.get('entity_group', entity.get('entity', 'UNKNOWN')), 'word': entity.get('word', ''), 'score': entity.get('score', 0.0), 'start': entity.get('start', 0), 'end': entity.get('end', 0)})

            return formatted_entities

        except Exception as e:
            print(f'[NER] Error extracting entities: {str(e)}')
            return []

    def get_entity_summary(self, entities: List[Dict[str, Any]]) -> Dict[str, List[str]]:
        """
        Get a summary of entities grouped by type.

        Args:
            entities: List of entity dictionaries

        Returns:
            Dictionary mapping entity types to lists of unique entity texts
        """
        summary = {}

        for entity in entities:
            entity_type = entity['entity_group']
            entity_text = entity['word']

            if entity_type not in summary:
                summary[entity_type] = []

            if entity_text not in summary[entity_type]:
                summary[entity_type].append(entity_text)

        # Sort each list
        for entity_type in summary:
            summary[entity_type].sort()

        return summary

    def format_entities_for_display(self, entities: List[Dict[str, Any]]) -> str:
        """
        Format entities as human-readable text.

        Args:
            entities: List of entity dictionaries

        Returns:
            Formatted string representation
        """
        if not entities:
            return 'No entities found.'

        summary = self.get_entity_summary(entities)

        lines = [f'Found {len(entities)} entities:']

        # Map entity types to readable names
        type_names = {'PER': 'People', 'PERSON': 'People', 'ORG': 'Organizations', 'LOC': 'Locations', 'LOCATION': 'Locations', 'MISC': 'Miscellaneous', 'DATE': 'Dates', 'TIME': 'Times', 'MONEY': 'Monetary Values', 'PERCENT': 'Percentages'}

        for entity_type, words in summary.items():
            readable_type = type_names.get(entity_type.upper(), entity_type)
            lines.append(f'\n{readable_type} ({len(words)}):')
            for word in words:
                lines.append(f'  - {word}')

        return '\n'.join(lines)
