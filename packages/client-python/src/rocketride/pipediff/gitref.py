# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

"""
Git ref resolution for ``rocketride diff --git <ref> <file.pipe>``.

This module reads a pipeline file's contents at a given git ref so the working
tree can be diffed against history (for example ``rocketride diff --git HEAD
pipeline.pipe``). It shells out to ``git show`` via :mod:`subprocess` with an
argument list — never a shell string — so pipeline paths and refs cannot inject
shell commands.

Like the rest of :mod:`rocketride.pipediff`, this never contacts the RocketRide
engine or the network; ``git`` is the only external process invoked.

Functions:
    resolve_git_ref: Return the parsed pipeline at ``ref``, or ``None`` if the
        file does not exist in that ref (treated by the caller as an all-added
        pipeline).
"""

from __future__ import annotations

import ntpath
import os
import posixpath
import re
import subprocess
from collections.abc import Callable

from ._pipejson import PipeDiffError, parse_pipe_json

# Upper bound so a wedged git process can never hang the CLI indefinitely.
_GIT_TIMEOUT_SECONDS = 30

# The git tree-entry modes of a committed symbolic link and of a directory.
_SYMLINK_MODE = '120000'
_TREE_MODE = '040000'

# Most links followed from one path at the ref before giving up (SYMLOOP_MAX).
_MAX_SYMLINK_HOPS = 40

# What separates the components of committed link text where this process reads it: git
# stores a link's text as written, and Windows opens both kinds of slash.
_LINK_SEPARATOR = r'[\\/]' if os.name == 'nt' else '/'


def resolve_git_ref(ref: str, file_path: str) -> dict | None:
    """
    Load a pipeline file's contents at a specific git ref.

    Resolves ``file_path`` to its repository-relative location, verifies that
    ``ref`` names a commit, walks that path through the tree at ``ref`` (following
    each symlink, on the file or on a directory, as it was committed there, and
    recovering the tracked case of any component on a case-insensitive
    filesystem), and runs ``git show <ref>:<relative-path>`` to retrieve the file
    as it existed at ``ref``, then parses and validates the result. Used to diff a
    working-tree ``.pipe`` file against an arbitrary commit, branch, or tag.

    Args:
        ref: A git revision (commit sha, branch, tag, ``HEAD``, ``HEAD~1``, ...).
        file_path: Path to the working-tree ``.pipe`` file (absolute or relative
            to the current working directory).

    Returns:
        The parsed and validated pipeline ``dict`` at ``ref``, or ``None`` if the
        file does not exist in ``ref`` (the caller treats this as "everything is
        new").

    Raises:
        PipeDiffError: If the path is not inside a git repository, the ref is
            unknown (or does not name a commit), ``git`` is unavailable or times
            out, a symlink at the ref leaves the repository for good or loops,
            or the retrieved contents are not a valid pipeline.
    """
    # A ref is a revision, never an option: git would read `--x:path` as one
    if ref.startswith('-'):
        raise PipeDiffError(f'Unknown git ref {ref!r}')

    # Find the repository through the file's physical directory, so the path
    # matches the top level ``git rev-parse --show-toplevel`` reports even when
    # the repo is reached through a symlinked directory. The directory goes to
    # realpath as given, not through abspath first: abspath folds ``lnk/..`` as
    # text, but the OS opens it as the parent of lnk's target. On a
    # case-insensitive filesystem git itself reports the top level (and, below,
    # the prefix) spelled the way it is stored, whatever case was typed.
    try:
        file_dir = os.path.realpath(os.path.dirname(file_path) or os.curdir)
    except OSError as exc:
        # realpath starts a relative path from os.getcwd(), which fails once the
        # working directory has been removed
        raise PipeDiffError(f'Cannot resolve {file_path!r}: the working directory is gone ({exc.strerror})') from exc
    repo_root = _repository_root(file_dir, file_path)

    # The path below the repository root, as typed, so that a directory symlink
    # inside the repository stays a symlink and is looked up at the ref as the
    # link committed there; a ``..`` after a symlink is left for that walk too (on
    # Windows, which folds it as text first, it is resolved on disk instead).
    typed = _typed_components(file_path, repo_root)
    if typed is None:
        parts = [*_repository_prefix(file_dir, file_path), _git_name(os.path.basename(file_path))]
    else:
        parts = [_git_name(part) for part in typed]

    # "Ref unknown" and "path absent from a known ref" must not be confused: the
    # first is a user error (exit 2), the second means "everything is new". Both
    # are decided on a git exit code, never on the wording of git's diagnostic,
    # which echoes the ref's own name back.
    verified = _run_git(
        ['-C', repo_root, 'rev-parse', '--verify', '--quiet', f'{ref}^{{commit}}'],
        f'verifying ref {ref}',
    )
    if verified.returncode != 0:
        detail = verified.stderr.strip()
        suffix = f': {detail}' if detail else ''
        raise PipeDiffError(f'Unknown git ref {ref!r}{suffix}')

    # Walk the path through the tree as it was at the ref, one component at a
    # time, following every symlink as committed there (not as it is now), and
    # recovering the tracked spelling of any component that differs only in case.
    rel_path = _resolve_in_ref(repo_root, ref, parts)
    if rel_path is None:
        return None
    spec = f'{ref}:{_fs_name(rel_path)}'

    result = _run_git(['-C', repo_root, 'show', spec], f'reading {spec}')
    if result.returncode != 0:
        raise PipeDiffError(f'git show {spec} failed: {result.stderr.strip()}')

    return parse_pipe_json(result.stdout, spec)


