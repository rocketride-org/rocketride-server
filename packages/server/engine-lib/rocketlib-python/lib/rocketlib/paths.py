# =============================================================================
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

"""Filesystem path helpers shared by the Python output nodes.

These mirror, in Python, the long-path handling the C++ engine core already
does in ``apLib/file/FilePath.hpp`` (``FilePath::plat(longForm)`` ->
``WinPathApi`` ``\\\\?\\`` / ``\\\\?\\UNC\\`` prefixes). They exist because the
Python output nodes (``local_text_output``, ``text_output``) auto-derive output
filenames from source paths, which on Windows can push the total path past the
legacy 260-char ``MAX_PATH`` limit — or push a single segment past the 255-char
per-component limit — and abort an otherwise-successful write.

Two independent limits, two independent fixes:

* Total path length (260, legacy ``MAX_PATH``): lifted by the ``\\\\?\\``
  extended-length prefix -> :func:`extended_length_path`. Applies only to local
  Win32 file operations.
* Per-component length (255 on NTFS, and on most SMB targets): the ``\\\\?\\``
  prefix does *not* help here, so over-long components are deterministically
  hash-truncated -> :func:`shorten_path_component` /
  :func:`shorten_path_components`.

The module is intentionally dependency-free (stdlib only) so it can be imported
and unit-tested without the compiled engine.
"""

import hashlib
import os
import re

# NTFS caps a single path component at 255 UTF-16 code units; most SMB targets
# match it. This is separate from the total-path limit lifted by the \\?\ prefix.
DEFAULT_MAX_COMPONENT = 255

# Windows extended-length / device prefixes (literal 4-/8-char strings).
_EXT_PREFIX = '\\\\?\\'  # \\?\
_EXT_UNC_PREFIX = '\\\\?\\UNC\\'  # \\?\UNC\
_DEVICE_PREFIX = '\\\\.\\'  # \\.\

# Split on either separator while keeping the separators as tokens, so a path
# can be rejoined verbatim after per-component processing.
_SEP_SPLIT = re.compile(r'([\\/])')

__all__ = [
    'DEFAULT_MAX_COMPONENT',
    'extended_length_path',
    'shorten_path_component',
    'shorten_path_components',
]


def _win_extended_length(abs_win_path: str) -> str:
    """Apply the ``\\\\?\\`` prefix to an already-absolute Windows path string.

    Pure string transform (no filesystem / ``os.name`` access) so it is testable
    on any platform. Mirrors ``WinPathApi`` ``LongPlat`` / ``LongUncPlat``:

    * ``C:\\a\\b``            -> ``\\\\?\\C:\\a\\b``
    * ``\\\\server\\share\\x`` -> ``\\\\?\\UNC\\server\\share\\x``

    Paths already carrying an extended-length (``\\\\?\\``) or device (``\\\\.\\``)
    prefix are returned unchanged, which also makes the function idempotent.
    """
    if abs_win_path.startswith(_EXT_PREFIX) or abs_win_path.startswith(_DEVICE_PREFIX):
        return abs_win_path
    # UNC path (\\server\share\...) -> \\?\UNC\server\share\...
    if abs_win_path.startswith('\\\\'):
        return _EXT_UNC_PREFIX + abs_win_path[2:]
    return _EXT_PREFIX + abs_win_path


def extended_length_path(path: str) -> str:
    """Return *path* in a form usable beyond the Windows 260-char ``MAX_PATH``.

    On Windows this prefixes the absolute path with ``\\\\?\\`` (or ``\\\\?\\UNC\\``
    for UNC paths), which tells the Win32 API to skip ``MAX_PATH`` normalisation
    and accept paths up to ~32 767 chars. Extended-length paths must be fully
    qualified with backslash separators and no ``.``/``..`` segments, so the path
    is first passed through :func:`os.path.abspath`.

    On non-Windows platforms (or for an empty path) the input is returned
    unchanged, so callers can wrap every write unconditionally.

    .. note::
       Only for **local** Win32 file operations. Do not apply to SMB/UNC targets
       written via ``smbclient`` (the SMB protocol, not the Win32 API): the
       ``\\\\?\\`` prefix is not understood there.
    """
    if os.name != 'nt' or not path:
        return path
    return _win_extended_length(os.path.abspath(path))


def _utf16_len(value: str) -> int:
    """Length of *value* in UTF-16 code units — the unit NTFS/SMB actually cap at
    255. An astral character (e.g. an emoji) is one code point but two units.
    """
    return len(value.encode('utf-16-le', 'surrogatepass')) // 2


def _truncate_utf16(value: str, max_units: int) -> str:
    """Longest prefix of *value* whose UTF-16 length is <= *max_units*.

    Iterates whole code points, so an astral character is never split across its
    surrogate pair — it is kept whole or dropped.
    """
    if max_units <= 0:
        return ''
    units = 0
    for i, ch in enumerate(value):
        width = 2 if ord(ch) > 0xFFFF else 1
        if units + width > max_units:
            return value[:i]
        units += width
    return value


def shorten_path_component(name: str, max_len: int = DEFAULT_MAX_COMPONENT) -> str:
    """Shorten a single path component so it fits within *max_len* UTF-16 code units.

    Components at or under the limit are returned unchanged (the common case, so
    normal filenames are untouched). Over-long components are truncated and made
    unique with a short deterministic hash of the *original* name, preserving the
    extension where it still fits::

        <truncated-stem>_<16-hex-sha1>[.ext]

    The hash is content-derived (not random), so the same input always maps to
    the same output — keeping downstream change-detection / skip logic stable
    across runs. The function is idempotent: the result is at or under the limit,
    so re-applying it is a no-op. Raises ValueError for a negative *max_len*.
    """
    if max_len < 0:
        raise ValueError('max_len must be non-negative')
    if _utf16_len(name) <= max_len:
        return name

    stem, ext = os.path.splitext(name)
    digest = hashlib.sha1(name.encode('utf-8', 'surrogatepass')).hexdigest()[:16]

    # Budget is [stem][_][digest][ext] within max_len, all measured in UTF-16
    # code units (what NTFS/SMB cap). The digest is ASCII (1 unit each). Shrink
    # the extension first, then the digest, so the bound holds even for a max_len
    # smaller than the digest.
    if _utf16_len(ext) + len(digest) + 1 > max_len:
        ext = ''
    if len(digest) + 1 > max_len:
        # Not even '_' + digest fits: fall back to a bare (truncated) digest.
        return digest[:max_len]
    keep = max_len - len(digest) - 1 - _utf16_len(ext)
    return f'{_truncate_utf16(stem, keep)}_{digest}{ext}'


def shorten_path_components(path: str, max_len: int = DEFAULT_MAX_COMPONENT) -> str:
    """Apply :func:`shorten_path_component` to every component of *path*.

    Separators (``/`` and ``\\``) are preserved verbatim, so the path structure
    (including whether it is relative/absolute) is unchanged — only individual
    over-long name segments are rewritten.
    """
    return ''.join(
        token if token in ('', '\\', '/') else shorten_path_component(token, max_len)
        for token in _SEP_SPLIT.split(path)
    )
