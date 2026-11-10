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
The RocketRide cloud vector store node on the shared store base.

The node supplies the driver hook and the two tool-switch defaults; the base
owns the lifecycle and, through StoreInstanceBase, the lanes and the tools.
The save-time probe lives in IValidator and is driven here with the delivered
DSN and psycopg2 stood in.
"""

import json
import sys
import types
from types import SimpleNamespace
from unittest.mock import MagicMock, call

import pytest
import rocketlib
from rocketlib.config import ConfigError, resolveConfig

from ai.common.store import StoreInstanceBase

import nodes.rocketride_vector.IValidator as validator
from nodes.rocketride_vector.IGlobal import IGlobal
from nodes.rocketride_vector.IInstance import IInstance

TEST_DSN = 'postgresql://u:p@pool:5432/tenant_db'


def _resolve(conn_config):
    """Resolve a node config exactly as IGlobal.beginGlobal() would."""
    return resolveConfig(rocketlib.getServiceSchema('rocketride_vector'), conn_config)


# ---- the node's own surface --------------------------------------------------


def test_server_name_default():
    assert IGlobal.serverName == 'rrvector'


def test_tools_and_writes_are_off_unless_configured():
    # The managed store's table is the team's database: nothing is offered as
    # a tool until the pipeline owner turns Expose as tools on.
    assert IGlobal.expose_tools is False
    assert IGlobal.allow_write is False
    config = _resolve({})
    assert config['expose_tools'] is False and config['allow_write'] is False


def test_open_store_builds_the_driver_store_from_the_resolved_config(monkeypatch):
    # The base hands the resolved view through; the node must not pre-process it.
    store_cls = MagicMock(name='Store')
    driver = types.ModuleType('nodes.rocketride_vector.rocketride_vector')
    driver.Store = store_cls
    monkeypatch.setitem(sys.modules, 'nodes.rocketride_vector.rocketride_vector', driver)
    glb = IGlobal.__new__(IGlobal)
    config = _resolve({'collection': 'docs'})

    store = glb._open_store('rocketride_vector', config, {'bag': 1})

    store_cls.assert_called_once_with('rocketride_vector', config, {'bag': 1})
    assert store is store_cls.return_value


def test_iglobal_overrides_only_the_store_hook_and_the_switch_defaults():
    # Lifecycle (beginGlobal, endGlobal) and the switch resolution belong to
    # StoreGlobalBase; the node supplies the hook and its defaults.
    own = {name for name in vars(IGlobal) if not name.startswith('__') and name != '_abc_impl'}

    assert own == {'serverName', 'expose_tools', 'allow_write', '_open_store'}


def test_instance_inherits_lanes_and_tools_from_the_store_base():
    assert issubclass(IInstance, StoreInstanceBase)
    # No per-driver copies of the lane handlers or the tools: the base owns them.
    for name in ('writeQuestions', 'writeDocuments', 'renderObject', 'search', 'upsert', 'delete'):
        assert name not in vars(IInstance)


def test_the_schema_bounds_the_hnsw_parameters():
    with pytest.raises(ConfigError, match='hnsw_m'):
        _resolve({'hnsw_m': 1})
    with pytest.raises(ConfigError, match='hnsw_ef_construction'):
        _resolve({'hnsw_ef_construction': 1001})


# ---- the save-time probe -----------------------------------------------------


@pytest.fixture
def probe(monkeypatch):
    """The probe's collaborators stood in: warnings, the DSN resolution, depends and psycopg2."""
    stubs = SimpleNamespace(warning=MagicMock(), resolve_dsn=MagicMock(return_value=TEST_DSN), connect=MagicMock())
    monkeypatch.setattr(validator, 'warning', stubs.warning)
    monkeypatch.setattr(validator, 'resolve_rocketride_dsn', stubs.resolve_dsn)
    depends = types.ModuleType('depends')
    depends.depends = MagicMock()
    stubs.depends = depends.depends
    monkeypatch.setitem(sys.modules, 'depends', depends)
    psycopg2 = types.ModuleType('psycopg2')
    psycopg2.connect = stubs.connect
    psycopg2.OperationalError = type('OperationalError', (Exception,), {})
    psycopg2.ProgrammingError = type('ProgrammingError', (Exception,), {})
    monkeypatch.setitem(sys.modules, 'psycopg2', psycopg2)
    return stubs


