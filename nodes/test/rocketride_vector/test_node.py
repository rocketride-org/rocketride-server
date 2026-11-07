"""Unit tests for the rocketride_vector node on the shared store base (#2587).

The node keeps two things of its own on top of StoreGlobalBase: the tenant DSN
(no connection fields, and a transform key scoped by the tenant database) and
the two tool switches, both off by default (expose_tools for the whole tool
surface, allow_write for upsert/delete). The lanes and the tools come from the
base and are covered in packages/ai.
"""

from __future__ import annotations

import types
from unittest.mock import call

import pytest


def _iglobal(iglobal):
    return object.__new__(iglobal.IGlobal)


def test_tool_namespace_defaults_to_rrvector(node_modules):
    iglobal, _, _ = node_modules
    assert iglobal.IGlobal.serverName == 'rrvector'


def test_tools_are_off_unless_configured(node_modules):
    # The managed store's table is the team's database: nothing is offered as
    # a tool until the pipeline owner turns Expose as tools on.
    iglobal, _, _ = node_modules
    assert iglobal.IGlobal.expose_tools is False


def test_writes_are_off_unless_configured(node_modules):
    iglobal, _, _ = node_modules
    assert iglobal.IGlobal.allow_write is False


def test_the_shipped_services_json_keeps_both_switches_off():
    # services.json is what ships; the real-node check is in a *_full suite, which CI skips.
    from pathlib import Path

    json5 = pytest.importorskip('json5')
    path = Path(__file__).resolve().parents[2] / 'src' / 'nodes' / 'rocketride_vector' / 'services.json'
    services = json5.loads(path.read_text(encoding='utf-8'))

    cloud = services['preconfig']['profiles']['cloud']
    assert cloud['expose_tools'] is False
    assert cloud['allow_write'] is False
    assert services['fields']['rrvector.expose_tools']['default'] is False
    assert services['fields']['rrvector.allow_write']['default'] is False


def test_open_store_builds_the_driver_store_from_the_raw_config(node_modules):
    # The base passes the raw connConfig; the driver re-resolves the profile
    # merge itself, so the node must not pre-process it here.
    iglobal, _, stubs = node_modules
    glb = _iglobal(iglobal)

    store = glb._open_store('rocketride_vector', {'conn': 1}, {'bag': 1})

    stubs.Store.assert_called_once_with('rocketride_vector', {'conn': 1}, {'bag': 1})
    assert store is stubs.Store.return_value


def test_iglobal_overrides_only_the_store_hooks(node_modules):
    # Lifecycle (beginGlobal, endGlobal, validateConfig) and the switch
    # resolution belong to StoreGlobalBase; the node supplies the three hooks.
    # Exact equality holds because the conftest stands in for the base with a
    # plain class; under the real ABC base ``vars()`` would also show ``_abc_impl``.
    iglobal, _, _ = node_modules
    own = {name for name in vars(iglobal.IGlobal) if not name.startswith('__')}

    assert own == {'serverName', 'expose_tools', 'allow_write', '_open_store', '_sub_key', '_probe_connection'}


def test_sub_key_is_scoped_by_the_tenant_database(node_modules):
    iglobal, _, _ = node_modules
    glb = _iglobal(iglobal)
    glb.store = types.SimpleNamespace(database='tenant_db', host='pool', port=5432, collection='rocketride')

    assert glb._sub_key() == 'tenant_db/rocketride'


def test_sub_key_falls_back_to_host_and_port_without_a_database(node_modules):
    iglobal, _, _ = node_modules
    glb = _iglobal(iglobal)
    glb.store = types.SimpleNamespace(database='', host='pool', port=5432, collection='docs')

    assert glb._sub_key() == 'pool:5432/docs'


