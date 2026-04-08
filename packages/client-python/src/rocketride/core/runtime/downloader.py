"""
Runtime binary downloader.

Downloads release assets from GitHub and extracts them to
~/.rocketride/runtimes/{version}/.
"""

import os
import stat
import sys
import tarfile
import tempfile
import zipfile
from pathlib import Path
from typing import Callable, Optional

import aiohttp

from ..exceptions import RuntimeNotFoundError
from .paths import runtimes_dir, runtime_binary, ensure_dirs
from .platform import asset_name, release_tag

_GITHUB_DOWNLOAD = 'https://github.com/rocketride-org/rocketride-server/releases/download'


async def download_runtime(
    version: str,
    on_progress: Optional[Callable[[int, int], None]] = None,
    on_phase: Optional[Callable[[str], None]] = None,
) -> Path:
    """Download and extract the runtime binary for the given version.

    Returns the path to the runtime binary. No-ops if the binary already exists.

    *on_progress(downloaded_bytes, total_bytes)* is called after each chunk.
    *total_bytes* may be 0 when the server omits Content-Length.

    *on_phase(phase)* is called at each lifecycle transition:
    ``'downloading'``, ``'extracting'``, ``'done'``.
    """
    binary = runtime_binary(version)
    if binary.exists():
        return binary

    ensure_dirs()

    asset = asset_name(version)
    tag = release_tag(version)
    url = f'{_GITHUB_DOWNLOAD}/{tag}/{asset}'

    # Download to a temp file first
    tmp_fd, tmp_path = tempfile.mkstemp(suffix='.download')
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(url) as resp:
                if resp.status != 200:
                    raise RuntimeNotFoundError(f'Failed to download runtime v{version}: HTTP {resp.status} from {url}')
                total_bytes = resp.content_length or 0
                downloaded_bytes = 0
                if on_phase:
                    on_phase('downloading')
                with os.fdopen(tmp_fd, 'wb') as f:
                    async for chunk in resp.content.iter_chunked(8192):
                        f.write(chunk)
                        downloaded_bytes += len(chunk)
                        if on_progress:
                            on_progress(downloaded_bytes, total_bytes)
                # fd is now closed, don't close again in finally
                tmp_fd = -1

        # Extract
        if on_phase:
            on_phase('extracting')
        dest = runtimes_dir(version)
        dest.mkdir(parents=True, exist_ok=True)

        if asset.endswith('.tar.gz'):
            with tarfile.open(tmp_path, 'r:gz') as tar:
                tar.extractall(path=str(dest))
        elif asset.endswith('.zip'):
            with zipfile.ZipFile(tmp_path, 'r') as zf:
                zf.extractall(path=str(dest))

        # Set executable permission on Unix
        if sys.platform != 'win32' and binary.exists():
            binary.chmod(binary.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)

        if not binary.exists():
            # The archive might have a different internal structure.
            # Look for any executable in the extracted directory.
            raise RuntimeNotFoundError(f'Downloaded and extracted v{version} but binary not found at {binary}. Check the release asset structure.')

        if on_phase:
            on_phase('done')

        return binary

    finally:
        # Clean up temp file
        if tmp_fd >= 0:
            os.close(tmp_fd)
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
