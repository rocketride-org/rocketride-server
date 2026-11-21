# =============================================================================
# MIT License
#
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
The per-call parameters of the Google Workspace and Microsoft 365 tools (C.26 OAuth family).

The credential (``authType`` and its branch) is the control's; the access
tier and the destructive gates are caller-only params. Google mints a
service-account token per scope set, so a control keeps one discovery
service per tier a call has used; Graph never binds the tier, so one auth
serves every tier and each call checks its own. The node classes are the
real ones over the real rocketlib bases; the credential builders are
recording stand-ins, so nothing reaches Google or Microsoft.
"""

from __future__ import annotations

import importlib
import sys
from types import ModuleType

import pytest

from .framework.controls import assert_config_refuses, assert_params, bind_call, control_config

# ==== The schemas ================================================================

#: logical type -> its param leaf paths (every one is caller-only)
SCHEMAS = {
    'tool_calendar': ['access', 'allowDelete', 'allowPublicSharing'],
    'tool_docs': ['access'],
    'tool_drive': ['access', 'allowPublicSharing', 'allowHardDelete'],
    'tool_gmail': ['access', 'allowHardDelete'],
    'tool_sheets': [],
    'tool_excel': ['access'],
    'tool_onedrive': ['access', 'allowPublicSharing', 'allowHardDelete'],
    'tool_outlook_calendar': ['access'],
    'tool_outlook_mail': ['access', 'allowHardDelete'],
    'tool_word': ['access'],
}


@pytest.mark.parametrize('logical_type', sorted(SCHEMAS))
def test_the_tier_and_the_gates_are_caller_only_params(logical_type):
    assert_params(logical_type, SCHEMAS[logical_type], caller_only=SCHEMAS[logical_type])


@pytest.mark.parametrize('logical_type', sorted(SCHEMAS))
def test_the_control_config_refuses_the_tier_and_the_gates(logical_type):
    assert_config_refuses(control_config(logical_type), SCHEMAS[logical_type])


def test_the_dead_customer_id_is_gone_from_every_google_service():
    for logical_type in ('tool_calendar', 'tool_docs', 'tool_drive', 'tool_gmail', 'tool_sheets'):
        assert 'customerId' not in control_config(logical_type)


# ==== The node classes over the real bases ========================================


def _fresh(*names: str):
    """
    Import node modules afresh over the real rocketlib, leaving ``sys.modules`` as it was.

    Other tests import these packages over stubbed rocketlib bases; a fresh
    import here keeps the classes this module drives on the real ones.

    Returns:
        The imported modules, in order.
    """
    depends = ModuleType('depends')
    depends.depends = lambda *args, **kwargs: None
    absent = object()
    prefixes = ('nodes.tool_google_workspace', 'nodes.tool_microsoft_365')
    saved = {name: module for name, module in sys.modules.items() if name.startswith(prefixes)}
    saved_depends = sys.modules.get('depends', absent)
    try:
        for name in saved:
            sys.modules.pop(name)
        sys.modules['depends'] = depends
        return tuple(importlib.import_module(name) for name in names)
    finally:
        for name in [n for n in sys.modules if n.startswith(prefixes)]:
            sys.modules.pop(name)
        sys.modules.update(saved)
        if saved_depends is absent:
            sys.modules.pop('depends', None)
        else:
            sys.modules['depends'] = saved_depends


def _begin(glb_class, logical_type: str, stored=None, monkeypatch=None):
    """One control's IGlobal over the engine-resolved config, begun once (the package install stubbed)."""
    depends = ModuleType('depends')
    depends.depends = lambda *args, **kwargs: None
    monkeypatch.setitem(sys.modules, 'depends', depends)
    glb = glb_class()
    glb._config_restricted = control_config(logical_type, stored)
    glb.beginGlobal()
    return glb


# ==== Google: one service per tier ================================================