def _same_file(first: str, second: str) -> bool:
    """Report whether two paths name the same filesystem entry (links not followed)."""
    try:
        a, b = os.lstat(first), os.lstat(second)
    except OSError:
        return False
    return (a.st_dev, a.st_ino) == (b.st_dev, b.st_ino)


def _typed_components(file_path: str, repo_root: str) -> list[str] | None:
    """
    Return the components of ``file_path`` below ``repo_root``, exactly as typed.

    Directory symlinks inside the repository are left in place (not resolved),
    so each one can be looked up at the ref as the link committed there.

    A ``..`` after a real directory is that directory's parent and is applied here.
    On POSIX a ``..`` after a link is the parent of the link's *target*, which only
    the tree can say, so that ``..`` and everything after it are left in the list
    for the walk at the ref to apply to the link as it was committed there.

    Returns:
        The components below the repository root, or ``None`` when the typed path
        never passes through the root, or (Windows, which folds ``..`` as text
        first) has a ``..`` below it that follows a symlink or leaves the root.
        Those paths are resolved on disk instead.
    """
    typed = file_path if os.path.isabs(file_path) else os.path.join(_logical_cwd(), file_path)
    drive, rest = os.path.splitdrive(typed)
    parts = [part for part in re.split(r'[\\/]' if os.name == 'nt' else '/', rest) if part not in ('', '.')]
    current = drive + os.sep
    for index in range(len(parts) + 1):
        if _same_directory(current, repo_root):
            return _collapse_dotdot(repo_root, parts[index:])
        if index == len(parts):
            break
        # Before the root, ``..`` means the physical parent (lexical on Windows)
        if parts[index] == '..':
            current = os.path.dirname(current if os.name == 'nt' else os.path.realpath(current))
        else:
            current = os.path.join(current, parts[index])
    return None


def _collapse_dotdot(repo_root: str, parts: list[str]) -> list[str] | None:
    """
    Apply each ``..`` in ``parts`` to the real directory before it.

    From the first ``..`` that follows a link (or leaves the root) the rest is kept as
    typed, for the walk at the ref to apply; on Windows that is ``None`` instead.
    """
    kept: list[str] = []
    for index, part in enumerate(parts):
        if part != '..':
            kept.append(part)
        elif kept and not os.path.islink(os.path.join(repo_root, *kept)):
            kept.pop()
        elif os.name == 'nt':
            return None
        else:
            return [*kept, *parts[index:]]
    return kept


