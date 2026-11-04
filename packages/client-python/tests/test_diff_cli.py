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
Tests for the ``rocketride diff`` CLI subcommand (rocketride.cli.commands.diff).

These exercise ``run_diff`` end-to-end against real ``.pipe`` files on disk,
driving it through the same pinned engine and reporters the CLI uses in
production. The command is fully local (no server, no auth), so no client fixture
or network mock is needed; the only external dependency stubbed here is
``resolve_git_ref`` for ``--git`` mode, patched in the command's own module
namespace the same way the engine test suite stubs subprocess. Nesting-error
cases additionally execute real CLI subprocesses against real files and
temporary Git history, without mocking the failing load/compare/render path.

Coverage mirrors the product contract:
    - two-file happy path (semantic changes -> exit 1)
    - identical files (-> exit 0, "No semantic changes.")
    - ``--git`` mode with a mocked resolver (found ref, and file-absent -> all added)
    - unreadable / unparseable / non-pipe input (-> exit 2, error on stderr)
    - argument-usage errors (wrong file count for the mode -> exit 2)
    - ``--json`` output purity (stdout is a single parseable document)
    - ``--markdown`` output
    - ``--include-layout`` toggling ui.* field lines and the exit code
    - ``--exit-zero`` forcing 0 on changes but never masking an error
    - argparse registration + dispatch: 'diff' exists, routes to ``run_diff``,
      takes no connection args, and makes ``--json``/``--markdown`` mutually
      exclusive
"""

import argparse
import importlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import unicodedata
from types import SimpleNamespace

import pytest
import rocketride_common
from pipediff_git_helpers import init_repo, isolate_git_environment, make_symlink

from rocketride.cli.commands import diff as diff_module
from rocketride.cli.commands.diff import run_diff

# `rocketride.cli.main` must be imported as a module: the `rocketride.cli`
# package re-exports the `main()` function under the same name, which would
# shadow the module on attribute-style imports.
cli_main = importlib.import_module('rocketride.cli.main')


# =========================================================================
# Helpers / fixtures
# =========================================================================


@pytest.fixture(autouse=True)
def _hermetic_git(monkeypatch):
    # Tests that build a repository, or run `--git`, must not depend on the
    # developer's git configuration, hooks or signing, nor on inherited GIT_* variables.
    isolate_git_environment(monkeypatch)


def _diff_args(
    paths=None,
    *,
    git=None,
    include_layout=False,
    json=False,  # noqa: A002 - mirrors the argparse dest name exactly
    markdown=False,
    exit_zero=False,
):
    """Build a parsed-args namespace shaped like the diff subparser's output."""
    return SimpleNamespace(
        paths=list(paths or []),
        git=git,
        include_layout=include_layout,
        json=json,
        markdown=markdown,
        exit_zero=exit_zero,
    )


def _write_pipe(tmp_path, name, obj):
    """Write ``obj`` as JSON to ``name`` under ``tmp_path`` and return the path str."""
    path = tmp_path / name
    path.write_text(json.dumps(obj), encoding='utf-8')
    return str(path)


def _old_pipe():
    """A small but complete pipeline: webhook -> chat, with layout and version."""
    return {
        'version': 1,
        'viewport': {'x': 0, 'y': 0, 'zoom': 1},
        'components': [
            {
                'id': 'a',
                'provider': 'webhook',
                'config': {'mode': 'Source'},
                'ui': {'position': {'x': 0, 'y': 0}},
            },
            {
                'id': 'b',
                'provider': 'chat',
                'config': {'default': {'strlen': 512}},
                'input': [{'lane': 'text', 'from': 'a'}],
                'ui': {'position': {'x': 10, 'y': 10}},
            },
        ],
    }


def _new_pipe():
    """``_old_pipe`` with a semantic delta: node 'c' added, edge b->c, b.strlen changed."""
    pipe = _old_pipe()
    pipe['components'][1]['config']['default']['strlen'] = 1024
    pipe['components'].append(
        {
            'id': 'c',
            'provider': 'qdrant',
            'config': {},
            'input': [{'lane': 'vec', 'from': 'b'}],
            'ui': {'position': {'x': 20, 'y': 20}},
        }
    )
    return pipe


def _layout_only_new_pipe():
    """``_old_pipe`` with *only* canvas movement: node 'a' relocated, nothing else."""
    pipe = _old_pipe()
    pipe['components'][0]['ui']['position'] = {'x': 400, 'y': 250}
    return pipe


def _viewport_only_new_pipe():
    """``_old_pipe`` with *only* a top-level viewport pan/zoom, no node touched."""
    pipe = _old_pipe()
    pipe['viewport'] = {'x': 120, 'y': 40, 'zoom': 2}
    return pipe


async def _run(args):
    """Execute the diff command body, returning its integer exit code."""
    return await run_diff(args)


# =========================================================================
# Two-file mode
# =========================================================================


@pytest.mark.asyncio
async def test_two_file_changes_exit_1(tmp_path, capsys):
    old = _write_pipe(tmp_path, 'old.pipe', _old_pipe())
    new = _write_pipe(tmp_path, 'new.pipe', _new_pipe())

    code = await _run(_diff_args([old, new]))

    out = capsys.readouterr().out
    assert code == 1
    assert 'Nodes' in out
    assert '+ c (qdrant)' in out
    assert '+ b --vec--> c' in out
    assert 'config.default.strlen' in out


@pytest.mark.asyncio
async def test_identical_files_exit_0(tmp_path, capsys):
    same = _write_pipe(tmp_path, 'same.pipe', _old_pipe())

    code = await _run(_diff_args([same, same]))

    captured = capsys.readouterr()
    assert code == 0
    assert captured.out.strip() == 'No semantic changes.'
    assert captured.err == ''


# =========================================================================
# --git mode (resolver mocked)
# =========================================================================


@pytest.mark.asyncio
async def test_git_mode_diffs_against_ref(tmp_path, capsys, monkeypatch):
    new = _write_pipe(tmp_path, 'pipeline.pipe', _new_pipe())
    # Resolver returns the *old* pipe as it existed at the ref.
    monkeypatch.setattr(diff_module, 'resolve_git_ref', lambda ref, path: _old_pipe())

    code = await _run(_diff_args([new], git='HEAD'))

    out = capsys.readouterr().out
    assert code == 1
    assert '+ c (qdrant)' in out


