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

"""Exercise the real model-output adapter and NER consumer without downloading weights."""

import importlib.util
from pathlib import Path
from types import SimpleNamespace

import pytest

from ai.common.models.transformers.transformers import TransformersLoader


@pytest.fixture
def recognizer():
    """Load the checked-out recognizer; replace only model inference with HF-shaped data."""
    source = Path(__file__).parents[1] / 'src' / 'nodes' / 'ner' / 'ner_recognizer.py'
    spec = importlib.util.spec_from_file_location('ner_recognizer_contract', source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    instance = module.NERRecognizer.__new__(module.NERRecognizer)
    instance.min_confidence = 0.9
    return instance


@pytest.mark.parametrize('type_key, label', [('entity_group', 'PER'), ('entity', 'B-PER')])
def test_real_postprocessor_to_recognizer_preserves_high_confidence_entity(recognizer, type_key, label):
    """Cover aggregated spans and aggregation_strategy=none without bypassing the adapter."""
    raw = [
        {type_key: label, 'word': 'Alice', 'score': 0.99, 'start': 0, 'end': 5},
        {type_key: 'ORG', 'word': 'Uncertain', 'score': 0.1, 'start': 6, 'end': 15},
    ]

    def stub_pipeline(inputs):
        """Stand in for the model pipeline with HF-shaped data."""
        # The recognizer submits a single-item list so the batch size stays 1
        # on the model-server path as well as on the local path.
        assert isinstance(inputs, list) and len(inputs) == 1
        return TransformersLoader.postprocess(SimpleNamespace(task='token-classification'), [raw], 1, ['entities'])

    recognizer.ner_pipeline = stub_pipeline

    assert recognizer.extract_entities('Alice Uncertain') == [
        {'entity_group': label, 'word': 'Alice', 'score': 0.99, 'start': 0, 'end': 5}
    ]


def test_empty_entities_remain_empty(recognizer):
    """A valid no-entity result is different from losing populated model results."""

    def stub_pipeline(inputs):
        """Stand in for the model pipeline with an empty entity list."""
        return [{'entities': []}]

    recognizer.ner_pipeline = stub_pipeline
    assert recognizer.extract_entities('nothing to recognize') == []
