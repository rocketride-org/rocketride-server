# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""The node scaffolder renders a valid, discoverable node folder for each kind."""

import json

import pytest

from ai.account.node_scaffold import scaffold_node, validate_node


def _manifest(files):
    return json.loads(files['services.json'])


def test_filter_scaffold_shape():
    files = scaffold_node('my_filter', kind='filter')
    # A filter is IGlobal + IInstance, no endpoint factory.
    assert set(files) >= {
        'services.json',
        '__init__.py',
        'IGlobal.py',
        'IInstance.py',
        'requirements.txt',
        'VERSION',
        'my_filter.svg',
    }
    assert 'IEndpoint.py' not in files
    m = _manifest(files)
    assert m['register'] == 'filter'
    assert m['protocol'] == 'my_filter://'
    assert m['path'] == 'nodes.my_filter'
    assert m['prefix'] == 'MyFilter'
    assert m['classType'] == ['text']
    assert m['icon'] == 'my_filter.svg'
    # __init__ re-exports only the two classes a filter has.
    assert 'IEndpoint' not in files['__init__.py']


def test_source_scaffold_shape():
    files = scaffold_node('my_source', kind='source')
    # A source needs the endpoint factory and originates on the '_source' lane.
    assert 'IEndpoint.py' in files
    m = _manifest(files)
    assert m['register'] == 'endpoint'
    assert m['classType'] == ['source']
    assert '_source' in m['lanes']
    assert 'from .IEndpoint import IEndpoint' in files['__init__.py']


def test_manifest_is_valid_json_with_required_keys():
    m = _manifest(scaffold_node('good_node'))
    for key in (
        'title',
        'protocol',
        'classType',
        'capabilities',
        'register',
        'node',
        'path',
        'prefix',
        'lanes',
        'shape',
    ):
        assert key in m, f'manifest missing required key {key!r}'


def test_custom_title_lanes_and_description_flow_through():
    files = scaffold_node('tagger', title='Auto Tagger', lanes={'text': ['tags']}, description='Tags text.')
    m = _manifest(files)
    assert m['title'] == 'Auto Tagger'
    assert m['lanes'] == {'text': ['tags']}
    assert m['description'] == ['Tags text.']
    # The title drives the canvas section and the placeholder icon glyph.
    assert m['shape'][0]['title'] == 'Auto Tagger'
    assert '>A<' in files['tagger.svg']


@pytest.mark.parametrize('bad', ['', 'Bad', '1node', 'has-dash', 'has space', 'a', 'x' * 65, 'UPPER'])
def test_invalid_names_are_rejected(bad):
    # The name is the frozen protocol id; a bad one must never reach a manifest.
    with pytest.raises(ValueError):
        scaffold_node(bad)


def test_unknown_kind_is_rejected():
    with pytest.raises(ValueError):
        scaffold_node('ok_name', kind='transformer')


def test_python_stubs_are_syntactically_valid():
    # Every generated .py must at least compile — a scaffold that won't import is useless.
    for kind in ('filter', 'source'):
        files = scaffold_node('probe', kind=kind)
        for path, body in files.items():
            if path.endswith('.py'):
                compile(body, path, 'exec')


# --- validate_node ----------------------------------------------------------


@pytest.mark.parametrize('kind', ['filter', 'source'])
def test_scaffolded_node_validates_clean(kind):
    # Whatever we scaffold must pass our own validator, or the two disagree.
    files = scaffold_node('round_trip', kind=kind)
    result = validate_node('round_trip', files)
    assert result['ok'] is True, result['errors']
    assert result['errors'] == []


def test_validate_rejects_unparseable_manifest():
    files = scaffold_node('broken')
    files['services.json'] = '{ this is : not json'
    result = validate_node('broken', files)
    assert result['ok'] is False
    assert any('parse' in e for e in result['errors'])


def test_validate_rejects_protocol_folder_mismatch():
    files = scaffold_node('real_name')
    files['services.json'] = files['services.json'].replace('real_name://', 'other_name://')
    result = validate_node('real_name', files)
    assert result['ok'] is False
    assert any('protocol' in e for e in result['errors'])


def test_validate_flags_source_missing_endpoint():
    files = scaffold_node('a_source', kind='source')
    del files['IEndpoint.py']
    result = validate_node('a_source', files)
    assert result['ok'] is False
    assert any('IEndpoint' in e for e in result['errors'])


def test_validate_flags_python_syntax_error():
    files = scaffold_node('bad_py')
    files['IInstance.py'] = 'def open(:\n    pass'  # deliberate syntax error
    result = validate_node('bad_py', files)
    assert result['ok'] is False
    assert any('syntax error' in e for e in result['errors'])


def test_validate_warns_on_missing_icon_but_stays_ok():
    files = scaffold_node('no_icon')
    del files['no_icon.svg']
    result = validate_node('no_icon', files)
    assert result['ok'] is True  # icon is advisory, not blocking
    assert any('icon' in w for w in result['warnings'])


# --- handler dispatch (rrext_node_dev) --------------------------------------

from ai.modules.task.commands.cmd_node_dev import NodeDevCommands


def _conn():
    # Bypass the DAP transport __init__; the scaffold path touches no connection state.
    return NodeDevCommands.__new__(NodeDevCommands)


async def test_handler_scaffold_returns_file_map():
    result = await _conn().on_rrext_node_dev({'arguments': {'subcommand': 'scaffold', 'name': 'foo', 'kind': 'source'}})
    assert result['name'] == 'foo'
    assert result['protocol'] == 'foo://'
    assert 'IEndpoint.py' in result['files']


async def test_handler_validate_verb():
    files = scaffold_node('viahandler', kind='filter')
    result = await _conn().on_rrext_node_dev(
        {'arguments': {'subcommand': 'validate', 'name': 'viahandler', 'files': files}}
    )
    assert result['ok'] is True
    assert result['errors'] == []


async def test_handler_requires_subcommand():
    with pytest.raises(ValueError):
        await _conn().on_rrext_node_dev({'arguments': {}})


async def test_handler_rejects_unknown_subcommand():
    with pytest.raises(ValueError):
        await _conn().on_rrext_node_dev({'arguments': {'subcommand': 'nope'}})


def test_taskconn_composes_the_node_builder_handler():
    # The mixin must actually be wired into the connection, or the command never dispatches.
    from ai.modules.task.task_conn import TaskConn

    assert hasattr(TaskConn, 'on_rrext_node_dev')