def _validate(conn_config):
    v = validator.IValidator()
    v.glb = SimpleNamespace(logicalType='rocketride_vector', connConfig=conn_config)
    v.validateConfig()


def test_probe_rejects_an_invalid_table_without_connecting(probe):
    _validate({'collection': 'bad-name'})

    probe.warning.assert_called_once()
    assert 'Table name' in probe.warning.call_args.args[0]
    probe.resolve_dsn.assert_not_called()
    probe.connect.assert_not_called()


def test_probe_connects_with_the_tenant_dsn(probe):
    conn = probe.connect.return_value
    cursor = conn.cursor.return_value.__enter__.return_value

    _validate({})

    probe.resolve_dsn.assert_called_once_with('org', '')
    probe.depends.assert_called_once()
    probe.connect.assert_called_once_with(TEST_DSN, connect_timeout=3)
    assert cursor.execute.call_args_list == [call('SELECT 1'), call('SELECT NULL::vector')]
    conn.close.assert_called_once()
    probe.warning.assert_not_called()


@pytest.mark.parametrize('scope, target', [('team', ''), ('team', 't-1'), ('user', 'u-1')])
def test_probe_resolves_the_configured_database(probe, scope, target):
    """The probe preserves the scoped DSN lookup from #2626."""
    _validate({'collection': 'docs', 'scope': scope, 'target': target})

    probe.resolve_dsn.assert_called_once_with(scope, target)
    probe.connect.assert_called_once()
    probe.warning.assert_not_called()


def test_probe_outside_a_task_skips_connectivity(probe):
    """Save-time validation does not need a delivered database or driver dependencies."""
    probe.resolve_dsn.side_effect = validator.DsnNotDelivered('outside a task')

    _validate({'collection': 'docs', 'scope': 'team'})

    probe.resolve_dsn.assert_called_once_with('team', '')
    probe.depends.assert_not_called()
    probe.connect.assert_not_called()
    probe.warning.assert_not_called()


def test_probe_rejects_invalid_database_target(probe):
    """Static scope validation still runs before any database connection."""
    _validate({'collection': 'docs', 'scope': 'org', 'target': 't-1'})

    probe.resolve_dsn.assert_not_called()
    probe.connect.assert_not_called()
    assert 'org scope takes no target' in probe.warning.call_args.args[0]


def test_probe_reports_a_database_not_authorized_for_the_task(probe):
    """Only DsnNotDelivered is silent; a missing authorized scope remains an error."""
    probe.resolve_dsn.side_effect = ValueError('this task was not given the team database')

    _validate({'collection': 'docs', 'scope': 'team'})

    probe.connect.assert_not_called()
    assert 'not given the team database' in probe.warning.call_args.args[0]


def test_probe_reports_failures_as_warnings_not_exceptions(probe):
    probe.connect.side_effect = RuntimeError('pooler unreachable')

    _validate({})

    probe.warning.assert_called_once()
    assert 'pooler unreachable' in probe.warning.call_args.args[0]


def test_the_delivered_dsn_map_is_what_the_probe_reads(monkeypatch):
    """Without stand-ins: the DSN comes from ROCKETRIDE_DB_DSNS, and a scope the task was not given is an error."""
    monkeypatch.setenv('ROCKETRIDE_DB_DSNS', json.dumps({'org': TEST_DSN}))
    warnings = []
    monkeypatch.setattr(validator, 'warning', warnings.append)
    connect = MagicMock()
    monkeypatch.setitem(sys.modules, 'psycopg2', SimpleNamespace(connect=connect))
    depends = types.ModuleType('depends')
    depends.depends = MagicMock()
    monkeypatch.setitem(sys.modules, 'depends', depends)

    _validate({'scope': 'team', 'target': 't-9'})
    assert connect.call_count == 0
    assert len(warnings) == 1 and "not given the team database 't-9'" in warnings[0]

    _validate({})
    connect.assert_called_once_with(TEST_DSN, connect_timeout=3)
