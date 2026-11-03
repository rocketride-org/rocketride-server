# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
A config key that is nearly a real one is reported instead of silently dropped.

`merge()` copies unknown keys into the merged config, where nothing reads them,
so the node runs with a default the author believes they overrode. The check is
deliberately narrow: several nodes read keys their services.json never declares,
and warning about every unrecognised key would make the message worthless.
"""

import json5
import pytest
from pathlib import Path

from ai.common.config import Config


SERVICE = {
    'preconfig': {
        'default': 'gpt-4-1-mini',
        'profiles': {
            'custom': {'model': '', 'modelTotalTokens': 16384, 'apikey': ''},
            'gpt-4-1-mini': {
                'title': 'GPT-4.1 mini',
                'model': 'gpt-4.1-mini',
                'modelTotalTokens': 1047576,
                'modelOutputTokens': 32768,
                'apikey': '',
            },
        },
    },
    'fields': {
        'model': {'type': 'string'},
        'modelTotalTokens': {'type': 'number'},
        'openai.profile': {'type': 'string'},
    },
}


class TestKnownConfigKeys:
    def test_unions_every_profile_not_just_the_selected_one(self):
        keys = Config._knownConfigKeys(SERVICE)
        # 'custom' omits modelOutputTokens, but it is a real key of this node.
        assert 'modelOutputTokens' in keys
        assert 'apikey' in keys

    def test_strips_the_node_prefix_from_field_names(self):
        assert 'profile' in Config._knownConfigKeys(SERVICE)

    def test_empty_service(self):
        assert Config._knownConfigKeys({}) == set()

    def test_catalogue_metadata_is_not_a_configuration_key(self):
        # A pipeline never sets these, so they must not be offered as a suggestion.
        keys = Config._knownConfigKeys(
            {'preconfig': {'profiles': {'p': {'title': 'X', 'deprecated': True, 'migration': 'use y', 'model': 'm'}}}}
        )
        assert keys == {'model'}
        assert Config._suggestKey('deprecatd', keys) is None


class TestSuggestKey:
    def test_dropped_prefix_is_the_case_this_exists_for(self):
        keys = Config._knownConfigKeys(SERVICE)
        assert Config._suggestKey('outputTokens', keys) == 'modelOutputTokens'
        assert Config._suggestKey('totalTokens', keys) == 'modelTotalTokens'

    def test_a_real_key_is_not_flagged(self):
        keys = Config._knownConfigKeys(SERVICE)
        for key in ('model', 'modelTotalTokens', 'modelOutputTokens', 'apikey'):
            assert Config._suggestKey(key, keys) is None

    def test_a_casing_difference_is_a_mistake(self):
        # merge() keys off the exact spelling, so this overrides nothing.
        assert Config._suggestKey('MODELOUTPUTTOKENS', Config._knownConfigKeys(SERVICE)) == 'modelOutputTokens'
        assert Config._suggestKey('modeloutputtokens', Config._knownConfigKeys(SERVICE)) == 'modelOutputTokens'

    def test_an_unrelated_key_is_left_alone(self):
        keys = Config._knownConfigKeys(SERVICE)
        # Nodes legitimately read keys their services.json does not declare
        # (score, similarity, renderChunkSize...). Those must stay silent.
        for key in ('thisKeyDoesNotExist', 'score', 'similarity', 'renderChunkSize'):
            assert Config._suggestKey(key, keys) is None

    def test_a_shared_suffix_alone_does_not_qualify(self):
        # 'max_model_tokens' ends with 'tokens' but is not a misspelling of it.
        assert Config._suggestKey('max_model_tokens', {'tokens', 'model'}) is None

    def test_a_longer_known_key_starting_with_the_unknown_one_is_not_a_match(self):
        # 'anonymize' vs 'anonymizeChar' — a real pair in the catalogue, both valid.
        assert Config._suggestKey('anonymize', {'anonymizeChar', 'anonymizeAll'}) is None

    def test_a_plain_typo_is_caught(self):
        assert Config._suggestKey('modelOutputTokns', Config._knownConfigKeys(SERVICE)) == 'modelOutputTokens'


class TestWarnMisnamedKeys:
    def test_warns_naming_both_keys(self, monkeypatch):
        said = []
        monkeypatch.setattr('ai.common.config.warning', said.append)
        Config._warnMisnamedKeys('llm_openai', SERVICE, {'apikey': '', 'outputTokens': 32768})
        assert len(said) == 1
        assert 'outputTokens' in said[0]
        assert 'modelOutputTokens' in said[0]

    def test_silent_on_a_correct_config(self, monkeypatch):
        said = []
        monkeypatch.setattr('ai.common.config.warning', said.append)
        Config._warnMisnamedKeys('llm_openai', SERVICE, {'model': 'gpt-4.1-mini', 'modelOutputTokens': 32768})
        assert said == []

    def test_a_service_declaring_nothing_is_not_second_guessed(self, monkeypatch):
        said = []
        monkeypatch.setattr('ai.common.config.warning', said.append)
        Config._warnMisnamedKeys('some_node', {}, {'outputTokens': 1})
        assert said == []


class TestAgainstTheRealCatalogue:
    """Guards the heuristic: no node may flag a key it declares itself."""

    def _services(self):
        import glob
        import json5
        from pathlib import Path

        repo_root = Path(__file__).resolve().parents[5]
        for path in sorted(glob.glob(str(repo_root / 'nodes/src/nodes/*/services.json'))):
            # Never swallowed: a service that fails to load would silently drop out
            # of the sweep below and leave it passing on nothing.
            with open(path, encoding='utf-8') as fh:
                yield Path(path).parent.name, json5.load(fh)

    def test_no_declared_key_is_reported_as_a_mistake(self):
        offenders = []
        checked = 0
        for node, service in self._services():
            checked += 1
            keys = Config._knownConfigKeys(service)
            for key in keys:
                suggestion = Config._suggestKey(key, keys)
                if suggestion:
                    offenders.append(f'{node}: {key} -> {suggestion}')
        assert checked > 50, f'only {checked} services.json files found — the sweep is not running'
        assert not offenders, 'Valid keys flagged as mistakes:\n' + '\n'.join(offenders)

    def test_the_motivating_typo_is_still_caught(self):
        for node, service in self._services():
            if node == 'llm_openai':
                assert Config._suggestKey('outputTokens', Config._knownConfigKeys(service)) == 'modelOutputTokens'
                return
        raise AssertionError('llm_openai/services.json not found')

    def test_common_node_name_does_not_trigger_a_typo_warning(self, monkeypatch):
        said = []
        monkeypatch.setattr('ai.common.config.warning', said.append)
        for node, service in self._services():
            Config._warnMisnamedKeys(node, service, {'name': 'My display label'})
        assert said == []


@pytest.mark.parametrize('expose_tools, allow_write', [(False, False), (True, False), (True, True), (False, True)])
@pytest.mark.parametrize('nested', [False, True])
def test_vector_display_name_and_tool_settings_remain_independent(monkeypatch, expose_tools, allow_write, nested):
    """The editor's display label must not invalidate any tool-toggle combination."""
    repo_root = Path(__file__).resolve().parents[5]
    service = json5.loads((repo_root / 'nodes/src/nodes/rocketride_vector/services.json').read_text(encoding='utf-8'))
    said = []
    monkeypatch.setattr('ai.common.config.getServiceDefinition', lambda _node: service)
    monkeypatch.setattr('ai.common.config.warning', said.append)
    settings = {'serverName': 'custom_vector', 'expose_tools': expose_tools, 'allow_write': allow_write}
    config = {'profile': 'cloud', 'name': 'My display label'}
    config.update({'cloud': settings} if nested else settings)

    resolved = Config.getNodeConfig('rocketride_vector', config)

    assert said == []
    assert resolved['name'] == 'My display label'
    assert resolved['serverName'] == 'custom_vector'
    assert resolved['expose_tools'] is expose_tools
    assert resolved['allow_write'] is allow_write


def test_node_name_does_not_suppress_real_tool_name_typo(monkeypatch):
    said = []
    monkeypatch.setattr('ai.common.config.warning', said.append)
    Config._warnMisnamedKeys(
        'rocketride_vector',
        {'fields': {'rrvector.serverName': {'type': 'string'}}},
        {'name': 'My display label', 'serverNam': 'custom_vector'},
    )
    assert len(said) == 1
    assert '"serverNam"' in said[0]
    assert '"serverName"' in said[0]
