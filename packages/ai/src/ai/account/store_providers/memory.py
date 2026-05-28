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

from typing import Optional

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
        self._files[filename] = data
        self._versions[filename] = self._versions.get(filename, 0) + 1

    async def read_file(self, filename: str) -> str:
        if filename not in self._files:
            raise StorageError(f'File not found: {filename}')
        return self._files[filename]

    async def read_file_with_metadata(self, filename: str) -> tuple:
        if filename not in self._files:
            raise StorageError(f'File not found: {filename}')
        return self._files[filename], str(self._versions[filename])

    async def write_file_atomic(self, filename: str, data: str, expected_version: Optional[str] = None) -> str:
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
        return sorted(f for f in self._files if f.startswith(prefix))

    async def list_entries(
        self,
        prefix: str = '',
        *,
        recursive: bool = True,
        include_files: bool = True,
        include_dirs: bool = True,
        glob_pattern=None,
    ) -> list:
        raise NotImplementedError