@pytest.mark.asyncio
async def test_git_mode_absent_file_is_all_added(tmp_path, capsys, monkeypatch):
    new = _write_pipe(tmp_path, 'pipeline.pipe', _new_pipe())
    # None => file did not exist at the ref; everything is newly added.
    monkeypatch.setattr(diff_module, 'resolve_git_ref', lambda ref, path: None)

    code = await _run(_diff_args([new], git='HEAD', json=True))

    doc = json.loads(capsys.readouterr().out)
    assert code == 1
    added_ids = {n['id'] for n in doc['nodes']['added']}
    assert added_ids == {'a', 'b', 'c'}
    assert doc['nodes']['removed'] == []


@pytest.mark.asyncio
async def test_git_mode_requires_exactly_one_file(tmp_path, capsys):
    a = _write_pipe(tmp_path, 'a.pipe', _old_pipe())
    b = _write_pipe(tmp_path, 'b.pipe', _new_pipe())

    code = await _run(_diff_args([a, b], git='HEAD'))

    captured = capsys.readouterr()
    assert code == 2
    assert captured.out == ''
    assert '--git requires exactly one FILE' in captured.err


@pytest.mark.asyncio
@pytest.mark.parametrize('ref', ['', '   '], ids=['empty', 'blank'])
async def test_git_mode_rejects_an_empty_ref(tmp_path, capsys, ref):
    # An empty --git is a usage error, not "no --git"
    a = _write_pipe(tmp_path, 'a.pipe', _old_pipe())
    b = _write_pipe(tmp_path, 'b.pipe', _new_pipe())
    for paths in ([a], [a, b]):
        code = await _run(_diff_args(paths, git=ref))
        captured = capsys.readouterr()
        assert code == 2
        assert captured.out == ''
        assert '--git requires a non-empty REF' in captured.err


def test_diff_skips_the_workspace_env_file(tmp_path, monkeypatch):
    # diff is local-only and takes no configuration, so main() must not load the
    # workspace .env for it; every other command still does.
    calls = []
    monkeypatch.setattr(cli_main, 'load_dot_env', lambda *args, **kwargs: calls.append(args))
    a = _write_pipe(tmp_path, 'a.pipe', _old_pipe())

    monkeypatch.setattr(sys, 'argv', ['rocketride', 'diff', a, a])
    with pytest.raises(SystemExit) as diff_exit:
        cli_main.main()
    assert diff_exit.value.code == 0
    assert calls == []

    monkeypatch.setattr(sys, 'argv', ['rocketride'])
    with pytest.raises(SystemExit):
        cli_main.main()
    assert calls == [()]


def test_unreadable_workspace_env_does_not_break_diff(tmp_path):
    (tmp_path / '.env').write_bytes(b'X=\xff\xfe\n')
    _write_pipe(tmp_path, 'a.pipe', _old_pipe())
    result = _cli_subprocess(tmp_path, ['a.pipe', 'a.pipe'])
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == 'No semantic changes.'
    assert result.stderr == ''


@pytest.mark.asyncio
async def test_git_resolver_error_exit_2(tmp_path, capsys, monkeypatch):
    new = _write_pipe(tmp_path, 'pipeline.pipe', _new_pipe())

    def _boom(ref, path):
        raise diff_module.PipeDiffError('git show HEAD:pipeline.pipe failed: bad ref')

    monkeypatch.setattr(diff_module, 'resolve_git_ref', _boom)

    code = await _run(_diff_args([new], git='HEAD'))

    captured = capsys.readouterr()
    assert code == 2
    assert captured.out == ''
    assert 'Error:' in captured.err
    assert 'bad ref' in captured.err


# =========================================================================
# Error / usage handling (exit 2)
# =========================================================================


@pytest.mark.asyncio
async def test_missing_file_exit_2(tmp_path, capsys):
    existing = _write_pipe(tmp_path, 'old.pipe', _old_pipe())
    missing = str(tmp_path / 'does_not_exist.pipe')

    code = await _run(_diff_args([existing, missing]))

    captured = capsys.readouterr()
    assert code == 2
    assert captured.out == ''
    assert 'Error:' in captured.err


@pytest.mark.asyncio
async def test_invalid_json_exit_2(tmp_path, capsys):
    old = _write_pipe(tmp_path, 'old.pipe', _old_pipe())
    bad = tmp_path / 'bad.pipe'
    bad.write_text('{ this is not json', encoding='utf-8')

    code = await _run(_diff_args([old, str(bad)]))

    captured = capsys.readouterr()
    assert code == 2
    assert captured.out == ''
    assert 'Error:' in captured.err


@pytest.mark.asyncio
async def test_non_pipe_object_exit_2(tmp_path, capsys):
    old = _write_pipe(tmp_path, 'old.pipe', _old_pipe())
    # Valid JSON object, but no 'components' list -> not a pipeline.
    notpipe = _write_pipe(tmp_path, 'notpipe.pipe', {'hello': 'world'})

    code = await _run(_diff_args([old, notpipe]))

    captured = capsys.readouterr()
    assert code == 2
    assert captured.out == ''
    assert 'Error:' in captured.err


@pytest.mark.asyncio
async def test_wrong_positional_count_exit_2(tmp_path, capsys):
    only = _write_pipe(tmp_path, 'only.pipe', _old_pipe())

    code = await _run(_diff_args([only]))  # one file, no --git

    captured = capsys.readouterr()
    assert code == 2
    assert captured.out == ''
    assert 'two files are required' in captured.err


@pytest.mark.asyncio
async def test_no_files_exit_2(capsys):
    code = await _run(_diff_args([]))

    captured = capsys.readouterr()
    assert code == 2
    assert captured.out == ''
    assert 'two files are required' in captured.err


# =========================================================================
# Output-format flags
# =========================================================================


@pytest.mark.asyncio
async def test_json_output_is_pure_and_parseable(tmp_path, capsys):
    old = _write_pipe(tmp_path, 'old.pipe', _old_pipe())
    new = _write_pipe(tmp_path, 'new.pipe', _new_pipe())

    code = await _run(_diff_args([old, new], json=True))

    captured = capsys.readouterr()
    assert code == 1
    # stdout must be exactly one JSON document, nothing else.
    doc = json.loads(captured.out)
    assert set(doc.keys()) == {'nodes', 'edges', 'viewport', 'summary'}
    assert doc['summary']['has_semantic_changes'] is True
    # Without --include-layout the viewport is never enumerated.
    assert doc['viewport'] == []
    assert doc['summary']['viewport_changes'] == 0
    assert captured.err == ''


@pytest.mark.asyncio
async def test_markdown_output(tmp_path, capsys):
    old = _write_pipe(tmp_path, 'old.pipe', _old_pipe())
    new = _write_pipe(tmp_path, 'new.pipe', _new_pipe())

    code = await _run(_diff_args([old, new], markdown=True))

    out = capsys.readouterr().out
    assert code == 1
    assert '**Pipeline diff:**' in out
    assert '**Nodes**' in out
    assert '| Node | Field | Change |' in out


