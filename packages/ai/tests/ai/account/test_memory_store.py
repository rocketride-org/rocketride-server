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

import pytest

from ai.account.store import StorageError, VersionMismatchError
from ai.account.store_providers.memory import MemoryStore


@pytest.fixture
def store() -> MemoryStore:
    return MemoryStore()


# =============================================================================
# write_file / read_file
# =============================================================================


@pytest.mark.asyncio
async def test_write_then_read_returns_content(store):
    await store.write_file('a.txt', 'hello')
    assert await store.read_file('a.txt') == 'hello'


@pytest.mark.asyncio
async def test_overwrite_returns_new_content(store):
    await store.write_file('a.txt', 'first')
    await store.write_file('a.txt', 'second')
    assert await store.read_file('a.txt') == 'second'


@pytest.mark.asyncio
async def test_read_missing_file_raises(store):
    with pytest.raises(StorageError, match='File not found'):
        await store.read_file('missing.txt')


# =============================================================================
# read_file_with_metadata
# =============================================================================


@pytest.mark.asyncio
async def test_read_with_metadata_returns_content_and_version(store):
    await store.write_file('f.txt', 'data')
    content, version = await store.read_file_with_metadata('f.txt')
    assert content == 'data'
    assert version == '1'


@pytest.mark.asyncio
async def test_version_increments_on_each_write(store):
    await store.write_file('f.txt', 'v1')
    _, v1 = await store.read_file_with_metadata('f.txt')
    await store.write_file('f.txt', 'v2')
    _, v2 = await store.read_file_with_metadata('f.txt')
    assert int(v2) > int(v1)


@pytest.mark.asyncio
async def test_read_with_metadata_missing_file_raises(store):
    with pytest.raises(StorageError, match='File not found'):
        await store.read_file_with_metadata('missing.txt')


# =============================================================================
# write_file_atomic
# =============================================================================


@pytest.mark.asyncio
async def test_atomic_write_new_file(store):
    version = await store.write_file_atomic('f.txt', 'content')
    assert version == '1'
    assert await store.read_file('f.txt') == 'content'


@pytest.mark.asyncio
async def test_atomic_write_update_with_correct_version(store):
    v1 = await store.write_file_atomic('f.txt', 'first')
    v2 = await store.write_file_atomic('f.txt', 'second', expected_version=v1)
    assert await store.read_file('f.txt') == 'second'
    assert int(v2) > int(v1)


@pytest.mark.asyncio
async def test_atomic_write_raises_on_version_mismatch(store):
    await store.write_file_atomic('f.txt', 'original')
    with pytest.raises(VersionMismatchError):
        await store.write_file_atomic('f.txt', 'conflict', expected_version='999')


@pytest.mark.asyncio
async def test_atomic_write_without_version_overwrites_existing(store):
    await store.write_file_atomic('f.txt', 'original')
    await store.write_file_atomic('f.txt', 'overwritten')
    assert await store.read_file('f.txt') == 'overwritten'


@pytest.mark.asyncio
async def test_atomic_write_with_version_recreates_missing_file(store):
    # Matches S3/filesystem behaviour: if expected_version is supplied but the
    # file no longer exists (deleted externally), recreate without raising.
    version = await store.write_file_atomic('f.txt', 'recreated', expected_version='99')
    assert await store.read_file('f.txt') == 'recreated'
    assert version == '1'
    assert store._versions['f.txt'] == 1


# =============================================================================
# delete_file
# =============================================================================


@pytest.mark.asyncio
async def test_delete_removes_file(store):
    await store.write_file('f.txt', 'data')
    await store.delete_file('f.txt')
    with pytest.raises(StorageError):
        await store.read_file('f.txt')


@pytest.mark.asyncio
async def test_delete_missing_file_raises(store):
    with pytest.raises(StorageError, match='File not found'):
        await store.delete_file('missing.txt')


@pytest.mark.asyncio
async def test_delete_with_correct_version(store):
    v1 = await store.write_file_atomic('f.txt', 'data')
    await store.delete_file('f.txt', expected_version=v1)
    with pytest.raises(StorageError):
        await store.read_file('f.txt')


@pytest.mark.asyncio
async def test_delete_raises_on_version_mismatch(store):
    await store.write_file('f.txt', 'data')
    with pytest.raises(VersionMismatchError):
        await store.delete_file('f.txt', expected_version='999')


# =============================================================================
# list_files
# =============================================================================


@pytest.mark.asyncio
async def test_list_files_empty_store(store):
    assert await store.list_files() == []


@pytest.mark.asyncio
async def test_list_files_returns_all(store):
    await store.write_file('a.txt', '')
    await store.write_file('b.txt', '')
    assert await store.list_files() == ['a.txt', 'b.txt']


@pytest.mark.asyncio
async def test_list_files_filters_by_prefix(store):
    await store.write_file('users/alice/dep.json', '')
    await store.write_file('users/bob/dep.json', '')
    await store.write_file('other/file.json', '')
    result = await store.list_files('users/')
    assert result == ['users/alice/dep.json', 'users/bob/dep.json']


@pytest.mark.asyncio
async def test_list_files_prefix_no_match_returns_empty(store):
    await store.write_file('a.txt', '')
    assert await store.list_files('z/') == []


@pytest.mark.asyncio
async def test_list_files_returns_sorted(store):
    await store.write_file('b.txt', '')
    await store.write_file('a.txt', '')
    assert await store.list_files() == ['a.txt', 'b.txt']
