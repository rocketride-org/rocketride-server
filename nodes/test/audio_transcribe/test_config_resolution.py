# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Resolver tests for audio_transcribe's profile configuration (#2067).

test_decode_params.py stubs Config.getNodeConfig out, so it proves what IGlobal does
with a config dict but says nothing about how that dict is produced. This file runs the
*real* resolver — packages/ai/src/ai/common/config.py, loaded from source behind a
stubbed rocketlib — against the *real* services.json.

That combination is what the bug lives in. A profile's editable overrides are stored in
connConfig[<profile>] and merged OVER preconfig.profiles[<profile>], so any default the
config form materialises into that object beats the profile's own value. With one shared
model field defaulted to "base", picking "medium" and pressing Save wrote model=base and
the node quietly transcribed with base — no error, no log, and the integration runs (which
only exercise the default profile) stay green.

No server, no engine, no FFmpeg, no model download, no GPU, no network.
"""

from __future__ import annotations

import copy
import importlib.util
import json
import os
import sys
import types

import pytest

_HERE = os.path.dirname(os.path.abspath(__file__))
_NODE_DIR = os.path.join(_HERE, '..', '..', 'src', 'nodes', 'audio_transcribe')
_SERVICES_JSON = os.path.join(_NODE_DIR, 'services.json')
_DISCOVERY_PY = os.path.join(_HERE, '..', 'framework', 'discovery.py')
_CONFIG_PY = os.path.join(_HERE, '..', '..', '..', 'packages', 'ai', 'src', 'ai', 'common', 'config.py')

_LOGICAL_TYPE = 'audio_transcribe://'

# Every key IGlobal.beginGlobal() reads out of the resolved config. Anything a profile
# adds that is not in here (e.g. the display "title") is inert at runtime.
_KEYS_IGLOBAL_READS = (
    'model',
    'language',
    'compute_type',
    'chunk_duration',
    'beam_size',
    'vad_filter',
    'vad_threshold',
    'vad_min_silence_duration_ms',
    'vad_speech_pad_ms',
    'vad_max_speech_duration_s',
)


def _parse_services_json():
    """Parse via the repo's JSONC reader — services.json has comments and trailing commas."""
    spec = importlib.util.spec_from_file_location('_audio_transcribe_discovery', _DISCOVERY_PY)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod._parse_service_json(_SERVICES_JSON)


_SERVICE = _parse_services_json()
_PROFILES = _SERVICE['preconfig']['profiles']
_PROFILE_NAMES = sorted(_PROFILES)


def _load_get_node_config(service):
    """Load the real Config.getNodeConfig behind a rocketlib stub serving `service`."""
    saved = {}

    class FakeIJson:
        """Stands in for rocketlib.IJson. Plain dicts never match it, which is the point:
        the resolver's IJson branches must not be the thing under test here.
        """

        @staticmethod
        def toDict(value):
            return dict(value)

    rocketlib = types.ModuleType('rocketlib')
    rocketlib.getServiceDefinition = lambda logicalType: service
    rocketlib.IJson = FakeIJson
    rocketlib.warning = lambda *a, **kw: None

    stubs = {'rocketlib': rocketlib}

    # config.py imports json5 at module scope for getConfig(), which this file never
    # calls. Stub it only when it is genuinely absent so the real parser is used when
    # the engine's interpreter has it.
    if importlib.util.find_spec('json5') is None:
        json5 = types.ModuleType('json5')
        json5.loads = json.loads
        stubs['json5'] = json5

    for name, stub in stubs.items():
        saved[name] = sys.modules.get(name)
        sys.modules[name] = stub

    mod_name = '_audio_transcribe_ai_config_under_test'
    try:
        spec = importlib.util.spec_from_file_location(mod_name, _CONFIG_PY)
        mod = importlib.util.module_from_spec(spec)
        sys.modules[mod_name] = mod
        spec.loader.exec_module(mod)
        return mod.Config.getNodeConfig
    finally:
        sys.modules.pop(mod_name, None)
        for name in stubs:
            if saved[name] is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = saved[name]


def _resolve(conn_config):
    """Resolve a node config exactly as IGlobal.beginGlobal() would."""
    get_node_config = _load_get_node_config(copy.deepcopy(_SERVICE))
    return get_node_config(_LOGICAL_TYPE, copy.deepcopy(conn_config))


