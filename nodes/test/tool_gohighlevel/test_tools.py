# =============================================================================
# RocketRide Engine
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""
Live integration tests for tool_gohighlevel.

Calls the real GoHighLevel v2 API at https://services.leadconnectorhq.com through the
node's own tool methods, so the request shapes, the response cleaners, the pagination
envelope and the error mapping are all exercised against what GoHighLevel actually
sends rather than against a stub. That is the point of this file: the stubbed suite can
only prove the node is self-consistent, and every disagreement between the two lives
here.

    export GHL_PIT=<sub-account Private Integration Token>
    export GHL_LOCATION_ID=<the sub-account id the token is scoped to>
    export GHL_ALLOW_WRITES=1          # optional, enables the create/delete lifecycles
    pytest nodes/test/tool_gohighlevel/test_tools.py -v

Everything skips without GHL_PIT and GHL_LOCATION_ID. The write tests skip separately
without GHL_ALLOW_WRITES=1, and every record they create is removed in a finally block.

Rate limits are measured rather than assumed: a sub-account Private Integration Token
gets 25 requests per 10 seconds (the 429 lands on request 26) and 10,000 per day, not
the 100 per 10s published for marketplace apps. Every request this file makes goes
through one pacer that spaces them out, so the suite cannot trip the limiter it is
here to observe. Do not run it with pytest-xdist: parallel workers each get their own
pacer and share one budget.
"""

from __future__ import annotations

import os
import sys
import time
import types
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
import requests

# ---------------------------------------------------------------------------
# Import scaffolding
#
# The node imports ``rocketlib`` (engine-only, needs the native engLib) and
# ``ai.common.utils`` (which imports rocketlib in turn), so neither is available when
# this file runs standalone. rocketlib is stubbed the way the offline node suites stub
# it, and ``ai.common.utils`` is loaded from its real source file on top of that stub,
# because the argument validation in it is part of what this suite is checking. Both
# stubs, and the ``tool_gohighlevel`` package alias, are removed again once the node is
# imported: this module shares a pytest session with every other node's tests and a
# half-built ``ai.common`` left in sys.modules would shadow the real package for
# whoever imports it next.
# ---------------------------------------------------------------------------

_NODE_DIR = Path(__file__).resolve().parents[2] / 'src' / 'nodes' / 'tool_gohighlevel'
_TOOL_ARGS = (
    Path(__file__).resolve().parents[3] / 'packages' / 'ai' / 'src' / 'ai' / 'common' / 'utils' / 'tool_args.py'
)
_MISSING = object()
_SCAFFOLD = ('rocketlib', 'ai', 'ai.common', 'ai.common.utils', 'ai.common.config', 'tool_gohighlevel')


def _tool_function(**meta):
    """Stand-in for rocketlib's decorator that keeps the metadata the node reads back."""

    def wrap(fn):
        fn.__tool_meta__ = meta
        return fn

    return wrap


def _install_scaffolding() -> None:
    """Put the engine-only modules the node imports into sys.modules."""
    rocketlib = types.ModuleType('rocketlib')
    rocketlib.IInstanceBase = type('IInstanceBase', (), {})
    rocketlib.IGlobalBase = type('IGlobalBase', (), {})
    rocketlib.tool_function = _tool_function
    rocketlib.OPEN_MODE = type('OPEN_MODE', (), {'CONFIG': 'config'})
    for name in ('debug', 'error', 'warning'):
        setattr(rocketlib, name, lambda *a, **k: None)
    sys.modules['rocketlib'] = rocketlib

    for name in ('ai', 'ai.common', 'ai.common.config'):
        sys.modules[name] = types.ModuleType(name)
    sys.modules['ai.common.config'].Config = type('Config', (), {'getNodeConfig': staticmethod(lambda *a, **k: {})})

    # The real validators, not a passthrough: _args() rejecting an undeclared parameter
    # is node behaviour, and a stub would quietly stop testing it.
    import importlib.util

    spec = importlib.util.spec_from_file_location('ai.common.utils', _TOOL_ARGS)
    utils = importlib.util.module_from_spec(spec)
    sys.modules['ai.common.utils'] = utils
    spec.loader.exec_module(utils)

    package = types.ModuleType('tool_gohighlevel')
    package.__path__ = [str(_NODE_DIR)]
    sys.modules['tool_gohighlevel'] = package


_ORIGINAL = {name: sys.modules.get(name, _MISSING) for name in _SCAFFOLD}
try:
    _install_scaffolding()
    from tool_gohighlevel import gohighlevel_client as ghl  # noqa: E402
    from tool_gohighlevel.IGlobal import IGlobal  # noqa: E402
    from tool_gohighlevel.IInstance import IInstance  # noqa: E402
    from tool_gohighlevel.tool_groups import ALL_GROUPS  # noqa: E402
finally:
    # The node submodules these imports created (tool_gohighlevel.gohighlevel_client,
    # .IGlobal, .IInstance, .tool_groups, .tools.*) are removed along with the scaffold:
    # they were built against the stubs installed above, and the offline suite imports the
    # same names in the same pytest session, so leaving them cached would hand it whatever
    # this file installed, with the outcome depending on collection order. The references
    # this module holds keep the objects alive.
    for _name in [key for key in sys.modules if key == 'tool_gohighlevel' or key.startswith('tool_gohighlevel.')]:
        sys.modules.pop(_name, None)
    for _name, _module in _ORIGINAL.items():
        if _module is _MISSING:
            sys.modules.pop(_name, None)
        else:
            sys.modules[_name] = _module


# ---------------------------------------------------------------------------
# Credentials and gates
# ---------------------------------------------------------------------------

TOKEN = os.getenv('GHL_PIT', '')
LOCATION = os.getenv('GHL_LOCATION_ID', '')
ALLOW_WRITES = os.getenv('GHL_ALLOW_WRITES') == '1'

pytestmark = pytest.mark.skipif(
    not TOKEN or not LOCATION,
    reason='GHL_PIT and GHL_LOCATION_ID must both be set',
)

writes = pytest.mark.skipif(
    not ALLOW_WRITES,
    reason='GHL_ALLOW_WRITES=1 must be set: these tests create, change and delete real records',
)

