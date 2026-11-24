"""Local-mode loaders put their model on a device that works (#1168).

Each loader resolves its device through ``cuda_utils.select_torch_device``. These
tests drive the real ``load()`` bodies with the model libraries stubbed and the
CUDA check replaced, and cover the device forms that used to crash or be
mis-mapped: a ``torch.device``, ``'mps'``, and a CUDA device that cannot run
the model.
"""

import sys
import types

import pytest

from ai.common.models.gliner.gliner import GLiNERLoader
from ai.common.models.ocr.surya import SuryaLoader
from ai.common.models.ocr.trocr import TrOCRLoader
from ai.common.models.transformers.sentence_transformers import SentenceTransformerLoader
from ai.common.models.transformers.transformers import TransformersLoader
from ai.common.utils import cuda_utils


class _Device:
    """Stands in for torch.device, whose str() is 'cuda:1', 'mps' and so on."""

    def __init__(self, name):
        self.name = name

    def __str__(self):
        return self.name


class _Model:
    """A model stand-in that records where it is moved."""

    def __init__(self, *args, **kwargs):
        self.moves = []
        self.kwargs = kwargs
        self.config = types.SimpleNamespace(to_dict=lambda: {})

    def to(self, device):
        self.moves.append(device)
        return self

    def eval(self):
        return self


@pytest.fixture
def cuda_works(monkeypatch):
    """Which CUDA ordinals run; every ordinal not listed does."""
    works = {}
    monkeypatch.setattr(cuda_utils, '_cuda_kernels_run', lambda index: works.get(index, True))
    return works


# -----------------------------------------------------------------------------
# TransformersLoader._load_pipeline
# -----------------------------------------------------------------------------


@pytest.fixture
def pipeline(monkeypatch):
    """Stub transformers.pipeline; return the list of devices it was called with."""
    devices = []

    def hf_pipeline(task, model, device, **kwargs):
        devices.append(device)
        return types.SimpleNamespace(model=_Model())

    monkeypatch.setitem(sys.modules, 'transformers', types.SimpleNamespace(pipeline=hf_pipeline))
    monkeypatch.setattr(TransformersLoader, '_estimate_memory', staticmethod(lambda *a, **k: 0.0))
    monkeypatch.setattr(TransformersLoader, '_get_memory_footprint', staticmethod(lambda model: 0.0))
    return devices


def _load_pipeline(device):
    return TransformersLoader._load_pipeline('text-classification', 'some/model', device, None, [])


@pytest.mark.parametrize(
    'device,pipeline_device,label,gpu_index',
    [
        ('mps', 'mps', 'mps', -1),
        ('cpu', -1, 'cpu', -1),
        ('cuda:1', 1, 'cuda:1', 1),
        (_Device('cuda:1'), 1, 'cuda:1', 1),
        (2, 2, 'cuda:2', 2),
    ],
)
def test_a_pipeline_goes_to_the_device_it_names(cuda_works, pipeline, device, pipeline_device, label, gpu_index):
    """'mps' and a torch.device used to raise TypeError at ``device >= 0``."""
    _, metadata, index = _load_pipeline(device)

    assert pipeline == [pipeline_device]
    assert metadata['device'] == label
    assert index == gpu_index


def test_a_pipeline_moves_to_the_cpu_when_its_gpu_cannot_run_it(cuda_works, pipeline):
    cuda_works[1] = False

    _, metadata, index = _load_pipeline('cuda:1')

    assert pipeline == [-1]
    assert metadata['device'] == 'cpu'
    assert index == -1


# -----------------------------------------------------------------------------
# Loaders that move a model to a device string
# -----------------------------------------------------------------------------


@pytest.fixture
def transformers_model(monkeypatch):
    """Stub transformers.AutoModel; return the models it builds."""
    built = []

    def from_pretrained(name, **kwargs):
        built.append(_Model())
        return built[-1]

    monkeypatch.setitem(
        sys.modules,
        'transformers',
        types.SimpleNamespace(AutoModel=types.SimpleNamespace(from_pretrained=from_pretrained)),
    )
    monkeypatch.setattr(TransformersLoader, '_load_tokenizer', staticmethod(lambda name: None))
    monkeypatch.setattr(TransformersLoader, '_get_memory_footprint', staticmethod(lambda model: 0.0))
    return built


@pytest.fixture
def gliner_model(monkeypatch):
    """Stub gliner.GLiNER; return the models it builds."""
    built = []

    def from_pretrained(name, **kwargs):
        built.append(_Model())
        return built[-1]

    monkeypatch.setattr(GLiNERLoader, '_ensure_dependencies', staticmethod(lambda: None))
    monkeypatch.setattr(GLiNERLoader, '_patch_mecab', staticmethod(lambda: None))
    monkeypatch.setitem(
        sys.modules, 'gliner', types.SimpleNamespace(GLiNER=types.SimpleNamespace(from_pretrained=from_pretrained))
    )
    monkeypatch.setattr(GLiNERLoader, '_get_memory_footprint', staticmethod(lambda model: 0.0))
    return built


