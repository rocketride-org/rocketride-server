"""Unit tests for the caption loader + facade (no torch/transformers needed)."""

import io
import sys
import types

import pytest
from PIL import Image

import ai.common.models.vision.caption as capmod
from ai.common.models.vision.caption import CaptionerLoader, Captioner

# Pinned commit shas mirrored from nodes/src/nodes/caption/services.json.
QWEN3VL_SHA = 'ebb281ec70b05090aa6165b016eac8ec08e71b17'
MAGEVL_SHA = '5c78cab61938e73859b63724d9bf5cb88c477eaa'

# Config-level shapes of the real config.json files (no downloads).
IDEFICS3_CONFIG = {'model_type': 'idefics3', 'architectures': ['Idefics3ForConditionalGeneration']}
QWEN3VL_CONFIG = {'model_type': 'qwen3_vl', 'architectures': ['Qwen3VLForConditionalGeneration']}
MAGEVL_CONFIG = {
    'model_type': 'mage_vl',
    'architectures': ['MageVLForConditionalGeneration'],
    'auto_map': {
        'AutoConfig': 'configuration_mage_vl.MageVLConfig',
        'AutoModelForCausalLM': 'modeling_mage_vl.MageVLForConditionalGeneration',
        'AutoProcessor': 'processing_mage_vl.MageVLProcessor',
    },
}


def test_postprocess_wraps_captions():
    out = CaptionerLoader.postprocess(None, ['a cat', 'a dog'], 2, ['caption'])
    assert out == [{'caption': 'a cat'}, {'caption': 'a dog'}]


def test_loading_strategy_is_config_driven_not_name_driven():
    # Natively supported architectures (no auto_map) -> native auto-mapping path,
    # regardless of model name and with or without a revision pin.
    assert CaptionerLoader._select_loading_strategy(IDEFICS3_CONFIG, revision=None) == 'native'
    assert CaptionerLoader._select_loading_strategy(QWEN3VL_CONFIG, revision=QWEN3VL_SHA) == 'native'
    # auto_map (repo ships modeling code) + full sha pin -> remote-code path.
    assert CaptionerLoader._select_loading_strategy(MAGEVL_CONFIG, revision=MAGEVL_SHA) == 'remote_code'


def test_remote_code_requires_full_commit_sha_pin():
    for bad_revision in (None, '', 'main', 'v1.0', MAGEVL_SHA[:12]):
        with pytest.raises(ValueError, match='commit-sha'):
            CaptionerLoader._select_loading_strategy(MAGEVL_CONFIG, revision=bad_revision)


class _FakeLoaded:
    """Stands in for both model and processor; records nothing itself."""

    def to(self, device):
        return self

    def eval(self):
        return self


def _fake_transformers(captured):
    """Build a fake transformers module recording every from_pretrained call."""
    mod = types.ModuleType('transformers')

    def _auto(name):
        class _Auto:
            @staticmethod
            def from_pretrained(model_name, **kw):
                captured.setdefault(name, []).append((model_name, kw))
                return _FakeLoaded()

        return _Auto

    mod.AutoModelForImageTextToText = _auto('image_text_to_text')
    mod.AutoModelForCausalLM = _auto('causal_lm')
    mod.AutoProcessor = _auto('processor')
    return mod


def _patch_loader_env(monkeypatch, captured, config_dict):
    monkeypatch.setitem(sys.modules, 'transformers', _fake_transformers(captured))
    monkeypatch.setattr(CaptionerLoader, '_ensure_dependencies', classmethod(lambda cls: None))
    monkeypatch.setattr(CaptionerLoader, '_get_config_dict', staticmethod(lambda name, revision=None: config_dict))
    monkeypatch.setattr(capmod, 'pick_torch_dtype', lambda device, **kw: 'float32')