#: Obviously fake, so secret scanners have nothing to find. Used for the 401 probe.
BAD_TOKEN = 'pit-gohighlevel-live-suite-not-a-real-token'

#: Suffix on every record this suite creates, so a run that dies between create and
#: cleanup leaves something searchable behind rather than something anonymous.
UID = uuid.uuid4().hex[:8]


# ---------------------------------------------------------------------------
# Rate-limit pacing
#
# Measured on this credential: x-ratelimit-max 25 with
# x-ratelimit-interval-milliseconds 10000, and a deliberately fired burst put the 429
# on request 26. That is 2.5 requests per second, so every request the suite makes is
# spaced 0.5s apart, serially. The pacer wraps the ``requests`` module reference inside
# the client rather than the client functions themselves, so retries, redirects and the
# raw request tool are all paced too and nothing in the node changes behaviour.
# ---------------------------------------------------------------------------

MIN_INTERVAL = 0.5

#: Response headers of the most recent call, for the rate-limit assertions.
LAST_HEADERS: dict = {}


class _PacedRequests:
    """The ``requests`` module, with a floor on the interval between requests."""

    def __init__(self, real, min_interval: float):
        self._real = real
        self._min_interval = min_interval
        self._last = 0.0
        self.count = 0

    def request(self, method, url, **kwargs):
        wait = self._min_interval - (time.monotonic() - self._last)
        if wait > 0:
            time.sleep(wait)
        response = self._real.request(method, url, **kwargs)
        self._last = time.monotonic()
        self.count += 1
        LAST_HEADERS.clear()
        LAST_HEADERS.update(response.headers)
        return response

    def __getattr__(self, name):
        return getattr(self._real, name)


PACER = _PacedRequests(requests, MIN_INTERVAL)


@pytest.fixture(scope='session', autouse=True)
def _pace_requests():
    """Install the pacer for this suite and put the real ``requests`` reference back after.

    Assigning ``ghl.requests`` at import time would leave the pacer inside the client module
    for the rest of the pytest session, and the offline suite imports the same module objects.
    """
    original = ghl.requests
    ghl.requests = PACER
    yield
    ghl.requests = original


# ---------------------------------------------------------------------------
# Mismatch log
#
# A live response that disagrees with what the node expects is the whole reason this
# file exists, and not every disagreement is worth failing a test over: the node is
# deliberately tolerant in places (unknown custom-field shapes, absent totals). Those
# are recorded here and printed at the end of the session, so a tolerated difference is
# still visible instead of being silently absorbed.
# ---------------------------------------------------------------------------

MISMATCHES: list[str] = []

#: Tools GoHighLevel sent no record count for, so ``total`` is null. Expected on most of
#: this surface and kept apart from the mismatches so it cannot bury them.
NO_TOTAL: list[str] = []


def note(text: str) -> None:
    """Record a live response that differs from what the node expects."""
    if text not in MISMATCHES:
        MISMATCHES.append(text)


@pytest.fixture(scope='session', autouse=True)
def _report_mismatches():
    yield
    print(f'\n\n=== live/code mismatches ({len(MISMATCHES)}) ===')
    for line in MISMATCHES or ['none']:
        print(f'  - {line}')
    print(f'=== tools that reported no total ({len(NO_TOTAL)}) ===')
    print(f'  {", ".join(sorted(NO_TOTAL)) or "none"}')
    print(f'=== HTTP requests made: {PACER.count} ===')


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def cleanup(action, label: str) -> None:
    """Run a teardown delete, retrying a transport failure before giving up on it.

    A cleanup that dies on a read timeout leaks a record into the sub-account and turns
    a run red for a reason that has nothing to do with the node, and this API times a
    request out often enough to matter. Retried twice, then recorded rather than raised,
    so the leak is named in the report and the run still reports on what it tested.
    """
    for attempt in range(3):
        try:
            action()
            return
        except Exception as exc:  # noqa: BLE001 - a teardown must not mask the test result
            if attempt == 2:
                note(f'cleanup failed for {label}: {exc}')
                return
            time.sleep(2)


def _node(token: str = '', location: str = '', read_only: bool = False) -> IInstance:
    """A node instance wired to the live sub-account, with every tool group published."""
    instance = IInstance()
    state = IGlobal()
    state.token = token or TOKEN
    state.location_id = location or LOCATION
    state.read_only = read_only
    state.tool_groups = ALL_GROUPS
    state.allow_raw_request = True
    instance.IGlobal = state
    return instance


@pytest.fixture(scope='module')
def node() -> IInstance:
    return _node()


@pytest.fixture(scope='module')
def company_id(node) -> str:
    """Agency id, read off the sub-account: GET /users/search requires it and 401s without."""
    location = node.location_get({})
    value = location.get('companyId')
    if not value:
        pytest.skip('the sub-account record carries no companyId')
    return value


@pytest.fixture(scope='module')
def seed_contact_id(node) -> str:
    """Id of a contact that already exists, preferring one with an email on it.

    The email-based reads (contact_search by filter, contact_duplicate_check) need an
    address to look for, and the seed data does not put one on every contact, so the
    contact is chosen rather than taken off the top of the list.
    """
    page = node.contact_list({'limit': 20})
    if not page['items']:
        pytest.skip('the sub-account has no contacts to read')
    with_email = [record for record in page['items'] if record.get('email')]
    if not with_email:
        note('no contact on the first page of contact_list carries an email, so the email reads were skipped')
        return page['items'][0]['id']
    return with_email[0]['id']


@pytest.fixture(scope='module')
def seed_conversation(node) -> dict:
    page = node.conversation_search({'limit': 5})
    if not page['items']:
        pytest.skip('the sub-account has no conversations to read')
    return page['items'][0]


@pytest.fixture(scope='module')
def pipeline(node) -> dict:
    page = node.pipeline_list({})
    if not page['items']:
        pytest.skip('the sub-account has no opportunity pipeline')
    return page['items'][0]


