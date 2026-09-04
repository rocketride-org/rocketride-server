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

These exercise ``DiffCommand.execute`` end-to-end against real ``.pipe`` files on
disk, driving it through the same pinned engine and reporters the CLI uses in
production. The command is fully local (no server, no auth), so no client fixture
or network mock is needed; the only external dependency stubbed here is
``resolve_git_ref`` for ``--git`` mode, patched in the command's own module
namespace the same way the engine test suite stubs subprocess.

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
    - argparse registration: 'diff' exists, takes no connection args, and makes
      ``--json``/``--markdown`` mutually exclusive
"""

import json
from types import SimpleNamespace

import pytest

from rocketride.cli.commands import diff as diff_module
from rocketride.cli.commands.diff import DiffCommand
from rocketride.cli.main import RocketRideCLI


# =========================================================================
# Helpers / fixtures
# =========================================================================


class _StubCLI:
    """Minimal stand-in for the CLI context.

    ``DiffCommand`` stores the CLI on construction but never touches it during
    ``execute`` (the command is fully local), so an attribute-free stub is enough
    to satisfy ``BaseCommand.__init__``.
    """


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
    """Instantiate and execute a DiffCommand, returning its integer exit code."""
    command = DiffCommand(_StubCLI(), args)
    return await command.execute()


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
    # --help and the docs claim --include-layout enumerates the top-level
    # viewport; before this it silently reported nothing and exited 0.
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


# =========================================================================
# argparse registration (parser-level, no execution)
# =========================================================================


def test_parser_registers_diff_subcommand():
    parser = RocketRideCLI().setup_parser()
    ns = parser.parse_args(['diff', 'old.pipe', 'new.pipe'])
    assert ns.command == 'diff'
    assert ns.paths == ['old.pipe', 'new.pipe']
    assert ns.git is None
    assert ns.include_layout is False
    assert ns.json is False
    assert ns.markdown is False
    assert ns.exit_zero is False


def test_parser_diff_takes_no_connection_args():
    parser = RocketRideCLI().setup_parser()
    ns = parser.parse_args(['diff', 'old.pipe', 'new.pipe'])
    # This command never touches the engine, so the shared connection args that
    # every other subcommand carries must be absent from its namespace.
    assert not hasattr(ns, 'apikey')
    assert not hasattr(ns, 'uri')
    assert not hasattr(ns, 'token')


def test_parser_json_and_markdown_are_mutually_exclusive():
    parser = RocketRideCLI().setup_parser()
    with pytest.raises(SystemExit):
        parser.parse_args(['diff', '--json', '--markdown', 'old.pipe', 'new.pipe'])


if __name__ == '__main__':
    import sys

    sys.exit(pytest.main([__file__, '-v']))
