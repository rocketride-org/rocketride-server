# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""Per-object scratch files. No account, network or persistent storage access."""

from contextlib import contextmanager
import json
from pathlib import Path
import shutil
import tempfile


def store_path_problem(path):
    """Describe an invalid relative file name, or return None if it is safe."""
    if not isinstance(path, str) or not path or path != path.strip():
        return 'Expected a non-empty relative file name'
    if '\\' in path or ':' in path or any(ord(c) < 32 or ord(c) == 127 for c in path):
        return 'Invalid character in file name'
    if path.startswith('/') or any(part in ('', '.', '..') for part in path.split('/')):
        return 'File name must stay inside the temporary workspace'
    return None


def safe_store_path(path):
    """Return whether a relative name is valid for object-local scratch files."""
    return store_path_problem(path) is None


class Workspace:
    """Own a private temporary directory for one input object."""

    def __init__(self):
        self.temp = tempfile.TemporaryDirectory(prefix='rocketride-media-')
        self.root = Path(self.temp.name).resolve()

    def resolve(self, name):
        """Resolve a relative name inside this workspace, rejecting escapes."""
        problem = store_path_problem(name)
        if problem:
            raise ValueError(problem)
        path = (self.root / name).resolve()
        if not path.is_relative_to(self.root):
            raise ValueError('File name escapes the temporary workspace')
        return path

    def close(self):
        """Release all scratch files owned by this workspace."""
        self.temp.cleanup()


def write_file(workspace, name, local):
    """Copy local bytes to a workspace-relative name and return that name."""
    target = workspace.resolve(name)
    target.parent.mkdir(parents=True, exist_ok=True)
    if Path(local).resolve() != target:
        shutil.copyfile(local, target)
    return name


def write_json(workspace, name, value):
    """
    Serialize value to a workspace-relative scratch file. Strict JSON: a NaN
    or infinity is refused (`ValueError`) rather than written as `-Infinity`,
    which no other reader parses — the report replaces them with null first.
    """
    target = workspace.resolve(name)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(value, indent=2, allow_nan=False), encoding='utf-8')


def download_to(workspace, name, local):
    """Copy a workspace-relative input to local scratch and return its Path."""
    local = Path(local)
    local.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(workspace.resolve(name), local)
    return local


@contextmanager
def local_copy(workspace, name):
    """Yield the received input workspace path without copying; raise FileNotFoundError if missing."""
    path = workspace.resolve(name)
    if not path.is_file():
        raise FileNotFoundError('Required input stream is missing: ' + name)
    yield path