def _group_id(profile):
    """The field id of `profile`'s object group, read off the selector's conditional.

    Going through the conditional rather than guessing the id is deliberate: a profile
    whose group is never attached to the selector is unreachable from the UI, and this
    lookup fails loudly instead of silently testing a group nobody can open.
    """
    conditionals = _SERVICE['fields']['transcribe.profile']['conditional']
    matches = [c for c in conditionals if c['value'] == profile]

    assert len(matches) == 1, f'profile {profile} has {len(matches)} conditional entries'
    assert len(matches[0]['properties']) == 1, f'profile {profile} attaches more than one group'

    return matches[0]['properties'][0]


def _materialised_defaults(profile):
    """What the config form writes into connConfig[profile] on an untouched save.

    RJSF fills every declared default into the form data, so this is the payload the
    resolver actually sees the first time someone opens the node and presses Save.
    """
    fields = _SERVICE['fields']
    group = fields[_group_id(profile)]

    written = {}
    for prop in group['properties']:
        field = fields[prop]
        if 'default' in field:
            written[prop.rsplit('.', 1)[-1]] = field['default']

    return written


# -----------------------------------------------------------------------------
# Compatibility: what already-saved configs must keep resolving to
# -----------------------------------------------------------------------------


def test_unconfigured_node_still_resolves_to_base_english():
    config = _resolve({})

    assert config['model'] == 'base'
    assert config['language'] == 'en'


def test_selecting_the_default_profile_matches_an_unconfigured_node():
    assert _resolve({'profile': 'default'})['model'] == _resolve({})['model']


def test_hand_authored_default_profile_overrides_survive():
    """The shape the UI has always written: profile + a same-named object of overrides."""
    config = _resolve({'profile': 'default', 'default': {'model': 'large-v3', 'beam_size': 1}})

    assert config['model'] == 'large-v3'
    assert config['beam_size'] == 1
    assert config['language'] == 'en'  # untouched, still from the profile


def test_legacy_flat_config_without_a_profile_key_still_resolves():
    """Configs written before the node had a profile selector put keys at the top level."""
    config = _resolve({'model': 'small', 'language': 'de'})

    assert config['model'] == 'small'
    assert config['language'] == 'de'


def test_legacy_nested_object_without_a_profile_key_still_resolves():
    """The other historical shape: the default profile's object, but no "profile" key."""
    assert _resolve({'default': {'model': 'small'}})['model'] == 'small'


# -----------------------------------------------------------------------------
# The bug: a selected profile must actually select its model
# -----------------------------------------------------------------------------


@pytest.mark.parametrize('profile', _PROFILE_NAMES)
def test_selecting_a_profile_selects_its_model(profile):
    assert _resolve({'profile': profile})['model'] == _PROFILES[profile]['model']


@pytest.mark.parametrize('profile', _PROFILE_NAMES)
def test_an_untouched_save_cannot_downgrade_the_selected_model(profile):
    """The regression this file exists for.

    One shared model field defaulted to "base" makes this resolve to base for tiny,
    small, medium and large-v3 — the node silently runs a different model than the one
    on screen. Per-profile model fields make the materialised default a no-op.
    """
    written = _materialised_defaults(profile)
    config = _resolve({'profile': profile, profile: written})

    assert config['model'] == _PROFILES[profile]['model']


@pytest.mark.parametrize('profile', _PROFILE_NAMES)
def test_an_untouched_save_preserves_everything_the_profile_declares(profile):
    """The model key is the one that bit, but the same merge decides every profile-supplied key.

    Keys the profile does not declare (beam_size, the vad_* family, ...) are absent
    before the save and carry their declared default after it; that those defaults equal
    IGlobal's own fallbacks is checked in test_decode_params.py.
    """
    written = _materialised_defaults(profile)
    saved = _resolve({'profile': profile, profile: written})

    for key in _KEYS_IGLOBAL_READS:
        if key in _PROFILES[profile]:
            assert saved[key] == _PROFILES[profile][key], f'{key} moved on an untouched save of {profile}'


