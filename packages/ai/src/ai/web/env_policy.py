"""Prevent hosted engines from keeping deployment secrets in a task-readable file."""

from pathlib import Path
from typing import Iterable

from dotenv import dotenv_values


def validate_hosted_env_file(path: str, args: Iterable[str]) -> None:
    """Refuse a populated install .env before accepting hosted pipeline work.

    Task subprocesses share the engine's UID. File mode 0600 cannot hide the
    install directory's .env from them, so hosted engines must receive config
    through the process environment and operators must remove the file itself.
    Empty/comment-only files and local OSS development keep working.
    """
    if not {'--saas', '--hosted'}.intersection(args):
        return
    env_file = Path(path)
    if env_file.exists() and dotenv_values(env_file, interpolate=False):
        raise RuntimeError(
            'Hosted engines cannot use an install .env file: task processes share its file permissions. '
            'Inject configuration through the process environment and remove the install .env before starting.'
        )
