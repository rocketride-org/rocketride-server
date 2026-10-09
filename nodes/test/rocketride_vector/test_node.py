"""Unit tests for the rocketride_vector node on the shared store base (#2587).

The node keeps two things of its own on top of StoreGlobalBase: the tenant DSN
(no connection fields, and a transform key scoped by the tenant database) and
the write switch behind the upsert/delete tools. The lanes and the tools come
from the base and are covered in packages/ai.
"""

from __future__ import annotations

import types
from unittest.mock import call


def _iglobal(iglobal):
    return object.__new__(iglobal.IGlobal)


def test_tool_namespace_defaults_to_rrvector(node_modules):
    iglobal, _, _ = node_modules
    assert iglobal.IGlobal.serverName == 'rrvector'


def test_writes_are_off_unless_configured(node_modules):
    iglobal, _, _ = node_modules
    assert iglobal.IGlobal.allow_write is False


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

    assert own == {'serverName', 'allow_write', '_open_store', '_sub_key', '_probe_connection'}


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

    stubs.resolve_dsn.assert_called_once_with()
    stubs.depends.assert_called_once()
    stubs.connect.assert_called_once_with('postgresql://u:p@pool:5432/tenant_db', connect_timeout=3)
    assert cursor.execute.call_args_list == [call('SELECT 1'), call('SELECT NULL::vector')]
    conn.close.assert_called_once()
    stubs.warning.assert_not_called()


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