# =========================================================================
# --include-layout
# =========================================================================


@pytest.mark.asyncio
async def test_layout_only_hidden_by_default_exit_0(tmp_path, capsys):
    old = _write_pipe(tmp_path, 'old.pipe', _old_pipe())
    new = _write_pipe(tmp_path, 'new.pipe', _layout_only_new_pipe())

    code = await _run(_diff_args([old, new]))

    out = capsys.readouterr().out
    # Pure canvas movement is non-semantic: exit 0, coarse layout hint, no ui.* lines.
    assert code == 0
    assert 'Layout' in out
    assert 'ui.position' not in out


@pytest.mark.asyncio
async def test_include_layout_surfaces_ui_fields_exit_1(tmp_path, capsys):
    old = _write_pipe(tmp_path, 'old.pipe', _old_pipe())
    new = _write_pipe(tmp_path, 'new.pipe', _layout_only_new_pipe())

    code = await _run(_diff_args([old, new], include_layout=True))

    out = capsys.readouterr().out
    # Opting layout in enumerates ui.* field changes and makes them count.
    assert code == 1
    assert 'ui.position' in out


@pytest.mark.asyncio
async def test_viewport_only_hidden_by_default_exit_0(tmp_path, capsys):
    old = _write_pipe(tmp_path, 'old.pipe', _old_pipe())
    new = _write_pipe(tmp_path, 'new.pipe', _viewport_only_new_pipe())

    code = await _run(_diff_args([old, new]))

    out = capsys.readouterr().out
    assert code == 0
    assert 'Layout' in out
    assert 'viewport.' not in out


@pytest.mark.asyncio
async def test_include_layout_surfaces_viewport_fields_exit_1(tmp_path, capsys):
    # --include-layout enumerates the top-level viewport
    old = _write_pipe(tmp_path, 'old.pipe', _old_pipe())
    new = _write_pipe(tmp_path, 'new.pipe', _viewport_only_new_pipe())

    code = await _run(_diff_args([old, new], include_layout=True, json=True))

    doc = json.loads(capsys.readouterr().out)
    assert code == 1
    paths = [fc['path'] for fc in doc['viewport']]
    assert paths == ['viewport.x', 'viewport.y', 'viewport.zoom']
    assert doc['summary']['viewport_changes'] == 3
    assert doc['summary']['has_semantic_changes'] is True


# =========================================================================
# --exit-zero
# =========================================================================


@pytest.mark.asyncio
async def test_exit_zero_forces_success_on_changes(tmp_path, capsys):
    old = _write_pipe(tmp_path, 'old.pipe', _old_pipe())
    new = _write_pipe(tmp_path, 'new.pipe', _new_pipe())

    code = await _run(_diff_args([old, new], exit_zero=True))

    out = capsys.readouterr().out
    # Changes are still reported, but the exit code is forced to 0 for non-gating use.
    assert code == 0
    assert '+ c (qdrant)' in out


@pytest.mark.asyncio
async def test_exit_zero_does_not_mask_errors(tmp_path, capsys):
    old = _write_pipe(tmp_path, 'old.pipe', _old_pipe())
    missing = str(tmp_path / 'nope.pipe')

    code = await _run(_diff_args([old, missing], exit_zero=True))

    captured = capsys.readouterr()
    # --exit-zero only forces 0 on a *successful* run; a load error is still exit 2.
    assert code == 2
    assert captured.out == ''
    assert 'Error:' in captured.err


def _nested_pipe_json(depth, leaf=0):
    """Construct real nested JSON without depending on the encoder's limit."""
    return '{"components":[{"id":"n","provider":"p","config":{"deep":' + '[' * depth + str(leaf) + ']' * depth + '}}]}'


def _cli_subprocess(tmp_path, arguments, *, limit=1000, prelude='', output_encoding='utf-8'):
    """
    Run the actual CLI entry point using the package selected by this suite.

    ``limit`` is the child's recursion limit, set before ``main()`` runs, and
    ``prelude`` is Python source run just before it (a stream reconfiguration,
    say). Both are fixed by the test, so what the child can do is deterministic.
    ``output_encoding`` is how the child's stdout/stderr bytes are decoded here.
    """
    env = {key: value for key, value in os.environ.items() if not key.startswith('ROCKETRIDE_')}
    # pytest's in-process sys.path is not inherited by subprocesses. Pin the
    # child's import roots to the packages this suite actually imported,
    # including wheel runs: rocketride itself, and rocketride_common, which
    # conftest.py puts on sys.path in-process when it is not installed (CI).
    # They go onto sys.path inside the child, not only into PYTHONPATH: in CI
    # sys.executable is the engine, an isolated interpreter that ignores
    # PYTHONPATH (PyConfig_InitIsolatedConfig).
    roots = list(
        dict.fromkeys(
            str(root)
            for root in (
                Path(diff_module.__file__).resolve().parents[3],
                Path(rocketride_common.__file__).resolve().parents[1],
            )
        )
    )
    env['PYTHONPATH'] = os.pathsep.join(roots)
    return subprocess.run(
        [
            sys.executable,
            '-c',
            f'import sys; sys.path[:0] = {roots!r}; from rocketride.cli.main import main; '
            f'sys.setrecursionlimit({limit}); {prelude}main()',
            'diff',
            *arguments,
        ],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
        encoding=output_encoding,
        timeout=20,
    )


# What a clean refusal of an over-deep input says. The wording depends on which
# stage first runs out of frames, and that depends on the interpreter: the CLI's
# own "nesting is too deep", the comparison's "too deep to compare", or, where the
# JSON parser itself is bounded by the limit, its "maximum recursion depth exceeded".
_REFUSAL_MARKERS = ('nest', 'recursion depth')


