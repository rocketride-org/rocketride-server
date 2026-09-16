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

"""Tests for execute()'s error reporting and the refresh_schema tool.

Both cover ``DatabaseInstanceBase`` behaviour that only shows up against a
real engine, so every test here runs on the in-memory SQLite engine the
fixtures build. Deliberately a separate module from ``test_db_base.py``: that
file is being appended to by more than one open pull request.

Covered:

- ``execute`` surfaces the driver's own message instead of a generic string.
- ``refresh_schema`` re-reflects the database, so DDL run after task start
  becomes visible (``get_schema`` keeps serving the start-up snapshot).
"""

from __future__ import annotations

import re
import threading

import pytest
from sqlalchemy import MetaData, Table as SQLTable, Text, create_engine, event, insert
from sqlalchemy.dialects import mysql, postgresql, sqlite
from sqlalchemy.pool import StaticPool

import ai.common.database.db_global_base as db_global_base_module
from ai.common.database.db_global_base import DatabaseGlobalBase
from ai.common.database.db_instance_base import _REFLECT_LOCK, DatabaseInstanceBase, _format_table


# ---------------------------------------------------------------------------
# Concrete subclasses satisfying the two ABCs
# ---------------------------------------------------------------------------


class _TestableGlobal(DatabaseGlobalBase):
    """Concrete DatabaseGlobalBase that knows how to build a SQLite URL."""

    def _connection_params(self, config):
        """Trivial mapping — every key passes through."""
        return dict(config)

    def _build_connection_url(self, params):
        """Build a sqlite:///:memory: URL (params ignored)."""
        return 'sqlite:///:memory:'


class _TestableInstance(DatabaseInstanceBase):
    """Concrete DatabaseInstanceBase that satisfies the two abstract methods."""

    def _db_display_name(self):
        """Human-readable name used in tool descriptions."""
        return 'TestDB'

    def _db_dialect(self):
        """Machine-readable dialect identifier."""
        return 'testdb'


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _make_instance(engine):
    """Build an instance over the given engine, as beginGlobal would leave it.

    The global is a genuine DatabaseGlobalBase subclass, so ``_format_db_error``
    and ``_getDatabaseSchema`` are the production implementations; only the
    fields ``beginGlobal`` sets are filled in by hand. ``db_schema`` starts
    empty, which is exactly what task start leaves behind for a database that
    was empty at the time.
    """
    iglobal = _TestableGlobal.__new__(_TestableGlobal)
    iglobal.engine = engine
    iglobal.schema = {}
    iglobal.db_schema = {}
    iglobal.database = 'main'
    iglobal.allow_execute = True
    iglobal.max_execute_rows = 1000

    inst = _TestableInstance.__new__(_TestableInstance)
    inst.IGlobal = iglobal
    return inst


@pytest.fixture
def instance():
    """Single-threaded instance on an in-memory SQLite database.

    The default pool reuses one connection per thread, so DDL run through
    execute() is visible to the inspector afterwards.
    """
    inst = _make_instance(create_engine('sqlite:///:memory:'))
    yield inst
    inst.IGlobal.engine.dispose()


@pytest.fixture
def file_instance(tmp_path):
    """Instance on a file-backed SQLite database, one connection per thread.

    The concurrency tests need two threads to write, and StaticPool hands every
    thread the SAME connection, which would merge their transactions. A file
    database with the default pool gives each thread its own connection while
    still letting all of them see one set of tables.
    """
    engine = create_engine(f'sqlite:///{tmp_path / "test.db"}', connect_args={'check_same_thread': False})
    inst = _make_instance(engine)
    yield inst
    engine.dispose()


@pytest.fixture
def shared_instance():
    """Instance whose in-memory database is shared across threads.

    ``sqlite:///:memory:`` normally hands every thread its own empty database,
    which would make a concurrency test assert nothing. StaticPool plus
    ``check_same_thread`` pins all threads to one connection (the same shape
    tests/database/test_execute_session.py uses).
    """
    engine = create_engine('sqlite://', connect_args={'check_same_thread': False}, poolclass=StaticPool)
    inst = _make_instance(engine)
    yield inst
    engine.dispose()


# ---------------------------------------------------------------------------
# execute() error text
# ---------------------------------------------------------------------------


def test_execute_raises_with_the_driver_error_text(instance):
    """A failed statement must carry the database's own message to the caller.

    Before this fix _executeRawQuery logged the SQLAlchemyError and returned
    None, so every failure reached the caller as the same opaque 'check server
    logs for details' string: a typo, a missing table, and a permission error
    were indistinguishable in any UI built on the tool.
    """
    with pytest.raises(RuntimeError) as excinfo:
        instance.execute({'sql': 'SELECT * FROM no_such_table'})

    message = str(excinfo.value)
    assert message.startswith('SQL execution failed: ')
    assert 'no_such_table' in message
    assert 'no such table' in message.lower()


def test_execute_error_names_the_offending_column(instance):
    """The message is specific enough to locate the mistake, not just its kind."""
    instance.execute({'sql': 'CREATE TABLE widgets (id INTEGER PRIMARY KEY)'})

    with pytest.raises(RuntimeError, match='no_such_column'):
        instance.execute({'sql': 'SELECT no_such_column FROM widgets'})


def test_execute_error_does_not_mention_server_logs(instance):
    """The old message pointed at the server log; the new one answers directly."""
    with pytest.raises(RuntimeError) as excinfo:
        instance.execute({'sql': 'THIS IS NOT SQL'})

    assert 'check server logs' not in str(excinfo.value)


def test_execute_returns_rows_on_success(instance):
    """The success path is unchanged by the error-handling rewrite."""
    assert instance.execute({'sql': 'SELECT 1 AS one'}) == {'rows': [{'one': 1}], 'affected_rows': 0}


def test_execute_still_refuses_when_the_gate_is_off(instance):
    """The allow_execute gate runs before any of this and is untouched."""
    instance.IGlobal.allow_execute = False
    with pytest.raises(ValueError, match='allow_execute'):
        instance.execute({'sql': 'SELECT 1'})


