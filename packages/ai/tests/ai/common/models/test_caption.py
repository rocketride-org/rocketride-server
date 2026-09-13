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


def test_sentence_helpers_edge_cases():
    count, trim = capmod._sentence_count, capmod._trim_to_sentences

    # Uppercase-preceded abbreviation periods ('J.R.') never count; the guard is
    # deliberately lowercase-blind, so a lowercase abbreviation like 'Dr.' does
    # count as a boundary (documented limitation: prefers over-stop to a
    # decimal firing mid-number).
    assert count('J.R. Smith arrives.') == 1
    assert count('Dr. Smith arrives.') == 2

    # Runs of terminators are one boundary each.
    assert count('Wow!!! Great.') == 2
    assert count('Really?!') == 1
    assert trim('Wow!!! Great.', 1) == 'Wow!!!'

    # Ellipses are a single boundary, mid-text and at end-of-text.
    assert count('It fades... Then dark.') == 2
    assert count('It fades...') == 1
    assert trim('It fades... Then dark.', 1) == 'It fades...'

    # Closing quote after the terminator stays with its sentence.
    assert count('He said "go." Then left.') == 2
    assert trim('He said "go." Then left.', 1) == 'He said "go."'

    # max_sentences=1 keeps exactly the first sentence.
    assert trim('One. Two. Three.', 1) == 'One.'
    # 0 / None mean no limit.
    assert trim('One. Two. Three.', 0) == 'One. Two. Three.'
    assert trim('One. Two. Three.', None) == 'One. Two. Three.'
    assert trim('', 1) == ''


def test_facade_proxy_treats_zero_max_sentences_as_off(monkeypatch):
    captured = {'caption': 'ok'}
    monkeypatch.setattr(capmod, 'get_model_server_address', lambda: 'localhost:5590')
    monkeypatch.setattr(capmod, 'ModelClient', _fake_client_factory(captured))

    cap = Captioner(max_sentences=0)
    assert cap.max_sentences is None
    cap.caption(Image.new('RGB', (8, 8)))
    assert 'max_sentences' not in captured['args']

    cap2 = Captioner(max_sentences=3)
    cap2.caption(Image.new('RGB', (8, 8)), max_sentences=0)  # per-call 0 switches the limit off
    assert 'max_sentences' not in captured['args']
    # max_new_tokens is always on the wire (server floor: part of the contract since day one).
    assert captured['args']['max_new_tokens'] == capmod.DEFAULT_MAX_NEW_TOKENS


def _fake_stopping_transformers():
    mod = types.ModuleType('transformers')

    class StoppingCriteria:
        pass

    mod.StoppingCriteria = StoppingCriteria
    mod.StoppingCriteriaList = list
    return mod


class _FakeTokenizer:
    """Decodes ids through a fixed vocab so the criterion sees real text."""

    VOCAB = {0: '<pad>', 1: 'A', 2: ' cat', 3: '.', 4: ' sits', 5: ' Then', 6: ' it', 7: ' runs'}

    def decode(self, ids, skip_special_tokens=False):
        return ''.join(self.VOCAB[int(i)] for i in ids if not (skip_special_tokens and int(i) == 0))


def test_sentence_stop_criteria_is_per_row(monkeypatch):
    from ai.common.torch import torch

    monkeypatch.setitem(sys.modules, 'transformers', _fake_stopping_transformers())
    prompt_len = 2
    criteria = capmod._sentence_stop_criteria(_FakeTokenizer(), prompt_len, max_sentences=1)
    (stop,) = criteria

    # Row 0: 'A cat.' (done); row 1: 'A cat sits' (not yet).
    batch = torch.tensor([[0, 0, 1, 2, 3], [0, 0, 1, 2, 4]])
    verdict = stop(batch, None)
    assert verdict.dtype == torch.bool and tuple(verdict.shape) == (2,)
    assert verdict.tolist() == [True, False]

    # Batch-1 behaviour unchanged: a (1,) tensor.
    single = stop(torch.tensor([[0, 0, 1, 2, 4]]), None)
    assert single.tolist() == [False]
    assert stop(torch.tensor([[0, 0, 1, 2, 3]]), None).tolist() == [True]

    # Budget of two: one sentence is not enough, two is.
    two = capmod._sentence_stop_criteria(_FakeTokenizer(), prompt_len, max_sentences=2)[0]
    assert two(torch.tensor([[0, 0, 1, 2, 3, 5, 6, 7, 3], [0, 0, 1, 2, 3, 5, 6, 7, 0]]), None).tolist() == [True, False]


