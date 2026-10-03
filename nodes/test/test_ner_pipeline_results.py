# MIT License
# Copyright (c) 2026 Aparavi Software AG
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
    recognizer.ner_pipeline = lambda text: TransformersLoader.postprocess(
        SimpleNamespace(task='token-classification'), [raw], 1, ['entities']
    )

    assert recognizer.extract_entities('Alice Uncertain') == [
        {'entity_group': label, 'word': 'Alice', 'score': 0.99, 'start': 0, 'end': 5}
    ]


def test_empty_entities_remain_empty(recognizer):
    """A valid no-entity result is different from losing populated model results."""
    recognizer.ner_pipeline = lambda text: [{'entities': []}]
    assert recognizer.extract_entities('nothing to recognize') == []
