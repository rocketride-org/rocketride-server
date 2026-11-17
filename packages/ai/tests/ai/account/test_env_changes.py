# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""The env write both servers parse: env_changes and check_env_changes in ai.account.base."""

import pytest

from ai.account.base import ENV_MASK, check_env_changes, env_changes

LEGACY = 'ROCKETRIDE_MY KEY'


def test_a_write_merges_values_and_deletes():
    changes = env_changes({'env': {'ROCKETRIDE_A': 'a', 'ROCKETRIDE_B': ENV_MASK}, 'delete': ['ROCKETRIDE_C']})

    assert changes == {'ROCKETRIDE_A': 'a', 'ROCKETRIDE_B': ENV_MASK, 'ROCKETRIDE_C': None}


@pytest.mark.parametrize('value', [None, ENV_MASK])
def test_a_name_the_rule_no_longer_takes_can_be_deleted_or_kept(value):
    check_env_changes({LEGACY: value})


def test_a_name_the_rule_no_longer_takes_cannot_get_a_new_value():
    with pytest.raises(ValueError, match='ROCKETRIDE_MY KEY'):
        check_env_changes({LEGACY: 'new'})


@pytest.mark.parametrize('value', [None, ENV_MASK, 'new'])
def test_a_name_outside_the_prefix_is_refused_whatever_its_value(value):
    with pytest.raises(ValueError, match='OPENAI_API_KEY'):
        check_env_changes({'OPENAI_API_KEY': value})


def test_a_name_both_set_and_deleted_is_refused_with_its_name_only():
    with pytest.raises(ValueError, match='ROCKETRIDE_A') as error:
        env_changes({'env': {'ROCKETRIDE_A': 'sk-secret'}, 'delete': ['ROCKETRIDE_A']})

    assert 'sk-secret' not in str(error.value)


def test_a_value_typed_after_the_mask_is_refused():
    with pytest.raises(ValueError, match='begins with the mask'):
        check_env_changes({'ROCKETRIDE_A': ENV_MASK + 'sk-new'})


@pytest.mark.parametrize(
    'args',
    [{'env': []}, {'delete': 'ROCKETRIDE_A'}, {'delete': [1]}, {'env': {'ROCKETRIDE_A': 1}}, {'env': {1: 'a'}}],
)
def test_a_malformed_write_is_refused(args):
    with pytest.raises(ValueError, match='nothing was saved'):
        env_changes(args)
