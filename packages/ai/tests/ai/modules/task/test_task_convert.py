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
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

"""
Tests for ``task_convert`` (plan 5.6.8): the old node-config format rewritten to the current one.

Two layers. The rule tests use a synthetic chunker-like schema and legacy
block so each rule is pinned on its own. The corpus tests run the real
engine's definitions over every ``.pipe`` in the repository and assert the
round-trip property the plan asks for: for every old-shape component the
flattened view the node reads is the same before and after, the result
resolves, and converting a second time changes nothing.
"""

import copy
import json
import subprocess
from pathlib import Path

import pytest
import rocketlib
from rocketlib import resolveConfig

from ai.modules.task import task_convert
from ai.modules.task.task_convert import PROFILE_METADATA, convert_pipeline

# ============================================================================
# A synthetic node: the chunker's shape plus one hoisted leaf, a constant and an array
# ============================================================================

SCHEMA = {
    'capabilities': 0,
    'params': [],
    'properties': [
        {
            'name': 'strategy',
            'path': 'strategy',
            'type': 'string',
            'default': 'sentence',
            'enum': {
                'sentence': {
                    'properties': [
                        {'name': 'chunk_size', 'path': 'sentence.chunk_size', 'type': 'integer', 'default': 1000},
                        {'name': 'chunk_overlap', 'path': 'sentence.chunk_overlap', 'type': 'integer', 'default': 200},
                        {'name': 'label', 'path': 'label', 'type': 'string', 'default': 'chunks'},
                    ]
                },
                'token': {
                    'properties': [
                        {'name': 'chunk_size', 'path': 'token.chunk_size', 'type': 'integer', 'default': 512},
                        {'name': 'chunk_overlap', 'path': 'token.chunk_overlap', 'type': 'integer', 'default': 50},
                        {
                            'name': 'encoding_name',
                            'path': 'token.encoding_name',
                            'type': 'string',
                            'default': 'cl100k_base',
                        },
                        {'name': 'label', 'path': 'label', 'type': 'string', 'default': 'chunks'},
                    ]
                },
            },
        },
        {'name': 'type', 'path': 'type', 'type': 'constant', 'default': 'chunker'},
        {'name': 'tags', 'path': 'tags', 'type': 'array', 'item': {'name': 'tag', 'type': 'string'}, 'default': []},
        {'name': 'limit', 'path': 'limit', 'type': 'integer', 'default': 10, 'maximum': 20},
    ],
}

LEGACY = {
    'selector': 'profile',
    'default': 'sentence',
    'profiles': {
        'sentence': {'title': 'Sentence', 'strategy': 'sentence', 'chunk_size': 1000, 'chunk_overlap': 200},
        'token': {
            'title': 'Token',
            'strategy': 'token',
            'chunk_size': 512,
            'chunk_overlap': 50,
            'encoding_name': 'cl100k_base',
        },
        'legacy_fast': {'title': 'Fast', 'strategy': 'token', 'chunk_size': 256, 'deprecated': True},
    },
    'dropped': ['parameters', 'provider'],
    'renamed': {'tag_list': 'tags', 'fast': {'to': 'strategy', 'values': {'true': 'token', 'false': 'sentence'}}},
}

RAW = {'title': 'Text Chunker', 'legacy': LEGACY}


def lookup(provider):
    if provider == 'chunker':
        return SCHEMA, RAW
    if provider == 'plain':
        return {'capabilities': 0, 'params': [], 'properties': [{'name': 'x', 'path': 'x', 'type': 'string'}]}, {
            'title': 'Plain'
        }
    return None, None


def pipe(config, provider='chunker', **extra):
    component = {'id': 'chunker_1', 'provider': provider, 'name': 'Chunker', 'config': config}
    component.update(extra)
    return {'name': 'Test', 'project_id': 'test', 'components': [component]}


def convert(config, **extra):
    return convert_pipeline(pipe(config, **extra), lookup)


def config_of(result):
    return result.pipeline['components'][0]['config']