@pytest.fixture
def sentence_model(monkeypatch):
    """Stub sentence_transformers.SentenceTransformer; return the models it builds."""
    built = []

    class _ST(_Model):
        max_seq_length = 128

        def __init__(self, model_name_or_path, device, **kwargs):
            super().__init__()
            self.moves.append(device)
            built.append(self)

        def get_sentence_embedding_dimension(self):
            return 8

    monkeypatch.setattr(SentenceTransformerLoader, '_ensure_dependencies', staticmethod(lambda: None))
    monkeypatch.setitem(sys.modules, 'sentence_transformers', types.SimpleNamespace(SentenceTransformer=_ST))
    monkeypatch.setattr(SentenceTransformerLoader, '_get_memory_footprint', staticmethod(lambda model: 0.0))
    return built


def _load_transformers(device):
    return TransformersLoader._load_model('some/model', device, None, [])


def _load_gliner(device):
    return GLiNERLoader.load('some/model', device=device)


def _load_sentence(device):
    return SentenceTransformerLoader.load('some/model', device=device)


_LOADERS = [
    pytest.param(_load_transformers, 'transformers_model', id='transformers'),
    pytest.param(_load_gliner, 'gliner_model', id='gliner'),
    pytest.param(_load_sentence, 'sentence_model', id='sentence_transformers'),
]


@pytest.mark.parametrize('load,models', _LOADERS)
def test_a_model_goes_to_the_gpu_a_torch_device_names(request, cuda_works, load, models):
    """A torch.device used to pass the 'cuda' check and then fail at ``device.split(':')``."""
    built = request.getfixturevalue(models)

    _, metadata, gpu_index = load(_Device('cuda:1'))

    assert built[0].moves == ['cuda:1']
    assert metadata['device'] == 'cuda:1'
    assert gpu_index == 1


@pytest.mark.parametrize('load,models', _LOADERS)
def test_a_model_moves_to_the_cpu_when_its_gpu_cannot_run_it(request, cuda_works, load, models):
    built = request.getfixturevalue(models)
    cuda_works[0] = False

    _, metadata, gpu_index = load('cuda')

    assert built[0].moves == ['cpu']
    assert metadata['device'] == 'cpu'
    assert gpu_index == -1


# -----------------------------------------------------------------------------
# OCR loaders on MPS
# -----------------------------------------------------------------------------


@pytest.fixture
def ocr_libraries(monkeypatch):
    """Stub opencv, Surya and TrOCR's libraries; return what each was built with."""
    built = types.SimpleNamespace(surya=[], craft=[], trocr=[])

    def predictor(*args, **kwargs):
        # RecognitionPredictor takes the foundation predictor, not a device
        if 'device' in kwargs:
            built.surya.append(kwargs['device'])
        return types.SimpleNamespace()

    def craft(**kwargs):
        built.craft.append(kwargs['cuda'])
        return types.SimpleNamespace()

    def trocr_model(name):
        built.trocr.append(_Model())
        return built.trocr[-1]

    monkeypatch.setitem(sys.modules, 'ai.common.opencv', types.SimpleNamespace(cv2=None))
    for name, attr in (
        ('surya.foundation', 'FoundationPredictor'),
        ('surya.recognition', 'RecognitionPredictor'),
        ('surya.detection', 'DetectionPredictor'),
    ):
        monkeypatch.setitem(sys.modules, name, types.SimpleNamespace(**{attr: predictor}))
    monkeypatch.setitem(sys.modules, 'craft_text_detector', types.SimpleNamespace(Craft=craft))
    monkeypatch.setitem(
        sys.modules,
        'transformers',
        types.SimpleNamespace(
            TrOCRProcessor=types.SimpleNamespace(from_pretrained=lambda name: object()),
            VisionEncoderDecoderModel=types.SimpleNamespace(from_pretrained=trocr_model),
        ),
    )
    monkeypatch.setattr(SuryaLoader, '_ensure_dependencies', staticmethod(lambda: None))
    monkeypatch.setattr(TrOCRLoader, '_ensure_dependencies', staticmethod(lambda: None))
    return built


def test_surya_stays_on_mps(cuda_works, ocr_libraries):
    """'mps' used to fall to the branch that placed the model on cuda:0."""
    bundle, _, gpu_index = SuryaLoader.load(device='mps')

    assert ocr_libraries.surya == ['mps', 'mps']  # the foundation and detection predictors
    assert bundle['device'] == 'mps'
    assert gpu_index == -1


def test_trocr_on_mps_does_not_ask_craft_for_cuda(cuda_works, ocr_libraries):
    bundle, _, gpu_index = TrOCRLoader.load(device='mps')

    assert ocr_libraries.craft == [False]
    assert ocr_libraries.trocr[0].moves == ['mps']
    assert bundle['device'] == 'mps'
    assert gpu_index == -1
