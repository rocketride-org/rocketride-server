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
Tests for ``rocketride node convert`` (rocketride.cli.node_convert + commands/node).

The fixtures in ``tests/fixtures/node_convert`` are shared with the TypeScript
suite (``client-typescript/tests/node-convert.test.ts``): both converters must
turn each ``<case>.old.json`` into exactly ``<case>.expected.json``. This suite
also holds the converter's legacy block to its source of truth,
``tools/legacy_blocks.py``: the same old and new definitions give the same
block, and for a shipped node that block is the one in the tree.
"""

import argparse
import asyncio
import importlib
import importlib.util
import json
import os
import stat
from pathlib import Path

import pytest

from rocketride.cli.commands import node as node_command
from rocketride.cli.commands.node import run_node
from rocketride.cli.node_convert import build_block, convert_definition, is_old_format, load_json

cli_main = importlib.import_module('rocketride.cli.main')

# ============================================================================
# Fixtures
# ============================================================================

FIXTURES = Path(__file__).parent / 'fixtures' / 'node_convert'
REPO = Path(__file__).resolve().parents[3]
LEGACY_TOOL = REPO / 'tools' / 'legacy_blocks.py'
NODES = REPO / 'nodes' / 'src' / 'nodes'
CASES = json.loads((FIXTURES / 'cases.json').read_text(encoding='utf-8'))['cases']


def _old(case: str) -> dict:
    return load_json((FIXTURES / f'{case}.old.json').read_text(encoding='utf-8'))


def _expected(case: str) -> dict:
    return json.loads((FIXTURES / f'{case}.expected.json').read_text(encoding='utf-8'))


@pytest.fixture(scope='module')
def legacy_tool():
    """``tools/legacy_blocks.py`` loaded by path (a repo script, not a package)."""
    if not LEGACY_TOOL.is_file():
        pytest.skip('tools/legacy_blocks.py is not in this checkout')
    spec = importlib.util.spec_from_file_location('legacy_blocks', LEGACY_TOOL)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope='module')
def shared(legacy_tool):
    """The shared definitions of ``core/services.common*.json``, read the way the tool reads them."""
    return legacy_tool.shared_definitions(REPO)


# ============================================================================
# The fixture cases (the parity contract with the TypeScript CLI)
# ============================================================================


@pytest.mark.parametrize('case', [c['case'] for c in CASES])
def test_fixture_converts_to_expected(case):
    result = convert_definition(_old(case))
    expected = _expected(case)
    assert result.definition == expected['definition']
    assert result.warnings == expected['warnings']
    assert result.legacy == expected['legacy']


@pytest.mark.parametrize('case', [c['case'] for c in CASES])
def test_converted_text_round_trips(case):
    result = convert_definition(_old(case))
    assert json.loads(result.text()) == result.definition
    assert result.text().endswith('}\n')
    assert not is_old_format(result.definition)


# ============================================================================
# The legacy block is tools/legacy_blocks.py's
# ============================================================================


@pytest.mark.parametrize('case', [c['case'] for c in CASES])
def test_block_matches_tool_on_converted_definition(case, legacy_tool, shared):
    old = _old(case)
    if not isinstance(old.get('protocol'), str):
        pytest.skip('a library file carries no block')
    converted = convert_definition(old, shared).definition
    converted.pop('legacy', None)
    # An external node is never in the tool's hand-verified table
    assert build_block(old, converted, shared) == legacy_tool.build_block(f'external/{case}', old, converted, shared)


@pytest.mark.parametrize('entry', [c for c in CASES if c['node']], ids=lambda c: c['case'])
def test_block_matches_tool_on_shipped_definition(entry, legacy_tool, shared):
    # The hand-converted definition in the tree, not ours: the block depends
    # only on (old, new), so the two derivations must agree on any pair. The
    # tool, not the block stored in the tree, is the reference: a stored block
    # is only as current as the tool run that wrote it
    path = NODES / entry['node']
    if not path.is_file():
        pytest.skip(f'{entry["node"]} is not in this checkout')
    old = _old(entry['case'])
    in_tree = legacy_tool.load_json(path.read_text(encoding='utf-8'))
    in_tree.pop('legacy', None)
    assert build_block(old, in_tree, shared) == legacy_tool.build_block(entry['node'], old, in_tree, shared)


# ============================================================================
# Rules
# ============================================================================


def test_refuses_a_current_definition():
    with pytest.raises(ValueError, match='not an old-format node definition'):
        convert_definition({'title': 'x', 'protocol': 'x://', 'properties': []})


def test_secret_moves_from_array_item_to_array():
    # The engine refuses a secret inside an array item
    github = _expected('tool_github')['definition']['propertyDefinitions']['github.credentialMap']
    assert github['secret'] is True
    assert {'base': 'github.credentialValue', 'secret': False} in github['item']['properties']


def test_profile_constant_never_shadows_a_sibling():
    # face_detection's profile sets threshold and emit_landmarks, which are declared beside the selector
    props = _expected('face_detection')['definition']['properties']
    names = [p if isinstance(p, str) else p['name'] for p in props]
    assert names == ['profile', 'face_detection.threshold', 'face_detection.emit_landmarks']
    assert props[0]['enum']['short']['properties'] == []


def test_profile_branch_unwraps_its_object():
    # qdrant's cloud branch lists the cloud object's members, not a group named "cloud"
    profile = _expected('store_qdrant')['definition']['properties'][0]
    assert profile['name'] == 'profile'
    assert 'vector.cloud.host' in profile['enum']['cloud']['properties']
    assert {'name': 'mode', 'type': 'constant', 'default': 'cloud'} in profile['enum']['cloud']['properties']


# ============================================================================
# The command
# ============================================================================


def _args(files, out=None, dry_run=False, json_arg=None):
    return argparse.Namespace(node_subcommand='convert', files=files, out=out, dry_run=dry_run, json=json_arg)


def test_command_converts_in_place(tmp_path, capsys):
    target = tmp_path / 'services.json'
    target.write_text((FIXTURES / 'store_qdrant.old.json').read_text(encoding='utf-8'), encoding='utf-8')
    assert asyncio.run(run_node(_args([str(target)]))) == 0
    assert json.loads(target.read_text(encoding='utf-8')) == _expected('store_qdrant')['definition']
    captured = capsys.readouterr()
    assert '(legacy block added)' in captured.out
    assert 'Transform' in captured.err


def test_command_dry_run_writes_nothing(tmp_path, capsys):
    target = tmp_path / 'services.json'
    original = (FIXTURES / 'tool_gcs.old.json').read_text(encoding='utf-8')
    target.write_text(original, encoding='utf-8')
    assert asyncio.run(run_node(_args([str(target)], dry_run=True))) == 0
    assert target.read_text(encoding='utf-8') == original
    assert json.loads(capsys.readouterr().out) == _expected('tool_gcs')['definition']


def test_command_dry_run_json_carries_the_definition(capsys):
    source = str(FIXTURES / 'tool_gcs.old.json')
    assert asyncio.run(run_node(_args([source], dry_run=True, json_arg='-'))) == 0
    entry = json.loads(capsys.readouterr().out)['files'][0]
    assert entry['out'] is None
    assert entry['definition'] == _expected('tool_gcs')['definition']


def test_command_out_writes_elsewhere(tmp_path):
    source = FIXTURES / 'azure.old.json'
    target = tmp_path / 'out' / 'services.json'
    assert asyncio.run(run_node(_args([str(source)], out=str(target)))) == 0
    assert json.loads(target.read_text(encoding='utf-8')) == _expected('azure')['definition']


def test_command_out_takes_one_file(tmp_path, capsys):
    code = asyncio.run(run_node(_args(['a.json', 'b.json'], out=str(tmp_path / 'x.json'))))
    assert code == 1
    assert '--out takes exactly one input file' in capsys.readouterr().err


def test_command_reports_a_current_file_and_exits_1(tmp_path, capsys):
    target = tmp_path / 'services.json'
    target.write_text('{"title": "x", "protocol": "x://", "properties": []}', encoding='utf-8')
    assert asyncio.run(run_node(_args([str(target)], json_arg='-'))) == 1
    captured = capsys.readouterr()
    assert 'not an old-format node definition' in captured.err
    assert json.loads(captured.out)['files'][0]['error'].startswith('not an old-format')


def test_parser_registers_node_convert():
    parser = cli_main.setup_parser()
    args = parser.parse_args(['node', 'convert', 'a.json', 'b.json', '--dry-run'])
    assert (args.command, args.node_subcommand, args.files, args.dry_run, args.out) == (
        'node',
        'convert',
        ['a.json', 'b.json'],
        True,
        None,
    )
    assert cli_main._is_local_only_command(['node', 'convert', 'a.json'])


# ============================================================================
# Review rules (PR #3393)
# ============================================================================


def _review():
    return _expected('review_rules')['definition']


def test_upload_does_not_depend_on_member_order():
    for item in ({'format': 'data-url', 'type': 'string'}, {'type': 'string', 'format': 'data-url'}):
        old = {
            'protocol': 'x://',
            'fields': {'x.key': {**item, 'ui:options:accept': '.pem'}},
            'shape': [{'section': 'Pipe', 'properties': ['x.key']}],
        }
        definition = convert_definition(old).definition['propertyDefinitions']['x.key']
        assert definition['type'] == 'upload'
        assert definition['options'] == {'accept': '.pem'}


def test_every_profile_is_a_branch_with_its_title():
    branches = _review()['properties'][0]['enum']
    assert list(branches) == ['pro', 'basic', '__proto__']
    assert branches['pro']['title'] == 'Pro'


def test_inline_branch_property_takes_the_profile_default():
    pro = _review()['properties'][0]['enum']['pro']['properties']
    assert pro == [{'name': 'limit', 'type': 'integer', 'title': 'Limit', 'default': 50}]


def test_warnings_never_carry_configuration_values():
    warnings = ' '.join(_expected('review_rules')['warnings'])
    for value in ('tok-b', 'tok-p', 'root-token'):
        assert value not in warnings
    assert 'profile "pro" sets token' in warnings


def test_unreadable_array_item_reference_is_named():
    assert any('review.hosts' in w and 'shared.host' in w for w in _expected('review_rules')['warnings'])


@pytest.mark.parametrize(
    ('member', 'value', 'message'),
    [
        ('fields', ['bad'], '"fields" must be an object'),
        ('shape', {'section': 'Pipe'}, '"shape" must be a list'),
        ('preconfig', [], '"preconfig" must be an object'),
        ('preconfig', {'profiles': ['a']}, '"preconfig.profiles" must be an object'),
    ],
)
def test_malformed_containers_are_this_files_error(member, value, message):
    with pytest.raises(ValueError, match=message.replace('.', r'\.')):
        convert_definition({'protocol': 'x://', 'shape': [], member: value})


def _stage(tmp_path, names):
    paths = []
    for index, name in enumerate(names):
        target = tmp_path / f'{index}' / 'services.json'
        target.parent.mkdir()
        target.write_text((FIXTURES / f'{name}.old.json').read_text(encoding='utf-8'), encoding='utf-8')
        paths.append(target)
    return paths


def test_command_continues_after_a_malformed_file(tmp_path, capsys):
    bad, good = _stage(tmp_path, ['tool_gcs', 'tool_gcs'])
    bad.write_text('{"protocol": "x://", "fields": ["bad"], "shape": []}', encoding='utf-8')
    assert asyncio.run(run_node(_args([str(bad), str(good)], json_arg='-'))) == 1
    files = json.loads(capsys.readouterr().out)['files']
    assert files[0]['error'] == '"fields" must be an object'
    assert files[1]['legacy'] is True
    assert json.loads(good.read_text(encoding='utf-8')) == _expected('tool_gcs')['definition']


def test_command_refuses_a_report_that_would_replace_an_input(tmp_path, capsys):
    (target,) = _stage(tmp_path, ['tool_gcs'])
    original = target.read_text(encoding='utf-8')
    alias = str(target.parent / '.' / 'services.json')
    assert asyncio.run(run_node(_args([str(target)], dry_run=True, json_arg=alias))) == 1
    assert target.read_text(encoding='utf-8') == original
    assert 'would replace' in capsys.readouterr().err


def test_command_keeps_going_after_a_destination_error(tmp_path, capsys, monkeypatch):
    first, second, third = _stage(tmp_path, ['tool_gcs', 'tool_gcs', 'tool_gcs'])
    real = node_command._write_atomic

    def failing(target, text):
        if target == str(second):
            raise PermissionError('read-only')
        real(target, text)

    monkeypatch.setattr(node_command, '_write_atomic', failing)
    assert asyncio.run(run_node(_args([str(first), str(second), str(third)], json_arg='-'))) == 1
    files = json.loads(capsys.readouterr().out)['files']
    assert [bool(f.get('error')) for f in files] == [False, True, False]
    assert 'read-only' in files[1]['error']
    assert json.loads(third.read_text(encoding='utf-8')) == _expected('tool_gcs')['definition']


def test_a_failed_write_leaves_the_original_and_no_temporary(tmp_path, monkeypatch):
    (target,) = _stage(tmp_path, ['tool_gcs'])
    original = target.read_text(encoding='utf-8')

    def no_replace(_source, _destination):
        raise OSError('disk full')

    monkeypatch.setattr(node_command.os, 'replace', no_replace)
    assert asyncio.run(run_node(_args([str(target)]))) == 1
    assert target.read_text(encoding='utf-8') == original
    assert [p.name for p in target.parent.iterdir()] == ['services.json']


# ============================================================================
# File modes (PR #3393, round 2)
# ============================================================================

POSIX_ONLY = pytest.mark.skipif(os.name != 'posix', reason='Windows files carry no POSIX mode bits to preserve')


def _umask() -> int:
    mask = os.umask(0)
    os.umask(mask)
    return mask


def test_final_mode_of_a_new_file_is_0644_under_the_umask(tmp_path):
    assert node_command._final_mode(str(tmp_path / 'new.json')) == 0o644 & ~_umask()


def test_final_mode_of_an_existing_file_is_its_own(tmp_path):
    (target,) = _stage(tmp_path, ['tool_gcs'])
    assert node_command._final_mode(str(target)) == stat.S_IMODE(os.stat(target).st_mode)


@POSIX_ONLY
@pytest.mark.parametrize('mode', [0o600, 0o644, 0o640])
def test_in_place_conversion_keeps_the_definition_mode(tmp_path, mode):
    (target,) = _stage(tmp_path, ['tool_gcs'])
    os.chmod(target, mode)
    assert asyncio.run(run_node(_args([str(target)]))) == 0
    assert stat.S_IMODE(os.stat(target).st_mode) == mode


@POSIX_ONLY
def test_a_new_out_file_gets_0644_under_the_umask(tmp_path):
    target = tmp_path / 'out' / 'services.json'
    assert asyncio.run(run_node(_args([str(FIXTURES / 'tool_gcs.old.json')], out=str(target)))) == 0
    assert stat.S_IMODE(os.stat(target).st_mode) == 0o644 & ~_umask()