# ============================================================================
# Pipeline-level rules
# ============================================================================


OLD = {'profile': 'token', 'token': {'chunk_size': 400}}


def test_a_converted_pipeline_is_named_from_its_project_id_when_it_has_no_name():
    result = convert_pipeline(
        {'project_id': 'docBrain', 'components': [{'id': 'c1', 'provider': 'chunker', 'name': 'C', 'config': OLD}]},
        lookup,
    )
    assert result.touched and result.pipeline['name'] == 'docBrain'
    assert any('had no name' in w['message'] for w in result.warnings)


def test_a_converted_component_is_named_from_the_node_title_when_it_has_no_name():
    result = convert_pipeline({'name': 'T', 'components': [{'id': 'c1', 'provider': 'chunker', 'config': OLD}]}, lookup)
    assert result.pipeline['components'][0]['name'] == 'Text Chunker'
    assert any(w.get('id') == 'c1' and 'named it' in w['message'] for w in result.warnings)


def test_a_current_pipeline_is_not_rewritten_for_a_missing_name_but_warned():
    result = convert_pipeline(
        {'project_id': 'p', 'components': [{'id': 'c1', 'provider': 'chunker', 'config': {}}]}, lookup
    )
    assert not result.touched and 'name' not in result.pipeline and 'name' not in result.pipeline['components'][0]
    assert {w['message'] for w in result.warnings} == {'the pipeline has no name', 'the component has no name'}


@pytest.mark.parametrize('bad', ['a.b', 'a/b', '', 'with space'])
def test_a_component_id_must_be_one_dot_free_segment(bad):
    result = convert_pipeline({'name': 'T', 'components': [{'id': bad, 'provider': 'plain', 'config': {}}]}, lookup)
    assert result.errors and 'B5' in result.errors[0]['message']


def test_a_deleted_provider_is_an_error_not_a_conversion():
    result = convert_pipeline({'name': 'T', 'components': [{'id': 'a1', 'provider': 'autopipe', 'config': {}}]}, lookup)
    assert result.errors[0]['id'] == 'a1' and 'removed' in result.errors[0]['message']


def test_an_unknown_provider_is_left_to_the_engine():
    """The engine's structural validation names an unknown node; the converter adds no second error."""
    result = convert_pipeline(
        {'name': 'T', 'components': [{'id': 'a1', 'provider': 'nope', 'name': 'n', 'config': {'k': 1}}]}, lookup
    )
    assert not result.errors and not result.touched


def test_the_input_is_never_mutated():
    original = pipe({'profile': 'token', 'token': {'chunk_size': 400}})
    snapshot = copy.deepcopy(original)
    convert_pipeline(original, lookup)
    assert original == snapshot


# ============================================================================
# Detection and idempotency
# ============================================================================


def test_a_new_format_config_is_untouched():
    result = convert({'strategy': 'token', 'token': {'chunk_size': 400}})
    assert not result.touched and not result.errors
    assert config_of(result) == {'strategy': 'token', 'token': {'chunk_size': 400}}


def test_a_node_without_a_legacy_block_is_untouched():
    result = convert({'x': 'kept'}, provider='plain')
    assert not result.touched and config_of(result) == {'x': 'kept'}


def test_converting_twice_changes_nothing():
    first = convert({'profile': 'token', 'token': {'chunk_size': 400, 'encoding_name': 'o200k_base'}, 'parameters': {}})
    again = convert_pipeline(first.pipeline, lookup)
    assert first.touched and not first.errors
    assert not again.touched and not again.errors and again.pipeline == first.pipeline


# ============================================================================
# The shape rules
# ============================================================================


def test_the_profile_block_lands_under_the_branch_and_defaults_are_not_written():
    result = convert(
        {'profile': 'token', 'token': {'chunk_size': 400, 'chunk_overlap': 50, 'encoding_name': 'o200k_base'}}
    )
    assert config_of(result) == {'strategy': 'token', 'token': {'chunk_size': 400, 'encoding_name': 'o200k_base'}}


