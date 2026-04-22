"""
Runtime lifecycle management subpackage.

Handles runtime binary download, process lifecycle, state tracking,
Docker container management, and the auto-spawn logic used by
RocketRideClient when no URI is provided.
"""

from .manager import RuntimeManager
from .service import RuntimeService
from .state import StateDB
from .docker import DockerRuntime
from ..exceptions import UnsupportedPlatformError, RuntimeManagementError, RuntimeNotFoundError

__all__ = [
    'RuntimeManager',
    'RuntimeService',
    'StateDB',
    'DockerRuntime',
    'UnsupportedPlatformError',
    'RuntimeManagementError',
    'RuntimeNotFoundError',
]
