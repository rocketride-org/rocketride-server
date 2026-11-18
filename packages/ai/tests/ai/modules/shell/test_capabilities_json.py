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

"""``capabilities.json`` and the build step that ships it (#1022 PR1, design section 8 and Appendix B).

The data file lives at ``packages/shell/isolation/capabilities.json``; the shell
build (``packages/shell/scripts/tasks.js``) copies it to
``dist/server/static/shell/isolation/capabilities.json``, where the server reads
it (startup check c, ``appManifest.capabilities`` validation) and PR2's gate
imports it. This test file pins the data and the copy step; it does not run the
build.

Test T42 of ``.rr-sec/PR1_PLAN.md``.
"""

from __future__ import annotations

import json
from pathlib import Path

REPO = Path(__file__).resolve().parents[6]  # tests/ai/modules/shell -> repository root
CAPS = REPO / 'packages' / 'shell' / 'isolation' / 'capabilities.json'
TASKS = REPO / 'packages' / 'shell' / 'scripts' / 'tasks.js'

V1_CAPABILITIES = {'core', 'pipelines.run', 'fs.app'}
FS_SUBCOMMANDS = {
    'fs_stat',
    'fs_list_dir',
    'fs_open',
    'fs_read',
    'fs_write',
    'fs_close',
    'fs_mkdir',
    'fs_delete',
    'fs_rmdir',
    'fs_rename',
    'fs_get_json',
    'fs_put_json',
}
PIPELINE_COMMANDS = {
    'execute',
    'terminate',
    'restart',
    'rrext_get_task_status',
    'rrext_get_pipeline',
    'rrext_get_token',
    'rrext_monitor',
    'rrext_process',
}
DENIED_COMMANDS = {
    'rrext_log',
    'rrext_list_tasks',
    'rrext_get_tasks',
    'rrext_dashboard',
    'rrext_list_connections',
    'rrext_services',
    'rrext_validate',
    'rrext_resolve_config',
    'rrext_app',
    'rrext_saas',
    'rrext_billing_rates',
    'auth',
    'deauth',
    'rrext_identify',
}
DENIED_PREFIXES = ('rrext_account_', 'rrext_public_', 'rrext_deploy', 'rrext_cprofile_', 'host.')


def _data():
    assert CAPS.is_file(), f'{CAPS.relative_to(REPO)} does not exist yet (#1022 PR1)'
    return json.loads(CAPS.read_text(encoding='utf-8'))


def _rows():
    return _data()['rows']


def test_capabilities_json_copied_and_parsable():
    """T42: the data file parses, is version 1 and its rows follow Appendix B; the build copies it next to the shell."""
    data = _data()
    assert data['v'] == 1
    assert isinstance(data['rows'], list) and data['rows']
    for row in data['rows']:
        assert row['cap'] in V1_CAPABILITIES, row
        assert row['op'], row
        assert isinstance(row.get('args', {}), dict), row
        if row['op'] == 'client.request':
            assert row.get('command'), row

    # the copy step: the shell build puts it at <static>/shell/isolation/capabilities.json
    source = TASKS.read_text(encoding='utf-8')
    lines = [line for line in source.splitlines() if 'isolation' in line and 'capabilities.json' in line]
    assert lines, 'packages/shell/scripts/tasks.js has no copy step for isolation/capabilities.json'
    assert 'SERVER_STATIC_DIR' in source  # the destination is the same static/shell tree the bundle goes to


def test_capabilities_json_is_stable_text():
    """T42: the server hashes the FILE (``runtime.json.capabilitiesSha256``): it must be plain UTF-8 JSON with a final newline."""
    raw = CAPS.read_bytes()
    raw.decode('utf-8')
    assert raw.endswith(b'\n')
    assert b'\r' not in raw  # CRLF would make the sha differ between checkouts


