# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""The access level on every API/Cron service, as the engine sees it.

Each service is driven through the engine's own ``tool.query`` (rocketlib's
real dispatch, see ``_support._real_filters``): the tools listed at a
level are exactly those whose declared level it covers. The levels a
service offers in its panel are the levels its code accepts. Vector has its
own tests (``vector/test_vector.py``), since it runs on store_postgres.
"""

from __future__ import annotations

import pytest

from ._support import (
    API_CFG,
    LOGS,
    PG_CFG,
    cfg_with,
    engine_stubs,
    load_common_fields,
    load_service,
    make_global,
    make_instance,
    tool_levels,
    tool_query,
)

with engine_stubs():
    from nodes.supabase import supabase_client as sc
    from nodes.supabase.auth import IGlobal as AuthGlobal, IInstance as AuthInstance
    from nodes.supabase.cron import IGlobal as CronGlobal, IInstance as CronInstance
    from nodes.supabase.functions import IGlobal as FunctionsGlobal, IInstance as FunctionsInstance
    from nodes.supabase.messaging import IGlobal as MessagingGlobal, IInstance as MessagingInstance
    from nodes.supabase.storage import IGlobal as StorageGlobal, IInstance as StorageInstance

SERVICES = {
    'auth': (AuthGlobal, AuthInstance, API_CFG),
    'storage': (StorageGlobal, StorageInstance, API_CFG),
    'messaging': (MessagingGlobal, MessagingInstance, API_CFG),
    'functions': (FunctionsGlobal, FunctionsInstance, API_CFG),
    'cron': (CronGlobal, CronInstance, PG_CFG),
}


def _offered_levels(name: str) -> list:
    """The supabase.access enum the panel shows: the service's own, else the shared one (arrays are replaced)."""
    local = load_service(name)['fields'].get('supabase.access', {})
    spec = local if 'enum' in local else load_common_fields()['supabase.access']
    return [value for value, _label in spec['enum']]


def _instance(name: str, access: str):
    glb_cls, inst_cls, base = SERVICES[name]
    return make_instance(inst_cls, make_global(glb_cls, cfg_with(base, access=access)))


@pytest.mark.parametrize('name', list(SERVICES))
def test_the_panel_offers_the_levels_the_code_accepts(name):
    glb_cls = SERVICES[name][0]
    assert _offered_levels(name) == list(glb_cls.ACCESS_LEVELS)


def test_vector_uses_the_shared_levels():
    assert 'enum' not in load_service('vector')['fields'].get('supabase.access', {})
    assert _offered_levels('vector') == list(sc.ACCESS_LEVELS)


@pytest.mark.parametrize('name', list(SERVICES))
def test_tool_query_lists_exactly_the_tools_the_level_covers(name):
    levels = tool_levels(SERVICES[name][1])
    for access in SERVICES[name][0].ACCESS_LEVELS:
        expected = {tool for tool, needed in levels.items() if sc.access_allows(access, needed)}
        assert {d['name'] for d in tool_query(_instance(name, access))} == expected, access


def test_every_cron_level_adds_tools():
    """Cron's former write level allowed nothing more than read; every level left now adds something."""
    offered = [{d['name'] for d in tool_query(_instance('cron', access))} for access in CronGlobal.ACCESS_LEVELS]
    assert all(lower < higher for lower, higher in zip(offered, offered[1:]))


@pytest.mark.parametrize(
    'name, product', [('messaging', 'Supabase Messaging'), ('functions', 'Supabase Edge Functions')]
)
def test_write_only_services_at_read_list_nothing_and_say_why(name, product):
    LOGS.clear()
    inst = _instance(name, 'read')
    assert tool_query(inst) == []
    inst.beginInstance()
    assert [m for level, m in LOGS if level == 'warning'] == [
        f'{product}: the access level is "read", which offers the agent no tools. '
        'Set "Access level" on the node to "write" to turn them on.'
    ]


@pytest.mark.parametrize('name', ['messaging', 'functions'])
def test_write_only_services_say_so_on_the_panel_and_the_tile(name):
    svc = load_service(name)
    assert 'offers the agent no tools: set write' in svc['fields']['supabase.access']['description']
    # True at every level, so a node already at write is not told to set write.
    assert svc['tile'][1] == 'Tools need write or admin'


@pytest.mark.parametrize('name', ['auth', 'storage', 'cron'])
def test_services_with_read_tools_stay_quiet_at_read(name):
    LOGS.clear()
    _instance(name, 'read').beginInstance()
    assert not [m for level, m in LOGS if 'offers the agent no tools' in m]