def _logical_cwd() -> str:
    """
    Return the working directory as the user's shell spells it, not as the kernel does.

    ``os.getcwd()`` is physical: inside a directory link it names the link's target.
    A relative path typed there means "next to me in the directory I am in", and which
    directory that was at the ref is what the link said then. POSIX shells keep the
    logical path in ``$PWD``; it is used only when it names the very directory
    ``os.getcwd()`` does.

    Raises:
        PipeDiffError: If the working directory no longer exists.
    """
    try:
        physical = os.getcwd()
    except OSError as exc:
        raise PipeDiffError(f'Cannot resolve a relative path: the working directory is gone ({exc.strerror})') from exc
    logical = os.environ.get('PWD')
    if os.name != 'nt' and logical and os.path.isabs(logical) and _same_directory(logical, physical):
        return logical
    return physical


def _same_directory(first: str, second: str) -> bool:
    """Report whether two paths name the same directory (links followed)."""
    try:
        return os.path.samefile(first, second)
    except OSError:
        return False


def _resolve_in_ref(repo_root: str, ref: str, parts: list[str]) -> str | None:
    """
    Resolve ``parts`` to a repository-relative path as the tree at ``ref`` has it.

    Walks the path one component at a time. A component that is a symlink at the
    ref is replaced by the link text stored there, which is read relative to the
    directory holding the link; ``..`` is applied to the path resolved so far, so
    it means the parent of a link's target, as on disk. Git trees never traverse
    links, so this is the only way to read a file reached through one.

    A link that leaves the repository (an absolute path, or enough ``..`` to climb
    out of the root) is followed on disk, where the path outside the repository
    exists today, until it comes back to the repository root; the rest of the path
    is then looked up in the tree at ``ref`` again. A link that never comes back is
    an error: nothing outside the repository has a history here.

    A component the caller typed that is not in the tree under the spelling given,
    but is under one that differs only in case, takes the tracked spelling when
    both name the same entry on disk (a case-insensitive filesystem). On a
    case-sensitive one they are two entries, so nothing matches. Link text is
    taken as committed.

    Returns:
        The repository-relative path of the entry at ``ref``, or ``None`` when
        the path does not exist there (including a link to such a path).

    Raises:
        PipeDiffError: If a link points outside the repository for good, links
            nest more than ``_MAX_SYMLINK_HOPS`` deep (a loop), or git cannot list
            the tree.
    """
    requested = '/'.join(parts)
    pending = [(part, True) for part in reversed(parts)]  # a stack: the next component is last
    resolved: list[str] = []
    listings: dict[str, dict[str, str]] = {}
    last_link = ''
    hops = 0

    while pending:
        part, typed = pending.pop()
        if part in ('', '.'):
            continue
        if part == '..':
            if resolved:
                resolved.pop()
                continue
            # Above the root: the path may come back in (../<repository>/x)
            rest = list(reversed(pending))
            pending[:] = _back_in_the_repository(
                repo_root, os.path.dirname(repo_root), rest, last_link or f'{ref}:{requested} climbs out'
            )
            continue

        directory = '/'.join(resolved)
        if directory not in listings:
            listings[directory] = _list_tree(repo_root, ref, directory)
        entries = listings[directory]
        name = part
        if name not in entries and typed:
            name = _tracked_spelling(repo_root, resolved, part, entries)
        mode = entries.get(name)
        if mode is None:
            return None

        if mode == _SYMLINK_MODE:
            hops += 1
            if hops > _MAX_SYMLINK_HOPS:
                raise PipeDiffError(f'{ref}:{requested}: too many levels of symbolic links')
            link_path = '/'.join([*resolved, name])
            link = _run_git(
                ['-C', repo_root, 'cat-file', 'blob', f'{ref}:{_fs_name(link_path)}'],
                f'reading link {ref}:{link_path}',
                decode=_decode_git_name,
            )
            if link.returncode != 0:
                raise PipeDiffError(f'git cat-file {ref}:{link_path} failed: {link.stderr.strip()}')
            target = link.stdout
            last_link = f'{ref}:{link_path} is a symlink to {target!r}'
            if _is_absolute_link(target):
                # An absolute link restarts at the filesystem root, not at the repository root
                base, pieces = _absolute_link_pieces(repo_root, target)
                rest = [(piece, False) for piece in pieces] + list(reversed(pending))
                resolved.clear()
                pending[:] = _back_in_the_repository(repo_root, base, rest, last_link)
                continue
            pending.extend((piece, False) for piece in reversed(re.split(_LINK_SEPARATOR, target)))
            continue

        resolved.append(name)
        # Only a tree can be walked into; a file (or submodule) with more path
        # after it is no path at all
        if pending and mode != _TREE_MODE:
            return None

    return '/'.join(resolved) if resolved else None


