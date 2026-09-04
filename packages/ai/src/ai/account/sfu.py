# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Managed MediaMTX SFU: the engine fetches and runs it so WebRTC needs no external setup.

An explicit ROCKETRIDE_MEDIA_SFU points at an external SFU and skips all of this.
"""

import atexit
import hashlib
import os
import platform
import socket
import stat
import subprocess
import tarfile
import threading
import time
import urllib.request
import zipfile
from pathlib import Path
from typing import Optional

from rocketlib import warning, debug

# Pinned MediaMTX release; the engine downloads the matching binary once and caches it.
_VERSION = 'v1.11.3'
_RTSP_PORT = 8554
_WHEP_PORT = 8889

# Trimmed config for the managed instance: RTSP in, WebRTC (WHEP) out, nothing else. Run
# without it MediaMTX also opens RTMP/HLS/SRT/API/metrics; the media-plane uses none of
# those, so the engine host should not listen on them. Keys are the v1.11.3 schema.
# `paths: all_others` is the catch-all the default config ships; without it MediaMTX rejects
# every publish/read with "path is not configured" (400), so the trimmed config must keep it.
_CONFIG = f"""logLevel: error
rtmp: no
hls: no
srt: no
api: no
metrics: no
pprof: no
playback: no
rtsp: yes
rtspAddress: 127.0.0.1:{_RTSP_PORT}
webrtc: yes
webrtcAddress: :{_WHEP_PORT}
paths:
  all_others:
"""

# (platform.system().lower(), platform.machine().lower()) -> release asset arch suffix.
# Note the ARM64 Linux asset is 'linux_arm64v8' upstream, not 'linux_arm64'.
_ASSETS = {
    ('linux', 'x86_64'): 'linux_amd64',
    ('linux', 'amd64'): 'linux_amd64',
    ('linux', 'aarch64'): 'linux_arm64v8',
    ('linux', 'arm64'): 'linux_arm64v8',
    ('darwin', 'x86_64'): 'darwin_amd64',
    ('darwin', 'arm64'): 'darwin_arm64',
    ('windows', 'amd64'): 'windows_amd64',
    ('windows', 'x86_64'): 'windows_amd64',
}

# SHA-256 of each pinned _VERSION archive (upstream .sha256sum), verified before extraction.
# Update alongside _VERSION on a bump. HTTPS + the pinned URL already give integrity in transit;
# this also rejects a tampered/re-published release before it runs.
_SHA256 = {
    'linux_amd64': 'b2e65c0be00434b13e01feb64e85af4bc65fa3c62d1b9aa2d4139bd28d795cba',
    'linux_arm64v8': '6ae3e3d78a770ed28ae26f8e8b474387e9d44ee88d419a245e48530062bdb629',
    'darwin_amd64': 'e0cfd7a4ee85a06c6ac2f76673441a8d793cfdd4f2a71a28f87e03f88b7748ab',
    'darwin_arm64': 'd7dc40c84f0099deb604f6cac39c6d58ef4d8d0d18645af3ea07e6da779b06c2',
    'windows_amd64': 'f9c690556fbe0eb8d409aea5c1ae48af16d985a80db12a58c2793e15e0f3c4de',
}

_lock = threading.Lock()
_started = False  # one managed MediaMTX per engine process


def _asset() -> Optional[str]:
    return _ASSETS.get((platform.system().lower(), platform.machine().lower()))


def _cache_dir() -> Path:
    """Where the MediaMTX binary is cached, versioned so a bump re-downloads cleanly."""
    root = os.environ.get('ROCKETRIDE_MEDIA_SFU_CACHE') or os.path.join(
        os.path.expanduser('~'), '.rocketride', 'mediamtx'
    )
    path = Path(root) / _VERSION
    path.mkdir(parents=True, exist_ok=True)
    return path


def _binary() -> Path:
    name = 'mediamtx.exe' if platform.system().lower() == 'windows' else 'mediamtx'
    return _cache_dir() / name


def _safe_extract(archive: Path, dest: Path) -> None:
    """Extract, rejecting any member that would escape dest (zip-slip / tar traversal)."""
    if archive.name.endswith('.zip'):
        with zipfile.ZipFile(archive) as z:
            members = z.namelist()
            if any(os.path.isabs(m) or '..' in Path(m).parts for m in members):
                raise ValueError('unsafe archive member')
            z.extractall(dest)
    else:
        with tarfile.open(archive) as t:
            for m in t.getmembers():
                if os.path.isabs(m.name) or '..' in Path(m.name).parts:
                    raise ValueError('unsafe archive member')
                # A symlink/hardlink member with a safe name can still point outside dest via
                # its link target. The MediaMTX tarball is only regular files, so allow nothing else.
                if not (m.isfile() or m.isdir()):
                    raise ValueError(f'unsafe archive member (not a regular file or dir): {m.name}')
            t.extractall(dest)


def _sha256(path: Path) -> str:
    """SHA-256 of a file, streamed a block at a time."""
    h = hashlib.sha256()
    with open(path, 'rb') as fh:
        for block in iter(lambda: fh.read(1 << 20), b''):
            h.update(block)
    return h.hexdigest()


def _ensure_binary() -> Optional[Path]:
    """Download + extract the pinned MediaMTX for this platform (cached). None if unsupported/failed."""
    binary = _binary()
    if binary.exists():
        return binary
    asset = _asset()
    if not asset:
        warning(f'media SFU: no MediaMTX build for {platform.system()}/{platform.machine()}; falling back to the spool')
        return None
    ext = 'zip' if asset.startswith('windows') else 'tar.gz'
    url = f'https://github.com/bluenviron/mediamtx/releases/download/{_VERSION}/mediamtx_{_VERSION}_{asset}.{ext}'
    archive = _cache_dir() / f'mediamtx.{ext}'
    try:
        urllib.request.urlretrieve(url, archive)  # HTTPS to GitHub releases, pinned version
        expected = _SHA256.get(asset)
        if expected and _sha256(archive) != expected:
            warning(f'media SFU: MediaMTX checksum mismatch for {asset}; refusing it, falling back to the spool')
            return None
        _safe_extract(archive, _cache_dir())
    except Exception as e:
        warning(f'media SFU: MediaMTX download failed ({e}); falling back to the spool')
        return None
    finally:
        archive.unlink(missing_ok=True)
    if not binary.exists():
        return None
    binary.chmod(binary.stat().st_mode | stat.S_IEXEC)
    return binary


def _lan_host() -> str:
    """The engine's LAN IP, so a WHEP url resolves from other machines; 127.0.0.1 if offline."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('8.8.8.8', 80))  # no packet is sent; just picks the default-route interface
        return s.getsockname()[0]
    except OSError:
        return '127.0.0.1'
    finally:
        s.close()


