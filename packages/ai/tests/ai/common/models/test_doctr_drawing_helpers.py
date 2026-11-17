"""docTR loads without its drawing helpers, which import matplotlib and abort the Linux engine (#3067).

A fake ``doctr`` package on disk keeps the real import path: ``doctr.models`` imports ``doctr.io.elements``,
which imports the drawing helpers under ``try/except ModuleNotFoundError``, as python-doctr 1.1.0 does.
The fake helpers raise on import, the way importing matplotlib kills the engine process.
"""

import sys
import types

import pytest

from ai.common.models.ocr.doctr import DocTRLoader

_FAKE_DOCTR = {
    '__init__.py': '',
    'utils/__init__.py': '',
    'utils/visualization.py': "raise RuntimeError('drawing helpers imported')\n",
    'io/__init__.py': 'from . import elements\n',
    'io/elements.py': (
        'try:\n'
        '    from doctr.utils.visualization import visualize_kie_page, visualize_page\n'
        'except ModuleNotFoundError:\n'
        '    pass\n'
    ),
    'models/__init__.py': ('import doctr.io\n\n\ndef ocr_predictor(**kwargs):\n    return object()\n'),
}


def _doctr_modules():
    """List the ``doctr`` modules in ``sys.modules``.

    Returns:
        Their names.
    """
    return [name for name in sys.modules if name == 'doctr' or name.startswith('doctr.')]


@pytest.fixture
def fake_doctr(tmp_path, monkeypatch):
    """Put the fake ``doctr`` package first on ``sys.path`` and stub opencv and torch.

    Args:
        tmp_path: pytest's per-test directory.
        monkeypatch: pytest's monkeypatch fixture.

    Yields:
        None; every ``doctr`` module is dropped from ``sys.modules`` afterwards.
    """
    for relative, text in _FAKE_DOCTR.items():
        path = tmp_path / 'doctr' / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
    monkeypatch.syspath_prepend(str(tmp_path))
    for name in _doctr_modules():
        monkeypatch.delitem(sys.modules, name)
    cuda = types.SimpleNamespace(is_available=lambda: False)
    monkeypatch.setattr(DocTRLoader, '_ensure_dependencies', staticmethod(lambda: None))
    monkeypatch.setitem(sys.modules, 'ai.common.opencv', types.SimpleNamespace(cv2=None))
    monkeypatch.setitem(sys.modules, 'ai.common.torch', types.SimpleNamespace(torch=types.SimpleNamespace(cuda=cuda)))
    yield
    for name in _doctr_modules():
        del sys.modules[name]


def test_doctr_loads_without_importing_its_drawing_helpers(fake_doctr):
    """The load succeeds, docTR's own modules load, and the drawing helpers never run.

    Args:
        fake_doctr: The fake docTR package fixture.
    """
    bundle, _, gpu_index = DocTRLoader.load(device='cpu')
    assert gpu_index == -1
    assert bundle['device'] == 'cpu'
    assert 'doctr.io.elements' in sys.modules
    assert sys.modules['doctr.utils.visualization'] is None


def test_the_drawing_helpers_cannot_be_imported_after_the_load(fake_doctr):
    """Code that asks for the helpers later gets ``ModuleNotFoundError``, the error docTR already handles.

    Args:
        fake_doctr: The fake docTR package fixture.
    """
    DocTRLoader.load(device='cpu')
    with pytest.raises(ModuleNotFoundError):
        from doctr.utils.visualization import visualize_page  # noqa: F401


def test_helpers_already_imported_stay(fake_doctr, monkeypatch):
    """A process that already imported the helpers keeps them.

    Args:
        fake_doctr: The fake docTR package fixture.
        monkeypatch: pytest's monkeypatch fixture.
    """
    helpers = types.ModuleType('doctr.utils.visualization')
    helpers.visualize_page = helpers.visualize_kie_page = lambda *args, **kwargs: None
    monkeypatch.setitem(sys.modules, 'doctr.utils.visualization', helpers)
    DocTRLoader.load(device='cpu')
    assert sys.modules['doctr.utils.visualization'] is helpers