def _is_absolute_link(target: str) -> bool:
    """Report whether committed link text is an absolute path where this process reads it."""
    if posixpath.isabs(target):
        return True
    return os.name == 'nt' and (bool(ntpath.splitdrive(target)[0]) or target.startswith('\\'))


def _absolute_link_pieces(repo_root: str, target: str) -> tuple[str, list[str]]:
    """Split an absolute link into the directory it starts from and its components."""
    if os.name == 'nt':
        drive, rest = ntpath.splitdrive(target)
        base = (drive or ntpath.splitdrive(repo_root)[0]) + os.sep
        return base, [piece for piece in re.split(_LINK_SEPARATOR, rest) if piece]
    return os.sep, [piece for piece in target.split('/') if piece]


def _back_in_the_repository(
    repo_root: str, base: str, rest: list[tuple[str, bool]], last_link: str
) -> list[tuple[str, bool]]:
    """
    Follow ``rest`` on disk from ``base``, a directory outside the repository, until it reaches ``repo_root``.

    Components outside the repository have no history in it, so the filesystem as it
    is now says where they lead: a name is joined onto the directory so far, ``..``
    is the physical parent, and the path is back in the repository the moment it
    names the repository root (itself or through any link to it).

    Returns:
        What is left of ``rest`` after the repository root, for the tree walk to
        continue with (in stack order, the next component last).

    Raises:
        PipeDiffError: If the path ends outside the repository, or goes somewhere that
            does not exist.
    """
    current = base
    for index, (piece, _typed) in enumerate(rest):
        if piece in ('', '.'):
            continue
        current = (
            os.path.dirname(os.path.realpath(current)) if piece == '..' else os.path.join(current, _fs_name(piece))
        )
        if _same_directory(current, repo_root):
            return list(reversed(rest[index + 1 :]))
    raise PipeDiffError(f'{last_link}, outside the repository')


def _list_tree(repo_root: str, ref: str, directory: str) -> dict[str, str]:
    """
    Return ``{entry name: git file mode}`` for ``directory`` ('' is the root) at ``ref``.

    The directory is named as ``<ref>:<directory>`` and not as a pathspec, so a
    name that looks like pathspec magic (``:(top)x``) is still taken literally.
    The walker only asks for directories it has already seen as tree entries.
    """
    listing = _run_git(
        ['-C', repo_root, 'ls-tree', '-z', f'{ref}:{_fs_name(directory)}'],
        f'listing {ref}:{directory or "."}',
        decode=_decode_git_name,
    )
    if listing.returncode != 0:
        raise PipeDiffError(f'git ls-tree {ref}:{directory or "."} failed: {listing.stderr.strip()}')
    entries: dict[str, str] = {}
    for entry in listing.stdout.split('\0'):
        meta, _tab, name = entry.partition('\t')
        if meta:
            entries[name] = meta.split(' ', 1)[0]
    return entries


def _tracked_spelling(repo_root: str, resolved: list[str], part: str, entries: dict[str, str]) -> str:
    """
    Find the tracked spelling of ``part`` when it differs only in case, else ``part``.

    A candidate counts only when it is the same directory entry on disk as
    ``part`` (links not followed), so on a case-sensitive filesystem, where two
    spellings are two entries, nothing matches.
    """
    wanted = part.casefold()
    above = [_fs_name(name) for name in resolved]
    typed_path = os.path.join(repo_root, *above, _fs_name(part))
    for name in entries:
        if name.casefold() == wanted and _same_file(os.path.join(repo_root, *above, _fs_name(name)), typed_path):
            return name
    return part


