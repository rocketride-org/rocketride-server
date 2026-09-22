"""Make this contribution importable under the engine's pytest interpreter."""

from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'src' / 'nodes'))


@pytest.fixture(scope='session', autouse=True)
def prepare_node_dependencies():
    """Serialize dependency setup before direct unit tests import native media libraries."""
    from depends import load_depends

    # Engine-backed tests load dependencies in beginGlobal; direct unit tests
    # must do the same before another xdist worker starts a live pipeline.
    # load_depends uses RocketRide's cross-process install.lock.
    node_file = Path(__file__).resolve().parents[2] / 'src' / 'nodes' / 'media_speech' / 'IGlobal.py'
    load_depends(str(node_file))
