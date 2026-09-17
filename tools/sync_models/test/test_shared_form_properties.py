"""
Pins how the patcher builds the form (field object) of a newly added model.

A new model's form gets the node's own properties — the ones every existing
model form shows, such as a vision node's prompt fields — between the API key
and the hidden model source. A property only some models show is a per-model
choice and is not copied.

Run: pytest tools/sync_models/test/test_shared_form_properties.py
"""

from __future__ import annotations

import shutil
from pathlib import Path

import json5

from core.patcher import _shared_properties, _update_fields_for_added, get_profiles, patch

_REPO_ROOT = Path(__file__).resolve().parents[3]
_VISION = ['vision.systemPrompt', 'vision.prompt']


def _form(obj, *props):
    """
    Build one model form.

    Args:
        obj: Profile key the form belongs to
        *props: Its properties

    Returns:
        The field object dict
    """
    return {'object': obj, 'properties': list(props)}


def _selector():
    """Return an empty profile selector field."""
    return {'enum': ['*>preconfig.profiles.*.title'], 'conditional': []}


class TestSharedProperties:
    """Which properties count as the node's own form."""

    def test_properties_on_every_model_form_are_shared(self):
        """Every vision form shows the prompts, so they are shared."""
        fields = {
            'ns.a': _form('a', 'llm.cloud.apikey', *_VISION),
            'ns.b': _form('b', 'ns.apikey', *_VISION, 'llm.cloud.modelSource'),
            'ns.profile': _selector(),
        }
        assert _shared_properties(fields, 'ns', set()) == _VISION

    def test_a_property_on_only_some_forms_is_not_shared(self):
        """OpenAI shows temperature on some models only; it stays per model."""
        fields = {
            'ns.a': _form('a', 'llm.cloud.apikey', 'temperature', 'llm.cloud.modelSource'),
            'ns.b': _form('b', 'llm.cloud.apikey', 'llm.cloud.modelSource'),
        }
        assert _shared_properties(fields, 'ns', set()) == []

    def test_placeholder_and_protected_forms_are_ignored(self):
        """The custom form lists model/token inputs that a real model form never shows."""
        fields = {
            'ns.custom': _form('custom', 'model', 'modelTotalTokens', 'llm.cloud.apikey'),
            'ns.blank': _form('blank', 'serverbase', 'llm.cloud.apikey'),
            'ns.a': _form('a', 'llm.cloud.apikey', *_VISION),
        }
        profiles = {'custom': {'model': ''}, 'blank': {'model': ''}, 'a': {'model': 'm'}}
        assert _shared_properties(fields, 'ns', {'custom'}, profiles) == _VISION

    def test_forms_of_another_namespace_are_ignored(self):
        """Shared field definitions outside the namespace are not model forms."""
        fields = {
            'other.x': _form('x', 'unrelated'),
            'ns.a': _form('a', 'llm.cloud.apikey', *_VISION),
        }
        assert _shared_properties(fields, 'ns', set()) == _VISION

    def test_no_model_forms_means_nothing_shared(self):
        """A node with no model forms yet has no shared properties."""
        assert _shared_properties({'ns.profile': _selector()}, 'ns', set()) == []


class TestNewModelForm:
    """The form written for a newly added model."""

    def test_a_new_vision_model_gets_the_prompt_fields(self):
        """Shared properties sit between the API key and the model source."""
        fields = {'ns.a': _form('a', 'llm.cloud.apikey', *_VISION), 'ns.profile': _selector()}
        _update_fields_for_added(fields, 'ns', 'b', {'title': 'B'}, set(), {'a': {'model': 'm'}, 'b': {'model': 'n'}})

        assert fields['ns.b']['properties'] == ['llm.cloud.apikey', *_VISION, 'llm.cloud.modelSource']
        assert fields['ns.profile']['conditional'] == [{'value': 'b', 'properties': ['ns.b']}]

    def test_the_thinking_toggle_follows_the_shared_properties(self):
        """A reasoning model's toggle goes after the node's own properties, before the model source."""
        fields = {
            'extendedThinking': {'type': 'boolean'},
            'ns.a': _form('a', 'llm.cloud.apikey', 'ns.region', 'llm.cloud.modelSource'),
            'ns.profile': _selector(),
        }
        _update_fields_for_added(fields, 'ns', 'r', {'capabilities': {'reasoning': True}}, set())

        assert fields['ns.r']['properties'] == [
            'llm.cloud.apikey',
            'ns.region',
            'extendedThinking',
            'llm.cloud.modelSource',
        ]


class TestPatchRealVisionNode:
    """End to end on a copy of the real llm_vision_mistral services.json."""

    def test_an_added_model_is_wired_like_its_siblings(self, tmp_path):
        """The new form carries the prompts; existing forms keep theirs and gain the model source."""
        source = _REPO_ROOT / 'nodes' / 'src' / 'nodes' / 'llm_vision_mistral' / 'services.json'
        target = tmp_path / 'services.json'
        shutil.copyfile(source, target)

        profiles = get_profiles(str(target))
        profiles['pixtral-large-2411'] = {
            'title': 'Pixtral Large 2411',
            'model': 'pixtral-large-2411',
            'modelSource': 'provider',
            'modelTotalTokens': 131072,
            'apikey': '',
        }
        patch(str(target), profiles, added_profile_keys={'pixtral-large-2411'})

        data = json5.loads(target.read_text(encoding='utf-8'))
        fields = data['fields']
        assert fields['image_vision_mistral.pixtral-large-2411']['properties'] == [
            'llm.cloud.apikey',
            *_VISION,
            'llm.cloud.modelSource',
        ]
        assert fields['image_vision_mistral.mistral-large-3']['properties'] == [
            'llm.cloud.apikey',
            *_VISION,
            'llm.cloud.modelSource',
        ]
        assert 'pixtral-large-2411' in data['preconfig']['profiles']
        assert data['preconfig']['default'] == 'mistral-large-3'