@pytest.mark.parametrize('profile', _PROFILE_NAMES)
def test_overrides_survive_alongside_the_profile_model(profile):
    """Editing a knob must not cost you the profile, and picking a profile must not cost
    you the knob. Both halves of #2067 in one assertion.
    """
    written = _materialised_defaults(profile)
    written.update({'beam_size': 1, 'language': 'de', 'vad_filter': False, 'compute_type': 'int8'})

    config = _resolve({'profile': profile, profile: written})

    assert config['model'] == _PROFILES[profile]['model']
    assert config['beam_size'] == 1
    assert config['language'] == 'de'
    assert config['vad_filter'] is False
    assert config['compute_type'] == 'int8'


def test_an_explicit_model_override_still_wins_over_the_profile():
    """The model field stays editable — a deliberate change is not the bug."""
    assert _resolve({'profile': 'medium', 'medium': {'model': 'tiny'}})['model'] == 'tiny'


def test_one_profiles_overrides_do_not_leak_into_another():
    """Each profile owns its own object, so switching profiles keeps both sets intact."""
    conn = {
        'profile': 'medium',
        'medium': {'beam_size': 1},
        'tiny': {'beam_size': 9, 'model': 'large-v3'},
    }

    config = _resolve(conn)

    assert config['model'] == 'medium'
    assert config['beam_size'] == 1


def test_the_profile_display_title_never_reaches_a_key_iglobal_reads():
    """Profiles gained a "title" so the selector can label them; it must stay inert."""
    config = _resolve({'profile': 'large-v3'})

    assert config['title'] == 'Large v3'
    assert 'title' not in _KEYS_IGLOBAL_READS
    assert config['model'] == 'large-v3'


# -----------------------------------------------------------------------------
# The schema side: every declared profile has to be reachable from the UI
# -----------------------------------------------------------------------------


def test_the_profile_selector_is_visible():
    """It was `"hidden": true`, so the node offered no way to pick a profile at all."""
    assert not _SERVICE['fields']['transcribe.profile'].get('hidden')


def test_the_selector_enumerates_every_declared_profile():
    """The enum is generated from preconfig so a new profile cannot be left off the list."""
    assert _SERVICE['fields']['transcribe.profile']['enum'] == ['*>preconfig.profiles.*.title']


def test_every_profile_declares_a_title():
    """The generated enum reads preconfig.profiles.<name>.title; a missing one lists blank."""
    for name, values in _PROFILES.items():
        assert values.get('title'), f'profile {name} has no title to display'


def test_the_selector_attaches_a_group_for_every_profile():
    conditionals = _SERVICE['fields']['transcribe.profile']['conditional']

    assert sorted(c['value'] for c in conditionals) == _PROFILE_NAMES


@pytest.mark.parametrize('profile', _PROFILE_NAMES)
def test_each_group_stores_under_its_own_profile_key(profile):
    """The group's "object" name is the connConfig key the resolver reads overrides from,
    so a mismatch here sends the edits somewhere nothing looks.
    """
    assert _SERVICE['fields'][_group_id(profile)]['object'] == profile


@pytest.mark.parametrize('profile', _PROFILE_NAMES)
def test_each_group_exposes_the_same_editable_fields(profile):
    """Field ids differ per profile; the config keys they resolve to must not."""
    fields = _SERVICE['fields'][_group_id(profile)]['properties']
    names = [prop.rsplit('.', 1)[-1] for prop in fields]

    assert sorted(names) == sorted(_KEYS_IGLOBAL_READS)


@pytest.mark.parametrize('profile', _PROFILE_NAMES)
def test_each_groups_model_default_matches_its_profile(profile):
    """Stated on the schema itself, so the invariant is visible without running a merge."""
    fields = _SERVICE['fields']
    model_field = next(p for p in fields[_group_id(profile)]['properties'] if p.endswith('.model'))

    assert fields[model_field]['default'] == _PROFILES[profile]['model']


def test_compute_type_is_declared_with_the_runtime_fallback_as_its_default():
    """IGlobal has read compute_type since the initial commit; float16 is its fallback."""
    field = _SERVICE['fields']['transcribe.compute_type']

    assert field['default'] == 'float16'
    assert [choice[0] for choice in field['enum']] == ['float16', 'int8', 'int8_float16', 'float32']
