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
from pathlib import Path

import pytest

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