def _fake_inference_bundle(captured):
    from ai.common.torch import torch

    class _Inputs(dict):
        def to(self, device):
            return self

    class FakeProcessor:
        def apply_chat_template(self, messages, add_generation_prompt=True, tokenize=False):
            return 'PROMPT'

        def __call__(self, text=None, images=None, return_tensors=None):
            return _Inputs(input_ids=torch.zeros((1, 2), dtype=torch.long))

        def batch_decode(self, ids, skip_special_tokens=True):
            return ['One here. Two here. Three']

    class FakeModel:
        def generate(self, **kwargs):
            captured['generate'] = kwargs
            return torch.zeros((1, 6), dtype=torch.long)

    return {'model': FakeModel(), 'processor': FakeProcessor(), 'device': 'cpu', 'dtype': None}


@pytest.mark.parametrize('max_sentences', [0, None])
def test_inference_zero_or_none_max_sentences_means_no_limit(monkeypatch, max_sentences):
    monkeypatch.setitem(sys.modules, 'transformers', _fake_stopping_transformers())
    captured = {}
    bundle = _fake_inference_bundle(captured)

    out = CaptionerLoader.inference(bundle, {'images': ['img']}, max_sentences=max_sentences)
    assert 'stopping_criteria' not in captured['generate']
    assert out == ['One here. Two here. Three']  # untrimmed


def test_inference_max_sentences_installs_criterion_and_trims(monkeypatch):
    monkeypatch.setitem(sys.modules, 'transformers', _fake_stopping_transformers())
    captured = {}
    bundle = _fake_inference_bundle(captured)

    out = CaptionerLoader.inference(bundle, {'images': ['img']}, max_sentences=2)
    assert len(captured['generate']['stopping_criteria']) == 1
    assert out == ['One here. Two here.']


class _FakeImageProcessor:
    merge_size = 2


class _FakeQwenProcessor:
    image_token = '<img>'
    image_processor = _FakeImageProcessor()

    def replace_image_token(self, image_inputs, image_idx):
        raise AssertionError('stock replace_image_token must be re-bound')


def test_apply_qwen3_vl_fixes_replace_image_token_casts_tensor_count_to_int():
    from ai.common.torch import torch

    processor = _FakeQwenProcessor()
    capmod._apply_qwen3_vl_fixes(model=object(), processor=processor, dtype=torch.float32)

    # grid (t=1, h=4, w=4) -> 16 patches // merge_size**2 (4) = 4 image tokens;
    # the count arrives as a 0-dim tensor and must become a Python int (str * tensor aborts).
    grid = torch.tensor([[1, 4, 4], [1, 8, 4]])
    assert processor.replace_image_token({'image_grid_thw': grid}, 0) == '<img>' * 4
    assert processor.replace_image_token({'image_grid_thw': grid}, 1) == '<img>' * 8


def test_apply_qwen3_vl_fixes_leaves_other_processors_alone():
    from ai.common.torch import torch

    class Plain:
        pass

    processor = Plain()
    capmod._apply_qwen3_vl_fixes(model=object(), processor=processor, dtype=torch.bfloat16)
    assert not hasattr(processor, 'replace_image_token')


def _fake_qwen_model(captured):
    from ai.common.torch import torch

    class PatchEmbed:
        def __init__(self):
            self.floated = False

        def float(self):
            self.floated = True
            return self

        def forward(self, hidden_states):
            captured['in_dtype'] = hidden_states.dtype
            return hidden_states * 2

    visual = types.SimpleNamespace(patch_embed=PatchEmbed())
    return types.SimpleNamespace(model=types.SimpleNamespace(visual=visual)), torch


def test_apply_qwen3_vl_fixes_patch_embed_runs_fp32_only_for_bf16():
    captured = {}
    model, torch = _fake_qwen_model(captured)
    capmod._apply_qwen3_vl_fixes(model=model, processor=object(), dtype=torch.bfloat16)

    pe = model.model.visual.patch_embed
    assert pe.floated is True
    out = pe.forward(torch.ones(2, dtype=torch.bfloat16))
    assert captured['in_dtype'] == torch.float32  # conv ran in fp32...
    assert out.dtype == torch.bfloat16  # ...and the result is cast back

    # fp32 models are untouched.
    captured = {}
    model, torch = _fake_qwen_model(captured)
    capmod._apply_qwen3_vl_fixes(model=model, processor=object(), dtype=torch.float32)
    pe = model.model.visual.patch_embed
    assert pe.floated is False
    assert pe.forward(torch.ones(2, dtype=torch.float32)).dtype == torch.float32
