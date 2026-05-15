import sys
from pathlib import Path

# (1) Reactively strip the debugger / pytest rootdir entries that point at
#     stale dist content. Triggers only under the VS Code debug attach.
#     sys.path[0] = packages/ai  (pytest rootdir from pyproject.toml)
#     sys.path[1] = ''           (cwd = dist/server, injected by debugpy)
if len(sys.path) >= 2 and Path(sys.path[0]) == Path(__file__).parent.parent and sys.path[1] == '':
    del sys.path[0:2]

# (2) Proactively put packages/ai/src at the front so `from ai.*` resolves
#     to the source tree (what we want coverage to measure), not the synced
#     dist copy under dist/server/ai.
src_path = Path(__file__).parent.parent / 'src'
if str(src_path) not in sys.path:
    sys.path.insert(0, str(src_path))