@pytest.fixture(scope='module')
def temp_contact(node) -> dict:
    """A contact created for this run and deleted afterwards."""
    if not ALLOW_WRITES:
        pytest.skip('GHL_ALLOW_WRITES=1 must be set')
    contact = node.contact_create(
        {
            'firstName': 'RocketRide',
            'lastName': f'Live {UID}',
            'email': f'rocketride-live-{UID}@example.com',
            'phone': '+15005550001',
            'source': 'rocketride live suite',
        }
    )
    try:
        yield contact
    finally:
        cleanup(lambda: node.contact_delete({'contactId': contact['id']}), f'contact {contact["id"]}')


@pytest.fixture(scope='module')
def temp_calendar(node) -> dict:
    """A calendar created for this run and deleted afterwards.

    A fresh sub-account has none, and the appointment tools cannot be exercised without
    one, so the calendar group of tests builds its own subject rather than skipping.
    """
    if not ALLOW_WRITES:
        pytest.skip('GHL_ALLOW_WRITES=1 must be set')
    calendar = node.calendar_create({'name': f'RocketRide live {UID}', 'slotDuration': 30})
    try:
        yield calendar
    finally:
        cleanup(lambda: node.calendar_delete({'calendarId': calendar['id']}), f'calendar {calendar["id"]}')


@pytest.fixture(scope='module')
def temp_appointment(node, temp_calendar, temp_contact) -> dict:
    """An appointment booked on the temporary calendar for the temporary contact."""
    start = datetime.now(timezone.utc).astimezone() + timedelta(days=2)
    start = start.replace(minute=0, second=0, microsecond=0)
    appointment = node.appointment_create(
        {
            'calendarId': temp_calendar['id'],
            'contactId': temp_contact['id'],
            'startTime': start.isoformat(timespec='seconds'),
            'title': f'RocketRide live {UID}',
            'ignoreFreeSlotValidation': True,
            'toNotify': False,
        }
    )
    try:
        yield appointment
    finally:
        cleanup(lambda: node.appointment_delete({'eventId': appointment['id']}), f'appointment {appointment["id"]}')


# ---------------------------------------------------------------------------
# Shared assertions
# ---------------------------------------------------------------------------


def check_page(result: dict, tool: str, requested_limit: int | None = None) -> list:
    """Assert the paginated envelope this node returns, and hand back the records.

    The envelope is the node's own invention rather than anything GoHighLevel sends, so
    an agent has nothing else to go on: count has to equal the number of records, and
    next has to be null whenever has_more is false, or an agent that trusts either one
    spends a request discovering an empty page.
    """
    assert set(result) == {'items', 'count', 'total', 'next', 'has_more'}, tool
    assert isinstance(result['items'], list), tool
    assert result['count'] == len(result['items']), tool
    assert isinstance(result['has_more'], bool), tool
    if not result['has_more']:
        assert result['next'] is None, f'{tool}: next is set while has_more is false'
    if requested_limit is not None:
        assert result['count'] <= requested_limit, f'{tool}: returned more records than the limit asked for'
    if result['total'] is None and tool not in NO_TOTAL:
        NO_TOTAL.append(tool)
    return result['items']


# ---------------------------------------------------------------------------
# Listing sweep
# ---------------------------------------------------------------------------

#: Every listing tool that needs no id, with the arguments to call it with. Grouped by
#: tool group so a failure names the area rather than only the tool.
LISTINGS = [
    ('contacts', 'contact_list', {'limit': 5}),
    ('contacts', 'contact_search', {'limit': 5}),
    ('opportunities', 'opportunity_search', {'limit': 5}),
    ('opportunities', 'opportunity_search_advanced', {'limit': 5}),
    ('pipelines', 'pipeline_list', {}),
    ('pipelines', 'lost_reason_list', {}),
    ('conversations', 'conversation_search', {'limit': 5}),
    ('messages', 'message_export', {'limit': 10}),
    ('businesses', 'business_list', {'limit': 5}),
    ('locations', 'location_tasks_search', {'limit': 5}),
    ('location_tags', 'location_tags_list', {}),
    ('custom_fields', 'custom_field_list', {}),
    ('custom_values', 'custom_value_list', {}),
    ('users', 'user_list_by_location', {}),
    ('calendars', 'calendar_list', {}),
    ('calendar_groups', 'calendar_group_list', {}),
]


class TestListings:
    @pytest.mark.parametrize('group,tool,args', LISTINGS, ids=[f'{row[0]}-{row[1]}' for row in LISTINGS])
    def test_listing(self, node, group, tool, args):
        result = getattr(node, tool)(args)
        check_page(result, tool, args.get('limit'))

    def test_user_search_needs_the_company_id(self, node, company_id):
        result = node.user_search({'limit': 5, 'companyId': company_id})
        users = check_page(result, 'user_search', 5)
        assert users, 'a sub-account always has at least one user'
        assert users[0].get('id')


# ---------------------------------------------------------------------------
# Reads that need an id
# ---------------------------------------------------------------------------