def _assert_nested_cli_result(result, *, exit_zero, path, kind, old_leaf, new_leaf, depth=0, require_error=False):
    """Require a clean resource error or an accurate, strictly valid JSON report."""
    assert 'Traceback' not in result.stderr
    if result.returncode == 2:
        assert result.stdout == ''
        assert 'Error:' in result.stderr
        assert any(marker in result.stderr.lower() for marker in _REFUSAL_MARKERS), result.stderr
        return
    assert not require_error
    assert result.returncode == (0 if exit_zero else 1)
    assert result.stderr == ''

    def reject_constant(token):
        raise ValueError(f'Non-JSON constant {token}')

    # The child has a controlled recursion budget. The parent may have deeper
    # pytest frames and must still be able to inspect a valid supported result.
    previous_limit = sys.getrecursionlimit()
    try:
        sys.setrecursionlimit(max(previous_limit, 10000))
        doc = json.loads(result.stdout, parse_constant=reject_constant)
    finally:
        sys.setrecursionlimit(previous_limit)
    assert doc['summary']['has_semantic_changes'] is True
    assert doc['summary']['config_changes'] == 1
    assert doc['summary']['nodes_changed'] == 1
    assert doc['nodes']['added'] == []
    assert doc['nodes']['removed'] == []
    assert doc['edges'] == {'added': [], 'removed': []}
    assert len(doc['nodes']['changed']) == 1
    node = doc['nodes']['changed'][0]
    assert node['id'] == 'n'
    assert node['provider_change'] is None
    assert len(node['config_changes']) == 1
    field = node['config_changes'][0]
    assert field['path'] == path
    assert field['kind'] == kind
    for key, expected in [('old', old_leaf), ('new', new_leaf)]:
        value = field[key]
        if expected is not None:
            for _ in range(depth):
                assert isinstance(value, list) and len(value) == 1
                value = value[0]
        assert type(value) is type(expected)
        assert value == expected


# -------------------------------------------------------------------------
# The RecursionError boundary in run_diff, proven deterministically
# -------------------------------------------------------------------------
#
# Whether a real deep input reaches that boundary depends on the interpreter
# (see below), so these tests inject the failure at each stage run_diff guards
# and require the stage to have run. They cannot pass without the handler.


def _raise_recursion_error(calls):
    def overflow(*_args, **_kwargs):
        calls.append('called')
        raise RecursionError('maximum recursion depth exceeded')

    return overflow


@pytest.mark.asyncio
@pytest.mark.parametrize('exit_zero', [False, True], ids=['normal', 'exit-zero'])
@pytest.mark.parametrize(
    ('stage', 'flags'),
    [
        pytest.param('load_pipe', {}, id='load'),
        pytest.param('resolve_git_ref', {'git': 'HEAD'}, id='git-ref'),
        pytest.param('diff_pipes', {}, id='compare'),
        pytest.param('render_json', {'json': True}, id='render-json'),
        pytest.param('render_markdown', {'markdown': True}, id='render-markdown'),
        pytest.param('render_human', {}, id='render-human'),
    ],
)
async def test_recursion_error_at_each_stage_is_a_clean_exit_2(tmp_path, capsys, monkeypatch, stage, flags, exit_zero):
    path = _write_pipe(tmp_path, 'a.pipe', _old_pipe())
    calls = []
    monkeypatch.setattr(diff_module, stage, _raise_recursion_error(calls))

    code = await _run(_diff_args([path] if 'git' in flags else [path, path], exit_zero=exit_zero, **flags))

    captured = capsys.readouterr()
    assert calls == ['called'], f'{stage} did not run, so the RecursionError boundary was not exercised'
    assert code == 2  # --exit-zero never turns an error into success
    assert captured.out == ''  # nothing is printed before the whole report exists
    assert captured.err.startswith('Error: Pipeline nesting is too deep')
    assert captured.err.count('\n') == 1


@pytest.mark.parametrize('exit_zero', [False, True], ids=['normal', 'exit-zero'])
def test_recursion_error_reaches_the_exit_code_through_the_real_entry_point(tmp_path, exit_zero):
    # Same boundary, through main() and a real process: the exit status, the
    # untouched stdout and the single stderr line are what a CI step sees
    (tmp_path / 'a.pipe').write_text(json.dumps(_old_pipe()), encoding='utf-8')
    prelude = (
        'import rocketride.cli.commands.diff as d; '
        "d.diff_pipes = lambda *a, **k: (_ for _ in ()).throw(RecursionError('maximum recursion depth exceeded')); "
    )

    result = _cli_subprocess(tmp_path, ['a.pipe', 'a.pipe', *(['--exit-zero'] if exit_zero else [])], prelude=prelude)

    assert result.returncode == 2
    assert result.stdout == ''
    assert result.stderr.startswith('Error: Pipeline nesting is too deep')
    assert 'Traceback' not in result.stderr


# -------------------------------------------------------------------------
# Real deep inputs through a real process
# -------------------------------------------------------------------------


@pytest.mark.parametrize('depth', [981, 2000])
@pytest.mark.parametrize('side', ['old', 'new'])
@pytest.mark.parametrize('exit_zero', [False, True])
def test_deep_one_sided_nesting_never_tracebacks_or_misreports(tmp_path, depth, side, exit_zero):
    # Under the child's 1000-frame budget which stage runs out first, if any, depends on
    # the interpreter, so depth 981 may be refused or reported: both are allowed, a
    # traceback and a wrong report are not. This asserts that contract, NOT that the
    # error branch ran (the injection tests above prove that). Depth 2000 is beyond
    # the budget on every supported interpreter, so it must be refused.
    ordinary = tmp_path / 'ordinary.pipe'
    ordinary.write_text('{"components":[{"id":"n","provider":"p","config":{}}]}', encoding='utf-8')
    nested = tmp_path / 'nested.pipe'
    nested.write_text(_nested_pipe_json(depth), encoding='utf-8')
    paths = [str(nested), str(ordinary)] if side == 'old' else [str(ordinary), str(nested)]
    result = _cli_subprocess(tmp_path, [*paths, '--json', *(['--exit-zero'] if exit_zero else [])])

    _assert_nested_cli_result(
        result,
        exit_zero=exit_zero,
        path='config.deep',
        kind='removed' if side == 'old' else 'added',
        old_leaf=0 if side == 'old' else None,
        new_leaf=0 if side == 'new' else None,
        depth=depth,
        require_error=depth == 2000,
    )


# A small, fixed budget makes the comparison case decisive: a pair 600 levels deep
# needs ~1200 frames to compare and 20 levels needs ~40, so 300 refuses the first
# and accepts the second on every interpreter. This relies on the comparison
# recursing; if it becomes iterative, move the deep case to the stage that still recurses.
_SMALL_BUDGET = 300


@pytest.mark.parametrize('exit_zero', [False, True])
def test_comparison_beyond_the_recursion_budget_is_refused(tmp_path, exit_zero):
    old = tmp_path / 'old.pipe'
    new = tmp_path / 'new.pipe'
    old.write_text(_nested_pipe_json(600, 0), encoding='utf-8')
    new.write_text(_nested_pipe_json(600, 1), encoding='utf-8')

    result = _cli_subprocess(
        tmp_path, [str(old), str(new), '--json', *(['--exit-zero'] if exit_zero else [])], limit=_SMALL_BUDGET
    )

    assert result.returncode == 2, result.stdout[:200]
    assert result.stdout == ''
    assert 'Traceback' not in result.stderr
    assert 'Error:' in result.stderr
    assert any(marker in result.stderr.lower() for marker in _REFUSAL_MARKERS), result.stderr