# ---------------------------------------------------------------------------
# refresh_schema
# ---------------------------------------------------------------------------


def test_refresh_schema_sees_a_table_created_after_startup(instance):
    """refresh_schema must re-reflect, not re-serve the task-start snapshot.

    db_schema is assigned exactly once, in beginGlobal. Without a refresh tool
    a table created through execute stays invisible to get_schema for the whole
    life of the task, so a designer that applies DDL and re-reads the schema
    repaints the pre-DDL shape.
    """
    # The task-start snapshot: empty, as beginGlobal would have left it.
    assert instance.get_schema({}) == {'database': 'main', 'tables': {}}

    instance.execute({'sql': 'CREATE TABLE widgets (id INTEGER PRIMARY KEY, label TEXT)'})

    # get_schema still serves the stale snapshot ...
    assert instance.get_schema({})['tables'] == {}

    # ... refresh_schema reflects the live database.
    refreshed = instance.refresh_schema({})
    assert refreshed['database'] == 'main'
    assert [c['column'] for c in refreshed['tables']['widgets']['columns']] == ['id', 'label']
    assert refreshed['tables']['widgets']['primary_key'] == ['id']

    # The cache was replaced, so get_schema now agrees with it.
    assert instance.get_schema({'table': 'widgets'})['tables']['widgets'] == refreshed['tables']['widgets']


