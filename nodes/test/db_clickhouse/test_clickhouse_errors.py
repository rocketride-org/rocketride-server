# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""The db_clickhouse node's error text: what ClickHouse repeats from the statement is removed."""

import importlib
import sys
import time
import types
from pathlib import Path

import pytest

from ai.common.database import DatabaseGlobalBase

NODE_DIR = Path(__file__).resolve().parents[2] / 'src' / 'nodes' / 'db_clickhouse'
TRACE = (
    '. Stack trace:\n\n0. DB::Exception::Exception(DB::Exception::MessageMasked&&, int, bool) @ 0x0000000011001070\n'
)


class ServerException(Exception):
    """clickhouse-driver's error: the code and the text are attributes."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


class DatabaseException(Exception):
    """clickhouse-sqlalchemy's wrapper, which is what the node's ``clickhouse+native://`` raises."""

    def __init__(self, orig):
        super().__init__(orig)
        self.orig = orig


class OperationalError(Exception):
    """``clickhouse_driver.dbapi``'s wrapper: the driver error is its only argument."""


ROUTES = {'sqla-native': DatabaseException, 'dbapi': OperationalError}


@pytest.fixture(scope='module')
def IGlobal():
    """Load db_clickhouse/IGlobal.py without the package ``__init__``, which installs the driver."""
    names = ('db_clickhouse', 'db_clickhouse.IGlobal')
    saved = {name: sys.modules.get(name) for name in names}
    package = types.ModuleType('db_clickhouse')
    package.__path__ = [str(NODE_DIR)]
    sys.modules['db_clickhouse'] = package
    try:
        yield importlib.import_module('db_clickhouse.IGlobal').IGlobal
    finally:
        for name, module in saved.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module


@pytest.fixture
def g(IGlobal):
    """A bare IGlobal; formatting needs no engine."""
    return IGlobal.__new__(IGlobal)


def _error(route, code, message):
    return ROUTES[route](ServerException(code, message + TRACE))