def test_probe_rejects_an_invalid_table_without_connecting(node_modules):
    iglobal, _, stubs = node_modules

    _iglobal(iglobal)._probe_connection({'table': 'bad-name'})

    stubs.warning.assert_called_once()
    assert 'Table name' in stubs.warning.call_args.args[0]
    stubs.resolve_dsn.assert_not_called()
    stubs.connect.assert_not_called()


def test_probe_connects_with_the_tenant_dsn(node_modules):
    iglobal, _, stubs = node_modules
    conn = stubs.connect.return_value
    cursor = conn.cursor.return_value.__enter__.return_value

    # Legacy key still accepted, as before the move to the store base.
    _iglobal(iglobal)._probe_connection({'collection': 'rocketride'})

    stubs.resolve_dsn.assert_called_once_with('org', '')
    stubs.depends.assert_called_once()
    stubs.connect.assert_called_once_with('postgresql://u:p@pool:5432/tenant_db', connect_timeout=3)
    assert cursor.execute.call_args_list == [call('SELECT 1'), call('SELECT NULL::vector')]
    conn.close.assert_called_once()
    stubs.warning.assert_not_called()


@pytest.mark.parametrize('scope, target', [('team', ''), ('team', 't-1'), ('user', 'u-1')])
def test_probe_resolves_the_configured_database(node_modules, scope, target):
    """The shared-base probe preserves the scoped DSN lookup from #2626."""
    iglobal, _, stubs = node_modules

    _iglobal(iglobal)._probe_connection({'collection': 'docs', 'scope': scope, 'target': target})

    stubs.resolve_dsn.assert_called_once_with(scope, target)
    stubs.connect.assert_called_once()
    stubs.warning.assert_not_called()


def test_probe_outside_a_task_skips_connectivity(node_modules):
    """Save-time validation does not need a delivered database or driver dependencies."""
    iglobal, _, stubs = node_modules
    stubs.resolve_dsn.side_effect = stubs.DsnNotDelivered('outside a task')

    _iglobal(iglobal)._probe_connection({'collection': 'docs', 'scope': 'team'})

    stubs.resolve_dsn.assert_called_once_with('team', '')
    stubs.depends.assert_not_called()
    stubs.connect.assert_not_called()
    stubs.warning.assert_not_called()


def test_probe_rejects_invalid_database_target(node_modules):
    """Static scope validation still runs before any database connection."""
    iglobal, _, stubs = node_modules

    _iglobal(iglobal)._probe_connection({'collection': 'docs', 'scope': 'org', 'target': 't-1'})

    stubs.resolve_dsn.assert_not_called()
    stubs.connect.assert_not_called()
    assert 'org scope takes no target' in stubs.warning.call_args.args[0]


def test_probe_reports_a_database_not_authorized_for_the_task(node_modules):
    """Only DsnNotDelivered is silent; a missing authorized scope remains an error."""
    iglobal, _, stubs = node_modules
    stubs.resolve_dsn.side_effect = ValueError('this task was not given the team database')

    _iglobal(iglobal)._probe_connection({'collection': 'docs', 'scope': 'team'})

    stubs.connect.assert_not_called()
    assert 'not given the team database' in stubs.warning.call_args.args[0]


def test_probe_reports_failures_as_warnings_not_exceptions(node_modules):
    iglobal, _, stubs = node_modules
    stubs.connect.side_effect = RuntimeError('pooler unreachable')

    _iglobal(iglobal)._probe_connection({'table': 'rocketride'})

    stubs.warning.assert_called_once()
    assert 'pooler unreachable' in stubs.warning.call_args.args[0]


def test_instance_inherits_lanes_and_tools_from_the_store_base(node_modules):
    _, iinstance, stubs = node_modules

    assert issubclass(iinstance.IInstance, stubs.StoreInstanceBase)
    # No per-driver copies of the lane handlers or the tools: the base owns them.
    for name in ('writeQuestions', 'writeDocuments', 'renderObject', 'search', 'upsert', 'delete'):
        assert name not in vars(iinstance.IInstance)
