# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Node-behavior test: a lane cannot be mapped to a key the result object already uses (#2438).

With ``laneName: result_types`` the node wrote its ``result_types`` dict under the
lane's key and then called ``.append`` on it, which raised ``AttributeError``;
``name``, ``path``, ``metadata``, ``objectId``, ``error`` and ``status`` were
overwritten instead. The node now refuses such a key when it starts, and the
validator warns when the config is checked. Drives the real ``IGlobal``,
``IValidator`` and ``IInstance`` through the engine-resolved schema.
"""

import importlib.util
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

NODES_SRC = Path(__file__).parent.parent.parent / 'src' / 'nodes'
DISCOVERY_PY = Path(__file__).parent.parent / 'framework' / 'discovery.py'
while str(NODES_SRC) in sys.path:
    sys.path.remove(str(NODES_SRC))
sys.path.insert(0, str(NODES_SRC))

from response.IGlobal import IGlobal  # noqa: E402
from response.IInstance import IInstance  # noqa: E402
from response.IValidator import IValidator  # noqa: E402
from ai.common.schema import Answer  # noqa: E402

# The reserved-key check and its warning live beside the validator
response_validator = sys.modules[IValidator.__module__]


class _Obj:
    """Minimal engine currentObject: a response dict plus the flags close() reads."""

    def __init__(self):
        """Start with an empty response and no name, path or metadata."""
        self.response = {}
        self.hasComponentId = False
        self.hasMetadata = False
        self.hasName = False
        self.hasPath = False


def _global(config, logical_type='response_text', cls=IGlobal):
    """Build the node's IGlobal (or IValidator) for ``config`` without starting it.

    Args:
        config: The connConfig, in the service's path-addressed shape.
        logical_type: The service: ``response_text`` declares ``laneName``, ``response`` declares ``lanes``.
        cls: The class to build.

    Returns:
        The IGlobal or IValidator.
    """
    glb = cls()
    glb.glb = SimpleNamespace(connConfig=config, logicalType=logical_type)
    return glb


def _instance(glb):
    """Build an IInstance on a started IGlobal, with an empty result object.

    Args:
        glb: The started IGlobal.

    Returns:
        The IInstance.
    """
    inst = IInstance()
    inst.IGlobal = glb
    inst.instance = SimpleNamespace(currentObject=_Obj())
    inst.open(None)
    return inst


# Listed here, not read from RESERVED_RESULT_KEYS, so that dropping a key from the node fails this test
_KEYS_THE_RESULT_ALREADY_HOLDS = ('result_types', 'name', 'path', 'metadata', 'objectId', 'error', 'status')


@pytest.mark.parametrize('key', _KEYS_THE_RESULT_ALREADY_HOLDS)
def test_a_reserved_lane_name_stops_the_node_with_a_clear_error(key):
    """Every reserved key is refused as the single-lane ``laneName``."""
    with pytest.raises(ValueError, match=f"Result key '{key}' is reserved"):
        _global({'laneName': key}).beginGlobal()


def test_a_reserved_key_in_the_lanes_mapping_is_refused_too():
    """The generic service's ``lanes`` mapping is checked the same way, every key named once."""
    config = {
        'lanes': [
            {'laneId': 'text', 'laneName': 'status'},
            {'laneId': 'answers', 'laneName': 'result_types'},
            {'laneId': 'table', 'laneName': 'status'},
        ]
    }
    with pytest.raises(ValueError, match="Result key 'result_types', 'status' is reserved"):
        _global(config, 'response').beginGlobal()


def test_the_config_dialog_warns_instead_of_failing(monkeypatch):
    """Opened for configuration the validator reports the key instead of failing."""
    warnings = []
    monkeypatch.setattr(response_validator, 'warning', warnings.append)

    _global({'laneName': 'result_types'}, cls=IValidator).validateConfig()

    assert len(warnings) == 1
    assert "'result_types' is reserved" in warnings[0]


def test_valid_keys_raise_no_warning(monkeypatch):
    """An ordinary custom key validates silently."""
    warnings = []
    monkeypatch.setattr(response_validator, 'warning', warnings.append)

    _global({'laneName': 'my_answers'}, cls=IValidator).validateConfig()

    assert warnings == []


def test_a_custom_key_still_collects_every_lane():
    """A valid custom key gets a list for each lane, and result_types maps it back."""
    glb = _global({'laneName': 'out'})
    glb.beginGlobal()
    inst = _instance(glb)
    answer = Answer()
    answer.setAnswer('42')

    inst.writeTable('| a |')
    inst.writeAnswers(answer)
    inst.writeJson({'k': 1})
    inst.writeText('hello')
    inst.close()

    response = inst.instance.currentObject.response
    assert response['out'] == ['| a |', '42', {'k': 1}, 'hello\n\n']
    assert response['result_types'] == {'out': 'text'}


def test_unmapped_lanes_use_their_lane_type():
    """With no key configured, each lane keeps its own name, as before."""
    glb = _global({'lanes': [{'laneId': 'table', 'laneName': 'grid'}]}, 'response')
    glb.beginGlobal()
    inst = _instance(glb)

    inst.writeTable('| a |')
    inst.writeJson({'k': 1})

    response = inst.instance.currentObject.response
    assert response['grid'] == ['| a |']
    assert response['json'] == [{'k': 1}]
    assert response['result_types'] == {'grid': 'table', 'json': 'json'}


def _default_lane_names():
    """Return ``(services file, default laneName)`` for every response service that sets a default.

    Read with the repo's JSONC reader: the services files have comments and trailing commas.

    Returns:
        ``(services file, logical type, default laneName)`` triples, sorted by file name.
    """
    spec = importlib.util.spec_from_file_location('_response_discovery', DISCOVERY_PY)
    discovery = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(discovery)
    found = []
    for path in sorted((NODES_SRC / 'response').glob('services*.json')):
        service = discovery._parse_service_json(str(path))
        assert service is not None, f'{path.name} did not parse'
        default = service.get('propertyDefinitions', {}).get('laneName', {}).get('default')
        if default:
            found.append((path.name, service['protocol'].replace('://', ''), default))
    return found


_DEFAULT_LANE_NAMES = _default_lane_names()


def test_the_services_still_set_defaults_to_check():
    """Guard the test below: with no defaults found it would check nothing and pass."""
    assert _DEFAULT_LANE_NAMES


@pytest.mark.parametrize(
    ('services_file', 'logical_type', 'lane_name'),
    _DEFAULT_LANE_NAMES,
    ids=[name for name, _, _ in _DEFAULT_LANE_NAMES],
)
def test_no_service_default_result_key_is_reserved(services_file, logical_type, lane_name):
    """A service's default key must stay usable: reserving it would stop every pipeline that keeps the default."""
    glb = _global({}, logical_type)
    glb.beginGlobal()
    assert glb.laneName == lane_name
