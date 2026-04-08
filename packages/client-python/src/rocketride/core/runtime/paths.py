"""
Filesystem paths for the ~/.rocketride directory structure.

Layout:
    ~/.rocketride/
        runtimes/{version}/engine(.exe)
        instances/state.db
        logs/{id}/stdout.log, stderr.log
"""

import sys
from pathlib import Path


def rocketride_home() -> Path:
    """Return the root ~/.rocketride directory."""
    return Path.home() / '.rocketride'


def runtimes_dir(version: str) -> Path:
    """Return the directory for a specific runtime version."""
    return rocketride_home() / 'runtimes' / version


def runtime_binary(version: str) -> Path:
    """Return the path to the runtime binary for a given version."""
    name = 'engine.exe' if sys.platform == 'win32' else 'engine'
    return runtimes_dir(version) / name


def state_db_path() -> Path:
    """Return the path to the instances state database."""
    return rocketride_home() / 'instances' / 'state.db'


def logs_dir(instance_id: str) -> Path:
    """Return the log directory for a given instance."""
    return rocketride_home() / 'logs' / instance_id


def ensure_dirs() -> None:
    """Create the ~/.rocketride directory tree if it doesn't exist."""
    rocketride_home().mkdir(parents=True, exist_ok=True)
    (rocketride_home() / 'runtimes').mkdir(exist_ok=True)
    (rocketride_home() / 'instances').mkdir(exist_ok=True)
    (rocketride_home() / 'logs').mkdir(exist_ok=True)