# Messages copied byte for byte from ClickHouse 23.8.16.16 and 25.8.33.6 (clickhouse-driver 0.2.9), 2026-10-20,
# for statements that bind QA_CANARY_* values into later rows; the stack trace is dropped. The rows added after
# this list (ids starting `constructed-`) are constructed: no live statement produced them.
_REAL = [
    pytest.param(
        27,
        (
            "DB::ParsingException. DB::ParsingException: Cannot parse input: expected '(' before: 'ON DUPLICATE K"
            "EY UPDATE s = \\'QA_CANARY_B1\\', (3, \\'QA_CANARY_B2\\')':  at row 1: While executing ValuesBlockInputF"
            'ormat'
        ),
        ['QA_CANARY_B1', 'QA_CANARY_B2'],
        "Cannot parse input: expected '('",
        id='23.8-before',
    ),
    pytest.param(
        27,
        (
            "DB::ParsingException. DB::ParsingException: Cannot parse input: expected ',' before: 'abc,\"QA_CANARY"
            '_C2"\\n3,"QA_CANARY_C3"\\n\': \nRow 1:\nColumn 0,   name: id, type: UInt32, parsed text: "1"\nColumn 1,   '
            'name: s,  type: String, parsed text: "<DOUBLE QUOTE>QA_CANARY_C1<DOUBLE QUOTE>"\n\nRow 2:\nColumn 0,   '
            'name: id, type: UInt32, ERROR: text "abc,<DOUBLE QUOTE>QA_CA" is not like UInt32\n\n: While executing '
            'ParallelParsingBlockInputFormat: (at row 2)\n'
        ),
        ['QA_CANARY_C1', 'QA_CANARY_C2', 'QA_CANARY_C3'],
        "Cannot parse input: expected ','",
        id='23.8-csv',
    ),
    pytest.param(
        117,
        (
            'DB::Exception: Expected end of line: (at row 2)\n: \nRow 1:\nColumn 0,   name: id, type: UInt32, parsed'
            ' text: "1"\nColumn 1,   name: s,  type: String, parsed text: "<DOUBLE QUOTE>QA_CANARY_C1<DOUBLE QUOTE'
            '>"\n\nRow 2:\nColumn 0,   name: id, type: UInt32, parsed text: "2"\nColumn 1,   name: s,  type: String, '
            'parsed text: "<DOUBLE QUOTE>QA_CANARY_C2<DOUBLE QUOTE>"\nERROR: There is no line feed. "9" found inst'
            "ead.\n It's like your file has more columns than expected.\nAnd if your file has the right number of c"
            'olumns, maybe it has an unquoted string value with a comma.\n\n: While executing ParallelParsingBlockI'
            'nputFormat'
        ),
        ['QA_CANARY_C1', 'QA_CANARY_C2'],
        'Expected end of line: (at row 2)',
        id='25.8-extra-column',
    ),
    pytest.param(
        72,
        (
            "DB::ParsingException. DB::ParsingException: Unsigned type must not contain '-' symbol: \nRow 1:\nColum"
            'n 0,   name: id, type: UInt32, parsed text: "1"\nColumn 1,   name: s,  type: String, parsed text: "<D'
            'OUBLE QUOTE>QA_CANARY_C1<DOUBLE QUOTE>"\n\nRow 2:\nColumn 0,   name: id, type: UInt32, ERROR: text "-5,'
            '<DOUBLE QUOTE>QA_CAN" is not like UInt32\n\n: While executing CSVRowInputFormat: (at row 2)\n'
        ),
        ['QA_CANARY_C1', 'QA_CANARY_C2'],
        "Unsigned type must not contain '-' symbol",
        id='23.8-negative',
    ),
    pytest.param(
        53,
        (
            "DB::Exception: Cannot insert NULL value into a column of type 'UInt32' at: NULL, 'QA_CANARY_N3'), (3"
            ", 'QA_CANARY_N4'): While executing ValuesBlockInputFormat"
        ),
        ['QA_CANARY_N3', 'QA_CANARY_N4'],
        "Cannot insert NULL value into a column of type 'UInt32'",
        id='25.8-null',
    ),
    pytest.param(
        62,
        (
            "DB::Exception: Cannot deduce template of expression: lower((('QA_CANARY_D3')))): While executing Val"
            'uesBlockInputFormat'
        ),
        ['QA_CANARY_D3'],
        'Cannot deduce template of expression',
        id='25.8-template',
    ),
    pytest.param(
        36,
        (
            'DB::Exception: Element of set in IN, VALUES, or LIMIT, or aggregate function parameter, or a table f'
            "unction argument is not a constant expression (result column not found): arrayJoin(['QA_CANARY_D7'])"
            ': While executing ValuesBlockInputFormat'
        ),
        ['QA_CANARY_D7'],
        'is not a constant expression (result column not found)',
        id='23.8-not-constant',
    ),
    pytest.param(
        62,
        (
            "DB::Exception: Cannot parse expression of type UInt32 here: 2 3, 'QA_CANARY_P5'), (3, 'QA_CANARY_P6'"
            '): While executing ValuesBlockInputFormat'
        ),
        ['QA_CANARY_P5', 'QA_CANARY_P6'],
        'Cannot parse expression of type UInt32',
        id='25.8-here',
    ),
    pytest.param(
        62,
        (
            "DB::Exception: Syntax error: failed at position 1 ('SELEC'): SELEC id FROM qa_rel.t WHERE s = 'QA_CA"
            "NARY_Y1'. Expected one of: Query, Query with output, EXPLAIN, SELECT query, possibly with UNION, lis"
            't of union elements, SELECT query, subquery, possibly with UNION, SELECT subquery, SELECT query, WIT'
            'H, FROM, SELECT, SHOW CREATE QUOTA query, SHOW CREATE, SHOW [FULL] [TEMPORARY] TABLES|DATABASES|CLUS'
            "TERS|CLUSTER 'name' [[NOT] [I]LIKE 'str'] [LIMIT expr], SHOW, SHOW COLUMNS query, SHOW ENGINES query"
            ', SHOW ENGINES, SHOW INDEXES query, EXISTS or SHOW CREATE query, EXISTS, DESCRIBE FILESYSTEM CACHE q'
            'uery, DESCRIBE, DESC, DESCRIBE query, SHOW PROCESSLIST query, SHOW PROCESSLIST, CREATE TABLE or ATTA'
            'CH TABLE query, CREATE, ATTACH, REPLACE, CREATE DATABASE query, CREATE VIEW query, CREATE DICTIONARY'
            ', CREATE LIVE VIEW query, CREATE WINDOW VIEW query, ALTER query, ALTER TABLE, ALTER LIVE VIEW, ALTER'
            ' DATABASE, RENAME query, RENAME TABLE, EXCHANGE TABLES, RENAME DICTIONARY, EXCHANGE DICTIONARIES, RE'
            'NAME DATABASE, DROP query, DROP, DETACH, TRUNCATE, UNDROP query, UNDROP, CHECK TABLE, KILL QUERY que'
            'ry, KILL, OPTIMIZE query, OPTIMIZE TABLE, WATCH query, WATCH, SHOW ACCESS query, SHOW ACCESS, ShowAc'
            'cessEntitiesQuery, SHOW GRANTS query, SHOW GRANTS, SHOW PRIVILEGES query, SHOW PRIVILEGES, INSERT qu'
            'ery, INSERT INTO, USE query, USE, SET ROLE or SET DEFAULT ROLE query, SET ROLE DEFAULT, SET ROLE, SE'
            'T DEFAULT ROLE, SET query, SET, SYSTEM query, SYSTEM, CREATE USER or ALTER USER query, ALTER USER, C'
            'REATE USER, CREATE ROLE or ALTER ROLE query, ALTER ROLE, CREATE ROLE, CREATE QUOTA or ALTER QUOTA qu'
            'ery, ALTER QUOTA, CREATE QUOTA, CREATE ROW POLICY or ALTER ROW POLICY query, ALTER POLICY, ALTER ROW'
            ' POLICY, CREATE POLICY, CREATE ROW POLICY, CREATE SETTINGS PROFILE or ALTER SETTINGS PROFILE query, '
            'ALTER SETTINGS PROFILE, ALTER PROFILE, CREATE SETTINGS PROFILE, CREATE PROFILE, CREATE FUNCTION quer'
            'y, DROP FUNCTION query, CREATE NAMED COLLECTION, DROP NAMED COLLECTION query, Alter NAMED COLLECTION'
            ' query, ALTER, CREATE INDEX query, DROP INDEX query, DROP access entity query, MOVE access entity qu'
            'ery, MOVE, GRANT or REVOKE query, REVOKE, GRANT, EXTERNAL DDL query, EXTERNAL DDL FROM, TCL query, B'
            'EGIN TRANSACTION, COMMIT, ROLLBACK, SET TRANSACTION SNAPSHOT, Delete query, DELETE, BACKUP or RESTOR'
            'E query, BACKUP, RESTORE'
        ),
        ['QA_CANARY_Y1'],
        'Syntax error',
        id='23.8-syntax',
    ),
    pytest.param(
        47,
        (
            "DB::Exception: Missing columns: 'nope' while processing query: 'SELECT nope FROM qa_rel.t WHERE s = "
            "'QA_CANARY_S1'', required columns: 'nope' 's', maybe you meant: 's'"
        ),
        ['QA_CANARY_S1'],
        "Missing columns: 'nope'",
        id='23.8-while-processing',
    ),
    pytest.param(
        47,
        (
            "DB::Exception: Unknown expression identifier `nope` in scope SELECT nope FROM qa_rel.t WHERE s = 'QA"
            "_CANARY_S1'"
        ),
        ['QA_CANARY_S1'],
        'Unknown expression identifier `nope`',
        id='25.8-in-scope',
    ),
    pytest.param(
        47,
        (
            "DB::Exception: Unknown expression or function identifier `nope` in scope 'QA_CANARY_S3' = nope: Whil"
            'e executing ValuesBlockInputFormat'
        ),
        ['QA_CANARY_S3', 'QA_CANARY_S4'],
        'Unknown expression or function identifier `nope`',
        id='25.8-in-scope-literal-first',
    ),
    pytest.param(
        47,
        (
            "DB::Exception: Unknown expression identifier `nope` in scope (SELECT nope FROM qa_rel.t WHERE s = 'Q"
            "A_CANARY_P1') AS v"
        ),
        ['QA_CANARY_P1'],
        'Unknown expression identifier `nope`',
        id='25.8-in-scope-subquery',
    ),
    pytest.param(
        215,
        (
            "DB::Exception: Column 'qa_rel.t.id' is not under aggregate function and not in GROUP BY keys. In que"
            "ry SELECT id, count() FROM qa_rel.t WHERE s = 'QA_CANARY_P4' GROUP BY s"
        ),
        ['QA_CANARY_P4'],
        'is not under aggregate function and not in GROUP BY keys.',
        id='25.8-in-query',
    ),
    pytest.param(
        60,
        'DB::Exception: Table qa_rel.nope_tbl does not exist',
        [],
        'Table qa_rel.nope_tbl does not exist.',
        id='23.8-no-echo',
    ),
]

