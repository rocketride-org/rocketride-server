# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""The managed SFU resolves a MediaMTX build per platform and degrades to the spool on failure."""

import io
import tarfile

import pytest

from ai.account import sfu


def test_asset_maps_known_platforms(monkeypatch):
    monkeypatch.setattr(sfu.platform, 'system', lambda: 'Darwin')
    monkeypatch.setattr(sfu.platform, 'machine', lambda: 'arm64')
    assert sfu._asset() == 'darwin_arm64'
    monkeypatch.setattr(sfu.platform, 'system', lambda: 'Linux')
    monkeypatch.setattr(sfu.platform, 'machine', lambda: 'x86_64')
    assert sfu._asset() == 'linux_amd64'


def test_asset_unknown_platform_is_none(monkeypatch):
    monkeypatch.setattr(sfu.platform, 'system', lambda: 'Plan9')
    monkeypatch.setattr(sfu.platform, 'machine', lambda: 'pdp11')
    assert sfu._asset() is None


def test_linux_arm64_uses_the_v8_asset(monkeypatch):
    # Upstream names it 'linux_arm64v8'; 'linux_arm64' 404s and the managed SFU would break.
    monkeypatch.setattr(sfu.platform, 'system', lambda: 'Linux')
    monkeypatch.setattr(sfu.platform, 'machine', lambda: 'aarch64')
    assert sfu._asset() == 'linux_arm64v8'


def test_every_supported_asset_has_a_pinned_checksum():
    # A download can't run un-verified: every arch we resolve must have a SHA-256 to check.
    assert set(sfu._ASSETS.values()) == set(sfu._SHA256)


def test_ensure_binary_rejects_a_checksum_mismatch(monkeypatch, tmp_path):
    monkeypatch.setattr(sfu.platform, 'system', lambda: 'Darwin')
    monkeypatch.setattr(sfu.platform, 'machine', lambda: 'arm64')
    monkeypatch.setattr(sfu, '_cache_dir', lambda: tmp_path)

    def fake_download(url, archive):
        with open(archive, 'wb') as fh:
            fh.write(b'not the real mediamtx')  # wrong bytes -> wrong SHA-256

    monkeypatch.setattr(sfu.urllib.request, 'urlretrieve', fake_download)
    assert sfu._ensure_binary() is None  # mismatch -> refuse, fall back to the spool


def test_safe_extract_rejects_traversal(tmp_path):
    evil = tmp_path / 'evil.tar'
    with tarfile.open(evil, 'w') as t:
        info = tarfile.TarInfo('../escape')
        info.size = 1
        t.addfile(info, io.BytesIO(b'x'))
    with pytest.raises(ValueError):
        sfu._safe_extract(evil, tmp_path / 'out')


def test_ensure_managed_sfu_degrades_when_binary_unavailable(monkeypatch):
    monkeypatch.setattr(sfu, '_started', False)
    monkeypatch.setattr(sfu, '_ensure_binary', lambda: None)  # unsupported platform / download failed
    assert sfu.ensure_managed_sfu() is None
