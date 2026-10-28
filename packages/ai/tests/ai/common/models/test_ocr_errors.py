"""A failed OCR inference raises instead of coming back as empty text (no torch/OCR libraries needed)."""

import pytest

from ai.common.models.ocr import doctr, easyocr, surya, trocr

_OOM = 'CUDA out of memory. Tried to allocate 932.00 MiB'

_WRAPPERS = [
    pytest.param(easyocr, easyocr.EasyOCR, easyocr.EasyOCRLoader, id='easyocr'),
    pytest.param(doctr, doctr.DocTR, doctr.DocTRLoader, id='doctr'),
    pytest.param(surya, surya.Surya, surya.SuryaLoader, id='surya'),
    pytest.param(trocr, trocr.TrOCR, trocr.TrOCRLoader, id='trocr'),
]


def _local(monkeypatch, mod, cls, loader, item):
    """Build the wrapper in local mode with a loader whose inference returns ``item`` per image."""
    monkeypatch.setattr(mod, 'get_model_server_address', lambda: None)
    monkeypatch.setattr(loader, 'load', staticmethod(lambda **kw: ({'device': 'cpu'}, {}, None)))
    monkeypatch.setattr(loader, 'preprocess', staticmethod(lambda model, images, metadata=None: {'images': images}))
    monkeypatch.setattr(
        loader, 'inference', staticmethod(lambda model, pre, metadata=None: [dict(item) for _ in pre['images']])
    )
    return cls()


class _Client:
    """Model-server client stand-in: records the requested fields and answers with ``reply``."""

    sent: list = []
    reply: dict = {}

    def __init__(self, addr):
        self.metadata = {}

    def load_model(self, *a, **kw):
        pass

    def send_command(self, command, args):
        _Client.sent.append(args['output_fields'])
        return {'result': [dict(_Client.reply)]}

    def disconnect(self):
        pass


def _proxy(monkeypatch, mod, cls, reply, **kwargs):
    _Client.sent = []
    _Client.reply = reply
    monkeypatch.setattr(mod, 'get_model_server_address', lambda: 'localhost:5590')
    monkeypatch.setattr(mod, 'ModelClient', _Client)
    return cls(**kwargs)


@pytest.mark.parametrize('mod, cls, loader', _WRAPPERS)
def test_local_failure_raises(monkeypatch, mod, cls, loader):
    ocr = _local(monkeypatch, mod, cls, loader, {'text': '', 'boxes': [], 'error': _OOM})

    with pytest.raises(RuntimeError, match='inference failed: CUDA out of memory'):
        ocr.read(b'png')


@pytest.mark.parametrize('mod, cls, loader', _WRAPPERS)
def test_local_success_returns_text_and_boxes(monkeypatch, mod, cls, loader):
    ocr = _local(monkeypatch, mod, cls, loader, {'text': 'hello', 'boxes': []})

    assert ocr.read(b'png') == {'text': 'hello', 'boxes': []}


@pytest.mark.parametrize('mod, cls, loader', _WRAPPERS)
def test_proxy_failure_raises(monkeypatch, mod, cls, loader):
    """The model server returns the plain ``error`` field when asked for it, as any deployed version does."""
    ocr = _proxy(monkeypatch, mod, cls, {'$text': '', '$boxes': [], 'error': _OOM})

    with pytest.raises(RuntimeError, match='inference failed: CUDA out of memory'):
        ocr.read(b'png')
    assert _Client.sent == [['$text', '$boxes', 'error']]


@pytest.mark.parametrize('mod, cls, loader', _WRAPPERS)
def test_proxy_success_keeps_the_callers_fields(monkeypatch, mod, cls, loader):
    ocr = _proxy(monkeypatch, mod, cls, {'$text': 'hello', 'error': None}, output_fields=['$text'])

    assert ocr.read(b'png') == {'text': 'hello', 'boxes': []}
    assert ocr.output_fields == ['$text']
    assert _Client.sent == [['$text', 'error']]