def _port_ready(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.4)
        return s.connect_ex(('127.0.0.1', port)) == 0


def _write_config() -> Path:
    """Write the trimmed config next to the binary (rewritten each start) and return its path."""
    path = _cache_dir() / 'mediamtx.yml'
    path.write_text(_CONFIG)
    return path


def ensure_managed_sfu() -> Optional[str]:
    """Start the bundled MediaMTX once and return the host clients reach it at, or None on failure."""
    global _started
    with _lock:
        host = _lan_host()
        if _started:
            return host
        binary = _ensure_binary()
        if binary is None:
            return None
        config = _write_config()
        try:
            proc = subprocess.Popen(
                [str(binary), str(config)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, cwd=str(binary.parent)
            )
        except OSError as e:
            warning(f'media SFU: MediaMTX failed to start ({e}); falling back to the spool')
            return None
        atexit.register(_stop, proc)
        for _ in range(30):  # let RTSP come up so the first push doesn't race the boot
            if proc.poll() is not None:
                warning('media SFU: MediaMTX exited during startup; falling back to the spool')
                return None
            if _port_ready(_RTSP_PORT):
                break
            time.sleep(0.1)
        _started = True
        debug(f'media SFU: managed MediaMTX up on {host} (RTSP {_RTSP_PORT} / WHEP {_WHEP_PORT})')
        return host


def _stop(proc: subprocess.Popen) -> None:
    """Best-effort shutdown of the managed MediaMTX at engine exit."""
    try:
        proc.terminate()
        proc.wait(timeout=5)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass
