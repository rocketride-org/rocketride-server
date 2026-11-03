# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Node-behavior test: a lane cannot be mapped to a key the result object already uses (#2438).

With ``laneName: result_types`` the node wrote its ``result_types`` dict under the
lane's key and then called ``.append`` on it, which raised ``AttributeError``;
``name``, ``path``, ``metadata``, ``objectId``, ``error`` and ``status`` were
overwritten instead. The node now refuses such a key when it starts, and warns
when the config is validated. Drives the real ``IGlobal`` and ``IInstance``.
"""

import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from rocketlib import OPEN_MODE

NODES_SRC = Path(__file__).parent.parent.parent / 'src' / 'nodes'
while str(NODES_SRC) in sys.path:
    sys.path.remove(str(NODES_SRC))
sys.path.insert(0, str(NODES_SRC))

from response.IGlobal import IGlobal  # noqa: E402
from response.IInstance import IInstance  # noqa: E402
from ai.common.schema import Answer  # noqa: E402

# The package exports the IGlobal class under the module's name, so reach the module itself
response_global = sys.modules[IGlobal.__module__]


class _Obj:
    """Minimal engine currentObject: a response dict plus the flags close() reads."""

    def __init__(self):
        """Start with an empty response and no name, path or metadata."""
        self.response = {}
        self.hasComponentId = False
        self.hasMetadata = False
        self.hasName = False
        self.hasPath = False


def _global(config, open_mode=None):
    """Build the node's IGlobal for ``config`` without starting it.

    Args:
        config: The connConfig.
        open_mode: The endpoint's open mode; a run mode when not given.

    Returns:
        The IGlobal.
    """
    glb = IGlobal()
    glb.glb = SimpleNamespace(connConfig=config, logicalType='response')
    glb.IEndpoint = SimpleNamespace(endpoint=SimpleNamespace(openMode=open_mode or OPEN_MODE.SOURCE))
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
        _global(config).beginGlobal()


def test_the_config_dialog_warns_instead_of_failing(monkeypatch):
    """Opened for configuration the node starts, and validateConfig reports the key."""
    warnings = []
    monkeypatch.setattr(response_global, 'warning', warnings.append)
    glb = _global({'laneName': 'result_types'}, OPEN_MODE.CONFIG)

    glb.beginGlobal()
    glb.validateConfig()

    assert len(warnings) == 1
    assert "'result_types' is reserved" in warnings[0]


def test_valid_keys_raise_no_warning(monkeypatch):
    """An ordinary custom key validates silently."""
    warnings = []
    monkeypatch.setattr(response_global, 'warning', warnings.append)

    _global({'laneName': 'my_answers'}).validateConfig()

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
    glb = _global({'lanes': [{'laneId': 'table', 'laneName': 'grid'}]})
    glb.beginGlobal()
    inst = _instance(glb)

    inst.writeTable('| a |')
    inst.writeJson({'k': 1})

    response = inst.instance.currentObject.response
    assert response['grid'] == ['| a |']
    assert response['json'] == [{'k': 1}]
    assert response['result_types'] == {'grid': 'table', 'json': 'json'}