_REAL += [
    pytest.param(
        395,
        "DB::Exception: Value passed to 'throwIf' is non-zero in scope SELECT 'QA_CANARY_K'",
        ['QA_CANARY_K'],
        "Value passed to 'throwIf' is non-zero",
        id='constructed-throw-if-without-context',
    ),
    pytest.param(
        47,
        "Missing columns: 'x' while processing query: 'SELECT x WHERE s = ''QA_CANARY_Z'''",
        ['QA_CANARY_Z'],
        "Missing columns: 'x'",
        id='constructed-message-without-the-class',
    ),
    pytest.param(
        47,
        "DB::Exception: There are no table sources. In scope SELECT token FROM users WHERE token = 'QA_CANARY_X'",
        ['QA_CANARY_X'],
        'There are no table sources.',
        id='constructed-sentence-initial-scope',
    ),
    pytest.param(
        47,
        "DB::Exception: Not found column secret in block, required columns: 'secret', 'QA_CANARY_Y'",
        ['QA_CANARY_Y'],
        'Not found column secret in block',
        id='constructed-required-columns',
    ),
]


@pytest.mark.parametrize('route', ROUTES)
@pytest.mark.parametrize(('code', 'payload', 'canaries', 'sentence'), _REAL)
def test_server_error_keeps_its_sentence_and_loses_the_echo(g, route, code, payload, canaries, sentence):
    result = g._format_db_error(_error(route, code, payload))

    assert result.startswith(f'Error {code}: ')
    assert sentence in result
    assert 'Stack trace' not in result
    for canary in canaries:
        assert canary not in result


