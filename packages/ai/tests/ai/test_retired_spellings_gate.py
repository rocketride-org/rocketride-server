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

"""The repository gate for the retired audience spellings (plan 2.5, Step 6c EXIT).

One audience grammar (``=user/<uid>``, ``=team/<tid>``, ``=org/<oid>``,
``@public``) is composed and decoded by ``ai/account/audience.py`` alone. The
spellings it replaced name a publication's audience in a way any decoder
could misread as a team, so none may come back: this test reads every file of
the source tree and fails on any of them outside

- the one OSS read-time translator, ``ai/account/legacy_audience.py``, and
  its test file;
- the frozen contract version files (``contract/versions/``), which are
  history and are never edited;
- this file.
"""

import os
import re
import subprocess
from pathlib import Path

#: The repository root (packages/ai/tests/ai/ is four levels below it).
ROOT = Path(__file__).resolve().parents[4]

#: The retired spellings: the user, team and org prefixes and the store key.
RETIRED = re.compile(r'(?:user|team|org)~|~public')

#: The files allowed to spell them, relative to the root.
ALLOWED = {
    'packages/ai/src/ai/account/legacy_audience.py',
    'packages/ai/tests/ai/account/test_legacy_audience.py',
    'packages/ai/tests/ai/test_retired_spellings_gate.py',
}

#: Directories that are no source when git cannot list the tree.
_SKIP_DIRS = {'.git', 'node_modules', 'dist', 'build', '__pycache__', '.venv', 'venv', '.pytest_cache', 'coverage'}

#: A file larger than this is no source text.
_MAX_BYTES = 2 * 1024 * 1024


def _source_files() -> 'list[str]':
    """Every file of the source tree, relative to the root: git's tracked and unignored files, else a walk."""
    try:
        listed = subprocess.run(
            ['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
            cwd=ROOT,
            capture_output=True,
            check=True,
        ).stdout
        return [name for name in listed.decode('utf-8', 'replace').split('\0') if name]
    except (OSError, subprocess.CalledProcessError):
        files = []
        for folder, dirs, names in os.walk(ROOT):
            dirs[:] = [d for d in dirs if d not in _SKIP_DIRS]
            files.extend(os.path.relpath(os.path.join(folder, name), ROOT).replace('\\', '/') for name in names)
        return files


def _allowed(path: str) -> bool:
    """True for the files allowed to spell the retired forms."""
    return path in ALLOWED or '/contract/versions/' in f'/{path}'


def test_no_retired_audience_spelling_outside_the_translator_and_the_frozen_contracts():
    offenders = []
    for path in _source_files():
        if _allowed(path):
            continue
        full = ROOT / path
        try:
            if not full.is_file() or full.stat().st_size > _MAX_BYTES:
                continue
            data = full.read_bytes()
        except OSError:
            continue
        if b'\0' in data[:8192]:
            continue  # binary
        for number, line in enumerate(data.decode('utf-8', 'replace').splitlines(), start=1):
            if RETIRED.search(line):
                offenders.append(f'{path}:{number}: {line.strip()[:120]}')
    assert not offenders, 'Retired audience spellings (plan 2.5; compose with audience.py):\n' + '\n'.join(offenders)


def test_the_gate_sees_the_tree():
    # A gate that lists nothing passes vacuously: it must see the translator
    files = set(_source_files())
    assert 'packages/ai/src/ai/account/audience.py' in files
    assert 'packages/ai/src/ai/account/legacy_audience.py' in files
