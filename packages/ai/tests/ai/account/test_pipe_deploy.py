"""Unit tests for ai.account.pipe_deploy: the publish row source.

ONE read of the one publish table per project (plan 10.1, C.17); the slots
come back in the caller's order. A failing store raises; a name is never
reported absent because the database was down (audit 2026-11-12).
"""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

import ai.account.pipe_deploy as pipe_deploy_mod
from ai.account import account as account_singleton
from ai.account.pipe_deploy import PUBLIC_AUDIENCE_KEY, pipe_catalog_row, publish_rows, resolve_pipe_version


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


# ==== The catalog row (plan 9, C.17b) ==========================================

LISTED_ENTRY = {
    'version': 3,
    'metadata': {
        'manifest': {
            'name': 'Doc Brain',
            'description': 'Reads',
            'defaultSource': 'webhook_1',
            'tagline': 'Reads documents',
            'categories': ['documents'],
            'tags': ['ocr'],
            'icon': 'icon.svg',
            'readme': 'docs/README.md',
            'links': {'homepage': 'https://example.com'},
            'mode': 'subscription',
            'billing': {'plans': [{'nickname': 'Pro'}]},
        }
    },
}


def test_a_listed_version_is_a_catalog_row_with_versioned_urls():
    """The app row's field names (pricing surfaces as ``mode`` alone, like an app row; the plans
    stay on the manifest for the approve path); icon and readme are the version's immutable URLs.
    """
    assert pipe_catalog_row('acme.docBrain', LISTED_ENTRY) == {
        'id': 'acme.docBrain',
        'name': 'Doc Brain',
        'publisher': 'acme',
        'description': 'Reads',
        'defaultSource': 'webhook_1',
        'tagline': 'Reads documents',
        'categories': ['documents'],
        'tags': ['ocr'],
        'links': {'homepage': 'https://example.com'},
        'mode': 'subscription',
        'version': 3,
        'icon': '/pipelines/acme.docBrain/v3/icon.svg',
        'readme': '/pipelines/acme.docBrain/v3/docs/README.md',
    }


def test_an_undeclared_icon_and_readme_are_omitted_from_the_row():
    manifest = {**LISTED_ENTRY['metadata']['manifest'], 'icon': '', 'readme': ''}
    row = pipe_catalog_row('acme.docBrain', {'version': 3, 'metadata': {'manifest': manifest}})
    assert 'icon' not in row and 'readme' not in row


def test_an_unlisted_version_has_no_catalog_row():
    """A dict deploy without a store block: the backends' synthesized name-only manifest lists nothing."""
    assert pipe_catalog_row('acme.docBrain', {'version': 3, 'metadata': {'manifest': {'name': 'Doc Brain'}}}) is None
    assert pipe_catalog_row('acme.docBrain', {'version': 3, 'metadata': {}}) is None
    assert pipe_catalog_row('acme.docBrain', {'version': 3}) is None


# ==== The serving resolver =====================================================


def _pin_row(version=3, artifact_state='ready', state='enabled'):
    return _row({'type': 'public', 'id': ''}, version=version, state=state, artifact_state=artifact_state)


@pytest.mark.asyncio
async def test_anonymous_resolution_is_the_publishers_public_row_alone(monkeypatch):
    """No caller: the publisher org is found through the developer id, and only a 'ready' public row serves."""
    monkeypatch.setattr(account_singleton, 'get_org_of_developer_id', AsyncMock(return_value='org-9'), raising=False)
    monkeypatch.setattr(account_singleton, 'publish_of_app', AsyncMock(return_value=[_pin_row()]), raising=False)

    pin = await resolve_pipe_version(None, 'acme.docBrain')

    assert (pin.rung, pin.version, pin.deployment.org_id) == ('public', 3, 'org-9')
    account_singleton.publish_of_app.assert_awaited_once_with('org-9', 'pipe', 'acme.docBrain')

    monkeypatch.setattr(
        account_singleton, 'publish_of_app', AsyncMock(return_value=[_pin_row(artifact_state='submit')])
    )
    assert await resolve_pipe_version(None, 'acme.docBrain') is None


@pytest.mark.asyncio
async def test_a_caller_gets_the_first_pin_and_a_bad_name_is_nothing(monkeypatch):
    """Authenticated: resolve_pins answers; a malformed name or a source address is a None, never an error."""
    first = SimpleNamespace(version=2)
    monkeypatch.setattr(pipe_deploy_mod, 'resolve_pins', AsyncMock(return_value=SimpleNamespace(first=first)))
    info = SimpleNamespace(userId='u1')

    assert await resolve_pipe_version(info, 'acme.docBrain') is first
    assert await resolve_pipe_version(info, 'acme.docBrain.chat') is None
    assert await resolve_pipe_version(info, 'not a name') is None
    assert await resolve_pipe_version(None, 'acme') is None
