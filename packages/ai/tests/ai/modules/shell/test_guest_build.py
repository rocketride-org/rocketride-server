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

"""The guest build and its runtime marker (#1022 PR2b, plan section 3.4, T83).

Two layers:

* STRUCTURE (always runs, needs no node): the build inputs exist and pin the
  options the plan lists (flat output, ``guest-`` filenames, ``/_rr/`` public
  path, nothing emitted beside the chunk list). These are the tests that are
  red on the base.
* THE REAL BUILD (T83 proper): ``shell:guest-build`` then ``shell:guest-copy``
  over a temp overlay root, then every emitted file is checked against the
  marker. It needs the shell's installed dependencies (``@rsbuild/core``) and
  is SKIPPED, not faked, without them (the red-evidence worktree has no
  ``node_modules``): it can only be exercised in CI or a full workspace.
"""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[6]
SHELL = REPO / 'packages' / 'shell'
CAPS = SHELL / 'isolation' / 'capabilities.json'
TASKS = SHELL / 'scripts' / 'tasks.js'
GUEST_CONFIG = SHELL / 'rsbuild.guest.config.mts'
BOOT = SHELL / 'src' / 'guest' / 'boot.ts'

# Appendix L, written out independently of the product code.
GUEST_ASSET = re.compile(r'guest-[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.(?:js|css|woff2|woff|svg|png)')


def _text(path: Path) -> str:
    assert path.is_file(), f'{path.relative_to(REPO)} does not exist yet (PR2b)'
    return path.read_text(encoding='utf-8')


# ---------------------------------------------------------------------------
# structure
# ---------------------------------------------------------------------------


def test_guest_entry_and_config_exist():
    """T83: the entry ``src/guest/boot.ts`` and ``rsbuild.guest.config.mts`` are the build's inputs."""
    assert BOOT.is_file(), 'src/guest/boot.ts does not exist yet (PR2b)'
    assert GUEST_CONFIG.is_file(), 'packages/shell/rsbuild.guest.config.mts does not exist yet (PR2b)'
    for name in ('index.ts', 'shellModule.ts', 'mfPlugin.ts'):
        assert (SHELL / 'src' / 'guest' / name).is_file(), f'src/guest/{name} does not exist yet (PR2b)'


def test_guest_config_pins_a_flat_closed_output():
    """T83 / P11: flat directory, ``guest-`` names, ``/_rr/`` public path, and nothing emitted that is not a listed asset."""
    config = _text(GUEST_CONFIG)
    assert 'src/guest/boot.ts' in config, 'the entry'
    assert re.search(r"assetPrefix\s*:\s*['\"]/_rr/['\"]", config), "output.assetPrefix = '/_rr/'"
    assert 'guest-' in config, 'every filename template is prefixed guest-'
    for subdir in ('js', 'css', 'font', 'image', 'media'):
        assert re.search(rf"\b{subdir}\s*:\s*['\"]['\"]", config), f"distPath.{subdir} is '' (flat)"
    assert re.search(r"legalComments\s*:\s*['\"]none['\"]", config), 'no *.LICENSE.txt'
    assert re.search(r'sourceMap\s*:\s*false', config), 'no *.map'
    assert re.search(r'htmlPlugin\s*:\s*false', config), 'no generated html: frame.html is written by shell:guest-copy'
    assert re.search(r'manifest\s*:\s*false', config), 'no Module Federation manifest'
    assert re.search(r'dts\s*:\s*false', config), 'no Module Federation types'
    for shared in ('react', 'react-dom', 'react/jsx-runtime', 'rocketride', 'shell'):
        assert f"'{shared}'" in config or f'"{shared}"' in config, f'{shared} is shared by the guest host'
    assert 'src/guest/shellModule.ts' in config, "the guest's 'shell' is the guest shell module"
    assert 'rocketride_guest' in config
    assert not re.search(r'\.br\b|\.gz\b|compress', config), 'no precompression in PR2 (P10)'