def test_load_native_path_never_trusts_remote_code(monkeypatch):
    captured = {}
    _patch_loader_env(monkeypatch, captured, QWEN3VL_CONFIG)

    bundle, metadata, gpu_index = CaptionerLoader.load('Qwen/Qwen3-VL-4B-Instruct', device='cpu', revision=QWEN3VL_SHA)

    assert gpu_index == -1
    assert metadata['model_name'] == 'Qwen/Qwen3-VL-4B-Instruct'
    assert 'causal_lm' not in captured  # trust_remote_code branch never taken
    ((name, kw),) = captured['image_text_to_text']
    assert name == 'Qwen/Qwen3-VL-4B-Instruct'
    assert kw['revision'] == QWEN3VL_SHA
    assert 'trust_remote_code' not in kw
    ((pname, pkw),) = captured['processor']
    assert pkw['revision'] == QWEN3VL_SHA
    assert 'trust_remote_code' not in pkw


def test_load_remote_code_path_pins_revision_and_scopes_trust(monkeypatch):
    captured = {}
    _patch_loader_env(monkeypatch, captured, MAGEVL_CONFIG)

    CaptionerLoader.load('microsoft/Mage-VL', device='cpu', revision=MAGEVL_SHA)

    assert 'image_text_to_text' not in captured  # native branch never taken
    ((name, kw),) = captured['causal_lm']
    assert name == 'microsoft/Mage-VL'
    assert kw['trust_remote_code'] is True
    assert kw['revision'] == MAGEVL_SHA  # SAME sha that gated the branch
    ((pname, pkw),) = captured['processor']
    assert pkw['trust_remote_code'] is True
    assert pkw['revision'] == MAGEVL_SHA


def test_load_requests_profile_memory_from_allocator(monkeypatch):
    captured = {}
    _patch_loader_env(monkeypatch, captured, QWEN3VL_CONFIG)
    asked = []

    def allocate_gpu(memory_gb, exclude_gpus):
        asked.append(memory_gb)
        return 0, 'cpu'  # any device string works for the fake load

    CaptionerLoader.load('Qwen/Qwen3-VL-4B-Instruct', allocate_gpu=allocate_gpu, revision=QWEN3VL_SHA, memory_gb=10.0)
    CaptionerLoader.load('HuggingFaceTB/SmolVLM-500M-Instruct', allocate_gpu=allocate_gpu)
    assert asked == [10.0, capmod.DEFAULT_MEMORY_GB]


def test_load_remote_code_without_sha_raises_before_any_download(monkeypatch):
    captured = {}
    _patch_loader_env(monkeypatch, captured, MAGEVL_CONFIG)

    with pytest.raises(ValueError, match='commit-sha'):
        CaptionerLoader.load('microsoft/Mage-VL', device='cpu', revision=None)
    assert 'causal_lm' not in captured and 'image_text_to_text' not in captured


def test_model_id_is_stable_and_revision_changes_identity():
    a = CaptionerLoader.generate_model_id('HuggingFaceTB/SmolVLM-500M-Instruct')
    assert a == CaptionerLoader.generate_model_id('HuggingFaceTB/SmolVLM-500M-Instruct')
    assert CaptionerLoader.generate_model_id('HuggingFaceTB/SmolVLM-500M-Instruct', revision='abc') != a


def _fake_client_factory(captured):
    class FakeClient:
        def __init__(self, addr):
            self.metadata = {}

        def load_model(self, model_name=None, model_type=None, loader_options=None):
            captured.setdefault('loads', []).append((model_name, model_type, loader_options))

        def send_command(self, command, args):
            captured['cmd'] = command
            captured['args'] = args
            return {'result': [{'caption': captured.get('caption', '')}]}

        def disconnect(self):
            captured['disconnected'] = True

    return FakeClient


def test_facade_load_once_ignores_prompt(monkeypatch):
    captured = {}
    monkeypatch.setattr(capmod, 'get_model_server_address', lambda: 'localhost:5590')
    monkeypatch.setattr(capmod, 'ModelClient', _fake_client_factory(captured))

    Captioner(prompt='Describe this image in detail.')
    Captioner(prompt='List every object in the scene.', max_new_tokens=64)

    loads = captured['loads']
    assert loads[0] == loads[1]  # same identity regardless of per-request prompt/budget
    assert loads[0][1] == 'caption'
    assert 'prompt' not in (loads[0][2] or {})
    assert 'max_new_tokens' not in (loads[0][2] or {})


