import sys
from pathlib import Path

import pytest

# Reactively strip the debugger / pytest rootdir entries that point at
# stale dist content. Triggers only under the VS Code debug attach.
# sys.path[0] = packages/ai  (pytest rootdir from pyproject.toml)
# sys.path[1] = ''           (cwd = dist/server, injected by debugpy)
if len(sys.path) >= 2 and Path(sys.path[0]) == Path(__file__).parent.parent and sys.path[1] == '':
    del sys.path[0:2]


@pytest.fixture(autouse=True)
def _reset_store_singleton():
    """Drop the Store process singleton around every test.

    The singleton is built lazily from RR_STORE_URL on first Store.instance()
    call and carries the process-wide _shared_handles / _shared_write_locks
    registries. Without this reset, the first test to touch the singleton
    would pin whatever env was live at that moment for the REST of the
    session, making any singleton-reaching test order-dependent and stateful.
    """
    from ai.account.store import Store

    Store.reset()
    yield
    Store.reset()