def test_flat_keys_follow_the_active_profile():
    result = convert({'profile': 'token', 'chunk_size': 400})
    assert config_of(result) == {'strategy': 'token', 'token': {'chunk_size': 400}}


def test_a_missing_profile_key_uses_the_old_default_profile():
    result = convert({'chunk_size': 800})
    assert config_of(result) == {'sentence': {'chunk_size': 800}}


def test_the_selector_is_omitted_when_it_equals_the_new_default():
    result = convert({'profile': 'sentence', 'sentence': {'chunk_size': 800}})
    assert 'strategy' not in config_of(result)


def test_the_top_level_key_wins_over_the_profile_block():
    result = convert({'profile': 'token', 'token': {'chunk_size': 400}, 'chunk_size': 300})
    assert config_of(result)['token']['chunk_size'] == 300


def test_a_hoisted_leaf_lands_at_the_root():
    result = convert({'profile': 'token', 'token': {'label': 'pieces'}})
    assert config_of(result) == {'strategy': 'token', 'label': 'pieces'}


def test_an_inactive_profile_block_that_names_a_branch_is_kept_as_it_is():
    """Plan 5.6.2: the switched-away block survives, unvalidated, so switching back finds it."""
    result = convert({'profile': 'token', 'sentence': {'chunk_size': 9}, 'token': {'chunk_size': 400}})
    assert config_of(result) == {'strategy': 'token', 'sentence': {'chunk_size': 9}, 'token': {'chunk_size': 400}}


def test_an_inactive_profile_block_with_no_branch_is_dropped():
    result = convert({'profile': 'token', 'legacy_fast': {'chunk_size': 9}, 'token': {'chunk_size': 400}})
    assert config_of(result) == {'strategy': 'token', 'token': {'chunk_size': 400}}


def test_dropped_keys_and_the_parameters_stub_go_silently():
    result = convert({'profile': 'token', 'token': {'chunk_size': 400}, 'parameters': {}, 'provider': 'x'})
    assert not result.errors and config_of(result) == {'strategy': 'token', 'token': {'chunk_size': 400}}
    assert not [w for w in result.warnings if 'parameters' in w['message']]


def test_a_renamed_key_moves_to_its_new_leaf():
    result = convert({'profile': 'token', 'tag_list': ['a', 'b']})
    assert config_of(result)['tags'] == ['a', 'b']


def test_a_boolean_rename_chooses_the_branch_by_its_value_map():
    # No old `profile` key: the old merge applied the default profile (sentence,
    # chunk_overlap 200) under the user's keys, so the node read 200; the
    # converter writes it because the token branch defaults to 50
    result = convert({'fast': True, 'chunk_size': 400})
    assert config_of(result) == {'strategy': 'token', 'token': {'chunk_size': 400, 'chunk_overlap': 200}}


def test_a_selector_value_of_the_wrong_type_is_an_error_not_a_crash():
    result = convert({'profile': 'sentence', 'strategy': ['token']})
    assert [e['message'] for e in result.errors] == [
        "strategy=['token'] is not one of ['sentence', 'token'] of chunker"
    ]


def test_a_selector_value_that_contradicts_the_other_keys_is_an_error():
    result = convert({'profile': 'sentence', 'strategy': 'token', 'fast': False})
    assert any('contradicts' in e['message'] for e in result.errors)


def test_a_constant_marker_is_kept_and_a_stale_override_is_dropped_with_a_warning():
    kept = convert({'profile': 'token', 'type': 'chunker'})
    assert config_of(kept)['type'] == 'chunker'
    stale = convert({'profile': 'token', 'type': 'other'})
    assert 'type' not in config_of(stale) and any('fixed by the node' in w['message'] for w in stale.warnings)


def test_empty_strings_are_omitted():
    result = convert({'profile': 'token', 'token': {'encoding_name': ''}})
    assert config_of(result) == {'strategy': 'token'}


