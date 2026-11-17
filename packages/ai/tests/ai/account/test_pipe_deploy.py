"""Unit tests for ai.account.pipe_deploy: the publish row source.

ONE read of the one publish table per project (plan 10.1, C.17); the slots
come back in the caller's order. A failing store raises; a name is never
reported absent because the database was down (audit 2026-11-12).
"""

from unittest.mock import AsyncMock

import pytest

from ai.account.pipe_deploy import PUBLIC_AUDIENCE_KEY, publish_rows


def _row(audience, version=1, state='enabled', artifact_state='ready', billing=''):
    """One publish row as publish_of_app answers it."""
    return {
        'kind': 'pipe',
        'audience': audience,
        'version': version,
        'state': state,
        'artifactState': artifact_state,
        'billingTeamId': billing,
    }


@pytest.mark.asyncio
async def test_a_failing_publish_read_raises_instead_of_reading_as_no_rows():
    """publish_of_app failing is the caller's error, not an empty row set."""
    account = AsyncMock()
    account.publish_of_app = AsyncMock(side_effect=RuntimeError('db down'))

    with pytest.raises(RuntimeError, match='db down'):
        await publish_rows(account, 'org-1', 'docBrain', ['team-1'])


@pytest.mark.asyncio
async def test_one_read_answers_every_slot_in_the_callers_order():
    """The project's rows are read ONCE; the slots asked for come back in order."""
    account = AsyncMock()
    account.publish_of_app = AsyncMock(
        return_value=[
            _row({'type': 'public', 'id': ''}, version=3, artifact_state='ready'),
            _row({'type': 'team', 'id': 'team-1'}, version=2, billing='team-1'),
            _row({'type': 'user', 'id': 'u-1'}, version=1, artifact_state='private', billing='team-home'),
            _row({'type': 'team', 'id': 'team-9'}, version=2),
        ]
    )

    rows = await publish_rows(account, 'org-1', 'docBrain', ['user~u-1', 'team-1', PUBLIC_AUDIENCE_KEY])

    account.publish_of_app.assert_awaited_once_with('org-1', 'pipe', 'docBrain')
    assert [(r.slot, r.version, r.artifact_state, r.billing_team_id) for r in rows] == [
        ('user~u-1', 1, 'private', 'team-home'),
        ('team-1', 2, 'ready', 'team-1'),
        (PUBLIC_AUDIENCE_KEY, 3, 'ready', ''),
    ]
    assert all(r.kind == 'pipe' and r.org_id == 'org-1' and r.project_id == 'docBrain' for r in rows)


@pytest.mark.asyncio
async def test_a_slot_without_a_row_yields_nothing():
    """A team that holds no publication of the name is skipped, not an error."""
    account = AsyncMock()
    account.publish_of_app = AsyncMock(return_value=[_row({'type': 'team', 'id': 'team-1'})])

    rows = await publish_rows(account, 'org-1', 'docBrain', ['team-2', PUBLIC_AUDIENCE_KEY])

    assert rows == []