def test_capabilities_json_has_the_v1_rows():
    """T42: ``core``, ``pipelines.run`` and ``fs.app`` carry the commands of design section 8; the denied ones have no row."""
    rows = _rows()
    by_cap = {cap: [r for r in rows if r['cap'] == cap] for cap in V1_CAPABILITIES}
    assert all(by_cap.values()), {c: bool(r) for c, r in by_cap.items()}

    assert any(r['op'] == 'client.request' and r.get('command') == 'rrext_ping' for r in by_cap['core'])
    assert any(r['op'] == 'shell.frameToken.refresh' for r in by_cap['core'])

    pipeline_commands = {r.get('command') for r in by_cap['pipelines.run'] if r['op'] == 'client.request'}
    assert PIPELINE_COMMANDS <= pipeline_commands, PIPELINE_COMMANDS - pipeline_commands

    fs_rows = [r for r in by_cap['fs.app'] if r.get('command') == 'rrext_store']
    assert fs_rows
    assert {s for r in fs_rows for s in r.get('subcommands', [])} == FS_SUBCOMMANDS  # no fs_read_many, no fs_geturl


def test_capabilities_json_never_rows_a_denied_command():
    """T42: deny by default: none of the commands the design lists as denied has a row, and ``rrext_process tool`` is absent."""
    for row in _rows():
        command = row.get('command') or ''
        assert command not in DENIED_COMMANDS, row
        assert not command.startswith(DENIED_PREFIXES), row
        assert not str(row['op']).startswith('host.'), row
        if command == 'rrext_process':
            assert set(row.get('subcommands', [])) <= {'open', 'write', 'close'}, row
        if command == 'rrext_store':
            assert 'subcommands' in row, 'an rrext_store row must name its fs_* subcommands'
            assert not ({'fs_read_many', 'fs_geturl'} & set(row['subcommands'])), row


_COPY_SCRIPT = r"""
const paths = require(process.argv[1] + '/scripts/lib/paths');
paths.setOverlayRoot(process.argv[2]);
const shell = require(process.argv[1] + '/packages/shell/scripts/tasks.js')[0];
const entry = shell.actions.find((a) => a.name === 'shell:copy');
const task = {};
entry.action().run({}, task).then(() => console.log(task.output), (e) => { console.error(e); process.exit(1); });
"""


def _node_with_build_deps():
    """``node`` when the build scripts' dependencies resolve (an installed workspace), else None."""
    import shutil
    import subprocess

    node = shutil.which('node')
    if node is None:
        return None
    probe = subprocess.run(
        [node, '-e', "for (const m of ['glob', 'listr2', 'adm-zip']) require.resolve(m)"],
        cwd=REPO,
        capture_output=True,
    )
    return node if probe.returncode == 0 else None


def test_copy_step_puts_the_table_beside_the_shell_and_keeps_it(tmp_path):
    """T42 (G4 NIT): run the real ``shell:copy`` over a temp tree: the table lands in
    ``static/shell/isolation/``, byte for byte, and the bundle mirror does not delete it on the next run.
    """
    import subprocess

    import pytest

    node = _node_with_build_deps()
    if node is None:
        pytest.skip('node or the build scripts dependencies are not installed')
    build = tmp_path / 'build' / 'shell'
    (build / 'static').mkdir(parents=True)
    (build / 'index.html').write_text('<!doctype html>')
    (build / 'static' / 'main.js').write_text('js')
    dest = tmp_path / 'dist' / 'server' / 'static' / 'shell'
    (dest / 'isolation').mkdir(parents=True)
    (dest / 'isolation' / 'capabilities.json').write_text('{"stale": true}\n')
    (dest / 'old.js').write_text('stale')

    for _ in range(2):
        run = subprocess.run([node, '-e', _COPY_SCRIPT, str(REPO), str(tmp_path)], capture_output=True, text=True)
        assert run.returncode == 0, run.stderr
        assert (dest / 'isolation' / 'capabilities.json').read_bytes() == CAPS.read_bytes()
        assert (dest / 'index.html').is_file() and not (dest / 'old.js').exists()