def test_values_are_clamped_with_a_warning_and_whole_floats_become_integers():
    clamped = convert({'profile': 'token', 'limit': 99})
    assert config_of(clamped)['limit'] == 20 and any('clamped' in w['message'] for w in clamped.warnings)
    whole = convert({'profile': 'token', 'limit': 15.0})
    assert config_of(whole)['limit'] == 15 and isinstance(config_of(whole)['limit'], int)


def test_a_value_of_the_wrong_type_is_never_guessed_at():
    """A string where the schema wants a list stays what it is; the resolver names it."""
    result = convert({'profile': 'token', 'tags': 'a, b'})
    assert result.errors and 'does not resolve' in result.errors[0]['message']


def test_a_retired_profile_takes_the_branch_its_values_name():
    result = convert({'profile': 'legacy_fast', 'legacy_fast': {'chunk_size': 128}})
    assert config_of(result) == {'strategy': 'token', 'token': {'chunk_size': 128}}


def test_an_unknown_profile_is_an_error():
    result = convert({'profile': 'nope'})
    assert result.errors and "'nope'" in result.errors[0]['message']


def test_an_unknown_key_is_an_error_naming_it_and_the_component_keeps_its_config():
    config = {'profile': 'token', 'token': {'chunk_size': 400}, 'mystery': 1}
    result = convert(config)
    assert result.errors[0]['id'] == 'chunker_1' and "'mystery'" in result.errors[0]['message']
    assert config_of(result) == config


def test_a_key_of_another_branch_is_kept_under_that_branch():
    result = convert({'profile': 'sentence', 'encoding_name': 'o200k_base'})
    assert config_of(result) == {'token': {'encoding_name': 'o200k_base'}}


def test_the_users_own_selector_value_chooses_the_branch_without_an_old_profile():
    result = convert({'strategy': 'token', 'chunk_size': 400, 'parameters': {}})
    assert config_of(result) == {'strategy': 'token', 'token': {'chunk_size': 400, 'chunk_overlap': 200}}


def test_the_result_resolves_like_the_node_reads_it():
    result = convert({'profile': 'token', 'token': {'chunk_size': 400}})
    view = resolveConfig(SCHEMA, config_of(result))
    assert view.strategy == 'token' and view.chunk_size == 400 and view.chunk_overlap == 50


# ============================================================================
# The corpus: every .pipe in the repository against the real definitions
# ============================================================================

# packages/ai/tests/ai/modules/task/<this file>: six parents up is the repository root
REPO = Path(__file__).resolve().parents[6]


def _repo_pipes():
    """Every tracked .pipe in the repository; empty when git is unavailable (the corpus test then skips visibly)."""
    try:
        listed = subprocess.run(['git', '-C', str(REPO), 'ls-files', '*.pipe'], capture_output=True, text=True)
    except OSError:
        return []
    if listed.returncode != 0:
        return []
    return [REPO / line.strip() for line in listed.stdout.splitlines() if line.strip()]


CORPUS = _repo_pipes() or [
    pytest.param(None, id='no-corpus', marks=pytest.mark.skip(reason='git ls-files found no .pipe'))
]


def _old_shape(component, legacy):
    config = component.get('config') or {}
    profiles = legacy.get('profiles') or {}
    return 'profile' in config or any(isinstance(config.get(p), dict) for p in profiles)


