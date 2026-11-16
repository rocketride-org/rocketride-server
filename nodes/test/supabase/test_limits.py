# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Each service's LIMITS table matches its services.<svc>.json, both ways.

The numbers live in two places on purpose: services.json drives the panel,
and the code clamps with the same bounds (a value written straight into a
.pipe file never passed the panel). This test makes a change to only one of
them fail CI.
"""

from __future__ import annotations

import pytest

from ._support import cfg_with, engine_stubs, load_service, make_global, API_CFG, PG_CFG

with engine_stubs():
    from nodes.supabase.auth.IGlobal import IGlobal as AuthGlobal
    from nodes.supabase.cron.IGlobal import IGlobal as CronGlobal
    from nodes.supabase.functions.IGlobal import IGlobal as FunctionsGlobal
    from nodes.supabase.messaging.IGlobal import IGlobal as MessagingGlobal
    from nodes.supabase.storage.IGlobal import IGlobal as StorageGlobal

SERVICES = {
    'auth': (AuthGlobal, API_CFG),
    'storage': (StorageGlobal, API_CFG),
    'messaging': (MessagingGlobal, API_CFG),
    'functions': (FunctionsGlobal, API_CFG),
    'cron': (CronGlobal, PG_CFG),
}


def _numeric_fields(svc: dict, prefix: str) -> dict:
    return {
        field_id.split('.', 1)[1]: spec
        for field_id, spec in svc['fields'].items()
        if field_id.startswith(f'{prefix}.') and spec.get('type') in ('integer', 'number')
    }


@pytest.mark.parametrize('name', list(SERVICES))
def test_limits_match_the_services_file(name):
    cls, _ = SERVICES[name]
    svc = load_service(name)
    fields = _numeric_fields(svc, cls.SERVICE)
    profile = svc['preconfig']['profiles'][svc['preconfig']['default']]
    assert set(cls.LIMITS) == set(fields), 'every numeric field has a LIMITS entry, and the other way round'
    for key, (attr, default, minimum, maximum) in cls.LIMITS.items():
        spec = fields[key]
        assert (spec['default'], spec['minimum'], spec['maximum']) == (default, minimum, maximum), key
        assert profile[key] == default, key
        assert getattr(cls, attr) == default, f'{attr} class default'


@pytest.mark.parametrize('name', list(SERVICES))
def test_limits_are_clamped_at_start_up(name):
    cls, base = SERVICES[name]
    above = {key: maximum + 1 for key, (_, _, _, maximum) in cls.LIMITS.items()}
    glb = make_global(cls, cfg_with(base, **above))
    for key, (attr, _, _, maximum) in cls.LIMITS.items():
        assert getattr(glb, attr) == maximum, key