_THROW_IF = {
    '23.8': "DB::Exception: QA app text: Upload failed at position 3 of batch: while executing 'FUNCTION throwIf(1 :: 0, 'QA app text: Upload failed at position 3 of batch' :: 1) -> throwIf(1, 'QA app text: Upload failed at position 3 of batch') UInt8 : 2'",
    '25.8': "DB::Exception: QA app text: Upload failed at position 3 of batch: while executing 'FUNCTION throwIf(1_UInt8 :: 1, 'QA app text: Upload failed at position 3 of batch'_String :: 2) -> throwIf(1_UInt8, 'QA app text: Upload failed at position 3 of batch'_String) UInt8 : 3'",
}


@pytest.mark.parametrize('route', ROUTES)
@pytest.mark.parametrize('payload', _THROW_IF.values(), ids=_THROW_IF)
def test_throw_if_message_comes_back_whole_without_its_runtime_context(g, route, payload):
    result = g._format_db_error(_error(route, 395, payload))

    assert result == 'Error 395: DB::Exception: QA app text: Upload failed at position 3 of batch'


@pytest.mark.parametrize(
    'exc',
    [
        DatabaseException(RuntimeError('no such column [SQL: SELECT 1]')),
        OperationalError(RuntimeError('no such column [SQL: SELECT 1]')),
        OperationalError(ServerException(210, '   ')),
        RuntimeError('boom'),
    ],
    ids=['sqlalchemy-error', 'dbapi-wrapper-of-another-error', 'blank-message', 'no-code'],
)
def test_an_error_without_the_drivers_code_and_message_goes_to_the_shared_formatter(g, exc):
    assert g._format_db_error(exc) == DatabaseGlobalBase._format_db_error(g, exc)


@pytest.mark.parametrize('route', ROUTES)
def test_the_node_formatter_is_the_one_in_use(g, IGlobal, route):
    # The shared formatter leaves the rest of the rows in; only the node's override removes them.
    exc = _error(route, 27, _REAL[0].values[1])

    assert IGlobal._format_db_error is not DatabaseGlobalBase._format_db_error
    assert g._format_db_error(exc) != DatabaseGlobalBase._format_db_error(g, exc)


def test_a_message_that_was_only_an_echo_says_so(g):
    exc = DatabaseException(ServerException(47, "DB::Exception: In scope SELECT 'QA_CANARY_E'" + TRACE))

    assert g._format_db_error(exc) == "Error 47: DB::Exception: (the server's message only repeated the statement)"


@pytest.mark.parametrize('filler', [' ', '\t', ' \n', '\n: ', '\nRow 1:'])
def test_formatting_time_does_not_grow_with_whitespace(g, filler):
    # Small first: a cubic pattern takes ~0.5 s here and would take an hour at 20,000.
    for size, limit in ((1000, 0.1), (20000, 1)):
        exc = DatabaseException(ServerException(27, f"DB::Exception: Cannot parse '{filler * size}' as UInt32" + TRACE))

        start = time.perf_counter()
        g._format_db_error(exc)

        assert time.perf_counter() - start < limit