def test_facade_proxy_sends_prompt_and_decodes(monkeypatch):
    captured = {'caption': 'a person standing'}
    monkeypatch.setattr(capmod, 'get_model_server_address', lambda: 'localhost:5590')
    monkeypatch.setattr(capmod, 'ModelClient', _fake_client_factory(captured))

    cap = Captioner(prompt='What is happening here?', max_new_tokens=128)
    assert cap._proxy_mode is True

    out = cap.caption(Image.new('RGB', (8, 8)))  # small -> not downscaled
    assert captured['cmd'] == 'rrext_ms_inference'
    args = captured['args']
    assert isinstance(args['data'], (bytes, bytearray)) and args['data'][:4] == b'\x89PNG'
    assert args['output_fields'] == ['caption']
    assert args['prompt'] == 'What is happening here?'
    assert args['max_new_tokens'] == 128
    assert out == 'a person standing'

    # Per-call overrides win over the constructor defaults.
    cap.caption(Image.new('RGB', (8, 8)), prompt='One word only.', max_new_tokens=8)
    assert captured['args']['prompt'] == 'One word only.'
    assert captured['args']['max_new_tokens'] == 8

    cap.disconnect()
    assert captured.get('disconnected') is True


def test_sentence_count_survives_abbreviations_and_decimals():
    # Abbreviation periods follow an UPPERCASE letter and must never count —
    # observed captions: 'a sign that says "P.L."', '... a P.C. on it.'
    assert capmod._sentence_count('a sign that says "P.L."') == 0
    assert capmod._sentence_count('a sign that says "P.L." next to a door. A person stands nearby.') == 2
    # A decimal in progress must not fire at end-of-text; a completed one counts.
    assert capmod._sentence_count('The pool is about 1.') == 0
    assert capmod._sentence_count('The pool is about 1.5 meters deep. A ladder is visible.') == 2
    # Plain sentences: boundary at whitespace-confirmed and at end-of-text.
    assert capmod._sentence_count('A red house. There are trees.') == 2
    assert capmod._sentence_count('A red house. There are') == 1


def test_trim_to_sentences_cuts_dangling_next_sentence():
    assert capmod._trim_to_sentences('One here. Two here. Three', 2) == 'One here. Two here.'
    assert capmod._trim_to_sentences('Only one sentence.', 2) == 'Only one sentence.'


def test_facade_proxy_sends_max_sentences_only_when_set(monkeypatch):
    captured = {'caption': 'ok'}
    monkeypatch.setattr(capmod, 'get_model_server_address', lambda: 'localhost:5590')
    monkeypatch.setattr(capmod, 'ModelClient', _fake_client_factory(captured))

    cap = Captioner()
    cap.caption(Image.new('RGB', (8, 8)))
    assert 'max_sentences' not in captured['args']  # off by default: wire format unchanged

    cap.caption(Image.new('RGB', (8, 8)), max_sentences=2)
    assert captured['args']['max_sentences'] == 2

    # Constructor default applies per-request, and is not part of load identity.
    cap2 = Captioner(max_sentences=3)
    cap2.caption(Image.new('RGB', (8, 8)))
    assert captured['args']['max_sentences'] == 3
    assert 'max_sentences' not in (captured['loads'][-1][2] or {})


def test_facade_proxy_downscales_large_image(monkeypatch):
    """Large image is downscaled before captioning (payload shrinks); caption unchanged."""
    captured = {'caption': 'ok'}
    monkeypatch.setattr(capmod, 'get_model_server_address', lambda: 'localhost:5590')
    monkeypatch.setattr(capmod, 'ModelClient', _fake_client_factory(captured))

    cap = Captioner()
    out = cap.caption(Image.new('RGB', (4000, 2000)))  # long edge > INFER_MAX_EDGE
    assert out == 'ok'

    sent = Image.open(io.BytesIO(captured['args']['data']))
    assert max(sent.size) <= capmod.INFER_MAX_EDGE