def test_refresh_schema_reports_a_utc_timestamp(instance):
    """refreshed_at lets a caller show how current the schema it is holding is."""
    refreshed_at = instance.refresh_schema({})['refreshed_at']
    # ISO-8601 with an explicit UTC offset, e.g. 2026-09-14T20:31:07.123456+00:00.
    assert re.match(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?\+00:00$', refreshed_at)


def test_refresh_schema_matches_get_schema_shape(instance):
    """Apart from refreshed_at, the two tools return the same payload.

    The table carries a primary key AND a foreign key so the two optional
    entries are exercised in both payloads: an equality check over a table
    that has neither passes even if one side stops emitting them.
    """
    instance.execute({'sql': 'CREATE TABLE makers (id INTEGER PRIMARY KEY, name TEXT)'})
    instance.execute({'sql': 'CREATE TABLE widgets (id INTEGER PRIMARY KEY, maker_id INTEGER REFERENCES makers (id))'})
    refreshed = instance.refresh_schema({})

    assert refreshed.pop('refreshed_at')
    assert refreshed == instance.get_schema({})

    widgets = refreshed['tables']['widgets']
    assert widgets['primary_key'] == ['id']
    assert widgets['foreign_keys'] == [
        {'columns': ['maker_id'], 'referred_table': 'makers', 'referred_columns': ['id']}
    ]


def test_format_table_keeps_the_optional_keys_optional():
    """The one formatter both schema tools use, exercised directly.

    ``get_schema`` and ``refresh_schema`` promise callers the same per-table
    shape, and an LLM picks between the two tools on the strength of that
    sentence. Comparing the two tool payloads to each other cannot catch a key
    added to one side only, so the shape itself is pinned here.
    """
    full = _format_table(
        {
            'columns': [('id', 'INTEGER'), ('maker_id', 'INTEGER')],
            'primary_key': ['id'],
            'foreign_keys': [{'columns': ['maker_id'], 'referred_table': 'makers', 'referred_columns': ['id']}],
        }
    )
    assert full == {
        'columns': [{'column': 'id', 'type': 'INTEGER'}, {'column': 'maker_id', 'type': 'INTEGER'}],
        'primary_key': ['id'],
        'foreign_keys': [{'columns': ['maker_id'], 'referred_table': 'makers', 'referred_columns': ['id']}],
    }

    # An empty primary key / foreign key list is omitted, not emitted empty.
    assert _format_table({'columns': [('label', 'TEXT')], 'primary_key': [], 'foreign_keys': []}) == {
        'columns': [{'column': 'label', 'type': 'TEXT'}]
    }

    # ... and so is a key the reflection never produced.
    assert _format_table({'columns': [('label', 'TEXT')]}) == {'columns': [{'column': 'label', 'type': 'TEXT'}]}

    # A table with no columns still yields the required key.
    assert _format_table({'columns': []}) == {'columns': []}


def test_refresh_schema_ignores_its_input(instance):
    """The tool declares no input; anything passed is ignored rather than fatal."""
    for args in (None, {}, {'unexpected': 1}):
        assert 'tables' in instance.refresh_schema(args)


def test_refresh_schema_drops_a_table_that_no_longer_exists(instance):
    """Re-reflection REPLACES the cache; it does not merge into it."""
    instance.execute({'sql': 'CREATE TABLE widgets (id INTEGER PRIMARY KEY)'})
    assert 'widgets' in instance.refresh_schema({})['tables']

    instance.execute({'sql': 'DROP TABLE widgets'})
    assert instance.refresh_schema({})['tables'] == {}


def test_concurrent_refresh_schema_calls_all_succeed(shared_instance):
    """The lock serialises reflection without deadlocking or losing a result."""
    shared_instance.execute({'sql': 'CREATE TABLE widgets (id INTEGER PRIMARY KEY)'})
    results: list[dict] = []
    errors: list[BaseException] = []

    def _refresh():
        try:
            results.append(shared_instance.refresh_schema({}))
        except BaseException as exc:  # noqa: BLE001 - the test reports whatever escaped
            errors.append(exc)

    threads = [threading.Thread(target=_refresh) for _ in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=10)

    assert not any(thread.is_alive() for thread in threads)
    assert errors == []
    assert len(results) == 4
    assert all('widgets' in result['tables'] for result in results)


def test_refresh_schema_invalidates_the_insert_lane_column_map(instance):
    """The answers lane must be as current as the tool's own return value.

    ``refresh_schema`` replaces ``IGlobal.db_schema`` (what the LLM path
    describes) but ``_insertData`` builds every INSERT from ``IGlobal.schema``,
    a separate start-up snapshot of the configured table. Leaving that behind
    made the node current on one path and stale on the other: a column added
    by the very DDL that prompted the refresh would still be dropped.
    """
    iglobal = instance.IGlobal
    iglobal.table = 'widgets'

    instance.execute({'sql': 'CREATE TABLE widgets (label TEXT)'})
    # Start-up state: beginGlobal reflected the one-column table.
    iglobal.schema = {name: (col_type, '') for name, col_type in iglobal._getTableSchema('widgets')}
    assert set(iglobal.schema) == {'label'}

    instance.execute({'sql': 'ALTER TABLE widgets ADD COLUMN size INTEGER'})
    instance.refresh_schema({})

    # Invalidated, so _insertData re-reflects on its next call.
    assert iglobal.schema == {}

    instance._insertData([{'label': 'a', 'size': 7}])

    assert instance.execute({'sql': 'SELECT label, size FROM widgets'})['rows'] == [{'label': 'a', 'size': 7}]
    assert set(iglobal.schema) == {'label', 'size'}


def test_insert_lane_drops_a_new_column_without_a_refresh(instance):
    """Pins why the invalidation above is needed, not just that it happens."""
    iglobal = instance.IGlobal
    iglobal.table = 'widgets'

    instance.execute({'sql': 'CREATE TABLE widgets (label TEXT)'})
    iglobal.schema = {name: (col_type, '') for name, col_type in iglobal._getTableSchema('widgets')}

    instance.execute({'sql': 'ALTER TABLE widgets ADD COLUMN size INTEGER'})
    # No refresh_schema call: the stale map still has only `label`.
    instance._insertData([{'label': 'a', 'size': 7}])

    assert instance.execute({'sql': 'SELECT label, size FROM widgets'})['rows'] == [{'label': 'a', 'size': None}]


def test_refresh_schema_empties_the_column_map_when_the_table_is_gone(instance):
    """A dropped configured table leaves a falsy map, matching task start."""
    iglobal = instance.IGlobal
    iglobal.table = 'widgets'

    instance.execute({'sql': 'CREATE TABLE widgets (label TEXT)'})
    iglobal.schema = {name: (col_type, '') for name, col_type in iglobal._getTableSchema('widgets')}

    instance.execute({'sql': 'DROP TABLE widgets'})
    instance.refresh_schema({})

    assert iglobal.schema == {}


# ---------------------------------------------------------------------------
# The lazy rebuild that refresh_schema re-arms must be safe under concurrency
# ---------------------------------------------------------------------------


class _PausingInspector:
    """Inspector proxy that suspends one ``get_columns`` walk mid-flight.

    ``_getTableSchema`` iterates the column list it gets back, so returning an
    iterable that stops partway leaves the rebuild genuinely in progress --
    which is the state a concurrent reader used to be able to observe. Every
    other inspector call is delegated untouched.
    """

    def __init__(self, inner, *, entered, release, armed, fail_after=None):
        self._inner = inner
        self._entered = entered
        self._release = release
        self._armed = armed
        self._fail_after = fail_after

    def __getattr__(self, name):
        """Delegate everything this proxy does not override."""
        return getattr(self._inner, name)

    def get_columns(self, table, *args, **kwargs):
        """Return the real column list, pausing (once) partway through it."""
        columns = self._inner.get_columns(table, *args, **kwargs)
        if not self._armed.is_set():
            return columns
        self._armed.clear()  # one walk only; later reflections run at full speed
        return self._pause_midway(columns)

    def _pause_midway(self, columns):
        for index, column in enumerate(columns):
            if index == 1:
                self._entered.set()
                assert self._release.wait(timeout=10), 'the paused rebuild was never released'
                if self._fail_after:
                    raise RuntimeError('reflection failed midway')
            yield column


def _install_pausing_inspector(monkeypatch, *, entered, release, armed, fail_after=None):
    """Patch the inspect() db_global_base calls so one column walk can be paused."""
    real_inspect = db_global_base_module.inspect

    def _inspect(target):
        return _PausingInspector(
            real_inspect(target), entered=entered, release=release, armed=armed, fail_after=fail_after
        )

    monkeypatch.setattr(db_global_base_module, 'inspect', _inspect)


def test_a_concurrent_insert_waits_for_the_schema_rebuild(file_instance, monkeypatch):
    """A second insert must never build its row from a half-rebuilt column map.

    ``refresh_schema`` empties ``IGlobal.schema``; the next ``_insertData``
    refills it through ``_getTableSchema``, which used to publish the map and
    then grow it column by column. A second insert arriving inside that window
    found a truthy but incomplete map, skipped the rebuild, and silently
    dropped every column not yet added -- the row landed with NULLs in columns
    the caller had supplied.

    The rebuild is held open inside the column walk, so the window is real and
    not simulated. Once the lock covers check + rebuild + snapshot, the second
    insert provably cannot proceed until the first has published, so the
    assertions below do not depend on how long the window is held open.
    """
    inst = file_instance
    iglobal = inst.IGlobal
    iglobal.table = 'widgets'
    inst.execute({'sql': 'CREATE TABLE widgets (label TEXT, size INTEGER)'})
    iglobal.schema = {}  # the state refresh_schema leaves behind

    entered, release, armed = threading.Event(), threading.Event(), threading.Event()
    reached_table_check = threading.Event()
    armed.set()
    _install_pausing_inspector(monkeypatch, entered=entered, release=release, armed=armed)

    errors: list[BaseException] = []

    def _insert(row, ready=None):
        try:
            if ready is not None:
                ready.set()
            inst._insertData([row])
        except BaseException as exc:  # noqa: BLE001 - the test reports whatever escaped
            errors.append(exc)

    rebuilder = threading.Thread(target=_insert, args=({'label': 'a', 'size': 1},))
    rebuilder.start()
    assert entered.wait(timeout=10), 'the rebuild never started'

    reader = threading.Thread(target=_insert, args=({'label': 'b', 'size': 2}, reached_table_check))
    reader.start()
    assert reached_table_check.wait(timeout=10)
    # Give the reader every chance to race ahead into the schema check; under
    # the lock it cannot finish, so the timeout is the expected outcome here.
    reader.join(timeout=0.5)
    release.set()

    for thread in (rebuilder, reader):
        thread.join(timeout=10)
    assert not any(thread.is_alive() for thread in (rebuilder, reader))
    assert errors == []

    assert set(iglobal.schema) == {'label', 'size'}
    rows = inst.execute({'sql': 'SELECT label, size FROM widgets ORDER BY label'})['rows']
    assert rows == [{'label': 'a', 'size': 1}, {'label': 'b', 'size': 2}]


def test_refresh_schema_overlapping_a_rebuild_is_safe(file_instance, monkeypatch):
    """refresh_schema arriving during a rebuild must not raise or lose columns."""
    inst = file_instance
    iglobal = inst.IGlobal
    iglobal.table = 'widgets'
    inst.execute({'sql': 'CREATE TABLE widgets (label TEXT, size INTEGER)'})
    iglobal.schema = {}

    entered, release, armed = threading.Event(), threading.Event(), threading.Event()
    armed.set()
    _install_pausing_inspector(monkeypatch, entered=entered, release=release, armed=armed)

    errors: list[BaseException] = []

    def _insert():
        try:
            inst._insertData([{'label': 'a', 'size': 1}])
        except BaseException as exc:  # noqa: BLE001
            errors.append(exc)

    def _refresh():
        try:
            inst.refresh_schema({})
        except BaseException as exc:  # noqa: BLE001
            errors.append(exc)

    rebuilder = threading.Thread(target=_insert)
    rebuilder.start()
    assert entered.wait(timeout=10), 'the rebuild never started'

    refresher = threading.Thread(target=_refresh)
    refresher.start()
    refresher.join(timeout=0.5)
    release.set()

    for thread in (rebuilder, refresher):
        thread.join(timeout=10)
    assert not any(thread.is_alive() for thread in (rebuilder, refresher))
    assert errors == []

    # Whichever order the two finished in, the next insert sees every column.
    inst._insertData([{'label': 'b', 'size': 2}])
    assert set(iglobal.schema) == {'label', 'size'}
    rows = inst.execute({'sql': 'SELECT label, size FROM widgets ORDER BY label'})['rows']
    assert rows == [{'label': 'a', 'size': 1}, {'label': 'b', 'size': 2}]


def test_a_failed_rebuild_leaves_no_partial_column_map(file_instance, monkeypatch):
    """A rebuild that dies midway must leave the cache untouched, not half built.

    ``_getTableSchema`` published ``self.schema = {}`` before reading a single
    column, so a reflection that failed partway left a map holding whichever
    columns it had reached. The next insert would have believed it.
    """
    inst = file_instance
    iglobal = inst.IGlobal
    iglobal.table = 'widgets'
    inst.execute({'sql': 'CREATE TABLE widgets (label TEXT, size INTEGER, colour TEXT)'})
    iglobal.schema = {}

    entered, release, armed = threading.Event(), threading.Event(), threading.Event()
    armed.set()
    release.set()  # fail immediately rather than pausing
    _install_pausing_inspector(monkeypatch, entered=entered, release=release, armed=armed, fail_after=True)

    with pytest.raises(RuntimeError, match='schema could not be retrieved'):
        inst._insertData([{'label': 'a', 'size': 1, 'colour': 'red'}])

    assert iglobal.schema == {}

    # The lock is released on the failure path, not stranded.
    assert _REFLECT_LOCK.acquire(blocking=False)
    _REFLECT_LOCK.release()


def test_a_concurrent_insert_waits_for_the_auto_created_column_map(file_instance, monkeypatch):
    """The auto-create path is the second writer of the map, and it publishes too.

    ``_createTableFromData`` created the table and then filled ``self.schema``
    column by column, outside ``_REFLECT_LOCK`` — the same publish-then-fill
    shape ``_getTableSchema`` was fixed for. A second first-batch arriving
    after the CREATE found a truthy one-column map, snapshotted it under the
    lock, and silently dropped every other column the row carried.

    The fill loop is paused through the type object it stringifies, so the real
    loop runs; the lock is NOT widened over table creation.
    """
    inst = file_instance
    iglobal = inst.IGlobal
    iglobal.table = 'widgets'

    entered, release = threading.Event(), threading.Event()
    calls = {'n': 0}

    class _PausingText(Text):
        """A Text type whose str() blocks once, partway through the fill loop."""

        def __str__(self):
            """Stringify as TEXT, pausing on the second column of the first pass."""
            calls['n'] += 1
            if calls['n'] == 2 and not entered.is_set():
                entered.set()
                assert release.wait(timeout=10), 'the paused fill loop was never released'
            return 'TEXT'

    monkeypatch.setattr(db_global_base_module.DatabaseGlobalBase, '_inferColumnType', lambda self, value: _PausingText)

    errors: list[BaseException] = []

    def _insert(row):
        try:
            inst._insertData([row])
        except BaseException as exc:  # noqa: BLE001 - the test reports whatever escaped
            errors.append(exc)

    creator = threading.Thread(target=_insert, args=({'label': 'a', 'size': 'one', 'colour': 'red'},))
    creator.start()
    assert entered.wait(timeout=10), 'the auto-create never reached its fill loop'
    # The table now exists and the map holds exactly one of its three columns.
    assert set(iglobal.schema) != {'label', 'size', 'colour'}

    reader = threading.Thread(target=_insert, args=({'label': 'b', 'size': 'two', 'colour': 'blue'},))
    reader.start()
    # Under the lock the reader cannot finish while the map is unpublished, so
    # this timeout is the expected outcome; without it the window is wider.
    reader.join(timeout=0.5)
    release.set()

    for thread in (creator, reader):
        thread.join(timeout=10)
    assert not any(thread.is_alive() for thread in (creator, reader))
    assert errors == []

    rows = inst.execute({'sql': 'SELECT label, size, colour FROM widgets ORDER BY label'})['rows']
    assert rows == [
        {'label': 'a', 'size': 'one', 'colour': 'red'},
        {'label': 'b', 'size': 'two', 'colour': 'blue'},
    ]


def test_a_failed_reflection_leaves_the_previous_column_map_in_place(file_instance, monkeypatch):
    """Publishing once means the OLD map survives a failure, not that it is reset.

    The concurrency test above starts from an empty map, so it cannot tell
    "left untouched" from "reset to {}". This one seeds a stale map and calls
    ``_getTableSchema`` directly.
    """
    inst = file_instance
    iglobal = inst.IGlobal
    inst.execute({'sql': 'CREATE TABLE widgets (label TEXT, size INTEGER)'})

    stale = {'stale_column': ('TEXT', 'from an earlier reflection')}
    iglobal.schema = dict(stale)

    entered, release, armed = threading.Event(), threading.Event(), threading.Event()
    armed.set()
    release.set()  # fail immediately rather than pausing
    _install_pausing_inspector(monkeypatch, entered=entered, release=release, armed=armed, fail_after=True)

    assert iglobal._getTableSchema('widgets') is None
    assert iglobal.schema == stale


def test_insert_follows_a_column_added_and_then_dropped(instance):
    """Added and dropped columns both reach the insert lane after a refresh."""
    iglobal = instance.IGlobal
    iglobal.table = 'widgets'

    instance.execute({'sql': 'CREATE TABLE widgets (label TEXT)'})
    iglobal.schema = {name: (col_type, '') for name, col_type in iglobal._getTableSchema('widgets')}

    instance.execute({'sql': 'ALTER TABLE widgets ADD COLUMN size INTEGER'})
    instance.refresh_schema({})
    assert _compiled_insert_columns(instance, [{'label': 'a', 'size': 7}]) == ['label', 'size']
    assert instance.execute({'sql': 'SELECT label, size FROM widgets'})['rows'] == [{'label': 'a', 'size': 7}]

    instance.execute({'sql': 'ALTER TABLE widgets DROP COLUMN size'})
    instance.refresh_schema({})
    # The dropped column is gone from the rebuilt map, so it is never bound.
    assert _compiled_insert_columns(instance, [{'label': 'b', 'size': 7}]) == ['label']
    assert instance.execute({'sql': 'SELECT label FROM widgets ORDER BY label'})['rows'] == [
        {'label': 'a'},
        {'label': 'b'},
    ]


# ---------------------------------------------------------------------------
# execute() must not echo the statement or its bind parameters
# ---------------------------------------------------------------------------


def test_execute_error_does_not_leak_the_statement_or_parameters(instance):
    """A failed statement reports the driver message, never [SQL:]/[parameters:].

    ``str()`` of a SQLAlchemy StatementError appends the executed statement
    and the values bound into it. That used to stay in the server log; since
    ``execute`` re-raises the formatted message to its caller, the whole repr
    would reach a user-facing Run/Refresh UI. Runs against the real sqlite3
    driver, so it pins the actual exception shape rather than a fake.
    """
    instance.execute({'sql': 'CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT)'})

    with pytest.raises(RuntimeError) as excinfo:
        instance.execute({'sql': 'SELECT no_such_column FROM users WHERE email = $1', 'params': ['ada@example.com']})

    message = str(excinfo.value)
    assert message == 'SQL execution failed: no such column: no_such_column'
    assert 'ada@example.com' not in message
    assert '[SQL:' not in message
    assert '[parameters:' not in message
    assert 'sqlalche.me' not in message


def test_execute_error_passes_the_primary_sentence_through_verbatim(instance):
    """What the contract actually is: tails stripped, primary sentence as written.

    SQLite reports a syntax error as ``near "<fragment>": syntax error``, and
    that fragment is a piece of the statement the caller sent. The prose used
    to claim the statement text is never part of the message; it is not, as a
    whole, but the driver's own sentence can quote the point it failed at.
    What this promises is narrower and true: SQLAlchemy's ``[SQL: ...]`` and
    ``[parameters: ...]`` tail never reaches the caller, and the full text
    stays in the server log.
    """
    instance.execute({'sql': 'CREATE TABLE widgets (label TEXT)'})

    with pytest.raises(RuntimeError) as excinfo:
        instance.execute({'sql': "INSERT INTO widgets VALUES 'hunter2'"})

    message = str(excinfo.value)
    assert message == 'SQL execution failed: near "\'hunter2\'": syntax error'
    # Documented, not lamented: the fragment the parser stopped on is present.
    assert 'hunter2' in message
    # The tail this contract does remove is absent.
    assert '[SQL:' not in message
    assert '[parameters:' not in message
    assert 'sqlalche.me' not in message


# ---------------------------------------------------------------------------
# The answers lane must not bind a database-generated primary key
# ---------------------------------------------------------------------------


def _captured_inserts(instance, items):
    """Run an _insertData batch and return every INSERT that reached the driver.

    Each entry is ``(statement, parameters)``. A batch is no longer one
    statement: rows that share a key set go out together as an executemany,
    and a row with nothing to bind gets its own default-values statement, so a
    test that looked only at the first statement would miss what the rest did.
    """
    captured: list[tuple[str, object]] = []
    engine = instance.IGlobal.engine

    def _before_cursor_execute(conn, cursor, statement, parameters, context, executemany):
        if statement.lstrip().upper().startswith('INSERT'):
            captured.append((statement, parameters))

    event.listen(engine, 'before_cursor_execute', _before_cursor_execute)
    try:
        instance._insertData(items)
    finally:
        event.remove(engine, 'before_cursor_execute', _before_cursor_execute)
    return captured


def _statement_columns(statement):
    """Return the column names a captured INSERT binds (empty for DEFAULT VALUES)."""
    if '(' not in statement:
        return []
    inside = statement[statement.index('(') + 1 : statement.index(')')]
    return [name.strip().strip('"').strip('`') for name in inside.split(',') if name.strip()]


def _compiled_insert_columns(instance, items):
    """Return the column names an _insertData batch binds in its first statement.

    Capturing the compiled statement is the only way to assert on the column
    list rather than on whatever the database happened to tolerate.
    """
    captured = _captured_inserts(instance, items)
    assert captured, 'no INSERT reached the driver'
    return _statement_columns(captured[0][0])


def test_insert_after_refresh_does_not_bind_the_generated_primary_key(instance):
    """refresh_schema must not change what an auto-created table inserts.

    ``_createTableFromData`` prepends an auto-increment ``id`` and then caches
    the DATA columns only, because the database generates the key. Refreshing
    replaces that curated map with a plain reflection that includes ``id``;
    without the guard in ``_insertData`` every later row would bind ``id=None``
    -- harmless on SQLite's rowid alias, a not-null violation against the
    ``id SERIAL NOT NULL`` Postgres renders for the same column.
    """
    iglobal = instance.IGlobal
    iglobal.table = 'answers'

    # Auto-create through the real path, then confirm the curated map.
    instance._insertData([{'q': 'why', 'a': 'because'}])
    assert set(iglobal.schema) == {'q', 'a'}

    instance.refresh_schema({})
    # The rebuilt map is a full reflection, primary key included ...
    instance._insertData([{'q': 'how', 'a': 'like this'}])
    assert set(iglobal.schema) == {'id', 'q', 'a'}

    # ... but the INSERT still carries the data columns only.
    columns = _compiled_insert_columns(instance, [{'q': 'when', 'a': 'now'}])
    assert 'id' not in columns
    assert set(columns) == {'q', 'a'}

    rows = instance.execute({'sql': 'SELECT id, q FROM answers ORDER BY id'})['rows']
    assert [row['q'] for row in rows] == ['why', 'how', 'when']
    assert all(row['id'] is not None for row in rows)


def test_insert_omits_a_reflected_primary_key_the_rows_do_not_supply(instance):
    """The same guard covers a table that already existed at task start.

    ``beginGlobal`` reflects the configured table, so its map has always
    carried the primary key; binding NULL into it was a pre-existing defect
    that the refresh path would otherwise have widened to auto-created tables.
    """
    iglobal = instance.IGlobal
    iglobal.table = 'widgets'

    instance.execute({'sql': 'CREATE TABLE widgets (id INTEGER PRIMARY KEY, label TEXT)'})
    iglobal.schema = {name: (col_type, '') for name, col_type in iglobal._getTableSchema('widgets')}
    assert set(iglobal.schema) == {'id', 'label'}

    columns = _compiled_insert_columns(instance, [{'label': 'a'}])
    assert columns == ['label']


def test_insert_still_binds_a_primary_key_the_rows_do_supply(instance):
    """An explicit key is the caller's to set; the guard must not swallow it."""
    iglobal = instance.IGlobal
    iglobal.table = 'widgets'

    instance.execute({'sql': 'CREATE TABLE widgets (id INTEGER PRIMARY KEY, label TEXT)'})
    iglobal.schema = {name: (col_type, '') for name, col_type in iglobal._getTableSchema('widgets')}

    columns = _compiled_insert_columns(instance, [{'id': 42, 'label': 'a'}])
    assert set(columns) == {'id', 'label'}
    assert instance.execute({'sql': 'SELECT id FROM widgets'})['rows'] == [{'id': 42}]


def test_insert_into_a_generated_only_table_uses_default_values(instance):
    """A table that is nothing but a generated key takes a default-values insert.

    Binding the sole primary key as NULL (the old fallback) is tolerable only
    because SQLite treats an integer primary key as a rowid alias. Postgres
    renders the same column as ``id SERIAL NOT NULL`` and rejects the explicit
    NULL outright, so the batch that works here would fail there.
    """
    iglobal = instance.IGlobal
    iglobal.table = 'ids'

    instance.execute({'sql': 'CREATE TABLE ids (id INTEGER PRIMARY KEY)'})
    iglobal.schema = {name: (col_type, '') for name, col_type in iglobal._getTableSchema('ids')}

    captured = _captured_inserts(instance, [{'label': 'ignored'}])
    assert len(captured) == 1
    statement, parameters = captured[0]
    assert _statement_columns(statement) == []
    assert 'DEFAULT VALUES' in statement.upper()
    assert not parameters

    # A batch of three yields three statements and three distinct keys.
    captured = _captured_inserts(instance, [{}, {}, {}])
    assert len(captured) == 3
    assert all(_statement_columns(stmt) == [] for stmt, _ in captured)

    rows = instance.execute({'sql': 'SELECT id FROM ids ORDER BY id'})['rows']
    ids = [row['id'] for row in rows]
    assert len(ids) == 4
    assert len(set(ids)) == 4
    assert all(value is not None for value in ids)


def test_default_values_insert_compiles_for_postgres_mysql_and_sqlite(instance):
    """Compile-only: the dialect-correct form of a values-less INSERT.

    There is no live PostgreSQL or MySQL in this suite, so the cross-dialect
    claim is proven by compilation rather than execution. SQLAlchemy renders
    ``DEFAULT VALUES`` for PostgreSQL and SQLite and ``() VALUES ()`` for
    MySQL, which is the whole reason this path hands the statement no values
    instead of binding NULL itself.
    """
    instance.execute({'sql': 'CREATE TABLE ids (id INTEGER PRIMARY KEY)'})
    table = SQLTable('ids', MetaData(), autoload_with=instance.IGlobal.engine)
    statement = insert(table)

    assert str(statement.compile(dialect=postgresql.dialect(), column_keys=[])) == (
        'INSERT INTO ids DEFAULT VALUES RETURNING ids.id'
    )
    assert str(statement.compile(dialect=mysql.dialect(), column_keys=[])) == 'INSERT INTO ids () VALUES ()'
    assert str(statement.compile(dialect=sqlite.dialect(), column_keys=[])) == 'INSERT INTO ids DEFAULT VALUES'


def test_insert_rejects_a_sole_primary_key_the_database_does_not_generate(instance):
    """An empty mapping is only safe when the database really does generate the key."""
    iglobal = instance.IGlobal
    iglobal.table = 'codes'

    instance.execute({'sql': 'CREATE TABLE codes (code TEXT PRIMARY KEY)'})
    iglobal.schema = {name: (col_type, '') for name, col_type in iglobal._getTableSchema('codes')}

    with pytest.raises(ValueError, match='code'):
        instance._insertData([{'label': 'ignored'}])

    assert instance.execute({'sql': 'SELECT code FROM codes'})['rows'] == []


# ---------------------------------------------------------------------------
# Generated-key presence is decided per row, not per batch
# ---------------------------------------------------------------------------


def test_insert_mixes_supplied_and_generated_keys_within_one_batch(instance):
    """One row supplying the key must not make every other row bind NULL.

    The decision used to be taken once per batch from the union of the rows'
    keys, so a single row carrying ``id`` put ``id`` into every mapping and the
    rows that omitted it bound NULL. SQLite happens to accept that for a rowid
    alias; Postgres rejects the whole batch for a ``SERIAL NOT NULL`` key.
    """
    iglobal = instance.IGlobal
    iglobal.table = 'widgets'

    instance.execute({'sql': 'CREATE TABLE widgets (id INTEGER PRIMARY KEY, label TEXT)'})
    iglobal.schema = {name: (col_type, '') for name, col_type in iglobal._getTableSchema('widgets')}

    captured = _captured_inserts(instance, [{'label': 'a'}, {'id': 42, 'label': 'b'}, {'label': 'c'}])

    # Three contiguous runs, two distinct column sets, input order preserved.
    assert [_statement_columns(stmt) for stmt, _ in captured] == [['label'], ['id', 'label'], ['label']]

    rows = instance.execute({'sql': 'SELECT id, label FROM widgets ORDER BY id'})['rows']
    assert [row['label'] for row in rows] == ['a', 'b', 'c']
    assert {row['label']: row['id'] for row in rows}['b'] == 42
    assert all(row['id'] is not None for row in rows)


def test_insert_leaves_an_explicit_null_generated_key_to_the_database(instance):
    """On the insert lane, an explicit null on a generated key means "no value".

    The caller here is an upstream node, not a person: an LLM node, a JSON
    mapper or a row round-tripped out of another table emits every schema key,
    so it writes ``{'id': None}`` for a key it has no value for. Binding that
    NULL is a not-null violation against Postgres' ``id SERIAL NOT NULL``, and
    a silent one -- ``writeAnswers`` only logs. MySQL and SQLite generate a
    value instead, which is why the column list, not the stored row, is what
    this asserts.
    """
    iglobal = instance.IGlobal
    iglobal.table = 'widgets'

    instance.execute({'sql': 'CREATE TABLE widgets (id INTEGER PRIMARY KEY, label TEXT)'})
    iglobal.schema = {name: (col_type, '') for name, col_type in iglobal._getTableSchema('widgets')}

    captured = _captured_inserts(instance, [{'id': None, 'label': 'a'}])
    assert len(captured) == 1
    statement, parameters = captured[0]
    assert _statement_columns(statement) == ['label']
    assert list(parameters) == ['a']

    rows = instance.execute({'sql': 'SELECT id, label FROM widgets'})['rows']
    assert rows == [{'id': 1, 'label': 'a'}]


def test_insert_still_binds_an_explicit_null_on_a_non_key_column(instance):
    """The rule is narrow: only a generated PRIMARY KEY reads null as "omitted".

    Everywhere else an explicit null is a value the caller chose, and a column
    that is simply absent from the row is bound NULL anyway, so there is
    nothing to distinguish and nothing to second-guess.
    """
    iglobal = instance.IGlobal
    iglobal.table = 'widgets'

    instance.execute({'sql': "CREATE TABLE widgets (id INTEGER PRIMARY KEY, label TEXT, note TEXT DEFAULT 'unset')"})
    iglobal.schema = {name: (col_type, '') for name, col_type in iglobal._getTableSchema('widgets')}

    columns = _compiled_insert_columns(instance, [{'label': 'a', 'note': None}])
    assert columns == ['label', 'note']
    assert instance.execute({'sql': 'SELECT label, note FROM widgets'})['rows'] == [{'label': 'a', 'note': None}]


# ---------------------------------------------------------------------------
# Columns the database fills in are left to the database, key or not
# ---------------------------------------------------------------------------


def test_insert_leaves_a_new_not_null_default_column_to_the_database(instance):
    """A column added by DDL and picked up by refresh_schema must not bind NULL.

    The sequence the refresh tool invites: the answers table is auto-created as
    (id, q, a) with the curated map {q, a}; an agent runs ALTER TABLE ... ADD
    COLUMN created_at ... NOT NULL DEFAULT ...; the tool description tells it
    to call refresh_schema, so the next batch rebuilds the map by reflection
    and now holds created_at as well. Binding an explicit NULL there overrides
    the server default and violates NOT NULL -- and writeAnswers only logs, so
    the batch that worked before the DDL now vanishes with one log line.
    """
    iglobal = instance.IGlobal
    iglobal.table = 'answers'

    instance._insertData([{'q': 'why', 'a': 'because'}])
    assert set(iglobal.schema) == {'q', 'a'}

    instance.execute({'sql': "ALTER TABLE answers ADD COLUMN created_at TEXT NOT NULL DEFAULT 'now'"})
    instance.refresh_schema({})

    columns = _compiled_insert_columns(instance, [{'q': 'how', 'a': 'like this'}])
    assert columns == ['q', 'a']

    rows = instance.execute({'sql': 'SELECT q, created_at FROM answers ORDER BY q'})['rows']
    assert rows == [{'q': 'how', 'created_at': 'now'}, {'q': 'why', 'created_at': 'now'}]


def test_insert_binds_a_supplied_value_over_a_server_default(instance):
    """Leaving a defaulted column alone applies only when the row omits it."""
    iglobal = instance.IGlobal
    iglobal.table = 'notes'

    instance.execute({'sql': "CREATE TABLE notes (label TEXT, created_at TEXT NOT NULL DEFAULT 'now')"})
    iglobal.schema = {name: (col_type, '') for name, col_type in iglobal._getTableSchema('notes')}

    columns = _compiled_insert_columns(instance, [{'label': 'a', 'created_at': 'yesterday'}])
    assert columns == ['label', 'created_at']
    assert instance.execute({'sql': 'SELECT label, created_at FROM notes'})['rows'] == [
        {'label': 'a', 'created_at': 'yesterday'}
    ]


def test_insert_still_binds_null_for_an_omitted_column_without_a_default(instance):
    """Unchanged behaviour: only a DEFAULT makes an omitted column the database's.

    A plain nullable column the rows do not carry is still bound NULL, which is
    what makes a batch of ragged rows land with a consistent column set.
    """
    iglobal = instance.IGlobal
    iglobal.table = 'widgets'

    instance.execute({'sql': 'CREATE TABLE widgets (label TEXT, note TEXT)'})
    iglobal.schema = {name: (col_type, '') for name, col_type in iglobal._getTableSchema('widgets')}

    columns = _compiled_insert_columns(instance, [{'label': 'a'}])
    assert columns == ['label', 'note']
    assert instance.execute({'sql': 'SELECT label, note FROM widgets'})['rows'] == [{'label': 'a', 'note': None}]


def test_insert_rejects_a_composite_primary_key_column_the_row_omits(instance):
    """A composite key is not auto-generated, so a missing half is a clear error."""
    iglobal = instance.IGlobal
    iglobal.table = 'pairs'

    instance.execute({'sql': 'CREATE TABLE pairs (a INTEGER, b INTEGER, PRIMARY KEY (a, b))'})
    iglobal.schema = {name: (col_type, '') for name, col_type in iglobal._getTableSchema('pairs')}

    with pytest.raises(ValueError) as excinfo:
        instance._insertData([{'a': 1, 'b': 2}, {'a': 3}])

    message = str(excinfo.value)
    assert 'b' in message
    assert 'pairs' in message
    assert '1' in message  # the row position

    # Nothing was executed: the rejection happens before the transaction opens.
    assert instance.execute({'sql': 'SELECT a FROM pairs'})['rows'] == []


def test_insert_rejects_a_text_primary_key_without_a_default(instance):
    """A TEXT primary key with no default is not something the database fills in."""
    iglobal = instance.IGlobal
    iglobal.table = 'codes'

    instance.execute({'sql': 'CREATE TABLE codes (code TEXT PRIMARY KEY, label TEXT)'})
    iglobal.schema = {name: (col_type, '') for name, col_type in iglobal._getTableSchema('codes')}

    with pytest.raises(ValueError, match='code'):
        instance._insertData([{'label': 'a'}])


def test_insert_lets_a_server_default_primary_key_generate_itself(instance):
    """A reflected server_default counts as generated even on a TEXT key."""
    iglobal = instance.IGlobal
    iglobal.table = 'codes'

    instance.execute({'sql': "CREATE TABLE codes (code TEXT PRIMARY KEY DEFAULT 'generated', label TEXT)"})
    iglobal.schema = {name: (col_type, '') for name, col_type in iglobal._getTableSchema('codes')}

    columns = _compiled_insert_columns(instance, [{'label': 'a'}])
    assert columns == ['label']
    assert instance.execute({'sql': 'SELECT code, label FROM codes'})['rows'] == [{'code': 'generated', 'label': 'a'}]


def test_a_failing_run_rolls_back_the_rows_of_every_other_run(instance):
    """Splitting a batch into runs must not split its transaction.

    All the runs share one engine.begin(), so a constraint violation in the
    second discards the first as well -- the all-or-nothing semantics a single
    executemany used to give for free.
    """
    iglobal = instance.IGlobal
    iglobal.table = 'widgets'

    instance.execute({'sql': 'CREATE TABLE widgets (id INTEGER PRIMARY KEY, label TEXT UNIQUE)'})
    instance.execute({'sql': "INSERT INTO widgets (id, label) VALUES (1, 'taken')"})
    iglobal.schema = {name: (col_type, '') for name, col_type in iglobal._getTableSchema('widgets')}

    with pytest.raises(Exception):  # noqa: B017 - the driver's IntegrityError, whatever it is called
        instance._insertData([{'label': 'fresh'}, {'id': 9, 'label': 'taken'}])

    # The first run's row must not survive the second run's failure.
    rows = instance.execute({'sql': 'SELECT label FROM widgets ORDER BY label'})['rows']
    assert rows == [{'label': 'taken'}]


# ---------------------------------------------------------------------------
# _executeRawQuery always returns a dict or raises
# ---------------------------------------------------------------------------


def test_execute_raw_query_returns_a_dict_for_ddl_and_select(instance):
    """The only caller (``execute``) never has to test the result for None.

    ``_executeRawQuery`` was annotated ``dict | None`` while its body either
    returned the shaped dict or raised, so ``execute`` carried a dead None
    guard whose message ('check server logs for details') was the opaque
    string this work replaced.
    """
    ddl = instance._executeRawQuery('CREATE TABLE widgets (id INTEGER PRIMARY KEY, label TEXT)')
    assert isinstance(ddl, dict)
    assert set(ddl) == {'rows', 'affected_rows'}

    select = instance._executeRawQuery('SELECT label FROM widgets')
    assert isinstance(select, dict)
    assert select == {'rows': [], 'affected_rows': 0}
