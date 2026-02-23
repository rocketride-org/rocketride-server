# =============================================================================
# MIT License
# Copyright (c) 2024 RocketRide Inc.
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

import os
import re
from typing import Any, Dict

from rocketlib import debug, expand
from ai.common.config import Config
from ai.common.models import GLiNER
from .Ruleparser import RuleParser
from .anonymize import anonymize as _anonymize


class GliNERRecognizer:
    def __init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]):
        """
        Initialize the GLiNER Recognizer.
        
        Uses ai.common.models.GLiNER which automatically routes to model server
        if --modelserver flag is present, otherwise runs locally.
        """
        # Get the nodes configuration
        config = Config.getNodeConfig(provider, connConfig)

        self.model_name = config.get('model', 'xomad/gliner-model-merge-large-v1.0')
        self.anonymize = config.get('anonymize', True)
        self.anonymize_char = config.get('anonymizeChar', '\u2588')

        enginePath = expand('%execPath%')
        rule_file_path = os.path.join(enginePath, 'nucleuz', 'rulePack.dat')
        self.ruleParser = RuleParser(rule_file_path)
        
        # Use ai.common.models.GLiNER - auto-detects local vs model server mode
        self.model = GLiNER(self.model_name)

    def extract_keywords_from_xml(self, data):
        """
        Safely extracts keyword terms from the given JSON string.

        :param data: A dict containing XML/JSON data.
        :return: A list of extracted keyword terms, or an empty list if not found.
        """
        if data is None or not data:
            return []
        keyword_pattern = re.compile(r'<Term>(.*?)</Term>')  # Regex to extract <Term> content
        all_keywords = []

        for key, value in data.items():
            keywords = keyword_pattern.findall(value)
            all_keywords.extend(keywords)

        return all_keywords

    def convert_ner_results_to_matches(self, ner_results):
        # Extract (offset, length) from ner_results
        matches = list(
            (
                (result['start'], result['end'] - result['start'])  # offset is 'start', length is 'end' - 'start'
                for result in ner_results
            )
        )
        return matches

    def normalize_label(self, label):
        """Clean label names to a consistent format."""
        label = re.sub(r"[“”\"']", '', label)  # Remove quotes
        label = re.sub(r'\s*-\s*', '_', label)  # Replace ' - ' with '_'
        label = re.sub(r'\s*\(\s*', '_', label)  # Replace ' (' with '_'
        label = re.sub(r'\s*\)\s*', '', label)  # Remove trailing ')'
        label = re.sub(r'\s+', '_', label)  # Replace spaces with underscores
        return label.lower()

    def batch_labels(self, labels, batch_size=32):
        """Split labels into smaller batches."""
        for i in range(0, len(labels), batch_size):
            yield labels[i : i + batch_size]

    def predict(self, text, labels, batch_size=32):
        import concurrent.futures

        cleaned_labels = [self.normalize_label(label) for label in labels]

        # Use larger chunks with overlap to avoid missing entities at boundaries
        CHUNK_SIZE = 1024
        OVERLAP = 128

        # Create overlapping chunks
        chunks = []
        chunk_offsets = []
        for i in range(0, len(text), CHUNK_SIZE - OVERLAP):
            chunk = text[i : i + CHUNK_SIZE]
            if chunk:  # Skip empty chunks
                chunks.append(chunk)
                chunk_offsets.append(i)

        # Precompute all label batches
        label_batches = list(self.batch_labels(cleaned_labels, batch_size))

        all_results = []

        # Process chunks in parallel if possible
        def process_chunk(chunk_idx):
            chunk = chunks[chunk_idx]
            offset = chunk_offsets[chunk_idx]
            chunk_results = []

            # Process all label batches for this chunk
            for label_batch in label_batches:
                try:
                    # Use a timeout to avoid hanging on problematic chunks
                    results = self.model.predict_entities(chunk, label_batch)

                    # Adjust offsets and add to results
                    for res in results:
                        res['start'] += offset
                        res['end'] += offset

                        # Skip entities in the overlap region that might be duplicates
                        if chunk_idx > 0 and res['start'] < offset + OVERLAP:
                            continue

                        chunk_results.append(res)

                except Exception as e:
                    debug(f'Anonymize: GLiNER Error on chunk {chunk_idx} with labels {label_batch}: {str(e)}')

            return chunk_results

        # Use ThreadPoolExecutor for parallel processing
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
            futures = [executor.submit(process_chunk, i) for i in range(len(chunks))]

            # Collect results as they complete
            total_chunks = len(futures)
            completed = 0

            for future in concurrent.futures.as_completed(futures):
                try:
                    chunk_results = future.result()
                    all_results.extend(chunk_results)

                    # Simple progress logging
                    completed += 1
                    if completed % 5 == 0 or completed == total_chunks:
                        debug(f'Anonymize: Processing text chunks: {completed}/{total_chunks} complete')

                except Exception as e:
                    debug(f'Anonymize: Error processing chunk: {str(e)}')

        # Remove duplicates (entities that appear in overlapping regions)
        seen = set()
        unique_results = []
        for res in sorted(all_results, key=lambda x: (x['start'], x['end'])):
            key = (res['start'], res['end'], res['label'])
            if key not in seen:
                seen.add(key)
                unique_results.append(res)

        return unique_results

    def process(self, text: str, labels: list, existing_matches: list = None) -> str:
        """
        Core anonymization method - detects entities using GLiNER and masks them.
        
        Args:
            text: The text to anonymize
            labels: Entity labels to detect
            existing_matches: Optional list of (offset, length) tuples from classifications
            
        Returns:
            Anonymized text with detected entities replaced by anonymize_char
        """
        if not text:
            return text
        
        # Run NER prediction
        ner_results = self.predict(text, labels)
        ner_matches = self.convert_ner_results_to_matches(ner_results)
        
        debug(f'Anonymize: Detected {len(ner_results)} entities')
        
        # Combine with existing matches (from classifications)
        all_matches = list(existing_matches or []) + ner_matches
        
        if not all_matches:
            debug('Anonymize: No entities to mask')
            return text
        
        # Sort by offset and apply masking
        all_matches_sorted = sorted(all_matches, key=lambda x: x[0])
        
        return _anonymize(text, all_matches_sorted, self.anonymize_char)

    def handleClassifications(self, classifications: dict, target_object_text: str, classificationPolicy: any, classificationRules: any):
        """
        Handle classifications from upstream classifier - extracts labels and matches,
        then delegates to core anonymize method.
        """
        text_matches = classifications.get('textMatches', '')

        # Get Nucleuz Rules/Policies
        unique_id_refs = set()
        rules = self.extract_keywords_from_xml(classificationRules)

        # Regex to match idRef attributes
        idref_pattern = r'<ClassificationRule idRef="([^"]+)"'

        # Extract idRefs from each key's value
        for key, value in classificationPolicy.items():
            matches = re.findall(idref_pattern, value)
            unique_id_refs.update(matches)

        labels = self.ruleParser.get_rules_names(unique_id_refs) + rules

        # Extract existing matches from classifications (offset, length tuples)
        existing_matches = list(
            (m['offset'], m['length']) 
            for m in ((m.get('location', {}).get('inChars') or m) for m in text_matches)
        )

        return self.process(target_object_text, labels, existing_matches)
