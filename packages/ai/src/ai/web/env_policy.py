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
    if not env_file.exists():
        return
    if _is_populated(env_file):
        raise RuntimeError(
            'Hosted engines cannot use an install .env file: task processes share its file permissions. '
            'Inject configuration through the process environment and remove the install .env before starting.'
        )


def _is_populated(env_file: Path) -> bool:
    """Whether the file holds anything but blank lines and comments, whether or not it parses.

    dotenv returns nothing for a file whose only line has an unmatched quote, yet a task can still read
    that text, so the check does not depend on the parser's answer. A file that cannot be read counts as
    populated (fail closed).
    """
    try:
        if dotenv_values(env_file, interpolate=False):
            return True
        text = env_file.read_text(encoding='utf-8', errors='replace')
    except Exception:
        return True
    return any(line.strip() and not line.lstrip().startswith('#') for line in text.splitlines())
