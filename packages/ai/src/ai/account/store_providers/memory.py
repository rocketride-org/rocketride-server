# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

"""In-memory IStore implementation for testing."""

import re
from typing import Optional
import posixpath

from ..store import IStore, StorageError, VersionMismatchError


class MemoryStore(IStore):
    """
    In-memory storage backend.

    Stores all data in plain dicts. Versions are monotonic integers
    incremented on every write. Intended for unit and integration tests;
    data is not persisted across instances.
    """

    def __init__(self) -> None:
        super().__init__('memory://')
        self._files: dict[str, str] = {}
        self._versions: dict[str, int] = {}

    async def write_file(self, filename: str, data: str) -> None:
        filename = _check_path(filename)
        self._files[filename] = data
        self._versions[filename] = self._versions.get(filename, 0) + 1

    async def read_file(self, filename: str) -> str:
        filename = _check_path(filename)
        if filename not in self._files:
            raise StorageError(f'File not found: {filename}')
        return self._files[filename]

    async def read_file_with_metadata(self, filename: str) -> tuple:
        filename = _check_path(filename)
        if filename not in self._files:
            raise StorageError(f'File not found: {filename}')
        return self._files[filename], str(self._versions[filename])

    async def write_file_atomic(self, filename: str, data: str, expected_version: Optional[str] = None) -> str:
        filename = _check_path(filename)
        if expected_version is not None and filename in self._files:
            current = str(self._versions[filename])
            if current != expected_version:
                raise VersionMismatchError(
                    filename=filename,
                    expected_version=expected_version,
                    actual_version=current,
                )
        self._files[filename] = data
        self._versions[filename] = self._versions.get(filename, 0) + 1
        return str(self._versions[filename])

    async def delete_file(self, filename: str, expected_version: Optional[str] = None) -> None:
        filename = _check_path(filename)
        if filename not in self._files:
            raise StorageError(f'File not found: {filename}')
        if expected_version is not None:
            current = str(self._versions[filename])
            if current != expected_version:
                raise VersionMismatchError(
                    filename=filename,
                    expected_version=expected_version,
                    actual_version=current,
                )
        del self._files[filename]
        del self._versions[filename]

    async def list_files(self, prefix: str = '') -> list:
        prefix = _check_path(prefix)
        return sorted(f for f in self._files if f.startswith(prefix))

    async def list_entries(
        self,
        prefix: str = '',
        *,
        recursive: bool = True,
        include_files: bool = True,
        include_dirs: bool = True,
        name_pattern: Optional[str] = None,
    ) -> list:
        prefix = _check_path(prefix)

        # Basic check is enough for in-memory store for testing
        if name_pattern and ('/' in name_pattern or '\\' in name_pattern):
            raise StorageError(f'Invalid name pattern: {name_pattern}')
        if name_pattern == '..':
            raise StorageError(f'Path traversal detected: {name_pattern}')

        prefix_dir = prefix.rstrip('/')

        re_pattern = r'^' + ((re.escape(prefix_dir) + r'/') if prefix_dir else r'')
        if recursive:
            re_pattern += r'([^/]+/)*'
        if name_pattern:
            for c in name_pattern:
                if c == '*':
                    re_pattern += r'[^/]*'
                elif c == '?':
                    re_pattern += r'[^/]'
                else:
                    re_pattern += re.escape(c)
        else:
            re_pattern += r'[^/]+'
        re_pattern += r'$'
        re_pattern = re.compile(re_pattern)

        result = []
        seen_dirs = set() if include_dirs else None
        for filepath in self._files:
            if include_dirs:
                parts = filepath.split('/')[:-1]
                dir_path = ''
                for part in parts:
                    dir_path += ('/' if dir_path else '') + part
                    if dir_path not in seen_dirs:
                        seen_dirs.add(dir_path)
                        if re_pattern.match(dir_path):
                            result.append(dir_path + '/')

            if include_files and re_pattern.match(filepath):
                result.append(filepath)

        return sorted(result)


def _check_path(filename: str) -> str:
    # Basic check is enough for in-memory store for testing
    normalized = posixpath.normpath(filename.replace('\\', '/').strip('/'))
    if normalized.startswith('../') or normalized == '..':
        raise StorageError(f'Path traversal detected: {filename}')
    if normalized == '.':
        normalized = ''
    return normalized