@pytest.mark.skipif(rocketlib.getServiceSchema('chunker') is None, reason='the engine definitions are not loaded')
@pytest.mark.parametrize('path', CORPUS, ids=lambda p: str(p.relative_to(REPO)) if p else 'none')
def test_every_repository_pipe_round_trips(path):
    """Old-shape components read the same after conversion; the result resolves and is stable."""
    with open(path, encoding='utf-8') as fh:
        doc = json.load(fh)
    pipeline = doc.get('pipeline', doc)
    result = convert_pipeline(pipeline)
    # The example files carry a few genuine defects (a profile that never
    # existed, a hand-added key, a credential that is required now); those are
    # the converter's errors, and a component with an error keeps its config
    errored = {e.get('id') for e in result.errors}
    converted = {c['id']: c for c in result.pipeline['components'] if isinstance(c, dict)}
    for component in pipeline.get('components', []):
        if not isinstance(component, dict) or component.get('id') in errored:
            continue
        raw = rocketlib.getServiceDefinition(component.get('provider')) or {}
        legacy = raw.get('legacy')
        if not legacy or not _old_shape(component, legacy):
            continue
        config = component.get('config') or {}
        profiles = legacy.get('profiles') or {}
        profile = config.get('profile', legacy.get('default'))
        old = {k: v for k, v in (profiles.get(profile) or {}).items() if k not in PROFILE_METADATA}
        if isinstance(config.get(profile), dict):
            old.update(config[profile])
        old.update(
            {
                k: v
                for k, v in config.items()
                if k != 'profile' and not (k in profiles and isinstance(v, dict)) and v is not None
            }
        )
        schema = rocketlib.getServiceSchema(component['provider'])
        view = resolveConfig(schema, converted[component['id']].get('config') or {})
        skip = set(legacy.get('dropped') or []) | set(legacy.get('renamed') or {}) | set(legacy.get('credential') or {})
        skip |= task_convert.OLD_EDITOR_STAMPS | task_convert.COMBO_BLOCKS | task_convert.OWNED_KEYS
        for key, value in old.items():
            short = key.split('.')[-1]
            if (
                f'{profile}.{key}' in skip
                or key in skip
                or short in skip
                or value in ('', None)
                or isinstance(value, dict)
            ):
                continue
            if short in view:
                assert view[short] == value or str(view[short]) == str(value), f'{component["id"]}.{key}'
    again = convert_pipeline(result.pipeline)
    assert again.errors == result.errors
    if not result.errors:
        assert not again.touched and again.pipeline == result.pipeline


@pytest.mark.skipif(rocketlib.getServiceSchema('chunker') is None, reason='the engine definitions are not loaded')
def test_the_repository_examples_convert_with_only_the_known_defects():
    """The example files' remaining errors are the ones the plan records, nothing else."""
    allowed = ('is not one of the old profiles', 'has no place', 'is required')
    unexpected = []
    for path in _repo_pipes():
        with open(path, encoding='utf-8') as fh:
            doc = json.load(fh)
        result = convert_pipeline(doc.get('pipeline', doc))
        unexpected += [(path.name, e['message']) for e in result.errors if not any(a in e['message'] for a in allowed)]
    assert unexpected == []


# ============================================================================
# The cases CodeRabbit raised on PR 3307, pinned on the real definitions
# ============================================================================


def _one(provider, config):
    pipeline = {
        'name': 'T',
        'project_id': 't',
        'components': [{'id': 'c1', 'provider': provider, 'name': 'C', 'config': config}],
    }
    result = convert_pipeline(pipeline)
    return result, result.pipeline['components'][0]['config']


def _view(provider, config):
    return dict(resolveConfig(rocketlib.getServiceSchema(provider), config))


engine = pytest.mark.skipif(
    rocketlib.getServiceSchema('chunker') is None, reason='the engine definitions are not loaded'
)


@engine
def test_an_explicit_model_wins_over_the_profile_map():
    # audio_transcribe: profileMap default->base, but the user wrote model=small
    result, config = _one('audio_transcribe', {'profile': 'default', 'model': 'small'})
    assert not result.errors and _view('audio_transcribe', config)['model'] == 'small'


@engine
def test_a_selector_value_that_is_no_branch_is_refused_not_replaced():
    result, _ = _one('audio_transcribe', {'profile': 'default', 'model': 'large'})
    assert [e['message'] for e in result.errors] == [
        "model='large' is not one of ['base', 'large-v3', 'medium', 'small', 'tiny'] of audio_transcribe"
    ]


