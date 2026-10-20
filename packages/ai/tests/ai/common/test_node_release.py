# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Node packages come from dist/nodes, else the release, cached by digest."""

import hashlib
import io
import os
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


def test_a_build_reads_dist_nodes_and_downloads_nothing(layout):
    tmp, _, asked = layout
    os.makedirs(tmp / 'nodes')
    (tmp / 'nodes' / 'index.json').write_bytes(b'{"local": true}')

    assert node_release.read_index() == b'{"local": true}'
    assert asked == []


def test_a_prerelease_is_found_under_its_own_tag(layout):
    _, release, asked = layout
    release[f'{node_release.RELEASES}/server-v1.2.3-prerelease/index.json'] = b'{}'

    assert node_release.read_index() == b'{}'
    assert [url.rsplit('/', 2)[1] for url in asked] == ['server-v1.2.3', 'server-v1.2.3-prerelease']


def test_the_release_the_extension_installed_is_asked_first(layout):
    tmp, release, asked = layout
    (tmp / 'version.local.json').write_text('{"tag": "server-v1.2.3-workshop", "publishedAt": "x"}')
    release[f'{node_release.RELEASES}/server-v1.2.3-workshop/index.json'] = b'{}'

    assert node_release.read_index() == b'{}'
    assert [url.rsplit('/', 2)[1] for url in asked] == ['server-v1.2.3-workshop']


def test_offline_the_last_index_downloaded_is_used(layout, monkeypatch):
    _, release, _ = layout
    release[f'{node_release.RELEASES}/server-v1.2.3/index.json'] = b'{"v": 1}'
    node_release.read_index()

    def offline(url, timeout):
        raise urllib.error.URLError('offline')

    monkeypatch.setattr(node_release.urllib.request, 'urlopen', offline)
    assert node_release.read_index() == b'{"v": 1}'


ZIP = b'zip'
ZIP_SHA = hashlib.sha256(ZIP).hexdigest()


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
