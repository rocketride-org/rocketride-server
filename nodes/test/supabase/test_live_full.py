# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Live tests against a real Supabase test project (plan section 10).

Run by hand only. ``./builder nodes:test`` ignores ``test_*_full.py``; this
file runs with ``./builder nodes:test-full`` or directly with pytest, and
every test skips unless its variables are set (put them in a local ``.env``,
never in code):

* API services (Auth, Storage, Messaging, Edge Functions):
  ``ROCKETRIDE_SUPABASE_URL``, ``ROCKETRIDE_SUPABASE_SECRET_KEY``
* Cron: ``ROCKETRIDE_SUPABASE_DB_HOST`` (session pooler host, optionally
  ``:port``), ``ROCKETRIDE_SUPABASE_POSTGRESDB_PASSWORD``, and optionally
  ``ROCKETRIDE_SUPABASE_DB_USER`` (default ``postgres.<project-ref>``)
* Optional names of the test fixtures (plan 10.1):
  ``ROCKETRIDE_SUPABASE_TEST_BUCKET`` (default ``rr-test``),
  ``ROCKETRIDE_SUPABASE_TEST_QUEUE`` (default ``rr_test``),
  ``ROCKETRIDE_SUPABASE_TEST_FUNCTION`` (default ``hello``)

Each test creates what it uses under a unique name and removes it in a
``finally`` block, so a run leaves the project as it found it. Database and
Vector are not covered here: they run db_postgres's / store_postgres's engine
bases, which need the engine (see the plan's end-to-end run).

The services run with the real supabase-py client and real psycopg2; only
the engine modules are stubbed, as in the unit tests.
"""

from __future__ import annotations

import os
import uuid

import pytest

from ._support import engine_stubs, make_global, make_instance

with engine_stubs():
    from nodes.supabase import supabase_client as sc
    from nodes.supabase.auth.IGlobal import IGlobal as AuthGlobal
    from nodes.supabase.auth.IInstance import IInstance as AuthInstance
    from nodes.supabase.cron.IGlobal import IGlobal as CronGlobal
    from nodes.supabase.cron.IInstance import IInstance as CronInstance
    from nodes.supabase.functions.IGlobal import IGlobal as FunctionsGlobal
    from nodes.supabase.functions.IInstance import IInstance as FunctionsInstance
    from nodes.supabase.messaging.IGlobal import IGlobal as MessagingGlobal
    from nodes.supabase.messaging.IInstance import IInstance as MessagingInstance
    from nodes.supabase.storage.IGlobal import IGlobal as StorageGlobal
    from nodes.supabase.storage.IInstance import IInstance as StorageInstance

URL = os.environ.get('ROCKETRIDE_SUPABASE_URL', '').strip()
SECRET_KEY = os.environ.get('ROCKETRIDE_SUPABASE_SECRET_KEY', '').strip()
DB_HOST = os.environ.get('ROCKETRIDE_SUPABASE_DB_HOST', '').strip()
DB_PASSWORD = os.environ.get('ROCKETRIDE_SUPABASE_POSTGRESDB_PASSWORD', '')
DB_USER = os.environ.get('ROCKETRIDE_SUPABASE_DB_USER', '').strip()
BUCKET = os.environ.get('ROCKETRIDE_SUPABASE_TEST_BUCKET', '').strip() or 'rr-test'
QUEUE = os.environ.get('ROCKETRIDE_SUPABASE_TEST_QUEUE', '').strip() or 'rr_test'
FUNCTION = os.environ.get('ROCKETRIDE_SUPABASE_TEST_FUNCTION', '').strip() or 'hello'

needs_api = pytest.mark.skipif(
    not (URL and SECRET_KEY), reason='ROCKETRIDE_SUPABASE_URL / ROCKETRIDE_SUPABASE_SECRET_KEY not set'
)
needs_db = pytest.mark.skipif(
    not (URL and DB_HOST and DB_PASSWORD),
    reason='ROCKETRIDE_SUPABASE_URL / ROCKETRIDE_SUPABASE_DB_HOST / ROCKETRIDE_SUPABASE_POSTGRESDB_PASSWORD not set',
)

PAUSED_HINT = (
    'The Supabase test project did not answer; it may be paused (free projects pause after about a week). '
    'Open the dashboard and click Resume project, then run again.'
)


def _unique(prefix: str) -> str:
    return f'{prefix}{uuid.uuid4().hex[:12]}'


def _api(global_cls, instance_cls, access='admin', **extra):
    cfg = {'authType': 'key', 'url': URL, 'secretKey': SECRET_KEY, 'access': access, **extra}
    return make_instance(instance_cls, make_global(global_cls, cfg))


def _db_user() -> str:
    if DB_USER:
        return DB_USER
    ref = sc.project_ref_from_url(sc.normalize_project_url(URL))
    return f'postgres.{ref}' if ref else 'postgres'


@pytest.fixture(scope='module')
def project_awake():
    """One check call first, so a paused project fails once with a clear message."""
    if not (URL and SECRET_KEY):
        pytest.skip('ROCKETRIDE_SUPABASE_URL / ROCKETRIDE_SUPABASE_SECRET_KEY not set')
    try:
        _api(AuthGlobal, AuthInstance, access='read').list_users({'per_page': 1})
    except Exception as e:  # any failure here means the run cannot say anything useful
        pytest.fail(f'{PAUSED_HINT} ({sc.Redactor([SECRET_KEY]).redact(str(e))})')


@needs_api
def test_auth_user_lifecycle(project_awake):
    auth = _api(AuthGlobal, AuthInstance)
    email = f'{_unique("rr-live-")}@example.com'
    user = auth.create_user({'email': email, 'email_confirm': True, 'user_metadata': {'run': 'live'}})
    try:
        assert user['email'] == email
        assert auth.get_user({'user_id': user['id']})['id'] == user['id']
        updated = auth.update_user({'user_id': user['id'], 'user_metadata': {'step': 'updated'}})
        assert updated['user_metadata'].get('step') == 'updated'
        link = auth.generate_link({'type': 'magiclink', 'email': email})
        assert link['link'].startswith('http') and link['user_id'] == user['id']
        page = auth.list_users({'per_page': 1})
        assert page['count'] <= 1
        refused = auth.verify_user({'access_token': 'not-a-real-token'})
        assert refused['valid'] is False
    finally:
        assert auth.delete_user({'user_id': user['id']})['deleted'] is True


@needs_api
def test_storage_file_lifecycle(project_awake):
    storage = _api(StorageGlobal, StorageInstance)
    folder = _unique('rr-live-')
    path = f'{folder}/hello.txt'
    try:
        storage.upload_file({'bucket': BUCKET, 'path': path, 'content': 'hello from rocketride'})
        listed = storage.list_files({'bucket': BUCKET, 'prefix': folder})
        assert [f['name'] for f in listed['files']] == ['hello.txt']
        got = storage.download_file({'bucket': BUCKET, 'path': path})
        assert got['inline'] is True and got['content'] == 'hello from rocketride'
        assert storage.create_signed_url({'bucket': BUCKET, 'path': path})['signed_url'].startswith('http')
    finally:
        storage.delete_file({'bucket': BUCKET, 'paths': [path]})


@needs_api
def test_storage_large_file_returns_signed_url(project_awake):
    storage = _api(StorageGlobal, StorageInstance, inlineLimitKb=1)
    path = f'{_unique("rr-live-")}/big.txt'
    try:
        storage.upload_file({'bucket': BUCKET, 'path': path, 'content': 'x' * 4096})
        got = storage.download_file({'bucket': BUCKET, 'path': path})
        assert got['inline'] is False and got['signed_url'].startswith('http')
    finally:
        storage.delete_file({'bucket': BUCKET, 'paths': [path]})


@needs_api
def test_messaging_queue_roundtrip(project_awake):
    messaging = _api(MessagingGlobal, MessagingInstance, access='write')
    marker = _unique('rr-live-')
    sent = messaging.queue_send({'queue': QUEUE, 'message': {'marker': marker}})
    try:
        read = messaging.queue_read({'queue': QUEUE, 'count': 10, 'visibility_seconds': 5})
        assert any(m['msg_id'] == sent['message_id'] for m in read['messages'])
    finally:
        assert messaging.queue_delete({'queue': QUEUE, 'message_id': sent['message_id']})['ok'] is True


@needs_api
def test_messaging_broadcast(project_awake):
    messaging = _api(MessagingGlobal, MessagingInstance, access='write')
    out = messaging.broadcast({'channel': _unique('rr-live-'), 'event': 'ping', 'payload': {'ok': True}})
    assert out['ok'] is True


@needs_api
def test_edge_function_echo(project_awake):
    functions = _api(FunctionsGlobal, FunctionsInstance, access='write')
    out = functions.invoke_function({'name': FUNCTION, 'body': {'name': 'rocketride'}})
    assert out['ok'] is True, out
    assert 'rocketride' in str(out['body'])


@needs_api
def test_read_level_refuses_writes_live(project_awake):
    storage = _api(StorageGlobal, StorageInstance, access='read')
    with pytest.raises(sc.SupabaseAccessError, match='needs the "write" access level'):
        storage.upload_file({'bucket': BUCKET, 'path': 'never/written.txt', 'content': 'x'})


@needs_db
def test_cron_job_lifecycle():
    cfg = {'host': DB_HOST, 'user': _db_user(), 'password': DB_PASSWORD, 'database': 'postgres', 'access': 'admin'}
    cron = make_instance(CronInstance, make_global(CronGlobal, cfg))
    name = _unique('rr_live_')
    scheduled = cron.schedule_job({'name': name, 'schedule': '0 3 * * *', 'sql': 'select 1'})
    try:
        assert scheduled['replaced'] is False
        assert name in [job['name'] for job in cron.list_jobs({})['jobs']]
        assert cron.job_runs({'job_name': name})['count'] == 0
    finally:
        assert cron.unschedule_job({'name': name})['unscheduled'] is True
