"""
Live integration tests for tool_pipedrive.

Calls every Pipedrive API v1 endpoint group the node exposes. Everything the
tests create is deleted again, but they still write to a real account — point
them at a sandbox, never at production data.

    export PIPEDRIVE_API_TOKEN=<your token>
    export PIPEDRIVE_COMPANY_DOMAIN=<yourcompany>     # optional
    export PIPEDRIVE_ALLOW_WRITES=1                   # opt in to create/delete tests
    pytest nodes/test/tool_pipedrive/test_tools.py -v

Without PIPEDRIVE_API_TOKEN the whole module is skipped. Read-only endpoints run
with just the token; the create/update/delete tests additionally require
PIPEDRIVE_ALLOW_WRITES=1.
"""

from __future__ import annotations

import os
import sys
import uuid
from pathlib import Path

import pytest

# Import through the node package, as test_pipedrive.py does. Inserting the node
# directory itself would publish `pipedrive_client` under a second, generic module
# identity, so a run collecting both files would load the same source twice.
_NODES_SRC = str(Path(__file__).resolve().parents[2] / 'src' / 'nodes')
while _NODES_SRC in sys.path:
    sys.path.remove(_NODES_SRC)
sys.path.insert(0, _NODES_SRC)
from tool_pipedrive.pipedrive_client import (  # noqa: E402
    PipedriveAPIError,
    base_url_for,
    base_url_v2_for,
    call,
    call_envelope,
)

TOKEN = os.getenv('PIPEDRIVE_API_TOKEN', '')
DOMAIN = os.getenv('PIPEDRIVE_COMPANY_DOMAIN', '')
ALLOW_WRITES = os.getenv('PIPEDRIVE_ALLOW_WRITES', '') == '1'
BASE = base_url_for(DOMAIN)
#: Search moved to v2 when Pipedrive retired the v1 search routes.
BASE_V2 = base_url_v2_for(DOMAIN)

pytestmark = pytest.mark.skipif(not TOKEN, reason='PIPEDRIVE_API_TOKEN must be set')

