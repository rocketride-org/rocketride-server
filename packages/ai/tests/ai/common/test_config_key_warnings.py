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


class TestSuggestKey:
    def test_dropped_prefix_is_the_case_this_exists_for(self):
        keys = Config._knownConfigKeys(SERVICE)
        assert Config._suggestKey('outputTokens', keys) == 'modelOutputTokens'
        assert Config._suggestKey('totalTokens', keys) == 'modelTotalTokens'

    def test_a_real_key_is_not_flagged(self):
        keys = Config._knownConfigKeys(SERVICE)
        for key in ('model', 'modelTotalTokens', 'modelOutputTokens', 'apikey'):
            assert Config._suggestKey(key, keys) is None

    def test_case_differences_are_not_a_mistake(self):
        assert Config._suggestKey('MODELOUTPUTTOKENS', Config._knownConfigKeys(SERVICE)) is None

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
            try:
                with open(path, encoding='utf-8') as fh:
                    yield Path(path).parent.name, json5.load(fh)
            except Exception:
                continue

    def test_no_declared_key_is_reported_as_a_mistake(self):
        offenders = []
        for node, service in self._services():
            keys = Config._knownConfigKeys(service)
            for key in keys:
                suggestion = Config._suggestKey(key, keys)
                if suggestion:
                    offenders.append(f'{node}: {key} -> {suggestion}')
        assert not offenders, 'Valid keys flagged as mistakes:\n' + '\n'.join(offenders)

    def test_the_motivating_typo_is_still_caught(self):
        for node, service in self._services():
            if node == 'llm_openai':
                assert Config._suggestKey('outputTokens', Config._knownConfigKeys(service)) == 'modelOutputTokens'
                return
        raise AssertionError('llm_openai/services.json not found')