class TestContactReads:
    def test_contact_get(self, node, seed_contact_id):
        contact = node.contact_get({'contactId': seed_contact_id})
        assert contact['id'] == seed_contact_id
        assert contact.get('locationId') == LOCATION
        raw = contact.get('customFields')
        if isinstance(raw, list) and raw:
            note('contact_get: customFields came back as a list the node could not project, passed through raw')

    def test_contact_search_by_email_finds_the_same_contact(self, node, seed_contact_id):
        contact = node.contact_get({'contactId': seed_contact_id})
        email = contact.get('email')
        if not email:
            pytest.skip('the seeded contact has no email to search on')
        result = node.contact_search({'limit': 5, 'filters': [{'field': 'email', 'operator': 'eq', 'value': email}]})
        found = check_page(result, 'contact_search', 5)
        assert seed_contact_id in [record['id'] for record in found]

    def test_contact_list_and_search_disagree_about_the_name_casing(self, node, seed_contact_id):
        """Both casing variants are kept because the two routes put the cased name in different keys."""
        listed = node.contact_list({'limit': 100})
        record = next((row for row in listed['items'] if row['id'] == seed_contact_id), None)
        if record is None:
            pytest.skip('the seeded contact is not on the first page of contact_list')
        searched = node.contact_search({'limit': 100})
        other = next((row for row in searched['items'] if row['id'] == seed_contact_id), None)
        if other is None:
            pytest.skip('the seeded contact is not on the first page of contact_search')
        if record.get('firstName') != other.get('firstName'):
            note(
                'contact_list and contact_search return different casing under firstName for the same contact, '
                'which is why _CONTACT_READ_KEYS keeps firstNameRaw and firstNameLowerCase alongside it'
            )

    def test_contact_duplicate_check(self, node, seed_contact_id):
        contact = node.contact_get({'contactId': seed_contact_id})
        email = contact.get('email')
        if not email:
            pytest.skip('the seeded contact has no email to check')
        result = node.contact_duplicate_check({'email': email})
        assert result['found'] is True
        assert result['contact'].get('id') == seed_contact_id

    def test_contact_duplicate_check_on_an_unused_address(self, node):
        result = node.contact_duplicate_check({'email': f'nobody-{UID}@example.com'})
        assert result['found'] is False

    def test_contact_appointments_list(self, node, seed_contact_id):
        result = node.contact_appointments_list({'contactId': seed_contact_id})
        check_page(result, 'contact_appointments_list')
        assert result['next'] is None

    def test_contact_notes_list(self, node, seed_contact_id):
        check_page(node.contact_notes_list({'contactId': seed_contact_id}), 'contact_notes_list')

    def test_contact_tasks_list(self, node, seed_contact_id):
        check_page(node.contact_tasks_list({'contactId': seed_contact_id}), 'contact_tasks_list')

    def test_contact_list_by_business(self, node):
        businesses = node.business_list({'limit': 5})['items']
        if not businesses:
            pytest.skip('the sub-account has no business to list contacts for')
        result = node.contact_list_by_business({'businessId': businesses[0]['id'], 'limit': 5})
        check_page(result, 'contact_list_by_business', 5)


class TestOtherReads:
    def test_location_get(self, node):
        location = node.location_get({})
        assert location['id'] == LOCATION
        assert location.get('companyId')

    def test_location_tasks_search_ids_are_underscore_id(self, node):
        tasks = node.location_tasks_search({'limit': 5})['items']
        if not tasks:
            pytest.skip('the sub-account has no tasks')
        assert '_id' in tasks[0], 'this route is documented to key tasks _id rather than id'
        if 'id' in tasks[0]:
            note('location_tasks_search returned both _id and id, where only _id was documented')

    def test_business_get(self, node):
        businesses = node.business_list({'limit': 5})['items']
        if not businesses:
            pytest.skip('the sub-account has no businesses')
        business = node.business_get({'businessId': businesses[0]['id']})
        assert business['id'] == businesses[0]['id']

    def test_pipeline_stages_carry_ids(self, node, pipeline):
        stages = pipeline.get('stages')
        assert isinstance(stages, list) and stages, 'a pipeline always has stages'
        assert isinstance(stages[0], dict), 'the spec types stages as any[][]; live sends objects'
        assert stages[0].get('id'), 'opportunity_create needs a pipelineStageId out of this'

    def test_opportunity_get(self, node):
        found = node.opportunity_search({'limit': 5})['items']
        if not found:
            pytest.skip('the sub-account has no opportunities')
        opportunity = node.opportunity_get({'opportunityId': found[0]['id']})
        assert opportunity['id'] == found[0]['id']

    def test_conversation_get(self, node, seed_conversation):
        conversation = node.conversation_get({'conversationId': seed_conversation['id']})
        assert conversation['id'] == seed_conversation['id']
        for key in ('contactName', 'email', 'phone'):
            if key in conversation and key not in seed_conversation:
                note(f'conversation_get returned {key}, which the node documents as search-only')

    def test_conversation_dates_are_epoch_milliseconds(self, node, seed_conversation):
        added = seed_conversation.get('dateAdded')
        if added is None:
            pytest.skip('the conversation carries no dateAdded')
        if not isinstance(added, (int, float)):
            note(f'conversation dateAdded is {type(added).__name__}, not the epoch milliseconds documented')

    def test_message_list_and_get(self, node):
        """Walk the conversations until one holds a message: a seeded thread can be empty."""
        conversations = node.conversation_search({'limit': 5})['items']
        if not conversations:
            pytest.skip('the sub-account has no conversations')
        messages: list = []
        for conversation in conversations:
            result = node.message_list({'conversationId': conversation['id'], 'limit': 5})
            messages = check_page(result, 'message_list', 5)
            if messages:
                break
        if not messages:
            pytest.skip('none of the first five conversations holds a message')
        message_id = messages[0].get('id')
        assert message_id, 'a message always carries an id'
        message = node.message_get({'messageId': message_id})
        assert message.get('id') == message_id

    def test_user_get(self, node):
        users = node.user_list_by_location({})['items']
        if not users:
            pytest.skip('the sub-account has no users')
        user = node.user_get({'userId': users[0]['id']})
        assert user['id'] == users[0]['id']

    def test_calendar_group_slug_check(self, node):
        result = node.calendar_group_slug_check({'slug': f'rocketride-live-{UID}'})
        assert isinstance(result, dict)


# ---------------------------------------------------------------------------
# Write lifecycles
# ---------------------------------------------------------------------------


