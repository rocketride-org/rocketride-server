# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Pins the capabilities-aware `extendedThinking` UI toggle in the field patcher.

The toggle is only managed for nodes that DEFINE the field (today: llm_anthropic).
Within such a node, reasoning models carry it and non-reasoning models do not, so the
UI stays self-maintaining across model syncs without leaking into other providers.
"""

from __future__ import annotations

from core.patcher import _repair_field_objects, _update_fields_for_added

# A node whose fields define the extendedThinking widget (like llm_anthropic).
_FIELD_DEF = {'extendedThinking': {'type': 'boolean', 'title': 'Extended thinking', 'default': False}}


def test_repair_adds_toggle_to_reasoning_and_removes_from_non_reasoning():
    fields = {
        **_FIELD_DEF,
        'ns.r': {'object': 'r', 'properties': ['llm.cloud.apikey', 'llm.cloud.modelSource']},
        'ns.n': {'object': 'n', 'properties': ['llm.cloud.apikey', 'extendedThinking', 'llm.cloud.modelSource']},
    }
    profiles = {'r': {'capabilities': {'reasoning': True}}, 'n': {'capabilities': {}}}

    _repair_field_objects(fields, profiles)

    # toggle sits before modelSource (which the patcher keeps last)
    assert fields['ns.r']['properties'] == ['llm.cloud.apikey', 'extendedThinking', 'llm.cloud.modelSource']
    assert fields['ns.n']['properties'] == ['llm.cloud.apikey', 'llm.cloud.modelSource']


def test_toggle_never_added_when_field_undefined():
    # A provider node that does NOT define extendedThinking (e.g. openai) must be left alone,
    # even for reasoning models — the toggle must not leak in.
    fields = {'ns.r': {'object': 'r', 'properties': ['llm.cloud.apikey', 'llm.cloud.modelSource']}}
    profiles = {'r': {'capabilities': {'reasoning': True}}}
    _repair_field_objects(fields, profiles)
    assert fields['ns.r']['properties'] == ['llm.cloud.apikey', 'llm.cloud.modelSource']


def test_repair_skips_custom():
    fields = {
        **_FIELD_DEF,
        'ns.custom': {
            'object': 'custom',
            'properties': ['llm.cloud.apikey', 'extendedThinking', 'llm.cloud.modelSource'],
        },
    }
    _repair_field_objects(fields, {'custom': {}})
    assert 'extendedThinking' in fields['ns.custom']['properties']


def test_repair_without_profiles_leaves_toggle_untouched():
    fields = {
        **_FIELD_DEF,
        'ns.r': {'object': 'r', 'properties': ['llm.cloud.apikey', 'extendedThinking', 'llm.cloud.modelSource']},
    }
    _repair_field_objects(fields)  # no profiles -> only the modelSource repair runs
    assert 'extendedThinking' in fields['ns.r']['properties']


def test_added_reasoning_profile_gets_toggle_when_field_defined():
    fields = {**_FIELD_DEF, 'ns.profile': {'enum': [], 'conditional': []}}
    _update_fields_for_added(fields, 'ns', 'newr', {'capabilities': {'reasoning': True}, 'title': 'New R'}, set())
    assert fields['ns.newr']['properties'] == ['llm.cloud.apikey', 'extendedThinking', 'llm.cloud.modelSource']


def test_added_reasoning_profile_no_toggle_when_field_undefined():
    fields = {'ns.profile': {'enum': [], 'conditional': []}}  # no extendedThinking field def
    _update_fields_for_added(fields, 'ns', 'newr', {'capabilities': {'reasoning': True}, 'title': 'New R'}, set())
    assert fields['ns.newr']['properties'] == ['llm.cloud.apikey', 'llm.cloud.modelSource']


def test_added_non_reasoning_profile_has_no_toggle():
    fields = {**_FIELD_DEF, 'ns.profile': {'enum': [], 'conditional': []}}
    _update_fields_for_added(fields, 'ns', 'newn', {'capabilities': {}, 'title': 'New N'}, set())
    assert fields['ns.newn']['properties'] == ['llm.cloud.apikey', 'llm.cloud.modelSource']
