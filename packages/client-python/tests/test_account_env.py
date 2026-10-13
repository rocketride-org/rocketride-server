# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""account.set_env wire shape (saas#809): values go in `env`, deletions in a
`delete` list. A server with the old full-replacement contract ignores the
list instead of storing None as a value; the write-only server applies it.
"""

import asyncio
from unittest.mock import AsyncMock

from rocketride.account import AccountApi


def _api():
    client = AsyncMock()
    client.call = AsyncMock(return_value={})
    return AccountApi(client), client


def test_set_env_splits_none_into_the_delete_list():
    api, client = _api()

    asyncio.run(api.set_env('user', {'ROCKETRIDE_A': 'a', 'ROCKETRIDE_B': None, 'ROCKETRIDE_C': '••••••••'}))

    client.call.assert_awaited_once_with(
        'rrext_account_me',
        subcommand='set_env',
        env={'ROCKETRIDE_A': 'a', 'ROCKETRIDE_C': '••••••••'},
        delete=['ROCKETRIDE_B'],
    )


def test_set_env_sends_an_empty_delete_list_when_nothing_is_removed():
    api, client = _api()

    asyncio.run(api.set_env('team', {'ROCKETRIDE_A': 'a'}, scope_id='team-1'))

    client.call.assert_awaited_once_with(
        'rrext_account_teams', subcommand='set_env', env={'ROCKETRIDE_A': 'a'}, delete=[], teamId='team-1'
    )