def _repository_root(file_dir: str, file_path: str) -> str:
    """
    Resolve the git repository root that contains ``file_dir``.

    Args:
        file_dir: A directory inside the repository (the file's parent).
        file_path: The original path, used only for error context.

    Returns:
        The absolute path to the repository top level.

    Raises:
        PipeDiffError: If ``file_dir`` is not inside a git repository (or git
            otherwise fails to resolve the top level).
    """
    result = _run_git(
        ['-C', file_dir, 'rev-parse', '--show-toplevel'],
        f'resolving repository for {file_path}',
        decode=os.fsdecode,
    )
    if result.returncode != 0:
        raise PipeDiffError(f'Not a git repository (or unable to resolve it) for {file_path}: {result.stderr.strip()}')
    return _one_line(result.stdout)


def _one_line(output: str) -> str:
    """Strip the one line end git wrote; any other trailing character belongs to the name."""
    text = output.removesuffix('\n')
    # A Windows console build may write CRLF; a name cannot end in CR there
    return text.removesuffix('\r') if os.name == 'nt' else text


def _repository_prefix(file_dir: str, file_path: str) -> list[str]:
    """
    Return the components of ``file_dir`` below the repository root, as git spells them.

    ``git rev-parse --show-prefix`` gives the stored spelling on a case-insensitive
    filesystem, which a path typed in another case would not match; no directory
    above the file has to be listed to recover it.

    Raises:
        PipeDiffError: If git cannot report the prefix.
    """
    result = _run_git(
        ['-C', file_dir, 'rev-parse', '--show-prefix'],
        f'locating {file_path} in its repository',
        decode=_decode_git_name,
    )
    if result.returncode != 0:
        raise PipeDiffError(f'Not a git repository (or unable to resolve it) for {file_path}: {result.stderr.strip()}')
    return [part for part in _one_line(result.stdout).split('/') if part]


def _decode_strict(raw: bytes) -> str:
    """Decode git output that must be UTF-8 text (a pipeline file, a revision)."""
    return raw.decode('utf-8')


def _decode_git_name(raw: bytes) -> str:
    """Decode git output that holds names (a tree listing, link text), keeping any byte that is not UTF-8."""
    return raw.decode('utf-8', 'surrogateescape')


def _git_name(text: str) -> str:
    """
    Spell a name from this process (argv, a directory listing) the way git's output spells it.

    Git speaks bytes. A process whose filesystem encoding is not UTF-8 (the engine's
    interpreter on Linux is ASCII) holds the same name as escaped bytes, which would
    never equal the name in a tree listing without this.
    """
    return os.fsencode(text).decode('utf-8', 'surrogateescape')


def _fs_name(name: str) -> str:
    """The reverse of :func:`_git_name`: a name from git's output as an argument or a path for this process."""
    return os.fsdecode(name.encode('utf-8', 'surrogateescape'))


def _run_git(
    args: list[str], context: str, decode: Callable[[bytes], str] = _decode_strict
) -> subprocess.CompletedProcess:
    """
    Run a ``git`` subcommand with a fixed argument list and no shell.

    Args:
        args: Arguments passed to ``git`` (already split; never a shell string).
        context: A short description of the operation for error messages.
        decode: How standard output is decoded; UTF-8 text unless the output is
            names or paths, which are bytes git does not promise are UTF-8.

    Returns:
        The completed process, with ``stdout`` and ``stderr`` as text (callers
        inspect ``returncode``/``stdout``/``stderr``).

    Raises:
        PipeDiffError: If ``git`` is not found on ``PATH``, the call times out, or
            git's output cannot be decoded (a blob that is not a text pipe file,
            for instance).
    """
    try:
        completed = subprocess.run(
            ['git', *args],
            capture_output=True,
            timeout=_GIT_TIMEOUT_SECONDS,
        )
    except FileNotFoundError as exc:
        raise PipeDiffError('git executable not found; --git requires git on PATH') from exc
    except subprocess.TimeoutExpired as exc:
        raise PipeDiffError(f'git timed out while {context}') from exc
    except OSError as exc:
        raise PipeDiffError(f'git could not be run while {context}: {exc.strerror or type(exc).__name__}') from exc
    try:
        stdout = decode(completed.stdout)
    except UnicodeDecodeError as exc:
        raise PipeDiffError(f'git output is not valid UTF-8 while {context}: {exc}') from exc
    return subprocess.CompletedProcess(
        completed.args, completed.returncode, stdout, completed.stderr.decode('utf-8', 'replace')
    )
