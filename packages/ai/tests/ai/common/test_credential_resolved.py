# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
A credential that still holds a placeholder fails with the missing variable's name.

The task keeps a ${ROCKETRIDE_*} it has no value for as-is, so without this check the
placeholder text goes to the provider as the key and the user reads "Incorrect API key
provided" instead of which variable to add.
"""

import pytest

from ai.common.config import UnresolvedCredentialError, check_credential_resolved, warn_if_credential_unresolved


@pytest.mark.parametrize('value', ['sk-live-key', '', None, 42, {'nested': '${ROCKETRIDE_X}'}])
def test_a_resolved_or_absent_value_passes(value):
    check_credential_resolved('llm_openai', 'apikey', value)


def test_an_unresolved_placeholder_names_the_variable_to_add():
    with pytest.raises(ValueError) as caught:
        check_credential_resolved('llm_openai', 'apikey', '${ROCKETRIDE_OPENAI_KEY}')

    message = str(caught.value)
    assert message.startswith('llm_openai: apikey is set to ${ROCKETRIDE_OPENAI_KEY}')
    assert 'no variable named ROCKETRIDE_OPENAI_KEY was found' in message
    assert 'Add ROCKETRIDE_OPENAI_KEY to the org, team or user environment variables' in message
    assert '*' not in message


def test_a_placeholder_inside_a_longer_value_is_caught():
    with pytest.raises(ValueError, match='no variable named ROCKETRIDE_KEY_PART was found'):
        check_credential_resolved('embedding_openai', 'apikey', 'sk-${ROCKETRIDE_KEY_PART}')


def test_a_variable_outside_the_namespace_says_only_rocketride_names_resolve():
    with pytest.raises(ValueError) as caught:
        check_credential_resolved('llm_openai', 'apikey', '<REDACTED>')

    assert 'does not start with ROCKETRIDE_' in str(caught.value)
    # The engine splits error text on '*', which would cut the message short.
    assert '*' not in str(caught.value)


def test_a_placeholder_the_pipeline_wrote_names_the_variable_to_add():
    written = {'profile': 'custom', 'custom': {'apikey': '${ROCKETRIDE_OPENAI_KEY}'}}
    with pytest.raises(ValueError, match='no variable named ROCKETRIDE_OPENAI_KEY was found'):
        check_credential_resolved('llm_openai', 'apikey', '${ROCKETRIDE_OPENAI_KEY}', written)


def test_a_placeholder_from_a_profile_default_says_to_set_it_in_the_node():
    # Nebius profiles default apikey to ${ROCKETRIDE_NEBIUS_KEY}. Only the pipeline's own
    # text is resolved, so a saved ROCKETRIDE_NEBIUS_KEY does not fill a default; telling
    # the user to add the variable would be wrong.
    written = {'profile': 'llama-3-3-70b', 'llama-3-3-70b': {}}
    with pytest.raises(ValueError) as caught:
        check_credential_resolved('llm_nebius', 'apikey', '${ROCKETRIDE_NEBIUS_KEY}', written)

    message = str(caught.value)
    assert message.startswith('llm_nebius: apikey is the profile default ${ROCKETRIDE_NEBIUS_KEY}')
    assert 'Set apikey to ${ROCKETRIDE_NEBIUS_KEY} in the node settings' in message
    assert 'no variable named' not in message
    assert '*' not in message


def test_the_same_placeholder_in_another_profile_does_not_count_as_written(monkeypatch):
    # The active profile (qwen3) leaves apikey to its default; only an inactive block
    # spells the placeholder, and that block is not the one in use.
    written = {'profile': 'qwen3', 'llama': {'apikey': '${ROCKETRIDE_NEBIUS_KEY}'}, 'qwen3': {}}
    with pytest.raises(ValueError, match='is the profile default'):
        check_credential_resolved('llm_nebius', 'apikey', '${ROCKETRIDE_NEBIUS_KEY}', written)


def test_a_top_level_value_counts_as_written():
    written = {'profile': 'qwen3', 'qwen3': {}, 'apikey': '${ROCKETRIDE_NEBIUS_KEY}'}
    with pytest.raises(ValueError, match='no variable named ROCKETRIDE_NEBIUS_KEY was found'):
        check_credential_resolved('llm_nebius', 'apikey', '${ROCKETRIDE_NEBIUS_KEY}', written)


def test_the_service_default_profile_is_the_active_one_when_none_is_set(monkeypatch):
    import ai.common.config as config_module

    monkeypatch.setattr(config_module, 'getServiceDefinition', lambda _: {'preconfig': {'default': 'llama'}})
    written = {'llama': {'apikey': '${ROCKETRIDE_NEBIUS_KEY}'}}
    with pytest.raises(ValueError, match='no variable named ROCKETRIDE_NEBIUS_KEY was found'):
        check_credential_resolved('llm_nebius', 'apikey', '${ROCKETRIDE_NEBIUS_KEY}', written)


@pytest.mark.parametrize(
    'written',
    [['not', 'a', 'config'], {'profile': 'llama', 'llama': 'not a block'}],
    ids=['config-not-a-mapping', 'active-block-not-a-mapping'],
)
def test_a_config_that_cannot_be_read_gets_the_general_message(written):
    """Do not guess "profile default" when the written config cannot be read."""
    with pytest.raises(UnresolvedCredentialError, match='no variable named ROCKETRIDE_NEBIUS_KEY was found'):
        check_credential_resolved('llm_nebius', 'apikey', '${ROCKETRIDE_NEBIUS_KEY}', written)


def test_the_error_is_a_value_error_so_existing_handlers_still_catch_it():
    with pytest.raises(ValueError):
        check_credential_resolved('llm_openai', 'apikey', '${ROCKETRIDE_OPENAI_KEY}')


def test_a_save_time_check_warns_and_says_to_skip_the_probe(monkeypatch):
    import ai.common.config as config_module

    warned = []
    monkeypatch.setattr(config_module, 'warning', warned.append)

    assert warn_if_credential_unresolved('llm_openai', 'apikey', '${ROCKETRIDE_OPENAI_KEY}') is True
    assert warned and 'no variable named ROCKETRIDE_OPENAI_KEY was found' in warned[0]


def test_a_save_time_check_lets_a_filled_key_through(monkeypatch):
    import ai.common.config as config_module

    warned = []
    monkeypatch.setattr(config_module, 'warning', warned.append)

    assert warn_if_credential_unresolved('llm_openai', 'apikey', 'sk-live-key') is False
    assert warned == []
