"""Prevent hosted engines from keeping deployment secrets in a task-readable file."""

from pathlib import Path
from typing import Iterable


def _has_binding_line(path: Path) -> bool:
    """True when the file holds any line that is neither blank nor a comment.

    Deliberately not a dotenv parse: a malformed line (an unclosed quote) parses
    to an empty mapping but is still a secret-bearing file the task could read.
    """
    text = path.read_text(encoding='utf-8', errors='replace')
    return any(line.strip() and not line.strip().startswith('#') for line in text.splitlines())


def validate_hosted_env_file(path: str, args: Iterable[str]) -> None:
    """Refuse a populated install .env before accepting hosted pipeline work.

    Task subprocesses share the engine's UID. File mode 0600 cannot hide the
    install directory's .env from them, so hosted engines must receive config
    through the process environment and operators must remove the file itself.
    Any non-blank, non-comment line counts, even one dotenv cannot parse.
    Empty/comment-only files and local OSS development keep working.
    """
    if not {'--saas', '--hosted'}.intersection(args):
        return
    env_file = Path(path)
    if env_file.is_file() and _has_binding_line(env_file):
        raise RuntimeError(
            'Hosted engines cannot use an install .env file: task processes share its file permissions. '
            'Inject configuration through the process environment and remove the install .env before starting.'
        )