def test_one_google_control_serves_two_tiers_building_each_service_once(monkeypatch):
    base_global, calendar_global, calendar_instance = _fresh(
        'nodes.tool_google_workspace.IGlobal',
        'nodes.tool_google_workspace.calendar.IGlobal',
        'nodes.tool_google_workspace.calendar.IInstance',
    )
    built = []

    def build_service(service, auth_type, cfg, scopes):
        built.append(tuple(scopes))
        return object()

    monkeypatch.setattr(base_global, 'build_service', build_service)
    glb = _begin(calendar_global.IGlobal, 'tool_calendar', {'service': {'adminEmail': 'a@b.c'}}, monkeypatch)
    assert built == []  # nothing is minted before a call asks for a tier

    reader = bind_call(calendar_instance.IInstance(), glb, {'access': 'readonly'})
    writer = bind_call(calendar_instance.IInstance(), glb, {'access': 'write', 'allowDelete': True})
    again = bind_call(calendar_instance.IInstance(), glb)

    assert reader._svc() is not writer._svc()
    assert again._svc() is writer._svc()  # the stored default tier is write
    assert len(built) == 2 and all(scope.endswith('.readonly') for scope in built[0])

    assert reader._access().can_write is False
    with pytest.raises(PermissionError):
        reader._access().require_write('event_insert')
    writer._access().require_flag('allowDelete', 'event_delete')
    with pytest.raises(PermissionError):
        again._access().require_flag('allowDelete', 'event_delete')

    glb.endGlobal()


# ==== Microsoft: one auth, each call's tier ========================================


def test_one_graph_auth_serves_calls_at_their_own_tier(monkeypatch):
    base_global, onedrive_global, onedrive_instance = _fresh(
        'nodes.tool_microsoft_365.IGlobal',
        'nodes.tool_microsoft_365.onedrive.IGlobal',
        'nodes.tool_microsoft_365.onedrive.IInstance',
    )
    auths = []
    monkeypatch.setattr(base_global, 'build_auth', lambda service, auth_type, cfg: auths.append(auth_type) or object())
    stored = {'service': {'tenantId': 't', 'clientId': 'c', 'clientSecret': 's', 'userPrincipalName': 'u@x.y'}}
    glb = _begin(onedrive_global.IGlobal, 'tool_onedrive', stored, monkeypatch)

    reader = bind_call(onedrive_instance.IInstance(), glb, {'access': 'readonly'})
    writer = bind_call(onedrive_instance.IInstance(), glb, {'access': 'write', 'allowHardDelete': True})

    assert reader._auth() is writer._auth() is glb.auth
    assert auths == ['service']
    with pytest.raises(PermissionError):
        reader._access().require_write('drive_upload')
    writer._access().require_write('drive_upload')
    writer._access().require_flag('allowHardDelete', 'drive_delete')
    with pytest.raises(PermissionError):
        reader._access().require_flag('allowHardDelete', 'drive_delete')

    glb.endGlobal()


def test_a_user_grant_is_checked_against_each_calls_tier(monkeypatch):
    base_global, base_instance, mail_global, mail_instance = _fresh(
        'nodes.tool_microsoft_365.IGlobal',
        'nodes.tool_microsoft_365.IInstance',
        'nodes.tool_microsoft_365.outlook_mail.IGlobal',
        'nodes.tool_microsoft_365.outlook_mail.IInstance',
    )
    monkeypatch.setattr(base_global, 'build_auth', lambda service, auth_type, cfg: object())
    checked = []

    def require_token_scopes(service, settings, scopes):
        checked.append(tuple(scopes))
        if any('Send' in scope for scope in scopes):
            raise ValueError('missing required scopes: Mail.Send')

    monkeypatch.setattr(base_instance, 'require_token_scopes', require_token_scopes)
    glb = _begin(mail_global.IGlobal, 'tool_outlook_mail', {'authType': 'user'}, monkeypatch)

    reader = bind_call(mail_instance.IInstance(), glb, {'access': 'readonly'})
    assert reader._auth() is glb.auth
    reader._auth()
    assert len(checked) == 1  # once per binding

    sender = bind_call(mail_instance.IInstance(), glb, {'access': 'send'})
    with pytest.raises(ValueError, match='Mail.Send'):
        sender._auth()

    glb.endGlobal()
