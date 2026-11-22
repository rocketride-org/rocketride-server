# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""
A control's config and one call's settings for node unit tests (plan 5.6.4).

A node reads two views: ``self.config`` on its IGlobal (the control's resolved
configuration, which refuses every ``param``-flagged key) and ``self.settings``
on its IInstance (that configuration plus this call's params). The helpers
here build both from the ENGINE's resolved schema of the node, so a test reads
exactly what a running engine would hand the node, and a ``services.json``
edit the engine rejects fails the test that uses it.

``control_config`` is what ``IGlobal.config`` returns; ``bind_call`` attaches a
control and one call's params to an instance the way the engine does;
``assert_params`` and ``assert_config_refuses`` are the two contract checks
every node with params carries: the schema flags exactly the leaves the test
names, and none of them can be read at global scope.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any, Dict, Iterable, Mapping, Optional

import pytest
import rocketlib
from rocketlib.config import ConfigError, ConfigView, NodeInfo, resolveConfig

# ==== Constants ==================================================================

#: The component id the helpers give a node unless a test names one.
NODE_ID = 'node_1'

# ==== The two views ==============================================================


def service_schema(logical_type: str) -> Dict[str, Any]:
    """
    The engine-resolved schema of a service.

    Args:
        logical_type: The service's logical type (its ``protocol`` without ``://``).

    Returns:
        ``engLib.getServiceSchema`` as the resolver takes it.
    """
    schema = rocketlib.getServiceSchema(logical_type)
    assert schema is not None, f'{logical_type} is not registered with the engine'
    return schema


def resolved_config(
    logical_type: str, stored: Optional[Mapping[str, Any]] = None, node_id: str = NODE_ID
) -> ConfigView:
    """
    A control's full resolved configuration, param-flagged keys readable.

    Args:
        logical_type: The service's logical type.
        stored: The node's config as the pipeline stores it (a tree by leaf path).
        node_id: The component id.

    Returns:
        Defaults + stored values, validated and flattened to the active branch.
    """
    node = NodeInfo(
        id=node_id, name=node_id, provider=logical_type, physicalType='python', capabilities=0, controlId='control-1'
    )
    return resolveConfig(service_schema(logical_type), dict(stored or {}), node=node)


def control_config(logical_type: str, stored: Optional[Mapping[str, Any]] = None, node_id: str = NODE_ID) -> ConfigView:
    """
    What ``IGlobal.config`` returns for a control: the resolved config, refusing param-flagged keys.

    Args:
        logical_type: The service's logical type.
        stored: The node's stored config.
        node_id: The component id.

    Returns:
        The restricted view.
    """
    return resolved_config(logical_type, stored, node_id).restricted(refuse_params=True)


def bind_call(instance: Any, glb: Any, params: Optional[Mapping[str, Any]] = None) -> Any:
    """
    Attach a control's IGlobal and one call's params to an instance, as the engine does at bind.

    Args:
        instance: A fresh IInstance (one per call: an instance lives one binding).
        glb: The control's IGlobal, or a ``ConfigView`` to stand for an IGlobal that holds only its config.
        params: The call's admitted params of this node, by leaf path or short name.

    Returns:
        The instance.
    """
    if isinstance(glb, ConfigView):
        glb = SimpleNamespace(config=glb)
    instance.IGlobal = glb
    instance._caller = {'params': {glb.config.node.id: dict(params or {})}}
    return instance


# ==== The contract checks ========================================================


def assert_params(logical_type: str, expected: Iterable[str], caller_only: Iterable[str] = ()) -> None:
    """
    The schema flags exactly ``expected`` as params, and exactly ``caller_only`` of them ``tool: false``.

    Args:
        logical_type: The service's logical type.
        expected: Every param leaf path of the service.
        caller_only: The param leaf paths an LLM may not set (``tool: false``).
    """
    descriptors = {d['field']: d for d in service_schema(logical_type).get('params') or []}
    assert sorted(descriptors) == sorted(expected)
    assert sorted(path for path, d in descriptors.items() if d.get('tool') is False) == sorted(caller_only)


def assert_config_refuses(config: ConfigView, keys: Iterable[str]) -> None:
    """
    Every key raises through ``IGlobal.config``: a param is per call and read from ``self.settings``.

    Args:
        config: A control's restricted view (``control_config``).
        keys: The short names of param-flagged keys reachable on the control's branch.
    """
    for key in keys:
        with pytest.raises(ConfigError):
            getattr(config, key)