@writes
class TestContactLifecycle:
    def test_create_update_get(self, node, temp_contact):
        assert temp_contact['id']
        assert temp_contact.get('email') == f'rocketride-live-{UID}@example.com'
        updated = node.contact_update({'contactId': temp_contact['id'], 'city': 'Cupertino'})
        assert updated['id'] == temp_contact['id']
        fetched = node.contact_get({'contactId': temp_contact['id']})
        assert fetched.get('city') == 'Cupertino'

    def test_update_rejects_the_create_only_fields(self, node, temp_contact):
        """The create DTO declares companyName and the update DTO does not, so the node refuses it locally."""
        with pytest.raises(ValueError, match='unknown parameter'):
            node.contact_update({'contactId': temp_contact['id'], 'companyName': 'Nope'})

    def test_tags_add_and_remove(self, node, temp_contact):
        """Adding an unknown tag name also defines it on the sub-account, and removing it does not undo that."""
        name = f'rocketride-live-{UID}'
        added = node.contact_tags_add({'contactId': temp_contact['id'], 'tags': [name]})
        try:
            assert name in added['tags'], 'a tag write answers with the whole tag list'
            removed = node.contact_tags_remove({'contactId': temp_contact['id'], 'tags': [name]})
            assert name not in removed['tags']
            leftover = [tag for tag in node.location_tags_list({})['items'] if tag.get('name') == name]
            assert leftover, 'the tag definition outlives the contact it was added to'
            note(
                'contact_tags_add defines an unknown tag name on the sub-account and contact_tags_remove leaves '
                'that definition behind, so a run that tags with a fresh name grows the sub-account tag list. '
                'Only location_tags_delete removes it. Undocumented by GoHighLevel; both tool descriptions and '
                'the node README say so.'
            )
        finally:
            for tag in node.location_tags_list({})['items']:
                if tag.get('name') == name:
                    cleanup(lambda tag_id=tag['id']: node.location_tags_delete({'tagId': tag_id}), f'tag {tag["id"]}')

    def test_tags_cannot_be_smuggled_through_extra(self, node, temp_contact):
        with pytest.raises(ValueError, match='cannot be sent through'):
            node.contact_update({'contactId': temp_contact['id'], 'extra': {'tags': ['nope']}})

    def test_followers_add_and_remove(self, node, temp_contact):
        users = node.user_list_by_location({})['items']
        if not users:
            pytest.skip('the sub-account has no users to follow with')
        user_id = users[0]['id']
        added = node.contact_followers_add({'contactId': temp_contact['id'], 'followers': [user_id]})
        assert user_id in added['followers']
        removed = node.contact_followers_remove({'contactId': temp_contact['id'], 'followers': [user_id]})
        assert user_id not in removed['followers']

    def test_upsert_matches_the_existing_contact(self, node, temp_contact):
        result = node.contact_upsert({'email': f'rocketride-live-{UID}@example.com', 'city': 'Sunnyvale'})
        assert result['contact']['id'] == temp_contact['id'], 'upsert on a known email must update, not duplicate'
        assert result['new'] is False

    def test_notes_lifecycle(self, node, temp_contact):
        note_record = node.contact_notes_create({'contactId': temp_contact['id'], 'body': f'live {UID}'})
        note_id = note_record['id']
        try:
            fetched = node.contact_notes_get({'contactId': temp_contact['id'], 'noteId': note_id})
            assert fetched['id'] == note_id
            updated = node.contact_notes_update(
                {'contactId': temp_contact['id'], 'noteId': note_id, 'body': f'live {UID} edited'}
            )
            assert updated['body'].endswith('edited')
        finally:
            deleted = node.contact_notes_delete({'contactId': temp_contact['id'], 'noteId': note_id})
        # Asserted outside the finally: an assert raised during exception handling would replace
        # the failure from the try body as the reported one. Same in every lifecycle test below.
        assert deleted['deleted'] is True

    def test_tasks_lifecycle(self, node, temp_contact):
        due = (datetime.now(timezone.utc) + timedelta(days=3)).isoformat().replace('+00:00', 'Z')
        task = node.contact_tasks_create({'contactId': temp_contact['id'], 'title': f'live {UID}', 'dueDate': due})
        task_id = task['id']
        try:
            fetched = node.contact_tasks_get({'contactId': temp_contact['id'], 'taskId': task_id})
            assert fetched['id'] == task_id
            node.contact_tasks_update({'contactId': temp_contact['id'], 'taskId': task_id, 'title': f'live {UID} v2'})
            completed = node.contact_tasks_set_completed(
                {'contactId': temp_contact['id'], 'taskId': task_id, 'completed': True}
            )
            assert isinstance(completed, dict)
        finally:
            deleted = node.contact_tasks_delete({'contactId': temp_contact['id'], 'taskId': task_id})
        assert deleted['deleted'] is True


@writes
class TestOpportunityLifecycle:
    def test_lifecycle(self, node, pipeline, temp_contact):
        stages = pipeline.get('stages') or []
        opportunity = node.opportunity_create(
            {
                'pipelineId': pipeline['id'],
                'pipelineStageId': stages[0]['id'] if stages else None,
                'name': f'RocketRide live {UID}',
                'status': 'open',
                'contactId': temp_contact['id'],
                'monetaryValue': 1234,
            }
        )
        opportunity_id = opportunity['id']
        try:
            assert opportunity['name'] == f'RocketRide live {UID}'
            updated = node.opportunity_update({'opportunityId': opportunity_id, 'monetaryValue': 4321})
            assert updated['id'] == opportunity_id
            status = node.opportunity_status_update({'opportunityId': opportunity_id, 'status': 'won'})
            assert status['ok'] is True
            after = node.opportunity_get({'opportunityId': opportunity_id})
            assert after['status'] == 'won'
        finally:
            deleted = node.opportunity_delete({'opportunityId': opportunity_id})
        assert deleted['deleted'] is True

    def test_followers(self, node, pipeline, temp_contact):
        users = node.user_list_by_location({})['items']
        if not users:
            pytest.skip('the sub-account has no users to follow with')
        opportunity = node.opportunity_create(
            {
                'pipelineId': pipeline['id'],
                'name': f'RocketRide followers {UID}',
                'status': 'open',
                'contactId': temp_contact['id'],
            }
        )
        try:
            added = node.opportunity_followers_add({'opportunityId': opportunity['id'], 'followers': [users[0]['id']]})
            assert isinstance(added, dict)
            node.opportunity_followers_remove({'opportunityId': opportunity['id'], 'followers': [users[0]['id']]})
        finally:
            node.opportunity_delete({'opportunityId': opportunity['id']})


