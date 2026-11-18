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

"""Source-level guards of the one-decision rule (#1022 PR1, design section 1).

The isolation decision is made ONCE, in ``resolve_app_pins`` (where the binding
org is known) through ``app_origin``; every app list on the wire comes from that
function, so every entry carries the stamp without further code. These greps
fail the day a new module builds entries from the rows itself, or writes the
stamp keys on its own.

Test T39 of ``.rr-sec/PR1_PLAN.md``. A guard: it holds on the base too.
"""

from __future__ import annotations

import re
from pathlib import Path

SRC = Path(__file__).resolve().parents[4] / 'src' / 'ai'  # packages/ai/src/ai

# Modules that may call ``resolve_app_pins`` (the producer, the OSS assembly, and
# the two serving surfaces that ask for the caller's winning entry).
RESOLVE_ALLOWLIST = {
    'account/app_deploy.py',
    'account/app_rows.py',  # shared row helpers document the resolver contract
    'modules/shell/data_sources.py',  # public-page data bindings resolve app pins
    'account/oss/__init__.py',
    'modules/shell/shell.py',
    'modules/shell/app_origin.py',
}
# The only module that may write the stamp keys; everything else reads them.
STAMP_WRITERS = {'modules/shell/app_origin.py'}

_STAMP_WRITE = re.compile(
    r"""(['"](?:isolated|firstParty)['"]\s*:)"""  # a dict literal key
    r"""|(\[['"](?:isolated|firstParty)['"]\]\s*=(?!=))"""  # entry['isolated'] = ...
    r"""|(setdefault\(\s*['"](?:isolated|firstParty)['"])"""
    r"""|(\.update\(\s*(?:isolated|firstParty)\s*=)"""
)


def _sources():
    """``(relative path, code)`` for every module; comment-only lines are dropped (a comment is not a caller)."""
    for path in sorted(SRC.rglob('*.py')):
        text = path.read_text(encoding='utf-8')
        code = '\n'.join(line for line in text.splitlines() if not line.lstrip().startswith('#'))
        yield path.relative_to(SRC).as_posix(), code


def test_resolve_app_pins_grep_guard():
    """T39: only the allowlisted modules mention ``resolve_app_pins``."""
    seen = {rel for rel, text in _sources() if 'resolve_app_pins' in text}
    assert seen, 'the guard found no caller at all: the source root moved?'
    assert seen <= RESOLVE_ALLOWLIST, f'new callers of resolve_app_pins: {sorted(seen - RESOLVE_ALLOWLIST)}'
    assert 'account/app_deploy.py' in seen and 'account/oss/__init__.py' in seen


def test_only_app_origin_writes_the_stamp():
    """T39: ``isolated`` / ``firstParty`` are written by ``app_origin.stamp_isolation`` and nowhere else."""
    offenders = []
    for rel, text in _sources():
        if rel in STAMP_WRITERS:
            continue
        for number, line in enumerate(text.splitlines(), 1):
            if _STAMP_WRITE.search(line):
                offenders.append(f'{rel}:{number}: {line.strip()}')
    assert not offenders, '\n'.join(offenders)


def test_account_producers_do_not_build_entries_from_pins_themselves():
    """T39: the OSS assembly decorates what ``resolve_app_pins`` returned; it never rebuilds an entry from a row."""
    oss = (SRC / 'account' / 'oss' / '__init__.py').read_text(encoding='utf-8')
    for forbidden in ("'registryVersion':", '"registryVersion":', "'bindingOrgId'", "'orgId':"):
        assert forbidden not in oss, f'account/oss/__init__.py builds entry fields itself: {forbidden}'