@pytest.mark.parametrize('exit_zero', [False, True])
def test_comparison_within_the_recursion_budget_is_reported_accurately(tmp_path, exit_zero):
    old = tmp_path / 'old.pipe'
    new = tmp_path / 'new.pipe'
    old.write_text(_nested_pipe_json(20, 0), encoding='utf-8')
    new.write_text(_nested_pipe_json(20, 1), encoding='utf-8')

    result = _cli_subprocess(
        tmp_path, [str(old), str(new), '--json', *(['--exit-zero'] if exit_zero else [])], limit=_SMALL_BUDGET
    )

    _assert_nested_cli_result(
        result,
        exit_zero=exit_zero,
        path='config.deep' + '[0]' * 20,
        kind='changed',
        old_leaf=0,
        new_leaf=1,
        require_error=False,
    )
    assert result.returncode == (0 if exit_zero else 1)  # it did NOT take the refusal branch


@pytest.mark.skipif(shutil.which('git') is None, reason='git is unavailable')
@pytest.mark.parametrize('exit_zero', [False, True])
def test_deep_historical_nesting_never_tracebacks_or_misreports(tmp_path, exit_zero):
    # Like the one-sided cases above, for the old side read from git history
    path = tmp_path / 'pipeline.pipe'
    path.write_text(_nested_pipe_json(981), encoding='utf-8')
    init_repo(tmp_path, 'pipeline.pipe', message='nested fixture')
    path.write_text('{"components":[{"id":"n","provider":"p","config":{}}]}', encoding='utf-8')

    result = _cli_subprocess(tmp_path, ['--git', 'HEAD', str(path), '--json', *(['--exit-zero'] if exit_zero else [])])

    _assert_nested_cli_result(
        result,
        exit_zero=exit_zero,
        path='config.deep',
        kind='removed',
        old_leaf=0,
        new_leaf=None,
        depth=981,
    )


@pytest.mark.asyncio
async def test_internal_value_error_is_not_reported_as_bad_input(tmp_path, monkeypatch):
    # A ValueError from the comparison is a bug, not a usage error: it must keep
    # its traceback instead of becoming a one-line exit-2 "Error:".
    a = _write_pipe(tmp_path, 'a.pipe', _old_pipe())

    def _broken(*_args, **_kwargs):
        raise ValueError('internal bug')

    monkeypatch.setattr(diff_module, 'diff_pipes', _broken)
    with pytest.raises(ValueError, match='internal bug'):
        await _run(_diff_args([a, a]))


@pytest.mark.asyncio
async def test_reporter_value_error_is_not_reported_as_bad_input(tmp_path, monkeypatch):
    # Only json.dumps's non-finite-number failure is converted to exit 2; a
    # ValueError from the reporter itself is a bug and keeps its traceback.
    a = _write_pipe(tmp_path, 'a.pipe', _old_pipe())

    def _broken(_diff):
        raise ValueError('reporter bug')

    monkeypatch.setattr(diff_module, 'render_json', _broken)
    with pytest.raises(ValueError, match='reporter bug'):
        await _run(_diff_args([a, a], json=True))


@pytest.mark.asyncio
async def test_json_renderer_rejects_nonfinite_output(tmp_path, capsys, monkeypatch):
    # Defense in depth: even an unexpected reporter value must never produce an
    # Infinity token or leak json.dumps' ValueError as an exit-1 traceback.
    path = _write_pipe(tmp_path, 'ordinary.pipe', _old_pipe())
    monkeypatch.setattr(diff_module, 'render_json', lambda diff: {'unexpected': float('inf')})

    code = await _run(_diff_args([path, path], json=True, exit_zero=True))

    captured = capsys.readouterr()
    assert code == 2
    assert captured.out == ''
    assert 'Error:' in captured.err
    assert 'JSON compliant' in captured.err


# =========================================================================
# --json carries every character exactly
# =========================================================================


def _text_pipe(tmp_path, name, value_literal):
    """Write a .pipe whose config value is the JSON string literal ``value_literal`` (escapes kept as text)."""
    path = tmp_path / name
    path.write_text(
        '{"components":[{"id":"n","provider":"p","config":{"v":' + value_literal + '}}]}',
        encoding='utf-8',
    )
    return str(path)


def test_json_keeps_values_that_differ_only_in_lone_surrogates(tmp_path):
    # Both are valid JSON escapes in a .pipe. Printed raw they both became "?" on
    # stdout (errors='replace'), so the report said "?" -> "?" for a real change.
    old = _text_pipe(tmp_path, 'old.pipe', r'"\ud800"')
    new = _text_pipe(tmp_path, 'new.pipe', r'"\udc00"')

    result = _cli_subprocess(tmp_path, [old, new, '--json'])

    assert result.returncode == 1, result.stderr
    assert result.stderr == ''
    doc = json.loads(result.stdout)
    assert doc['summary']['has_semantic_changes'] is True
    (change,) = doc['nodes']['changed'][0]['config_changes']
    assert (change['old'], change['new']) == ('\ud800', '\udc00')


def test_json_keeps_letters_an_ascii_console_cannot_print(tmp_path):
    old = _text_pipe(tmp_path, 'old.pipe', '"caf\u00e9"')
    new = _text_pipe(tmp_path, 'new.pipe', '"caf\u00e8"')

    result = _cli_subprocess(tmp_path, [old, new, '--json'], prelude="sys.stdout.reconfigure(encoding='ascii'); ")

    assert result.returncode == 1, result.stderr
    (change,) = json.loads(result.stdout)['nodes']['changed'][0]['config_changes']
    assert (change['old'], change['new']) == ('caf\u00e9', 'caf\u00e8')


def test_json_stays_unescaped_when_the_console_can_print_it(tmp_path):
    old = _text_pipe(tmp_path, 'old.pipe', '"caf\u00e9"')
    new = _text_pipe(tmp_path, 'new.pipe', '"caf\u00e8"')

    result = _cli_subprocess(tmp_path, [old, new, '--json'], prelude="sys.stdout.reconfigure(encoding='utf-8'); ")

    assert 'caf\u00e9' in result.stdout  # the real letter, not the six-character escape