@writes
class TestConversationLifecycle:
    def test_create_on_a_contact_that_already_has_one_is_rejected(self, node, temp_contact):
        """Creating a contact creates its conversation too, so conversation_create 400s on a new contact.

        Live-confirmed on a contact created seconds earlier through this node: the very first
        POST /conversations/ for it comes back 400 ``Conversation already exists``. There is no
        idempotent form of this call, so the create path is reachable only for a contact whose
        conversation has been deleted.

        The error body carries the id of the conversation that already exists, which is the
        only way forward from here, so the node has to surface it rather than reading
        ``message`` alone.
        """
        with pytest.raises(ghl.GoHighLevelAPIError) as excinfo:
            node.conversation_create({'contactId': temp_contact['id']})
        error = excinfo.value
        assert error.status_code == 400
        assert 'already exists' in str(error)
        if not error.details.get('conversationId'):
            note(
                'conversation_create: the 400 "Conversation already exists" body carried no conversationId on '
                'this run, so there was nothing for the node to surface'
            )
            return
        assert error.canonical_code == 'CONVERSATIONS_CONVERSATION_ALREADY_EXISTS'
        assert f'conversationId: {error.details["conversationId"]}' in str(error)
        # The id has to lead somewhere: the conversation it names must be real.
        existing = node.conversation_get({'conversationId': error.details['conversationId']})
        assert existing['id'] == error.details['conversationId']
        assert existing.get('contactId') == temp_contact['id']

    def test_update_and_delete(self, node, temp_contact):
        found = node.conversation_search({'contactId': temp_contact['id'], 'limit': 5})
        conversations = check_page(found, 'conversation_search', 5)
        if not conversations:
            pytest.skip('the contact has no conversation to update')
        conversation_id = conversations[0]['id']
        updated = node.conversation_update({'conversationId': conversation_id, 'unreadCount': 0})
        assert updated['id'] == conversation_id
        deleted = node.conversation_delete({'conversationId': conversation_id})
        assert deleted['deleted'] is True


@writes
class TestLocationSettingsLifecycles:
    def test_tag_lifecycle(self, node):
        tag = node.location_tags_create({'name': f'rocketride-live-tag-{UID}'})
        tag_id = tag['id']
        try:
            fetched = node.location_tags_get({'tagId': tag_id})
            assert fetched['id'] == tag_id
            renamed = node.location_tags_update({'tagId': tag_id, 'name': f'rocketride-live-tag-{UID}-v2'})
            assert renamed['name'].endswith('-v2')
        finally:
            deleted = node.location_tags_delete({'tagId': tag_id})
        assert deleted['deleted'] is True

    def test_custom_field_lifecycle(self, node):
        field = node.custom_field_create({'name': f'RocketRide live {UID}', 'dataType': 'TEXT'})
        field_id = field['id']
        try:
            fetched = node.custom_field_get({'customFieldId': field_id})
            assert fetched['id'] == field_id
            assert fetched.get('fieldKey'), 'the field key is what a custom-field write addresses'
            renamed = node.custom_field_update({'customFieldId': field_id, 'name': f'RocketRide live {UID} v2'})
            assert renamed['name'].endswith('v2')
        finally:
            deleted = node.custom_field_delete({'customFieldId': field_id})
        assert deleted['deleted'] is True

    def test_custom_field_round_trips_onto_a_contact(self, node, temp_contact):
        """Read tools return a map keyed by field id; write tools take an array. Prove both directions."""
        field = node.custom_field_create({'name': f'RocketRide rt {UID}', 'dataType': 'TEXT'})
        try:
            node.contact_update(
                {
                    'contactId': temp_contact['id'],
                    'customFields': [{'id': field['id'], 'field_value': f'value {UID}'}],
                }
            )
            fetched = node.contact_get({'contactId': temp_contact['id']})
            values = fetched.get('customFields')
            assert isinstance(values, dict), 'contact reads project custom fields into a map keyed by field id'
            assert values.get(field['id']) == f'value {UID}'
        finally:
            node.custom_field_delete({'customFieldId': field['id']})

    def test_custom_value_lifecycle(self, node):
        value = node.custom_value_create({'name': f'RocketRide live {UID}', 'value': 'one'})
        value_id = value['id']
        try:
            fetched = node.custom_value_get({'customValueId': value_id})
            assert fetched['id'] == value_id
            updated = node.custom_value_update(
                {'customValueId': value_id, 'name': f'RocketRide live {UID}', 'value': 'two'}
            )
            assert updated['value'] == 'two'
        finally:
            deleted = node.custom_value_delete({'customValueId': value_id})
        assert deleted['deleted'] is True


@writes
class TestBusinessLifecycle:
    def test_lifecycle(self, node):
        business = node.business_create({'name': f'RocketRide live {UID}'})
        business_id = business['id']
        try:
            assert business['name'] == f'RocketRide live {UID}'
            renamed = node.business_update({'businessId': business_id, 'name': f'RocketRide live {UID} v2'})
            assert renamed['name'].endswith('v2')
        finally:
            deleted = node.business_delete({'businessId': business_id})
        assert deleted['deleted'] is True