def test_tasks_register_the_guest_build_and_copy_actions():
    """T83: ``shell:guest-build`` runs in ``shell:build`` after the host build; ``shell:guest-copy`` mirrors the output and writes the marker."""
    tasks = _text(TASKS)
    assert 'shell:guest-build' in tasks, 'shell:guest-build does not exist yet (PR2b)'
    assert 'shell:guest-copy' in tasks, 'shell:guest-copy does not exist yet (PR2b)'
    assert 'frame.html' in tasks and 'runtime.json' in tasks
    for field in ('capabilitiesSha256', 'chunks', 'publicPath', 'protoMin', 'protoMax'):
        assert field in tasks, f'the marker writer sets {field}'
    assert 'shell-guest' in tasks


def test_boot_is_the_only_static_entry_and_loads_the_guest_dynamically():
    """T72/T83: nothing may construct the ConnectionManager before the guest flag is set."""
    source = _text(BOOT)
    assert re.search(r"import\(\s*['\"]\./index['\"]\s*\)", source)
    assert '#clear' in source and '/_rr/clear' in source


# ---------------------------------------------------------------------------
# the real build (skipped without the workspace's node_modules)
# ---------------------------------------------------------------------------

_RUN = r"""
const paths = require(process.argv[1] + '/scripts/lib/paths');
paths.setOverlayRoot(process.argv[2]);
const shell = require(process.argv[1] + '/packages/shell/scripts/tasks.js')[0];
(async () => {
  for (const name of process.argv.slice(3)) {
    const entry = shell.actions.find((a) => a.name === name);
    if (!entry) { console.error('no action ' + name); process.exit(2); }
    const task = {};
    await entry.action().run({}, task);
  }
})().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
"""


def _can_build() -> str:
    node = shutil.which('node')
    if node is None:
        return ''
    probe = subprocess.run(
        [node, '-e', "for (const m of ['glob','listr2','adm-zip']) require.resolve(m); require.resolve('@rsbuild/core', {paths: [process.argv[1]]})", str(SHELL)],
        cwd=REPO,
        capture_output=True,
    )
    return node if probe.returncode == 0 else ''


def test_real_guest_build_matches_its_marker(tmp_path):
    """T83: run the real build, then: flat; every file is the guest or in ``chunks``; names match; marker complete; hashes equal; frame.html has no inline script; no stray outputs."""
    node = _can_build()
    if not node:
        pytest.skip('node or the shell build dependencies (@rsbuild/core) are not installed: the real build cannot run here')
    # The host bundle first (shell:copy needs build/shell), then the guest steps.
    run = subprocess.run([node, '-e', _RUN, str(REPO), str(tmp_path), 'shell:guest-build', 'shell:guest-copy'], capture_output=True, text=True, cwd=REPO)
    assert run.returncode == 0, run.stderr[-2000:]
    out = tmp_path / 'dist' / 'server' / 'static' / 'shell-guest'
    marker = json.loads((out / 'runtime.json').read_text())
    files = sorted(p.name for p in out.iterdir())
    assert all(p.is_file() for p in out.iterdir()), 'flat: no subdirectory'
    assert set(marker) >= {'runtime', 'guest', 'chunks', 'publicPath', 'protoMin', 'protoMax', 'capabilitiesSha256'}
    assert marker['runtime'] == 1 and marker['publicPath'] == '/_rr/'
    assert (marker['protoMin'], marker['protoMax']) == (1, 1)
    assert marker['chunks'] == sorted(marker['chunks']) and len(marker['chunks']) <= 512 and marker['guest'] not in marker['chunks']
    listed = {marker['guest'], *marker['chunks']}
    emitted = set(files) - {'frame.html', 'runtime.json'}
    assert emitted == listed, f'every emitted file is the guest or a listed chunk: {emitted ^ listed}'
    for name in listed:
        assert GUEST_ASSET.fullmatch(name), name
    assert not [n for n in files if n.endswith(('.LICENSE.txt', '.map')) or (n.endswith('.html') and n != 'frame.html') or 'manifest' in n]
    frame = (out / 'frame.html').read_text()
    assert f'src="/_rr/{marker["guest"]}"' in frame
    assert not re.search(r'<script(?![^>]*\bsrc=)[^>]*>', frame), 'no inline script'
    digest = hashlib.sha256(CAPS.read_bytes()).hexdigest()
    assert marker['capabilitiesSha256'] == digest
    copied = tmp_path / 'dist' / 'server' / 'static' / 'shell' / 'isolation' / 'capabilities.json'
    if copied.exists():
        assert hashlib.sha256(copied.read_bytes()).hexdigest() == digest, 'source and copied capabilities.json agree'