@pytest.mark.parametrize('encoding', ['cp1252', 'ascii'])
@pytest.mark.parametrize('flag', [None, '--markdown'], ids=['human', 'markdown'])
def test_text_reports_never_print_a_change_as_question_marks(tmp_path, encoding, flag):
    # On a console that cannot encode CJK, errors='replace' printed "?? -> ??" for a
    # real change, indistinguishable from no change. The escapes must differ.
    old = _text_pipe(tmp_path, 'old.pipe', '"\\u65e5\\u672c"')  # 日本
    new = _text_pipe(tmp_path, 'new.pipe', '"\\u4e2d\\u56fd"')  # 中国

    result = _cli_subprocess(
        tmp_path, [old, new, *([flag] if flag else [])], prelude=f"sys.stdout.reconfigure(encoding='{encoding}'); "
    )

    assert result.returncode == 1, result.stderr
    assert result.stderr == ''
    assert '\\u65e5\\u672c' in result.stdout
    assert '\\u4e2d\\u56fd' in result.stdout
    assert '??' not in result.stdout


@pytest.mark.parametrize('flag', [None, '--markdown'], ids=['human', 'markdown'])
def test_text_reports_keep_characters_the_console_can_print(tmp_path, flag):
    # cp1252 carries these, so they are printed as themselves; only what it cannot carry is escaped
    old = _text_pipe(tmp_path, 'old.pipe', '"caf\\u00e9 \\u65e5"')
    new = _text_pipe(tmp_path, 'new.pipe', '"caf\\u00e8 \\u65e5"')

    result = _cli_subprocess(
        tmp_path,
        [old, new, *([flag] if flag else [])],
        prelude="sys.stdout.reconfigure(encoding='cp1252'); ",
        output_encoding='cp1252',
    )

    assert result.returncode == 1, result.stderr
    assert 'caf\u00e9' in result.stdout
    assert 'caf\u00e8' in result.stdout
    assert '\\u65e5' in result.stdout


# =========================================================================
# --git against real history (hermetic repositories)
# =========================================================================


@pytest.mark.skipif(shutil.which('git') is None, reason='git is unavailable')
@pytest.mark.asyncio
async def test_retargeted_symlink_swap_is_reported_end_to_end(tmp_path, capsys):
    # `current.pipe -> v1.pipe` repointed to v2.pipe is a real pipeline swap
    _write_pipe(tmp_path, 'v1.pipe', _old_pipe())
    _write_pipe(tmp_path, 'v2.pipe', _new_pipe())
    make_symlink(tmp_path / 'current.pipe', 'v1.pipe')
    init_repo(tmp_path, 'v1.pipe', 'v2.pipe', 'current.pipe')
    link = str(tmp_path / 'current.pipe')

    # untouched: the link itself is not a difference
    assert await _run(_diff_args([link], git='HEAD')) == 0
    assert capsys.readouterr().out.strip() == 'No semantic changes.'

    (tmp_path / 'current.pipe').unlink()
    make_symlink(tmp_path / 'current.pipe', 'v2.pipe')
    code = await _run(_diff_args([link], git='HEAD', json=True))

    doc = json.loads(capsys.readouterr().out)
    assert code == 1
    assert {node['id'] for node in doc['nodes']['added']} == {'c'}
    assert doc['summary']['has_semantic_changes'] is True


@pytest.mark.skipif(shutil.which('git') is None, reason='git is unavailable')
@pytest.mark.asyncio
async def test_retargeted_directory_symlink_is_reported_end_to_end(tmp_path, capsys):
    # The same swap one level up: `flows -> flows_v1` repointed to flows_v2
    for name, pipe in (('flows_v1', _old_pipe()), ('flows_v2', _new_pipe())):
        (tmp_path / name).mkdir()
        _write_pipe(tmp_path / name, 'rag.pipe', pipe)
    make_symlink(tmp_path / 'flows', 'flows_v1', directory=True)
    init_repo(tmp_path, 'flows_v1', 'flows_v2', 'flows')
    (tmp_path / 'flows').unlink()
    make_symlink(tmp_path / 'flows', 'flows_v2', directory=True)

    code = await _run(_diff_args([str(tmp_path / 'flows' / 'rag.pipe')], git='HEAD', json=True))

    doc = json.loads(capsys.readouterr().out)
    assert code == 1
    assert {node['id'] for node in doc['nodes']['added']} == {'c'}


@pytest.mark.skipif(shutil.which('git') is None, reason='git is unavailable')
def test_git_diff_never_reads_the_workspace_env(tmp_path):
    # diff reads no configuration, so the workspace .env is not loaded at all: a
    # damaged one, which every connected command warns about, leaves diff silent
    _write_pipe(tmp_path, 'pipeline.pipe', _old_pipe())
    init_repo(tmp_path, 'pipeline.pipe')
    _write_pipe(tmp_path, 'pipeline.pipe', _new_pipe())
    (tmp_path / '.env').write_bytes(b'ROCKETRIDE_URI=http://example.invalid\nBROKEN=\xff\n')

    result = _cli_subprocess(tmp_path, ['--git', 'HEAD', 'pipeline.pipe', '--json'])

    assert result.returncode == 1, result.stderr
    assert result.stderr == ''
    assert {node['id'] for node in json.loads(result.stdout)['nodes']['added']} == {'c'}


# =========================================================================
# Colour: the shell's NO_COLOR applies, a workspace-only NO_COLOR does not
# =========================================================================


class _Terminal(io.StringIO):
    """A stdout that claims to be a terminal, so colour is on unless NO_COLOR says otherwise."""

    def isatty(self):
        return True


def _diff_on_a_terminal(tmp_path, monkeypatch, *, shell_no_color, env_file_no_color):
    """Run `rocketride diff` through main() on a fake terminal and return its stdout."""
    old = _write_pipe(tmp_path, 'old.pipe', _old_pipe())
    new = _write_pipe(tmp_path, 'new.pipe', _new_pipe())
    if env_file_no_color:
        (tmp_path / '.env').write_text('NO_COLOR=1\n', encoding='utf-8')
    monkeypatch.chdir(tmp_path)
    # Register the original (absent) state first, so a leak out of main() is undone
    monkeypatch.setenv('NO_COLOR', '1')
    if shell_no_color:
        monkeypatch.setenv('NO_COLOR', '1')
    else:
        monkeypatch.delenv('NO_COLOR')
    terminal = _Terminal()
    monkeypatch.setattr(sys, 'stdout', terminal)
    monkeypatch.setattr(sys, 'argv', ['rocketride', 'diff', old, new])
    with pytest.raises(SystemExit) as exit_info:
        cli_main.main()
    assert exit_info.value.code == 1
    return terminal.getvalue()


def test_diff_colours_a_terminal_when_nothing_says_otherwise(tmp_path, monkeypatch):
    # The control for the two tests below: colour really is on in this harness
    assert '\x1b[' in _diff_on_a_terminal(tmp_path, monkeypatch, shell_no_color=False, env_file_no_color=False)


def test_shell_no_color_turns_diff_colour_off(tmp_path, monkeypatch):
    assert '\x1b[' not in _diff_on_a_terminal(tmp_path, monkeypatch, shell_no_color=True, env_file_no_color=False)