@writes
class TestCalendarLifecycle:
    def test_calendar_created_and_readable(self, node, temp_calendar):
        assert temp_calendar['id']
        fetched = node.calendar_get({'calendarId': temp_calendar['id']})
        assert fetched['id'] == temp_calendar['id']
        listed = node.calendar_list({})['items']
        assert temp_calendar['id'] in [row['id'] for row in listed]

    def test_calendar_update(self, node, temp_calendar):
        updated = node.calendar_update({'calendarId': temp_calendar['id'], 'description': f'live {UID}'})
        assert updated['id'] == temp_calendar['id']

    def test_group_lifecycle(self, node):
        group = node.calendar_group_create(
            {'name': f'RocketRide live {UID}', 'description': 'live suite', 'slug': f'rocketride-live-{UID}'}
        )
        group_id = group['id']
        try:
            node.calendar_group_update(
                {
                    'groupId': group_id,
                    'name': f'RocketRide live {UID} v2',
                    'description': 'live suite',
                    'slug': f'rocketride-live-{UID}',
                }
            )
            status = node.calendar_group_status_set({'groupId': group_id, 'isActive': False})
            assert isinstance(status, dict)
        finally:
            deleted = node.calendar_group_delete({'groupId': group_id})
        assert deleted['deleted'] is True

    def test_free_slots(self, node, temp_calendar):
        start = int(time.time() * 1000)
        result = node.appointment_free_slots_list(
            {'calendarId': temp_calendar['id'], 'startDate': start, 'endDate': start + 7 * 86400000}
        )
        assert isinstance(result, dict), 'free slots answer a map keyed by date rather than a list'
        assert all(len(key) == 10 for key in result), 'non-date keys such as traceId are dropped'

    def test_free_slots_range_is_capped_locally(self, node, temp_calendar):
        start = int(time.time() * 1000)
        with pytest.raises(ValueError, match='at most 31 days'):
            node.appointment_free_slots_list(
                {'calendarId': temp_calendar['id'], 'startDate': start, 'endDate': start + 60 * 86400000}
            )

    def test_appointment_get_reads_the_right_envelope_key(self, node, temp_appointment):
        """GET /calendars/events/appointments/{eventId} answers under "appointment", not "event".

        Regression guard. Both published specs declare "event" while the live API answers under
        "appointment". The tool once passed the spec spelling and returned {} for every
        appointment, because record_of only unwraps a key the payload carries and _clean_event
        then matched none of its read keys. It now accepts ("appointment", "event"), wire
        spelling first. Only the get was affected: create and update answer the record bare.
        """
        fetched = node.appointment_get({'eventId': temp_appointment['id']})
        if fetched.get('id') != temp_appointment['id']:
            note(
                'appointment_get returned no usable record: GET /calendars/events/appointments/{eventId} may '
                'have changed its envelope key away from "appointment"'
            )
        assert fetched.get('id') == temp_appointment['id'], 'appointment_get dropped the whole record'

    def test_appointment_lifecycle(self, node, temp_calendar, temp_appointment):
        assert temp_appointment['id']
        updated = node.appointment_update({'eventId': temp_appointment['id'], 'title': f'RocketRide live {UID} v2'})
        assert updated['id'] == temp_appointment['id'], 'the update answers the record bare, with no envelope key'
        window_start = int((time.time() - 86400) * 1000)
        listed = node.appointment_list(
            {'calendarId': temp_calendar['id'], 'startTime': window_start, 'endTime': window_start + 30 * 86400000}
        )
        events = check_page(listed, 'appointment_list')
        assert temp_appointment['id'] in [row['id'] for row in events]

    def test_appointment_read_through_the_contact_has_no_timezone(self, node, temp_contact, temp_appointment):
        listed = node.contact_appointments_list({'contactId': temp_contact['id']})
        events = check_page(listed, 'contact_appointments_list')
        match = next((row for row in events if row.get('id') == temp_appointment['id']), None)
        if match is None:
            pytest.skip('the appointment is not on the contact appointment list')
        start = str(match.get('startTime') or '')
        if '+' in start or start.endswith('Z'):
            note('contact_appointments_list returned an offset-bearing startTime, not the naive local string')

    def test_appointment_notes_lifecycle(self, node, temp_appointment):
        created = node.appointment_notes_create({'appointmentId': temp_appointment['id'], 'body': f'live {UID}'})
        note_id = created['id']
        try:
            listed = node.appointment_notes_list({'appointmentId': temp_appointment['id'], 'limit': 20})
            notes = check_page(listed, 'appointment_notes_list', 20)
            assert note_id in [row['id'] for row in notes]
            node.appointment_notes_update(
                {'appointmentId': temp_appointment['id'], 'noteId': note_id, 'body': f'live {UID} v2'}
            )
        finally:
            deleted = node.appointment_notes_delete({'appointmentId': temp_appointment['id'], 'noteId': note_id})
        assert deleted['deleted'] is True

    def test_blocked_slot_lifecycle(self, node, temp_calendar):
        start = datetime.now(timezone.utc).astimezone() + timedelta(days=5)
        start = start.replace(minute=0, second=0, microsecond=0)
        end = start + timedelta(hours=1)
        blocked = node.blocked_slot_create(
            {
                'calendarId': temp_calendar['id'],
                'title': f'RocketRide live {UID}',
                'startTime': start.isoformat(timespec='seconds'),
                'endTime': end.isoformat(timespec='seconds'),
            }
        )
        try:
            node.blocked_slot_update(
                {'eventId': blocked['id'], 'calendarId': temp_calendar['id'], 'title': f'RocketRide live {UID} v2'}
            )
            window = int((time.time() - 86400) * 1000)
            listed = node.blocked_slot_list(
                {'calendarId': temp_calendar['id'], 'startTime': window, 'endTime': window + 30 * 86400000}
            )
            check_page(listed, 'blocked_slot_list')
        finally:
            deleted = node.appointment_delete({'eventId': blocked['id']})
        assert deleted['deleted'] is True


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class TestErrors:
    def test_bad_token_is_401(self):
        bad = _node(token=BAD_TOKEN)
        with pytest.raises(ghl.GoHighLevelAPIError) as excinfo:
            bad.contact_list({'limit': 1})
        assert excinfo.value.status_code == 401
        assert BAD_TOKEN not in str(excinfo.value), 'the credential must never reach an error message'

    def test_missing_location_is_a_403_that_blames_the_token(self):
        """The vendor message says the token has no access; the guidance says the parameter is missing."""
        with pytest.raises(ghl.GoHighLevelAPIError) as excinfo:
            ghl.call(TOKEN, 'GET', '/contacts/')
        assert excinfo.value.status_code == 403
        assert 'locationId is missing or mismatched' in str(excinfo.value)

    def test_unknown_path_is_a_404_with_an_empty_body(self):
        with pytest.raises(ghl.GoHighLevelAPIError) as excinfo:
            ghl.call(TOKEN, 'GET', '/no-such-resource-here')
        assert excinfo.value.status_code == 404

    def test_contact_create_with_nothing_is_refused_before_the_request(self, node):
        before = PACER.count
        with pytest.raises(ValueError, match='at least one of'):
            node.contact_create({})
        assert PACER.count == before, 'the local check must fire before any network call'

    def test_contact_create_with_only_a_location_is_400_with_a_422_body(self, node):
        """HTTP status and body statusCode disagree here, and only the HTTP one may be trusted."""
        with pytest.raises(ghl.GoHighLevelAPIError) as excinfo:
            node.request({'method': 'POST', 'path': '/contacts/', 'body': {'locationId': LOCATION}})
        assert excinfo.value.status_code == 400, 'the body claims 422; the HTTP status is 400'

    def test_opportunity_search_rejects_the_camelcase_location(self, node):
        with pytest.raises(ghl.GoHighLevelAPIError) as excinfo:
            node.request({'method': 'GET', 'path': '/opportunities/search', 'params': {'locationId': LOCATION}})
        assert excinfo.value.status_code == 422
        assert 'should not exist' in str(excinfo.value)

    def test_users_search_with_no_parameters_is_a_401_that_is_really_validation(self, node):
        with pytest.raises(ghl.GoHighLevelAPIError) as excinfo:
            node.request({'method': 'GET', 'path': '/users/search'})
        assert excinfo.value.status_code == 401
        assert 'missing required parameter' in str(excinfo.value)

    def test_users_search_with_a_location_but_no_company_is_a_422(self, node):
        """The same missing companyId is a 401 bare and a 422 once locationId is supplied."""
        with pytest.raises(ghl.GoHighLevelAPIError) as excinfo:
            node.request({'method': 'GET', 'path': '/users/search', 'params': {'locationId': LOCATION}})
        assert excinfo.value.status_code == 422
        assert 'companyId must be a string' in str(excinfo.value)

    def test_users_list_rejects_the_company_id_its_sibling_requires(self, node, company_id):
        with pytest.raises(ghl.GoHighLevelAPIError) as excinfo:
            node.request(
                {'method': 'GET', 'path': '/users/', 'params': {'locationId': LOCATION, 'companyId': company_id}}
            )
        # This route answered 401 "Command timed out" on one run, which is the gateway in
        # front of the API failing rather than anything the node did. Recorded and skipped:
        # asserting on the validation message through a gateway that is not answering turns
        # a vendor outage into a red suite. The 401 mapping itself is covered offline.
        if excinfo.value.status_code == 401 and 'timed out' in str(excinfo.value).lower():
            note('GET /users/ answered 401 "Command timed out": an upstream timeout, not a credential problem')
            pytest.skip('the gateway answered 401 "Command timed out" rather than the endpoint validating')
        assert 'companyId should not exist' in str(excinfo.value)

    def test_contact_tags_cannot_be_read(self, node, seed_contact_id):
        """Tags are a write-only sub-resource: read them off the contact record instead."""
        with pytest.raises(ghl.GoHighLevelAPIError) as excinfo:
            node.request({'method': 'GET', 'path': f'/contacts/{seed_contact_id}/tags'})
        assert excinfo.value.status_code == 404

    def test_unknown_parameter_is_named_locally(self, node):
        before = PACER.count
        with pytest.raises(ValueError, match='unknown parameter'):
            node.contact_list({'locationId': LOCATION})
        assert PACER.count == before

    def test_agency_location_search_is_forbidden(self, node):
        with pytest.raises(ghl.GoHighLevelAPIError) as excinfo:
            node.request({'method': 'GET', 'path': '/locations/search'})
        assert excinfo.value.status_code == 403
        assert 'agency-scoped endpoint' in str(excinfo.value)

    def test_oauth_installed_locations_is_out_of_scope(self, node):
        with pytest.raises(ghl.GoHighLevelAPIError) as excinfo:
            node.request({'method': 'GET', 'path': '/oauth/installedLocations'})
        assert excinfo.value.status_code == 401

    def test_read_only_mode_refuses_a_write(self, seed_contact_id):
        locked = _node(read_only=True)
        before = PACER.count
        with pytest.raises(ValueError, match='read-only mode'):
            locked.contact_update({'contactId': seed_contact_id, 'city': 'Nowhere'})
        assert PACER.count == before, 'the read-only gate must fire before any network call'


