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
The per-call parameters of tool_apify (plan 5.1, 5.6.4).

The three run bounds (max items, run timeout, max cost) are parameters a
caller sets per call and an LLM may not; the control keeps one ``ApifyClient``
built from the account token. The node's config and settings are resolved
against the engine's own schema, so a ``services.json`` edit the engine
rejects fails here. The Apify SDK is replaced by a recording stand-in: no test
reaches the network.
"""

from __future__ import annotations

import importlib
import sys
from datetime import timedelta
from decimal import Decimal
from types import ModuleType, SimpleNamespace

from .framework.controls import assert_config_refuses, assert_params, bind_call, control_config

# ==== The node, imported over a stand-in SDK =====================================

LOGICAL_TYPE = 'tool_apify'

#: The param leaf paths of the service; every one is caller-only.
PARAMS = ['max_items', 'run_timeout_secs', 'max_cost_usd']


class _Dataset:
    """A dataset handle: serves as many items as the limit allows."""

    def __init__(self, client: '_ApifyClient', dataset_id: str):
        self._client = client
        self._dataset_id = dataset_id

    def list_items(self, *, limit: int) -> SimpleNamespace:
        """Record the limit and return that many items."""
        self._client.list_limits.append(limit)
        return SimpleNamespace(items=[{'n': index} for index in range(min(limit, 3))])


class _Actor:
    """An actor handle: records the arguments of each run."""

    def __init__(self, client: '_ApifyClient'):
        self._client = client

    def call(self, **kwargs) -> SimpleNamespace:
        """Record one run and name its dataset."""
        self._client.runs.append(kwargs)
        return SimpleNamespace(default_dataset_id='ds-1')


class _ApifyClient:
    """Stand-in for ``apify_client.ApifyClient``: counts constructions, records calls."""

    built = 0

    def __init__(self, token: str):
        type(self).built += 1
        self.token = token
        self.runs = []
        self.list_limits = []

    def actor(self, actor_id: str) -> _Actor:
        """The handle of one actor."""
        return _Actor(self)

    def dataset(self, dataset_id: str) -> _Dataset:
        """The handle of one dataset."""
        return _Dataset(self, dataset_id)


def _import_node():
    """
    Import the node with the SDK and its install replaced, leaving ``sys.modules`` as it was.

    Returns:
        The node's ``IGlobal`` and ``IInstance`` modules.
    """
    sdk = ModuleType('apify_client')
    sdk.ApifyClient = _ApifyClient
    depends = ModuleType('depends')
    depends.depends = lambda *args, **kwargs: None
    stubs = {'apify_client': sdk, 'depends': depends}
    node_modules = ('nodes.tool_apify.IGlobal', 'nodes.tool_apify.IInstance')
    absent = object()
    saved = {name: sys.modules.get(name, absent) for name in (*stubs, *node_modules)}
    try:
        sys.modules.update(stubs)
        for name in node_modules:
            sys.modules.pop(name, None)
        return tuple(importlib.import_module(name) for name in node_modules)
    finally:
        for name, previous in saved.items():
            if previous is absent:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = previous


_global_mod, _instance_mod = _import_node()


# ==== Helpers ====================================================================


def _control(stored=None):
    """
    One control's IGlobal over the engine-resolved config, begun once.

    Args:
        stored: The node's stored config; the token defaults to a fake one.

    Returns:
        The IGlobal after ``beginGlobal``.
    """
    glb = _global_mod.IGlobal()
    glb._config_restricted = control_config(LOGICAL_TYPE, {'apikey': 'k1', **(stored or {})})
    glb.beginGlobal()
    return glb


def _call(glb, params=None):
    """A fresh instance bound to one call of the control."""
    return bind_call(_instance_mod.IInstance(), glb, params)


# ==== The schema =================================================================


def test_the_run_bounds_are_caller_only_parameters():
    assert_params(LOGICAL_TYPE, PARAMS, caller_only=PARAMS)


def test_the_control_config_refuses_the_run_bounds():
    assert_config_refuses(control_config(LOGICAL_TYPE, {'apikey': 'k1'}), PARAMS)


# ==== One control, two calls =====================================================


def test_one_control_serves_two_calls_with_their_own_bounds():
    built = _ApifyClient.built
    glb = _control()

    first = _call(glb).run_actor({'actor_id': 'apify/a', 'limit': 500})
    second = _call(glb, {'max_items': 2, 'run_timeout_secs': 30, 'max_cost_usd': 0.25}).run_actor(
        {'actor_id': 'apify/a', 'limit': 500}
    )

    # One client for both calls: the bounds never rebuilt the control
    assert _ApifyClient.built == built + 1
    default_run, bounded_run = glb.client.runs
    assert default_run['max_items'] == 100
    assert default_run['max_total_charge_usd'] == Decimal('1')
    assert default_run['run_timeout'] == default_run['wait_duration'] == timedelta(seconds=120)
    assert bounded_run['max_items'] == 2
    assert bounded_run['max_total_charge_usd'] == Decimal('0.25')
    assert bounded_run['run_timeout'] == bounded_run['wait_duration'] == timedelta(seconds=30)
    assert glb.client.list_limits == [100, 2]
    assert first['count'] == 3
    assert second['count'] == 2


def test_a_dataset_read_is_clamped_by_the_call_cap():
    glb = _control({'max_items': 50})

    _call(glb).get_dataset_items({'dataset_id': 'ds-1', 'limit': 80})
    _call(glb, {'max_items': 10}).get_dataset_items({'dataset_id': 'ds-1', 'limit': 80})
    _call(glb, {'max_items': 10}).get_dataset_items({'dataset_id': 'ds-1', 'limit': 4})

    assert glb.client.list_limits == [50, 10, 4]


def test_the_control_ends_its_client():
    glb = _control()
    glb.endGlobal()
    assert glb.client is None
