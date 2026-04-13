"""
Platform detection and release asset naming.

Maps the current OS/arch to GitHub release asset names.
Supported platforms: darwin-arm64, linux-x64, win64.
"""

import platform as _platform
import sys
from typing import Tuple

from ..exceptions import UnsupportedPlatformError

# Maps (system, machine) to the platform slug used in release asset names.
_PLATFORM_MAP = {
    ('Darwin', 'arm64'): ('darwin', 'arm64'),
    ('Linux', 'x86_64'): ('linux', 'x64'),
    ('Linux', 'amd64'): ('linux', 'x64'),
}

# Windows is handled separately because platform.machine() varies
_WINDOWS_SLUG = ('win', '64')


def get_platform() -> Tuple[str, str]:
    """Return (os_slug, arch_slug) for the current platform."""
    system = _platform.system()
    machine = _platform.machine()

    if system == 'Windows' or sys.platform == 'win32':
        return _WINDOWS_SLUG

    key = (system, machine)
    if key in _PLATFORM_MAP:
        return _PLATFORM_MAP[key]

    raise UnsupportedPlatformError(f'Unsupported platform: {system} {machine}. Supported platforms: macOS ARM64, Linux x64, Windows x64.')


def normalize_version(version: str) -> str:
    """Strip a leading ``v`` from a version string if present."""
    return version.lstrip('v')


def _base_version(version: str) -> str:
    """Strip prerelease suffixes (e.g. ``-prerelease``) from a version string.

    The release tag keeps the suffix, but the asset filename does not.
    """
    for suffix in ('-prerelease', '-beta', '-alpha', '-rc'):
        if suffix in version:
            return version.split(suffix)[0]
    return version


def asset_name(version: str) -> str:
    """Return the release asset filename for the given version and current platform."""
    os_slug, arch_slug = get_platform()
    ext = 'zip' if os_slug == 'win' else 'tar.gz'
    slug = f'{os_slug}{arch_slug}' if os_slug == 'win' else f'{os_slug}-{arch_slug}'
    base = _base_version(version)
    return f'rocketride-server-v{base}-{slug}.{ext}'


def release_tag(version: str) -> str:
    """Return the GitHub release tag for a given runtime version."""
    return f'server-v{version}'
