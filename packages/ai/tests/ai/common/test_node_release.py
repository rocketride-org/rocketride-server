# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Node packages come from dist/nodes, else the release, cached by digest."""

import hashlib
import io
import os
import threading
import urllib.error

import pytest

from ai.common import node_release


@pytest.fixture
def layout(tmp_path, monkeypatch):
    """An engine in <tmp>/server with its cache under it, and a fake release."""
    monkeypatch.setattr(node_release.sys, 'executable', str(tmp_path / 'server' / 'engine'))
    monkeypatch.setattr(node_release, 'engine_cache_dir', lambda create=False: str(tmp_path / 'server' / 'cache'))
    monkeypatch.setattr(node_release, 'getVersion', lambda: {'version': '1.2.3'})
    release = {}
    asked = []

    def urlopen(url, timeout):
        asked.append(url)
        if url not in release:
            raise urllib.error.HTTPError(url, 404, 'Not Found', {}, None)
        return io.BytesIO(release[url])

    monkeypatch.setattr(node_release.urllib.request, 'urlopen', urlopen)
    return tmp_path, release, asked


ZIP = b'zip'
ZIP_SHA = hashlib.sha256(ZIP).hexdigest()


def test_the_index_is_the_one_the_server_was_built_with(layout):
    tmp, _, asked = layout
    os.makedirs(tmp / 'server' / 'nodes')
    (tmp / 'server' / 'nodes' / 'index.json').write_bytes(b'{"built": true}')

    assert node_release.read_index() == b'{"built": true}'
    assert asked == []


def test_a_prerelease_package_is_found_under_its_own_tag(layout):
    _, release, asked = layout
    release[f'{node_release.RELEASES}/server-v1.2.3-prerelease/llm_x.rrnode'] = ZIP

    assert node_release.read_package('llm_x', ZIP_SHA) == ZIP
    assert [url.rsplit('/', 2)[1] for url in asked] == ['server-v1.2.3', 'server-v1.2.3-prerelease']


def test_the_release_the_extension_installed_is_asked_first_and_a_containers_never(layout):
    tmp, release, asked = layout
    (tmp / 'version.docker.json').write_text('{"tag": "server-v9.9.9", "publishedAt": "x"}')
    (tmp / 'version.local.json').write_text('{"tag": "server-v1.2.3-workshop", "publishedAt": "x"}')
    release[f'{node_release.RELEASES}/server-v1.2.3-workshop/llm_x.rrnode'] = ZIP

    assert node_release.read_package('llm_x', ZIP_SHA) == ZIP
    assert [url.rsplit('/', 2)[1] for url in asked] == ['server-v1.2.3-workshop']


def test_a_package_is_downloaded_once_per_digest(layout):
    _, release, asked = layout
    release[f'{node_release.RELEASES}/server-v1.2.3/llm_x.rrnode'] = ZIP

    assert node_release.read_package('llm_x', ZIP_SHA) == ZIP
    assert node_release.read_package('llm_x', ZIP_SHA) == ZIP
    assert len(asked) == 1


def test_a_damaged_cached_package_is_downloaded_again(layout):
    tmp, release, asked = layout
    release[f'{node_release.RELEASES}/server-v1.2.3/llm_x.rrnode'] = ZIP
    node_release.save(os.path.join(tmp, 'server', 'cache', 'nodes', f'{ZIP_SHA}.rrnode'), b'zi')

    assert node_release.read_package('llm_x', ZIP_SHA) == ZIP
    assert len(asked) == 1


def test_a_release_asset_that_does_not_match_the_index_is_not_cached(layout):
    tmp, release, _ = layout
    release[f'{node_release.RELEASES}/server-v1.2.3/llm_x.rrnode'] = b'other'

    with pytest.raises(ValueError, match='does not match the index'):
        node_release.read_package('llm_x', ZIP_SHA)
    assert not os.path.exists(os.path.join(tmp, 'server', 'cache', 'nodes', f'{ZIP_SHA}.rrnode'))


def test_threads_saving_the_same_file_each_leave_it_whole(tmp_path):
    path = str(tmp_path / 'cache' / 'abc.rrnode')
    errors = []

    def write():
        try:
            node_release.save(path, b'x' * 100_000)
        except Exception as e:
            errors.append(e)

    for _ in range(20):
        threads = [threading.Thread(target=write) for _ in range(4)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

    assert errors == [] and open(path, 'rb').read() == b'x' * 100_000
    assert os.listdir(tmp_path / 'cache') == ['abc.rrnode']