@engine
def test_a_profiles_values_that_differ_from_the_new_defaults_are_carried():
    # context_optimizer ci_tiny -> manual: the budget percentages and the token cap come from the profile
    result, config = _one('context_optimizer', {'profile': 'ci_tiny'})
    view = _view('context_optimizer', config)
    assert not result.errors and view['mode'] == 'manual'
    assert (
        view['max_context_tokens'],
        view['document_budget_pct'],
        view['history_budget_pct'],
        view['query_budget_pct'],
    ) == (
        112,
        35,
        35,
        20,
    )


@engine
def test_the_landing_ai_profile_schema_file_is_carried():
    result, config = _one('landing_ai_extract', {'profile': 'default', 'api_key': 'k'})
    assert not result.errors and _view('landing_ai_extract', config)['schema_file'].startswith('{"type":"object"')


@engine
def test_the_memory_persistent_custom_profile_keeps_its_no_expiry_ttl():
    result, config = _one('memory_persistent', {'profile': 'custom', 'custom': {'redis_host': 'r'}})
    view = _view('memory_persistent', config)
    assert not result.errors and view['backend'] == 'redis' and view['session_ttl_hours'] == 0
    assert config == {'backend': 'redis', 'redis': {'redis_host': 'r', 'session_ttl_hours': 0}}


@engine
def test_the_mcp_client_profile_server_name_is_carried_and_an_explicit_one_wins():
    result, config = _one('mcp_client', {'profile': 'RocketRide'})
    assert not result.errors and _view('mcp_client', config)['serverName'] == 'RocketRide'
    result, config = _one('mcp_client', {'profile': 'RocketRide', 'serverName': 'mine'})
    assert not result.errors and _view('mcp_client', config)['serverName'] == 'mine'


@engine
def test_a_profile_qualified_dropped_key_goes_silently_from_the_profile_block():
    result, config = _one('scan_cropper', {'profile': 'album', 'album': {'tune': 3}})
    assert not result.errors and not result.warnings and config == {}


@engine
def test_the_nested_and_the_dotted_old_auth_group_convert_the_same():
    nested, config_nested = _one('opensearch', {'auth': {'enabled': True, 'username': 'u', 'password': 'p'}})
    dotted, config_dotted = _one('opensearch', {'auth.enabled': True, 'auth.username': 'u', 'auth.password': 'p'})
    assert not nested.errors and not dotted.errors and nested.touched and dotted.touched
    assert config_nested == config_dotted == {'basic': {'username': 'u', 'password': 'p'}}
    assert _view('opensearch', config_nested)['auth'] == 'basic'
    off, config_off = _one('opensearch', {'auth': {'enabled': False}})
    assert not off.errors and _view('opensearch', config_off)['auth'] == 'none'


@engine
def test_a_nested_selectors_branch_leaves_convert_to_that_branch():
    # tool_n8n: `webhookAuth` is a second selector; webhookToken lives under bearer and under jwt
    result, config = _one('tool_n8n', {'profile': 'default', 'webhookAuth': 'bearer', 'webhookToken': 't'})
    assert not result.errors and config == {'webhookAuth': 'bearer', 'bearer': {'webhookToken': 't'}}
    result, config = _one('tool_n8n', {'profile': 'default', 'default': {'webhookAuth': 'jwt', 'webhookToken': 't'}})
    assert not result.errors and config == {'webhookAuth': 'jwt', 'jwt': {'webhookToken': 't'}}
    assert _view('tool_n8n', config)['webhookToken'] == 't'


@engine
def test_an_open_group_is_placed_whole_and_judged_by_the_resolver():
    # The tools endpoint's `parameters` group declares no members; the converter
    # keeps the object as one value and the node's resolver has the last word
    result, config = _one('tools', {'profile': 'default', 'parameters': {}})
    assert not result.errors and config == {}
    result, config = _one('tools', {'profile': 'default', 'parameters': {'query': {'type': 'string'}}})
    assert [e['message'] for e in result.errors] == [
        'the converted config of tools does not resolve: unknown config key "parameters.query"'
    ]
