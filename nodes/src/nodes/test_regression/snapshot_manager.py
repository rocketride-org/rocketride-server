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

import hashlib
import os


class SnapshotManager:
    """Manages golden file persistence using SHA-256 content-keyed snapshots."""

    def __init__(self, snapshot_dir: str) -> None:  # noqa: D107
        self.snapshot_dir = os.path.abspath(snapshot_dir)
        os.makedirs(self.snapshot_dir, exist_ok=True)

    def computeKey(self, content: str) -> str:
        """Compute a SHA-256 hex digest for the given content."""
        return hashlib.sha256(content.encode('utf-8')).hexdigest()

    def _path(self, key: str) -> str:
        """Return the filesystem path for a given snapshot key."""
        return os.path.join(self.snapshot_dir, f'{key}.golden')

    def save(self, key: str, content: str) -> None:
        """Persist a golden snapshot to disk."""
        path = self._path(key)
        with open(path, 'w', encoding='utf-8') as f:
            f.write(content)

    def load(self, key: str) -> str | None:
        """Load a golden snapshot from disk, returning None if it does not exist."""
        path = self._path(key)
        if not os.path.exists(path):
            return None
        with open(path, 'r', encoding='utf-8') as f:
            return f.read()

    def exists(self, key: str) -> bool:
        """Check whether a golden snapshot exists for the given key."""
        return os.path.exists(self._path(key))