# ---------------------------------------------------------------------------
# Rate limits
# ---------------------------------------------------------------------------


class TestRateLimits:
    def test_headers_are_present_and_numeric(self, node):
        node.location_get({})
        for header in (
            'x-ratelimit-max',
            'x-ratelimit-remaining',
            'x-ratelimit-interval-milliseconds',
            'x-ratelimit-limit-daily',
            'x-ratelimit-daily-remaining',
        ):
            raw = LAST_HEADERS.get(header)
            assert raw is not None, f'{header} is missing'
            assert int(raw) >= 0, f'{header} is not an integer'

    def test_daily_reset_is_a_duration_not_a_timestamp(self, node):
        node.location_get({})
        raw = LAST_HEADERS.get('x-ratelimit-daily-reset')
        if raw is None:
            pytest.skip('x-ratelimit-daily-reset is absent on this response')
        assert int(raw) < 90000000, 'this is a duration in milliseconds, so it can never be an epoch timestamp'

    def test_no_retry_after_header(self, node):
        node.location_get({})
        # LAST_HEADERS is a plain dict, so the case-insensitivity of the live header set is
        # gone by here: check every spelling rather than one.
        if any(key.lower() == 'retry-after' for key in LAST_HEADERS):
            note('a Retry-After header appeared, which the client is written not to expect')

    def test_daily_budget_is_not_exhausted(self, node):
        node.location_get({})
        assert not ghl.daily_budget_exhausted(LAST_HEADERS), 'the daily bucket is empty, so nothing else can pass'


# ---------------------------------------------------------------------------
# What this account cannot exercise
#
# Recorded as skips with a reason rather than left out, so the coverage gap is visible
# in the run rather than only in a document.
# ---------------------------------------------------------------------------


class TestNotExercisable:
    def test_message_send(self):
        pytest.skip('message_send needs a phone number or email provider provisioned on the sub-account')

    def test_message_schedule_cancel(self):
        pytest.skip('nothing can be scheduled without a messaging provider, so there is no scheduled message to cancel')

    def test_message_transcription_get(self):
        pytest.skip('transcriptions exist only for recorded calls, which need a phone provider')

    def test_message_email_get(self):
        pytest.skip('needs an email message id, which needs an email provider on the sub-account')

    def test_contact_workflow_add_and_remove(self):
        pytest.skip('GoHighLevel publishes no endpoint that lists workflows, so a workflowId cannot be resolved')

    def test_agency_endpoints(self):
        pytest.skip('locations search, location create/update/delete and companies are agency-scoped and refused')