writes = pytest.mark.skipif(
    not ALLOW_WRITES, reason='PIPEDRIVE_ALLOW_WRITES=1 must be set to run tests that create records'
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def c(method, path, *, params=None, body=None):
    return call(TOKEN, method, path, base_url=BASE, params=params, body=body)


def envelope(method, path, *, params=None):
    return call_envelope(TOKEN, method, path, base_url=BASE, params=params)


def c_v2(method, path, *, params=None, body=None):
    return call(TOKEN, method, path, base_url=BASE_V2, params=params, body=body)


def envelope_v2(method, path, *, params=None):
    return call_envelope(TOKEN, method, path, base_url=BASE_V2, params=params)


def uid(prefix):
    return f'{prefix}-rocketride-test-{uuid.uuid4().hex[:8]}'


@pytest.fixture(scope='module')
def person():
    """A throwaway person, deleted at the end of the module."""
    created = c('POST', '/persons', body={'name': uid('person')})
    yield created
    c('DELETE', f'/persons/{created["id"]}')


@pytest.fixture(scope='module')
def organization():
    created = c('POST', '/organizations', body={'name': uid('org')})
    yield created
    c('DELETE', f'/organizations/{created["id"]}')


@pytest.fixture(scope='module')
def deal(person):
    created = c('POST', '/deals', body={'title': uid('deal'), 'person_id': person['id']})
    yield created
    c('DELETE', f'/deals/{created["id"]}')


# ---------------------------------------------------------------------------
# Account
# ---------------------------------------------------------------------------


class TestAccount:
    def test_users_me(self):
        me = c('GET', '/users/me')
        assert me['id']

    def test_user_list(self):
        assert isinstance(c('GET', '/users'), list)

    def test_user_settings(self):
        assert isinstance(c('GET', '/userSettings'), dict)

    def test_currencies(self):
        assert any(cur.get('code') for cur in c('GET', '/currencies'))

    def test_pagination_envelope(self):
        env = envelope('GET', '/deals', params={'limit': 1})
        assert env['success'] is True
        assert 'additional_data' in env


# ---------------------------------------------------------------------------
# Read-only listings — every group's list endpoint
# ---------------------------------------------------------------------------


class TestListings:
    @pytest.mark.parametrize(
        'path',
        [
            '/deals',
            '/persons',
            '/organizations',
            '/activities',
            '/activityTypes',
            '/activityFields',
            '/pipelines',
            '/stages',
            '/notes',
            '/noteFields',
            '/leads',
            '/leadLabels',
            '/leadSources',
            '/products',
            '/productFields',
            '/dealFields',
            '/personFields',
            '/organizationFields',
            '/files',
            '/filters',
            '/webhooks',
            '/roles',
            '/permissionSets',
            '/teams',
            '/callLogs',
            '/projects',
            '/projects/boards',
            '/projectTemplates',
            '/tasks',
        ],
    )
    def test_list_endpoint_answers(self, path):
        data = c('GET', path, params={'limit': 1} if path not in ('/pipelines', '/activityTypes') else None)
        assert data is not None

    def test_mail_threads(self):
        # Mailbox is only populated when email sync is on; a 4xx here is a config
        # signal, not a client bug, so only assert the call is well-formed.
        try:
            data = c('GET', '/mailbox/mailThreads', params={'folder': 'inbox', 'limit': 1})
        except ValueError as exc:
            pytest.skip(f'mailbox not available on this account: {exc}')
        assert data is not None


# ---------------------------------------------------------------------------
# Search
# ---------------------------------------------------------------------------


class TestSearch:
    """Search lives on /api/v2 — Pipedrive retired the v1 routes.

    Run this against the sandbox to confirm the v2 contract before trusting the
    node's search tools:

        PIPEDRIVE_API_TOKEN=... PIPEDRIVE_COMPANY_DOMAIN=... \\
            python -m pytest nodes/test/tool_pipedrive/test_tools.py -k Search -v
    """

    def test_item_search(self):
        env = envelope_v2('GET', '/itemSearch', params={'term': 'a', 'limit': 1})
        assert 'items' in (env.get('data') or {})

    def test_item_search_by_field(self):
        """v2 renamed ``field_type`` to ``entity_type`` and swapped ``exact_match`` for ``match``."""
        data = c_v2(
            'GET',
            '/itemSearch/field',
            params={'term': 'a', 'entity_type': 'deal', 'field_key': 'title', 'limit': 1},
        )
        assert data is not None

    def test_deal_search(self):
        env = envelope_v2('GET', '/deals/search', params={'term': 'a', 'limit': 1})
        assert 'items' in (env.get('data') or {})

    def test_person_search(self):
        env = envelope_v2('GET', '/persons/search', params={'term': 'a', 'limit': 1})
        assert 'items' in (env.get('data') or {})

    def test_organization_search(self):
        env = envelope_v2('GET', '/organizations/search', params={'term': 'a', 'limit': 1})
        assert 'items' in (env.get('data') or {})

    def test_lead_search(self):
        env = envelope_v2('GET', '/leads/search', params={'term': 'a', 'limit': 1})
        assert 'items' in (env.get('data') or {})

    def test_product_search(self):
        env = envelope_v2('GET', '/products/search', params={'term': 'a', 'limit': 1})
        assert 'items' in (env.get('data') or {})

    def test_v2_pages_with_a_cursor_not_an_offset(self):
        """Pins the field name the node's paginated_v2 reads."""
        env = envelope_v2('GET', '/persons/search', params={'term': 'a', 'limit': 1})
        additional = env.get('additional_data') or {}
        assert 'pagination' not in additional, 'v2 should not carry the v1 offset block'
        # next_cursor is absent on a final page, so only assert the shape when present.
        if additional:
            assert set(additional) <= {'next_cursor'}, f'unexpected v2 pagination keys: {sorted(additional)}'

    @pytest.mark.parametrize(
        'path',
        ['/itemSearch', '/deals/search', '/persons/search', '/organizations/search'],
    )
    def test_v1_search_is_gone(self, path):
        """Documents why the node moved. Delete this class of test if Pipedrive restores v1."""
        with pytest.raises(PipedriveAPIError) as exc:
            call_envelope(TOKEN, 'GET', path, base_url=BASE, params={'term': 'a', 'limit': 1})
        assert exc.value.status_code == 404

    def test_recents_stays_on_v1(self):
        """Non-search v1 endpoints were never affected."""
        data = c('GET', '/recents', params={'since_timestamp': '2020-01-01 00:00:00', 'limit': 1})
        assert data is not None


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------


class TestReporting:
    def test_deal_summary(self):
        assert 'total_count' in c('GET', '/deals/summary')

    def test_deal_timeline(self):
        data = c(
            'GET',
            '/deals/timeline',
            params={'start_date': '2026-01-01', 'interval': 'month', 'amount': 1, 'field_key': 'add_time'},
        )
        assert isinstance(data, list)

    def test_pipeline_conversion_statistics(self):
        pipelines = c('GET', '/pipelines')
        assert pipelines, 'account has no pipelines'
        stats = c(
            'GET',
            f'/pipelines/{pipelines[0]["id"]}/conversion_statistics',
            params={'start_date': '2026-01-01', 'end_date': '2026-12-31'},
        )
        assert 'stage_conversions' in stats

    def test_pipeline_movement_statistics(self):
        pipelines = c('GET', '/pipelines')
        assert pipelines, 'account has no pipelines'
        stats = c(
            'GET',
            f'/pipelines/{pipelines[0]["id"]}/movement_statistics',
            params={'start_date': '2026-01-01', 'end_date': '2026-12-31'},
        )
        assert stats is not None


# ---------------------------------------------------------------------------
# Write paths
# ---------------------------------------------------------------------------


@writes
class TestPersonLifecycle:
    def test_create_update_delete(self):
        created = c('POST', '/persons', body={'name': uid('person'), 'email': [{'value': 'a@example.com'}]})
        try:
            assert created['id']
            updated = c('PUT', f'/persons/{created["id"]}', body={'name': 'renamed'})
            assert updated['name'] == 'renamed'
            fetched = c('GET', f'/persons/{created["id"]}')
            assert fetched['id'] == created['id']
        finally:
            c('DELETE', f'/persons/{created["id"]}')


@writes
class TestDealLifecycle:
    def test_create_update_delete(self, person):
        created = c('POST', '/deals', body={'title': uid('deal'), 'person_id': person['id'], 'value': 100})
        try:
            assert created['id']
            updated = c('PUT', f'/deals/{created["id"]}', body={'value': 250})
            assert float(updated['value']) == 250
        finally:
            c('DELETE', f'/deals/{created["id"]}')

    def test_related_collections(self, deal):
        for suffix in ('activities', 'files', 'flow', 'participants', 'followers', 'persons', 'permittedUsers'):
            assert c('GET', f'/deals/{deal["id"]}/{suffix}') is not None

    def test_participants_and_followers(self, deal, person):
        me = c('GET', '/users/me')
        participant = c('POST', f'/deals/{deal["id"]}/participants', body={'person_id': person['id']})
        follower = c('POST', f'/deals/{deal["id"]}/followers', body={'user_id': me['id']})
        try:
            assert participant is not None
            assert follower['id']
        finally:
            c('DELETE', f'/deals/{deal["id"]}/followers/{follower["id"]}')


@writes
class TestOrganization:
    def test_create_and_relate(self, organization, person):
        c('PUT', f'/persons/{person["id"]}', body={'org_id': organization['id']})
        persons = c('GET', f'/organizations/{organization["id"]}/persons')
        assert any(p['id'] == person['id'] for p in persons or [])


@writes
class TestActivities:
    def test_create_complete_delete(self, deal):
        created = c(
            'POST',
            '/activities',
            body={'subject': uid('activity'), 'type': 'call', 'deal_id': deal['id'], 'due_date': '2026-12-31'},
        )
        try:
            done = c('PUT', f'/activities/{created["id"]}', body={'done': 1})
            assert done['done'] is True
        finally:
            c('DELETE', f'/activities/{created["id"]}')


@writes
class TestNotes:
    def test_create_comment_delete(self, deal):
        note = c('POST', '/notes', body={'content': 'rocketride test note', 'deal_id': deal['id']})
        try:
            assert note['id']
            comment = c('POST', f'/notes/{note["id"]}/comments', body={'content': 'a comment'})
            assert comment['uuid'] or comment['id']
            assert c('GET', f'/notes/{note["id"]}/comments') is not None
        finally:
            c('DELETE', f'/notes/{note["id"]}')


@writes
class TestLeads:
    def test_create_update_delete(self, person):
        lead = c('POST', '/leads', body={'title': uid('lead'), 'person_id': person['id']})
        try:
            assert lead['id']
            updated = c('PATCH', f'/leads/{lead["id"]}', body={'title': 'renamed lead'})
            assert updated['title'] == 'renamed lead'
        finally:
            c('DELETE', f'/leads/{lead["id"]}')


@writes
class TestProducts:
    def test_create_attach_delete(self, deal):
        product = c('POST', '/products', body={'name': uid('product'), 'prices': [{'currency': 'USD', 'price': 10}]})
        attachment = None
        try:
            attachment = c(
                'POST',
                f'/deals/{deal["id"]}/products',
                body={'product_id': product['id'], 'item_price': 10, 'quantity': 2},
            )
            assert attachment['id']
            attached = c('GET', f'/deals/{deal["id"]}/products')
            assert any(row['product_id'] == product['id'] for row in attached or [])
        finally:
            if attachment:
                c('DELETE', f'/deals/{deal["id"]}/products/{attachment["id"]}')
            c('DELETE', f'/products/{product["id"]}')


@writes
class TestFiles:
    def test_upload_download_delete(self, deal):
        import io

        import requests

        name = f'{uid("file")}.txt'
        payload = b'rocketride pipedrive test file'
        response = requests.post(
            f'{BASE}/files',
            params={'api_token': TOKEN},
            data={'deal_id': deal['id']},
            files={'file': (name, io.BytesIO(payload))},
            timeout=30,
        )
        response.raise_for_status()
        file_id = response.json()['data']['id']
        try:
            downloaded = call(TOKEN, 'GET', f'/files/{file_id}/download', base_url=BASE, raw=True)
            assert downloaded == payload
        finally:
            c('DELETE', f'/files/{file_id}')


@writes
class TestFilters:
    def test_create_and_delete(self):
        # Resolve a real deal field rather than assuming id 1 exists and is a
        # status field — on a fresh sandbox that assumption fails as a client
        # error instead of a skip.
        fields = c('GET', '/dealFields') or []
        status_field = next((f for f in fields if f.get('key') == 'status'), None)
        if status_field is None:
            pytest.skip('account exposes no "status" deal field to filter on')
        conditions = {
            'glue': 'and',
            'conditions': [
                {
                    'glue': 'and',
                    'conditions': [
                        {'object': 'deal', 'field_id': str(status_field['id']), 'operator': '=', 'value': 'open'}
                    ],
                },
                {'glue': 'or', 'conditions': []},
            ],
        }
        created = c('POST', '/filters', body={'name': uid('filter'), 'type': 'deals', 'conditions': conditions})
        try:
            assert created['id']
            assert c('GET', f'/filters/{created["id"]}')['id'] == created['id']
        finally:
            c('DELETE', f'/filters/{created["id"]}')

    def test_helpers(self):
        assert c('GET', '/filters/helpers') is not None


@writes
class TestWebhooks:
    def test_create_and_delete(self):
        created = c(
            'POST',
            '/webhooks',
            body={
                'subscription_url': 'https://example.com/rocketride-test-hook',
                'event_action': 'updated',
                'event_object': 'deal',
            },
        )
        try:
            assert created['id']
            assert any(w['id'] == created['id'] for w in c('GET', '/webhooks'))
        finally:
            c('DELETE', f'/webhooks/{created["id"]}')


@writes
class TestCustomFields:
    def test_create_and_delete_deal_field(self):
        created = c('POST', '/dealFields', body={'name': uid('field'), 'field_type': 'varchar'})
        try:
            assert len(created['key']) == 40
        finally:
            c('DELETE', f'/dealFields/{created["id"]}')


@writes
class TestCallLogs:
    def test_create_and_delete(self, person):
        created = c(
            'POST',
            '/callLogs',
            body={
                'outcome': 'connected',
                'to_phone_number': '+15550000000',
                'start_time': '2026-07-26T10:00:00Z',
                'end_time': '2026-07-26T10:01:00Z',
                'person_id': person['id'],
            },
        )
        try:
            assert created['id']
        finally:
            c('DELETE', f'/callLogs/{created["id"]}')


@writes
class TestProjects:
    def test_create_and_delete(self):
        boards = c('GET', '/projects/boards')
        if not boards:
            pytest.skip('account has no project boards')
        phases = c('GET', '/projects/phases', params={'board_id': boards[0]['id']})
        if not phases:
            pytest.skip('board has no phases')
        created = c(
            'POST',
            '/projects',
            body={'title': uid('project'), 'board_id': boards[0]['id'], 'phase_id': phases[0]['id']},
        )
        task = None
        try:
            assert created['id']
            task = c('POST', '/tasks', body={'title': uid('task'), 'project_id': created['id']})
            assert task['id']
            assert c('GET', f'/projects/{created["id"]}/plan') is not None
        finally:
            if task:
                c('DELETE', f'/tasks/{task["id"]}')
            c('DELETE', f'/projects/{created["id"]}')


# ---------------------------------------------------------------------------
# Error handling against the live API
# ---------------------------------------------------------------------------


class TestErrors:
    def test_missing_record_raises(self):
        with pytest.raises(ValueError) as exc:
            c('GET', '/deals/999999999')
        assert 'Pipedrive API' in str(exc.value)

    def test_bad_token_raises(self):
        with pytest.raises(ValueError) as exc:
            call('not-a-real-token', 'GET', '/users/me', base_url=BASE)
        assert 'Pipedrive API 40' in str(exc.value)
