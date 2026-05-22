import sys
from pathlib import Path

# Reactively strip the debugger / pytest rootdir entries that point at
# stale dist content. Triggers only under the VS Code debug attach.
# sys.path[0] = packages/ai  (pytest rootdir from pyproject.toml)
# sys.path[1] = ''           (cwd = dist/server, injected by debugpy)
if len(sys.path) >= 2 and Path(sys.path[0]) == Path(__file__).parent.parent and sys.path[1] == '':
    del sys.path[0:2]
