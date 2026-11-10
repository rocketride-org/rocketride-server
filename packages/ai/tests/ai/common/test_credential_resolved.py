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


def test_the_error_is_an_unresolved_credential_error():
    with pytest.raises(UnresolvedCredentialError, match='no variable named ROCKETRIDE_NEBIUS_KEY was found'):
        check_credential_resolved('llm_nebius', 'apikey', '${ROCKETRIDE_NEBIUS_KEY}')


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
