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

"""Preserve complete HF token-classification entities across the batch boundary."""

from types import SimpleNamespace

import numpy as np
import pytest

from ai.common.models.transformers.transformers import TransformersLoader


@pytest.mark.parametrize('task', ['ner', 'token-classification'])
@pytest.mark.parametrize('wrapped', [False, True])
def test_entities_are_batched_and_serialized(task, wrapped):
    """One result belongs to each input, including an input with no entities."""
    model = SimpleNamespace(task=task)
    if wrapped:
        model = SimpleNamespace(model_obj=model)
    entity = {'entity_group': 'PER', 'word': 'Alice', 'score': np.float32(0.99), 'start': 0, 'end': 5}

    result = TransformersLoader.postprocess(model, [[entity], []], 2, ['entities'])

    assert result[0]['entities'] == [{**entity, 'score': float(entity['score'])}]
    assert isinstance(result[0]['entities'][0]['score'], float)
    assert result[1] == {'entities': []}


@pytest.mark.parametrize('raw', [[], [{'entity': 'B-PER', 'word': 'Alice', 'score': 0.99, 'start': 0, 'end': 5}]])
def test_single_input_keeps_a_flat_entity_list_together(raw):
    """A scalar HF input must not turn each entity into a separate batch item."""
    result = TransformersLoader.postprocess(SimpleNamespace(task='ner'), raw, 1, ['entities'])
    assert result == [{'entities': raw}]


def test_other_requested_fields_keep_their_extraction_semantics():
    """Wrapping entities must not change callers requesting individual fields."""
    entity = {'entity_group': 'PER', 'word': 'Alice', 'score': 0.99}
    result = TransformersLoader.postprocess(SimpleNamespace(task='ner'), [[entity]], 1, ['entities', 'word'])
    assert result == [{'entities': [entity], 'word': ['Alice']}]


def test_other_tasks_keep_their_output_shape():
    """The NER fix does not change classification or generation output handling."""
    raw = [{'label': 'POSITIVE', 'score': 0.99}]
    result = TransformersLoader.postprocess(SimpleNamespace(task='text-classification'), raw, 1, ['label', 'score'])
    assert result == raw


def test_individual_fields_without_entities_keep_their_output_shape():
    """Only the requested entities envelope opts in to NER list wrapping."""
    raw = [{'word': 'Alice', 'score': 0.99}, {'word': 'Bob', 'score': 0.98}]
    result = TransformersLoader.postprocess(SimpleNamespace(task='ner'), raw, 1, ['word', 'score'])
    assert result == raw