def test_workspace_only_no_color_is_ignored_by_diff_by_design(tmp_path, monkeypatch):
    # diff reads no workspace .env at all (see test_diff_skips_the_workspace_env_file),
    # so a NO_COLOR that exists only there does not apply; the shell's does
    output = _diff_on_a_terminal(tmp_path, monkeypatch, shell_no_color=False, env_file_no_color=True)
    assert '\x1b[' in output
    assert 'NO_COLOR' not in os.environ


# =========================================================================
# argparse registration (parser-level, no execution)
# =========================================================================


def test_parser_registers_diff_subcommand():
    parser = cli_main.setup_parser()
    ns = parser.parse_args(['diff', 'old.pipe', 'new.pipe'])
    assert ns.command == 'diff'
    assert ns.paths == ['old.pipe', 'new.pipe']
    assert ns.git is None
    assert ns.include_layout is False
    assert ns.json is False
    assert ns.markdown is False
    assert ns.exit_zero is False


def test_parser_diff_takes_no_connection_args():
    parser = cli_main.setup_parser()
    ns = parser.parse_args(['diff', 'old.pipe', 'new.pipe'])
    # This command never touches the engine, so the shared connection args that
    # every other subcommand carries must be absent from its namespace.
    assert not hasattr(ns, 'apikey')
    assert not hasattr(ns, 'uri')
    assert not hasattr(ns, 'token')


def test_parser_json_and_markdown_are_mutually_exclusive():
    parser = cli_main.setup_parser()
    with pytest.raises(SystemExit):
        parser.parse_args(['diff', '--json', '--markdown', 'old.pipe', 'new.pipe'])


def test_diff_is_registered_exactly_once_alongside_validate():
    # The command table must carry both the upstream 'validate' verb and this
    # PR's 'diff' verb, each registered exactly once.
    parser = cli_main.setup_parser()
    subparsers = next(a for a in parser._actions if isinstance(a, argparse._SubParsersAction))
    names = [choice.dest for choice in subparsers._choices_actions]
    assert names.count('diff') == 1
    assert names.count('validate') == 1


@pytest.mark.asyncio
async def test_dispatch_routes_diff_to_run_diff(tmp_path, capsys):
    # End-to-end through the real parser and dispatcher, not just the body.
    old = _write_pipe(tmp_path, 'old.pipe', _old_pipe())
    new = _write_pipe(tmp_path, 'new.pipe', _new_pipe())

    parser = cli_main.setup_parser()
    ns = parser.parse_args(['diff', old, new])
    code = await cli_main._dispatch(ns)

    out = capsys.readouterr().out
    assert code == 1
    assert '+ c (qdrant)' in out


# =========================================================================
# Error lines cannot carry the inputs' control characters
# =========================================================================
#
# An error message quotes what it was given: a component id, a path, a ref, a name git
# echoes back. The pipe-diff Action pastes this stream into a pull-request comment, so a
# crafted .pipe must not be able to print a forged `Error:` line (a line break), recolour
# or hide text (ESC), or reorder it (bidi), whichever kind of error it provokes.
#
# The characters are built with chr(), so none of them is in this file.

_ESC = chr(0x1B)
_LF = chr(10)
_RLO = chr(0x202E)  # right-to-left override
_LS = chr(0x2028)  # line separator
_BS = chr(92)

# What an id holding all four prints as: each character spelled as a visible escape
_CRAFTED = 'x' + _RLO + 'y' + _ESC + '[31mFAKE' + _LF + 'Error: forged' + _LS + 'z'
_ESCAPED = 'x' + _BS + 'u202ey' + _BS + 'x1b[31mFAKE' + _BS + 'x0aError: forged' + _BS + 'u2028z'
_UNSAFE_CATEGORIES = ('Cc', 'Cf', 'Zl', 'Zp')


def _assert_one_safe_line(stderr):
    """The stream is exactly one line, and none of its characters is a control, format or separator one."""
    assert stderr.startswith('Error: ')
    assert stderr.endswith('\n')
    body = stderr[:-1]
    assert [char for char in body if unicodedata.category(char) in _UNSAFE_CATEGORIES and char != '\t'] == []


def _crafted_pipe(tmp_path, name, components):
    path = tmp_path / name
    path.write_text(json.dumps({'components': components}), encoding='utf-8')
    return str(path)


@pytest.mark.asyncio
@pytest.mark.parametrize('exit_zero', [False, True], ids=['normal', 'exit-zero'])
@pytest.mark.parametrize(
    'components',
    [
        pytest.param(
            [{'id': _CRAFTED, 'provider': 'p'}, {'id': _CRAFTED, 'provider': 'p'}],
            id='duplicate-id',
        ),
        pytest.param([{'id': _CRAFTED, 'provider': 'p', 'input': 'not a list'}], id='field-not-a-list'),
    ],
)
async def test_error_naming_a_crafted_id_prints_it_as_escapes(tmp_path, capsys, components, exit_zero):
    path = _crafted_pipe(tmp_path, 'crafted.pipe', components)

    code = await _run(_diff_args([path, path], exit_zero=exit_zero))

    captured = capsys.readouterr()
    assert code == 2
    assert captured.out == ''
    _assert_one_safe_line(captured.err)
    assert _ESCAPED in captured.err  # the id is there, readable, and harmless


# What a name or a ref can hold depends on the process and the platform. ASCII controls (ESC, LF) are
# spellable by any process on a POSIX filesystem and by none on Windows; the bidi override and the line
# separator by any process but one whose filesystem encoding is ASCII (the engine's interpreter on Linux).
# Each test says which it needs and skips only when the platform cannot hold it.
_HOSTILE = {
    'controls': (_ESC + '[31m' + _LF + 'Error: forged', _BS + 'x1b[31m' + _BS + 'x0aError: forged'),
    'bidi': (_RLO + 'y' + _LS + 'z', _BS + 'u202ey' + _BS + 'u2028z'),
}
_KINDS = pytest.mark.parametrize('kind', ['controls', 'bidi'])


def _hostile(kind):
    """Return ``(text, how it must print)`` for the kind, or skip if this process cannot spell it as a name."""
    raw, escaped = _HOSTILE[kind]
    try:
        os.fsencode(raw)
    except UnicodeEncodeError:
        pytest.skip(f'this process (filesystem encoding {sys.getfilesystemencoding()}) cannot spell that name')
    return raw, escaped


def _write_named(path, text):
    try:
        path.write_text(text, encoding='utf-8')
    except OSError as exc:
        pytest.skip(f'this filesystem cannot hold that file name: {exc}')


