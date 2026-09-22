"""Make this contribution importable under the engine's pytest interpreter."""

from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'src' / 'nodes'))


@pytest.fixture(scope='session', autouse=True)
def prepare_node_dependencies():
    """Serialize dependency setup before direct unit tests import native media libraries."""
    from depends import FileLock, engine_cache_dir, load_depends

    # Engine-backed tests load dependencies in beginGlobal; direct unit tests
    # must do the same before another xdist worker starts a live pipeline.
    # load_depends uses RocketRide's cross-process install.lock.
    node_file = Path(__file__).resolve().parents[2] / 'src' / 'nodes' / 'media_inspect' / 'IGlobal.py'
    load_depends(str(node_file))

    # Dependency installation and Python importing are separate operations.
    # Another xdist worker can install a package while this worker imports its
    # native extensions. Complete PyAV's initial import under the install lock,
    # then retain the imported module for this worker's entire test session.
    with FileLock(str(Path(engine_cache_dir()) / 'install.lock')):
        import av

        assert callable(av.open)
