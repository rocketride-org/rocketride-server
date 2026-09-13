"""Unit tests for the transformers loader after the v5 migration (no torch/transformers needed).

transformers v5 removed the question-answering / summarization / translation /
text2text-generation pipeline tasks and slow tokenizers (the `use_fast=False`
retry). These tests pin the migrated construction paths with fakes — nothing
is downloaded and the real libraries are never imported.
"""

import contextlib
import sys
import types

import pytest

import ai.common.models.transformers.transformers as tmod
from ai.common.models.transformers.transformers import TransformersLoader


def _install_fake_torch(monkeypatch):
    """Provide ai.common.torch (no_grad + cuda.is_available) without real torch."""
    mod = types.ModuleType('ai.common.torch')
    mod.torch = types.SimpleNamespace(
        no_grad=contextlib.nullcontext,
        cuda=types.SimpleNamespace(is_available=lambda: False),
    )
    monkeypatch.setitem(sys.modules, 'ai.common.torch', mod)


def _install_fake_transformers(monkeypatch, captured):
    """Provide a transformers module whose pipeline() records its kwargs."""
    mod = types.ModuleType('transformers')

    class _FakePipe:
        task = 'fake'

        def __call__(self, inputs):
            return [{'ok': True} for _ in inputs]

    def fake_pipeline(task=None, model=None, device=None, **kwargs):
        captured['pipeline_call'] = {'task': task, 'model': model, 'device': device, **kwargs}
        return _FakePipe()

    mod.pipeline = fake_pipeline
    monkeypatch.setitem(sys.modules, 'transformers', mod)
    return mod


def _no_deps(monkeypatch):
    monkeypatch.setattr(TransformersLoader, '_ensure_dependencies', classmethod(lambda cls: None))


# ---------------------------------------------------------------------------
# Task table contract
# ---------------------------------------------------------------------------


def test_task_tables_exclude_v5_removed_tasks():
    removed = set(tmod.TASKS_REMOVED_IN_V5)
    assert removed == {'question-answering', 'summarization', 'translation', 'text2text-generation'}
    assert removed.isdisjoint(tmod.TASK_OUTPUT_FIELDS)


def test_ner_output_fields_contract():
    # nodes/ner/ner_recognizer.py builds pipeline(task='ner') and expects
    # entity dicts — the task must stay mapped to ['entities'].
    assert tmod.TASK_OUTPUT_FIELDS['ner'] == ['entities']
    assert tmod.TASK_OUTPUT_FIELDS['token-classification'] == ['entities']
    assert tmod._get_output_fields_for_task('ner') == ['entities']


def test_unknown_task_falls_back_to_generic_output():
    assert tmod._get_output_fields_for_task('no-such-task') == ['output']


# ---------------------------------------------------------------------------
# Removed pipeline tasks fail loudly (no silent v4 behavior)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize('task', sorted(tmod.TASKS_REMOVED_IN_V5))
def test_removed_v5_pipeline_tasks_raise(monkeypatch, task):
    _no_deps(monkeypatch)
    with pytest.raises(ValueError, match='removed in transformers v5'):
        TransformersLoader.load(model_name='some/model', device='cpu', task=task)


# ---------------------------------------------------------------------------
# Pipeline construction (local mode)
# ---------------------------------------------------------------------------


def test_load_pipeline_local_cpu_construction(monkeypatch):
    captured = {}
    _install_fake_transformers(monkeypatch, captured)
    _install_fake_torch(monkeypatch)
    _no_deps(monkeypatch)

    pipe, metadata, gpu_index = TransformersLoader.load(
        model_name='dbmdz/bert-large-cased-finetuned-conll03-english', device='cpu', task='ner'
    )

    call = captured['pipeline_call']
    assert call['task'] == 'ner'
    assert call['model'] == 'dbmdz/bert-large-cased-finetuned-conll03-english'
    assert call['device'] == -1  # 'cpu' maps to -1 for hf pipeline
    assert call['trust_remote_code'] is True  # default, overridable via kwargs
    assert gpu_index == -1
    assert metadata['loader'] == 'transformers_pipeline'
    assert metadata['device'] == 'cpu'
    assert callable(pipe)


def test_load_pipeline_forwards_pipeline_kwargs(monkeypatch):
    captured = {}
    _install_fake_transformers(monkeypatch, captured)
    _install_fake_torch(monkeypatch)
    _no_deps(monkeypatch)

    TransformersLoader.load(model_name='m', device='cuda:1', task='token-classification', aggregation_strategy='simple')

    call = captured['pipeline_call']
    assert call['device'] == 1  # 'cuda:1' maps to index 1
    assert call['aggregation_strategy'] == 'simple'


# ---------------------------------------------------------------------------
# Tokenizer loading (v5: backend selection is automatic, no use_fast retry)
# ---------------------------------------------------------------------------


def test_load_tokenizer_never_passes_use_fast(monkeypatch):
    calls = []
    mod = types.ModuleType('transformers')

    class FakeAutoTokenizer:
        @staticmethod
        def from_pretrained(name, **kwargs):
            calls.append(kwargs)
            return 'tokenizer-object'

    mod.AutoTokenizer = FakeAutoTokenizer
    mod.AutoProcessor = None  # must not be touched on success
    monkeypatch.setitem(sys.modules, 'transformers', mod)

    assert TransformersLoader._load_tokenizer('some/model') == 'tokenizer-object'
    assert calls == [{}]  # exactly one attempt, no use_fast kwarg


def test_load_tokenizer_falls_back_to_processor(monkeypatch):
    calls = []
    mod = types.ModuleType('transformers')

    class FakeAutoTokenizer:
        @staticmethod
        def from_pretrained(name, **kwargs):
            calls.append(kwargs)
            raise RuntimeError('no tokenizer files')

    class FakeAutoProcessor:
        @staticmethod
        def from_pretrained(name, **kwargs):
            return 'processor-object'

    mod.AutoTokenizer = FakeAutoTokenizer
    mod.AutoProcessor = FakeAutoProcessor
    monkeypatch.setitem(sys.modules, 'transformers', mod)

    assert TransformersLoader._load_tokenizer('some/model') == 'processor-object'
    # v4 retried with use_fast=False; v5 goes straight to AutoProcessor.
    assert calls == [{}]


def test_load_tokenizer_returns_none_when_nothing_loads(monkeypatch):
    mod = types.ModuleType('transformers')

    class _Boom:
        @staticmethod
        def from_pretrained(name, **kwargs):
            raise RuntimeError('nope')

    mod.AutoTokenizer = _Boom
    mod.AutoProcessor = _Boom
    monkeypatch.setitem(sys.modules, 'transformers', mod)

    assert TransformersLoader._load_tokenizer('some/model') is None


# ---------------------------------------------------------------------------
# Memory estimation table no longer references removed tasks
# ---------------------------------------------------------------------------


def test_estimate_memory_removed_tasks_use_model_heuristics():
    # Removed tasks fall through to the model-name heuristics / generic default
    # instead of a dead task table entry.
    assert TransformersLoader._estimate_memory('bert-base-uncased', task='summarization') == 0.5
    assert TransformersLoader._estimate_memory('unknown-model', task='question-answering') == 2.0
    assert TransformersLoader._estimate_memory('m', task='token-classification') == 0.5
