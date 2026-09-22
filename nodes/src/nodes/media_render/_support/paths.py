# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================


"""Validate relative scratch paths and render output collisions."""

from pathlib import PurePosixPath
from .workspace import safe_store_path, store_path_problem


class SpecError(ValueError):
    """
    A spec that cannot be rendered. The message is written for the person who
    asked for the render, not for a log: it says what is wrong with the
    document, and the node turns it into the error report (C8) without
    producing any partial output.
    """


FILTER_CHARS = ':;,\'"\\[]=\n\r'


def _text(value) -> str:
    return value if isinstance(value, str) else ('' if value is None else str(value))


def check_store_path(value, field: str, *, allow_empty: bool = False) -> str:
    """
    One path inside the temporary workspace. What "inside the store" MEANS has a
    single definition — this package's own `store.safe_store_path` (R12/N10) — and
    this function does not grow a second one: it normalises a trailing `/` (a
    spec may name a folder as a prefix), asks that rule, and adds the one
    concern of its own, which is not about the store at all: a value that ends
    up in an ffmpeg argument may not carry the characters that would end a
    filter and start another. Returns the path.
    """
    text = _text(value).strip()
    if not text:
        if allow_empty:
            return ''
        raise SpecError(f'{field} is empty — the render has nowhere to put its files.')
    candidate = text[:-1] if text.endswith('/') else text
    if not safe_store_path(candidate):
        raise SpecError(
            f'{field} is not a path inside the temporary workspace: {store_path_problem(candidate)} ({text!r}).'
        )
    for ch in FILTER_CHARS:
        if ch in text:
            raise SpecError(f'{field} contains a character that is not allowed in a file name ({ch!r}).')
    return text


def emitted_name(path: str, root: str = 'outputs') -> str:
    """
    The name a rendered file is emitted under: its workspace path with the
    output directory taken off, always with forward slashes. Workspace paths
    are POSIX by construction (`store_path_problem` refuses a backslash), so
    they are read as such rather than through the host's own `Path`, which
    would hand a Windows host `sub\\clip.mp4` for the same file.
    """
    return PurePosixPath(path).relative_to(root).as_posix()


def input_paths(spec: dict) -> set[str]:
    """All caller-owned inputs that a render must never overwrite."""
    paths = [spec.get('source')]
    for field in ('overlays', 'concat'):
        for item in spec.get(field) or []:
            if isinstance(item, dict):
                paths.append(item.get('image') or item.get('path') or item.get('source'))
    music = spec.get('music')
    if isinstance(music, dict):
        paths.append(music.get('source'))
    return {str(PurePosixPath(path.strip())) for path in paths if isinstance(path, str) and path.strip()}


def check_destination(path: str, spec: dict, field: str) -> str:
    """Validate a write target, including diagnostic writes after validation fails."""
    checked = check_store_path(path, field)
    canonical = str(PurePosixPath(checked))
    if any(
        canonical == source or canonical.startswith(source + '/') or source.startswith(canonical + '/')
        for source in input_paths(spec)
    ):
        raise SpecError(f'{field} would be written over the recording or another input file.')
    return canonical
