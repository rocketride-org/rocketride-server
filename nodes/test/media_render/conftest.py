"""Make this contribution importable under the engine's pytest interpreter."""

from pathlib import Path
import sys

import pytest

# Capture the real loader before sibling test modules are collected. Some stock
# tests replace sys.modules['depends'] with a no-op mock during collection.
# Keep this fixture independent of that mock without changing sibling tests.
from depends import FileLock, engine_cache_dir, load_depends

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'src' / 'nodes'))


@pytest.fixture(scope='session', autouse=True)
def prepare_node_dependencies():
    """Serialize dependency setup before direct unit tests import native media libraries."""
    # Engine-backed tests load dependencies in beginGlobal; direct unit tests
    # must do the same before another xdist worker starts a live pipeline.
    # load_depends uses RocketRide's cross-process install.lock.
    node_file = Path(__file__).resolve().parents[2] / 'src' / 'nodes' / 'media_render' / 'IGlobal.py'
    load_depends(str(node_file))

    # Dependency installation and Python importing are separate operations.
    # Another xdist worker can install a package while this worker imports its
    # native extensions. Complete PyAV's initial import under the install lock,
    # then retain the imported module for this worker's entire test session.
    with FileLock(str(Path(engine_cache_dir()) / 'install.lock')):
        import av

        assert callable(av.open)