@_KINDS
@pytest.mark.asyncio
async def test_error_naming_a_crafted_missing_path_prints_it_as_escapes(tmp_path, capsys, kind):
    raw, escaped = _hostile(kind)
    missing = str(tmp_path / ('no-such' + raw + '.pipe'))

    code = await _run(_diff_args([missing, missing]))

    captured = capsys.readouterr()
    assert code == 2
    _assert_one_safe_line(captured.err)
    assert 'Pipe file not found' in captured.err or 'Could not read pipe file' in captured.err
    assert 'no-such' + escaped + '.pipe' in captured.err


@_KINDS
@pytest.mark.asyncio
async def test_error_naming_a_crafted_file_name_prints_it_as_escapes(tmp_path, capsys, kind):
    raw, escaped = _hostile(kind)
    path = tmp_path / ('bad' + raw + '.pipe')
    _write_named(path, 'not json')

    code = await _run(_diff_args([str(path), str(path)]))

    captured = capsys.readouterr()
    assert code == 2
    _assert_one_safe_line(captured.err)
    assert 'Invalid JSON in' in captured.err
    assert 'bad' + escaped + '.pipe' in captured.err


@_KINDS
@pytest.mark.asyncio
async def test_git_error_naming_a_crafted_path_prints_it_as_escapes(tmp_path, capsys, monkeypatch, kind):
    # Not in a repository: the message says which path it looked at. (git must not look above the test directory.)
    raw, escaped = _hostile(kind)
    monkeypatch.setenv('GIT_CEILING_DIRECTORIES', str(tmp_path.parent))
    path = tmp_path / ('plain' + raw + '.pipe')
    _write_named(path, json.dumps(_old_pipe()))

    code = await _run(_diff_args([str(path)], git='HEAD'))

    captured = capsys.readouterr()
    assert code == 2
    assert captured.out == ''
    _assert_one_safe_line(captured.err)
    assert 'plain' + escaped + '.pipe' in captured.err


@_KINDS
@pytest.mark.skipif(shutil.which('git') is None, reason='git is unavailable')
@pytest.mark.asyncio
async def test_git_error_naming_a_crafted_link_prints_it_as_escapes(tmp_path, capsys, kind):
    # A committed link, with a hostile name, that points outside the repository: the error names the link
    raw, escaped = _hostile(kind)
    repo = tmp_path / 'repo'
    repo.mkdir()
    (tmp_path / 'outside.pipe').write_text(json.dumps(_old_pipe()), encoding='utf-8')
    name = 'cur' + raw + '.pipe'
    try:
        make_symlink(repo / name, '../outside.pipe')
    except OSError as exc:
        pytest.skip(f'this filesystem cannot hold that file name: {exc}')
    init_repo(repo, name)

    code = await _run(_diff_args([str(repo / name)], git='HEAD'))

    captured = capsys.readouterr()
    assert code == 2
    assert captured.out == ''
    _assert_one_safe_line(captured.err)
    assert 'outside the repository' in captured.err
    assert 'cur' + escaped + '.pipe' in captured.err


@_KINDS
@pytest.mark.skipif(shutil.which('git') is None, reason='git is unavailable')
@pytest.mark.asyncio
@pytest.mark.parametrize('option_like', [False, True], ids=['ref', 'ref-like-an-option'])
async def test_git_error_naming_a_crafted_ref_prints_it_as_escapes(tmp_path, capsys, kind, option_like):
    raw, _escaped = _hostile(kind)
    path = _write_pipe(tmp_path, 'a.pipe', _old_pipe())
    init_repo(tmp_path, 'a.pipe')

    code = await _run(_diff_args([path], git=('-' if option_like else '') + 'x' + raw))

    captured = capsys.readouterr()
    assert code == 2
    _assert_one_safe_line(captured.err)
    assert 'Unknown git ref' in captured.err


@pytest.mark.asyncio
@pytest.mark.parametrize(
    'error',
    [
        pytest.param(ValueError('usage: ' + _CRAFTED), id='usage'),
        pytest.param(diff_module.PipeDiffError('library: ' + _CRAFTED), id='library'),
    ],
)
async def test_every_error_class_goes_through_the_same_escaping(tmp_path, capsys, monkeypatch, error):
    # Whatever raises inside input loading is reported by one function; prove the class does not matter
    def boom(*_args, **_kwargs):
        raise error

    monkeypatch.setattr(diff_module, 'load_pipe', boom)
    path = _write_pipe(tmp_path, 'a.pipe', _old_pipe())

    code = await _run(_diff_args([path, path]))

    captured = capsys.readouterr()
    assert code == 2
    _assert_one_safe_line(captured.err)
    assert _ESCAPED in captured.err


@pytest.mark.asyncio
async def test_recursion_error_message_is_unchanged_by_the_escaping(tmp_path, capsys, monkeypatch):
    def overflow(*_args, **_kwargs):
        raise RecursionError('maximum recursion depth exceeded')

    monkeypatch.setattr(diff_module, 'diff_pipes', overflow)
    path = _write_pipe(tmp_path, 'a.pipe', _old_pipe())

    code = await _run(_diff_args([path, path]))

    assert code == 2
    assert capsys.readouterr().err == f'Error: {diff_module._TOO_DEEP}\n'


@pytest.mark.asyncio
async def test_ordinary_error_text_prints_exactly_as_before(tmp_path, capsys):
    missing = str(tmp_path / 'plain name (1).pipe')

    code = await _run(_diff_args([missing, missing]))

    assert code == 2
    assert capsys.readouterr().err == f'Error: Pipe file not found: {missing}\n'


def test_fail_leaves_text_that_is_already_safe_alone(capsys):
    # Normalised accented text, CJK, a tab, a Windows path and a quote are all ordinary
    message = 'caf' + chr(0xE9) + ' ' + chr(0x65E5) + chr(0x672C) + chr(9) + 'C:' + _BS + 'Users' + _BS + "x's.pipe"

    assert diff_module._fail(message) == 2

    assert capsys.readouterr().err == f'Error: {message}\n'


def test_crafted_ids_reach_stderr_as_escapes_through_the_real_entry_point(tmp_path):
    (tmp_path / 'a.pipe').write_text(
        json.dumps({'components': [{'id': _CRAFTED, 'provider': 'p'}, {'id': _CRAFTED, 'provider': 'p'}]}),
        encoding='utf-8',
    )

    result = _cli_subprocess(tmp_path, ['a.pipe', 'a.pipe', '--markdown'])

    assert result.returncode == 2
    assert result.stdout == ''
    _assert_one_safe_line(result.stderr)
    assert _ESCAPED in result.stderr


if __name__ == '__main__':
    import sys

    sys.exit(pytest.main([__file__, '-v']))
