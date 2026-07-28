# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Pins the capabilities-aware `extendedThinking` UI toggle in the field patcher.

Reasoning models (capabilities.reasoning) carry the toggle; non-reasoning models do
not — so the UI stays self-maintaining across model syncs.
"""

from __future__ import annotations

from core.patcher import _repair_field_objects, _update_fields_for_added


def test_repair_adds_toggle_to_reasoning_and_removes_from_non_reasoning():
    fields = {
        'ns.r': {'object': 'r', 'properties': ['llm.cloud.apikey', 'llm.cloud.modelSource']},
        'ns.n': {'object': 'n', 'properties': ['llm.cloud.apikey', 'extendedThinking', 'llm.cloud.modelSource']},
    }
    profiles = {'r': {'capabilities': {'reasoning': True}}, 'n': {'capabilities': {}}}

    _repair_field_objects(fields, profiles)

    # toggle sits before modelSource (which the patcher keeps last)
    assert fields['ns.r']['properties'] == ['llm.cloud.apikey', 'extendedThinking', 'llm.cloud.modelSource']
    assert fields['ns.n']['properties'] == ['llm.cloud.apikey', 'llm.cloud.modelSource']


def test_repair_skips_custom():
    fields = {
        'ns.custom': {
            'object': 'custom',
            'properties': ['llm.cloud.apikey', 'extendedThinking', 'llm.cloud.modelSource'],
        }
    }
    _repair_field_objects(fields, {'custom': {}})
    assert 'extendedThinking' in fields['ns.custom']['properties']


def test_repair_without_profiles_leaves_toggle_untouched():
    fields = {'ns.r': {'object': 'r', 'properties': ['llm.cloud.apikey', 'extendedThinking', 'llm.cloud.modelSource']}}
    _repair_field_objects(fields)  # no profiles -> only the modelSource repair runs
    assert 'extendedThinking' in fields['ns.r']['properties']


def test_added_reasoning_profile_gets_toggle():
    fields = {'ns.profile': {'enum': [], 'conditional': []}}
    _update_fields_for_added(fields, 'ns', 'newr', {'capabilities': {'reasoning': True}, 'title': 'New R'}, set())
    assert fields['ns.newr']['properties'] == ['llm.cloud.apikey', 'extendedThinking', 'llm.cloud.modelSource']


def test_added_non_reasoning_profile_has_no_toggle():
    fields = {'ns.profile': {'enum': [], 'conditional': []}}
    _update_fields_for_added(fields, 'ns', 'newn', {'capabilities': {}, 'title': 'New N'}, set())
    assert fields['ns.newn']['properties'] == ['llm.cloud.apikey', 'llm.cloud.modelSource']
