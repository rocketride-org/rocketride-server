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

"""Hotdata node - per-instance tool surface.

Exposes schema introspection, read-only SQL, natural-language querying, data
loading and index building, plus the questions and answers lanes.
"""

from __future__ import annotations

import json
import hashlib
import re
import time
from typing import Any, Dict, List, Tuple

from ai.common.schema import Answer, Question
from ai.common.utils import normalize_tool_input
from rocketlib import IInstanceBase, debug, error, tool_function, warning
from rocketlib.types import IInvokeLLM

from .hotdata_schema import (
    format_schema_for_prompt,
    get_dialect_prompt_text,
    strip_sql_fences,
)

#: Statement verbs Hotdata rejects before execution. Caught client-side so the
#: agent gets a clear reason instead of a generic server error.
_WRITE_VERBS = frozenset(
    {
        'insert',
        'update',
        'delete',
        'merge',
        'copy',
        'create',
        'drop',
        'alter',
        'truncate',
        'grant',
        'revoke',
        'set',
        'prepare',
        'begin',
        'commit',
        'rollback',
        'vacuum',
    }
)

#: Identifiers safe to interpolate into a generated information_schema query.
#: Mirrors the client's path-segment rule: no quotes, so no way out of a literal.
_SAFE_IDENTIFIER = re.compile(r'^[A-Za-z0-9_][A-Za-z0-9_$-]{0,127}$')

#: Poll interval bounds while waiting on an async query run, seconds.
_POLL_BASE_S = 0.5
_POLL_MAX_S = 5.0

_TERMINAL_OK = frozenset({'succeeded', 'success', 'completed', 'complete', 'ready', 'finished'})
_TERMINAL_BAD = frozenset({'failed', 'error', 'cancelled', 'canceled'})

#: Async job states from the loads/indexes 202 envelope.
_JOB_PENDING = frozenset({'pending', 'running'})
_JOB_OK = frozenset({'succeeded', 'ready'})
_JOB_BAD = frozenset({'failed', 'cancelled', 'canceled'})

#: Load modes Hotdata accepts, and the subset that needs key columns.
_LOAD_MODES = frozenset({'append', 'replace', 'upsert', 'update', 'delete'})

#: Modes that overwrite or remove rows already in the table. The SQL surface is
#: read-only, but load_data is a separate write path - without this gate an agent
#: told to "delete the bad rows" simply routes around the SQL guard via replace.
_DESTRUCTIVE_MODES = frozenset({'replace', 'update', 'delete'})
_KEYED_MODES = frozenset({'upsert', 'update', 'delete'})

#: How many times to re-read the table's columns and re-project a refused append.
#: More than one because a concurrent producer can widen the table between the
#: read and the retry; bounded because each attempt costs an upload.
_WIDEN_ATTEMPTS = 3

#: Index types. bm25 is full text, vector is semantic, sorted speeds range scans.
_INDEX_TYPES = frozenset({'bm25', 'vector', 'sorted'})


def _strip_sql_noise(sql: str) -> str:
    """Remove comments and string/identifier literals, preserving structure.

    Used only for statement counting and verb detection - never for anything
    sent to the server.
    """
    out: List[str] = []
    i = 0
    n = len(sql)
    while i < n:
        ch = sql[i]
        nxt = sql[i + 1] if i + 1 < n else ''
        if ch == '-' and nxt == '-':
            i = sql.find('\n', i)
            if i == -1:
                break
            continue
        if ch == '/' and nxt == '*':
            end = sql.find('*/', i + 2)
            i = n if end == -1 else end + 2
            continue
        if ch == "'":
            i += 1
            while i < n:
                if sql[i] == "'":
                    if i + 1 < n and sql[i + 1] == "'":
                        i += 2
                        continue
                    i += 1
                    break
                i += 1
            out.append(' ')
            continue
        if ch == '"':
            i += 1
            while i < n and sql[i] != '"':
                i += 1
            i += 1
            out.append(' ')
            continue
        out.append(ch)
        i += 1
    return ''.join(out)


def _split_statements(sql: str) -> Tuple[str, int]:
    """Return (cleaned sql, statement count).

    One trailing semicolon is tolerated and stripped; anything beyond that is a
    genuine batch, which Hotdata rejects (one statement per request).
    """
    stripped = sql.strip()
    noise_free = _strip_sql_noise(stripped)
    parts = [p for p in noise_free.split(';') if p.strip()]
    if stripped.endswith(';'):
        stripped = stripped[:-1].rstrip()
    return stripped, len(parts)


def _schema_summary(tables: List[Any]) -> List[str]:
    """One flat line per table: ``schema.table(col type, col type)``."""
    lines = []
    for table in tables or []:
        if not isinstance(table, dict):
            continue
        name = '.'.join(p for p in (table.get('schema'), table.get('table')) if p)
        columns = table.get('columns') or []
        rendered = ', '.join(
            f'{c.get("name") or c.get("column_name")} {c.get("data_type") or c.get("type") or ""}'.strip()
            for c in columns
            if isinstance(c, dict) and (c.get('name') or c.get('column_name'))
        )
        lines.append(f'{name}({rendered})' if rendered else f'{name}(no columns reported)')
    return lines


def _to_ndjson(rows: List[Any]) -> bytes:
    """Serialize rows as newline-delimited JSON.

    Hotdata's ``json`` load format is NDJSON: one object per line. Uploading a
    JSON array fails schema inference server-side.
    """
    lines = []
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError('db_hotdata: every row must be an object, not a scalar or list')
        lines.append(json.dumps(row, default=str))
    return ('\n'.join(lines) + '\n').encode('utf-8')


def _is_missing_column(error: Exception) -> bool:
    """Is this the server refusing a write that omits a column the table has?

    Matched on the message because the code is a generic ``BAD_REQUEST``; the
    status is checked too so an unrelated 500 mentioning columns cannot trigger a
    silent second write.
    """
    if getattr(error, 'status_code', None) != 400:
        return False
    return 'missing column' in str(error).lower()


def _is_type_conflict(error: Exception) -> bool:
    """Is this the server refusing to re-type an existing column?

    Raised when a column is null in every row of a batch: nothing is there to
    infer from, the loader calls it text, and the column already holds numbers.
    """
    if getattr(error, 'status_code', None) != 409:
        return False
    return "can't change type" in str(error).lower()


def _json_from_text(text: str) -> Any:
    """Best-effort JSON out of model prose.

    Agents emit their final answer as free text, so JSON that is meant to become
    a row routinely arrives inside a ``` fence, or with a sentence in front of it.

    Yields every candidate value it can decode, in preference order: the whole
    string, the contents of the first fence, then each balanced value found
    scanning left to right. The caller keeps the first that actually yields rows,
    because the first decodable value is often not the row - "Scores: [1, 2, 3].
    Row: {"id": 1}" decodes the scores first and the row is what was wanted.
    """
    seen: List[Any] = []

    def offer(value: Any) -> None:
        seen.append(value)

    stripped = text.strip()
    if stripped:
        try:
            offer(json.loads(stripped))
        except (ValueError, TypeError):
            pass

    fence = text.find('```')
    if fence != -1:
        body = text[fence + 3 :]
        # Skip the language tag on the opening fence ("```json"). Only when the
        # first line looks like a bare tag - a line that starts the JSON itself
        # must not be eaten.
        newline = body.find('\n')
        if newline != -1:
            first_line = body[:newline].strip()
            if first_line and ' ' not in first_line and first_line[0] not in '{[':
                body = body[newline + 1 :]
        close = body.find('```')
        candidate = (body if close == -1 else body[:close]).strip()
        if candidate:
            try:
                offer(json.loads(candidate))
            except (ValueError, TypeError):
                pass

    decoder = json.JSONDecoder()
    for index, char in enumerate(text):
        if char in '{[':
            try:
                value, _end = decoder.raw_decode(text[index:])
            except ValueError:
                continue
            offer(value)
    return seen


#: The one reserved envelope key unwrapped into N rows. Deliberately just this
#: one: ``items``, ``data`` and ``results`` are all plausible business column
#: names, and unwrapping ``{"items": [{...}, {...}]}`` would turn one legitimate
#: record with a nested list into several rows and drop the column. Guessing
#: wrong in that direction loses data silently, while guessing wrong the other
#: way produces one row with a visible nested value.
_ROW_WRAPPER_KEY = 'rows'


def _rows_from_payload(payload: Any) -> List[Dict[str, Any]]:
    """Normalize a decoded answer into the rows to load, or [] if it holds none.

    A bare object is one row. A list of objects is many. An object whose only key
    is the reserved ``rows`` envelope, holding a list of objects, is that list -
    models produce that shape constantly, and loading it as a single row would
    flatten every record into one unusable cell. No other key is unwrapped: see
    ``_ROW_WRAPPER_KEY``.

    A list holding anything that is not an object is rejected rather than
    filtered: dropping the bad entries would load a subset and report success.
    """
    if isinstance(payload, dict):
        if len(payload) == 1:
            key, only = next(iter(payload.items()))
            if str(key).lower() == _ROW_WRAPPER_KEY and isinstance(only, list):
                if all(isinstance(item, dict) for item in only):
                    return only
                raise ValueError(f'db_hotdata: "{key}" must hold objects, not scalars or lists')
        return [payload] if payload else []
    if isinstance(payload, list):
        if not payload:
            return []
        if not all(isinstance(item, dict) for item in payload):
            raise ValueError('db_hotdata: every row must be an object; the list contains something else')
        return payload
    return []


def _cell(value: Any) -> str:
    """Render one table cell: pipes and newlines both break the row otherwise."""
    return str(value).replace('|', '\\|').replace('\r\n', ' ').replace('\n', ' ').replace('\r', ' ')


def _rows_to_markdown(rows: List[Any], limit: int = 100) -> str:
    """Render result rows as a GitHub-flavored table for the text/table lanes."""
    if not rows:
        return 'No rows.'
    shown = rows[:limit]
    if not isinstance(shown[0], dict):
        return '\n'.join(str(r) for r in shown)

    columns: List[str] = []
    for row in shown:
        for key in row:
            if key not in columns:
                columns.append(key)

    header = '| ' + ' | '.join(columns) + ' |'
    divider = '| ' + ' | '.join('---' for _ in columns) + ' |'
    body = ['| ' + ' | '.join(_cell(row.get(c, '')) for c in columns) + ' |' for row in shown]
    table = '\n'.join([header, divider] + body)
    if len(rows) > limit:
        table += f'\n\n_{len(rows) - limit} more rows not shown._'
    return table


def _leading_verb(sql: str) -> str:
    cleaned = _strip_sql_noise(sql).strip()
    if not cleaned:
        return ''
    # A leading '(' is legal for parenthesised SELECTs.
    cleaned = cleaned.lstrip('(').strip()
    token = cleaned.split(None, 1)[0] if cleaned else ''
    return token.lower().strip('(')


class IInstance(IInstanceBase):
    """Tool surface for db_hotdata."""

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _run_sql(self, sql: str, limit: int) -> Dict[str, Any]:
        """Execute one statement, following the async job if the server defers it."""
        glb = self.IGlobal
        database = glb.get_database()
        database_id = database.get('id')
        if not database_id:
            raise RuntimeError('db_hotdata: database was created without an id')

        # Deliberately no "table not found -> clear the load cache" recovery here.
        # Agents fan out tool calls, so a query can race a load that is still in
        # flight and see the table missing for a moment. Clearing the cache on
        # that signal would let the agent's follow-up load run a second time and
        # duplicate every row, which is precisely what the cache prevents. The
        # fingerprint is scoped to the database id, so a genuinely new database
        # already gets a fresh load without this.
        response = glb.client.query(
            sql=sql,
            database_id=database_id,
            async_after_ms=glb.async_after_ms,
        )

        # result_id names the WHOLE server-side result, while `rows` is only the
        # first `limit` of it. Surfacing the id next to a truncated window would
        # let an agent read 10 rows, pass the id to load_data and materialise
        # 25,000 - so the id is only offered when the caller has seen all of it.
        run_id = response.get('query_run_id') or response.get('id')
        if response.get('rows') is not None and not response.get('truncated'):
            rows = response.get('rows') or []
            result = {'rows': rows[:limit], 'row_count': len(rows[:limit]), 'sql': sql}
            if response.get('result_id') and len(rows) <= limit:
                result['result_id'] = response['result_id']
            return result

        if run_id and response.get('result_id') is None:
            response = self._await_run(run_id)

        result_id = response.get('result_id')
        if result_id:
            payload = glb.client.get_result(result_id, offset=0, limit=limit)
            rows = payload.get('rows') or payload.get('data') or []
            result = {'rows': rows[:limit], 'row_count': len(rows[:limit]), 'sql': sql}
            # get_result is explicitly a window; a full page back means there may
            # be more behind it, and the id would then name more than was seen.
            if len(rows) < limit:
                result['result_id'] = result_id
            return result

        rows = response.get('rows') or []
        return {'rows': rows[:limit], 'row_count': len(rows[:limit]), 'sql': sql}

    def _schema_via_sql(self) -> List[Dict[str, Any]]:
        """Read and reshape information_schema rows when no connection id is available."""
        sql = """SELECT table_schema, table_name, column_name, data_type
FROM information_schema.columns
WHERE table_schema NOT IN ('information_schema')
ORDER BY table_schema, table_name, ordinal_position"""
        rows = self._run_sql(sql, self.IGlobal.max_execute_rows).get('rows') or []
        grouped: Dict[Tuple[Any, Any], Dict[str, Any]] = {}
        for row in rows:
            if not isinstance(row, dict):
                continue
            key = (row.get('table_schema'), row.get('table_name'))
            table = grouped.setdefault(
                key,
                {'schema': key[0], 'table': key[1], 'columns': []},
            )
            table['columns'].append({'name': row.get('column_name'), 'data_type': row.get('data_type')})
        return list(grouped.values())

    def _table_columns(self, schema: str, table: str) -> List[str]:
        """Live column names for one table, in ordinal order, or [] if unknown.

        Read over SQL rather than the REST introspection endpoint so it works on
        an attached database too, where no connection id is available.

        The names are interpolated into the query, so they are re-validated here
        rather than trusted: they reach this point from agent-supplied tool input,
        and the client's own path-segment check is a different code path.
        """
        if not (_SAFE_IDENTIFIER.match(table) and _SAFE_IDENTIFIER.match(schema)):
            return []
        try:
            sql = (
                'SELECT column_name FROM information_schema.columns '
                f"WHERE table_name = '{table}' AND table_schema = '{schema}' "
                'ORDER BY ordinal_position'
            )
            rows = self._run_sql(sql, self.IGlobal.max_execute_rows).get('rows') or []
        except Exception as e:  # noqa: BLE001
            warning(f'db_hotdata: could not read the columns of {schema}.{table}: {e}')
            return []
        names: List[str] = []
        for row in rows:
            if isinstance(row, dict):
                value = row.get('column_name')
            elif isinstance(row, (list, tuple)) and row:
                value = row[0]
            else:
                continue
            if value:
                names.append(str(value))
        return names

    def _await_run(self, run_id: str) -> Dict[str, Any]:
        """Poll a query run to a terminal state under a monotonic deadline."""
        glb = self.IGlobal
        deadline = time.monotonic() + glb.job_timeout_secs
        delay = _POLL_BASE_S
        while True:
            run = glb.client.get_query_run(run_id)
            status = str(run.get('status') or '').lower()
            if status in _TERMINAL_BAD:
                message = run.get('error') or run.get('message') or status
                raise RuntimeError(f'db_hotdata: query failed: {message}')
            if status in _TERMINAL_OK or run.get('result_id'):
                return run
            if time.monotonic() + delay > deadline:
                raise RuntimeError(f'db_hotdata: query did not finish within {glb.job_timeout_secs}s')
            time.sleep(delay)
            delay = min(delay * 2, _POLL_MAX_S)

    # ------------------------------------------------------------------
    # Tools
    # ------------------------------------------------------------------

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {
                'schema': {'type': 'string', 'description': 'Restrict to one schema. Optional.'},
                'table': {'type': 'string', 'description': 'Restrict to one table. Optional.'},
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'tables': {'type': 'array', 'description': 'Tables with their columns and types.'},
            },
        },
        description=(
            "Inspect the live schema of this run's Hotdata database. "
            'Call this before writing SQL so column names and types are exact. '
            'Names are three-part (catalog.schema.table); the run\'s own catalog answers to "default". '
            'Types are Arrow types (Utf8, Int64, Timestamp, ...), not Postgres types. '
            'Returns tables with their columns.'
        ),
    )
    def get_schema(self, args: Any) -> Dict[str, Any]:
        args = normalize_tool_input(args, tool_name='get_schema')
        glb = self.IGlobal
        database = glb.get_database()
        database_id = database.get('id')
        connection_id = database.get('default_connection_id')

        schema = str(args.get('schema') or '').strip()
        table = str(args.get('table') or '').strip()

        if connection_id:
            payload = glb.client.information_schema(
                connection_id=connection_id,
                schema=schema,
                table=table,
                include_columns=True,
            )
            tables = payload.get('tables') or payload.get('data') or []
        else:
            tables = self._schema_via_sql()
            if schema:
                tables = [item for item in tables if item.get('schema') == schema]
            if table:
                tables = [item for item in tables if item.get('table') == table]
        # Small models reliably miscount columns when made to walk the nested
        # JSON (observed: a 4-column table reported as "note and product").
        # A flat one-line-per-table rendering removes the parsing step.
        return {'summary': _schema_summary(tables), 'tables': tables, 'database_id': database_id}

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {
                'sql': {'type': 'string', 'description': 'One read-only SQL statement.'},
                'limit': {'type': 'integer', 'description': 'Maximum rows to return.'},
            },
            'required': ['sql'],
        },
        output_schema={
            'type': 'object',
            'properties': {
                'rows': {'type': 'array', 'description': 'Result rows.'},
                'row_count': {'type': 'integer', 'description': 'Number of rows returned.'},
                'result_id': {
                    'type': 'string',
                    'description': 'Query result ID accepted by load_data.',
                },
            },
        },
        description=(
            "Run one read-only SQL statement against this run's Hotdata database. "
            'The engine is Apache DataFusion with the PostgreSQL parser dialect: Postgres syntax, '
            'DataFusion semantics and function library. The SQL surface is read-only - INSERT, UPDATE, DELETE '
            'and all DDL are rejected. Exactly one statement per call, no semicolon-separated batches. '
            'Unquoted identifiers fold to lowercase, so double-quote any name with uppercase or spaces. '
            'JSON operators and pg_catalog functions do not exist here. '
            'Use get_schema first if you are unsure of column names. '
            'The returned result_id can be passed to load_data to materialise these rows into a table '
            'without re-uploading them.'
        ),
    )
    def execute(self, args: Any) -> Dict[str, Any]:
        args = normalize_tool_input(args, tool_name='execute')
        glb = self.IGlobal

        if not glb.allow_execute:
            warning('db_hotdata: execute is disabled (allow_execute is off)')
            raise RuntimeError('db_hotdata: raw SQL execution is disabled; enable allow_execute on the node')

        sql = args.get('sql')
        if not isinstance(sql, str) or not sql.strip():
            raise ValueError('db_hotdata: sql is required and must be a non-empty string')

        cleaned, statement_count = _split_statements(sql)
        if statement_count > 1:
            raise ValueError(
                'db_hotdata: only one statement per call is supported; Hotdata rejects semicolon-separated batches'
            )
        if not cleaned:
            raise ValueError('db_hotdata: sql is required and must be a non-empty string')

        verb = _leading_verb(cleaned)
        if verb in _WRITE_VERBS:
            raise ValueError(
                f'db_hotdata: "{verb}" is not permitted - the Hotdata SQL surface is read-only '
                '(SELECT, WITH, EXPLAIN, DESCRIBE and VALUES only)'
            )

        limit = self._resolve_limit(args.get('limit'))

        debug(f'db_hotdata: executing statement, limit {limit}')
        return self._run_sql(cleaned, limit)

    # ------------------------------------------------------------------
    # Lanes
    # ------------------------------------------------------------------

    def writeQuestions(self, question: Question) -> None:
        """Questions lane: answer the question and emit to whichever lanes are wired."""
        question_text = question.questions[0].text if getattr(question, 'questions', None) else None
        if not question_text:
            warning('db_hotdata: no question text provided')
            return

        lanes = self.instance.getListeners()
        try:
            result = self.get_data({'question': question_text})
        except Exception as e:
            error(f'db_hotdata: error handling question: {e}')
            self._emitError(str(e), lanes)
            return

        rows = result.get('rows') or []
        markdown = _rows_to_markdown(rows)

        if 'text' in lanes:
            self.instance.writeText(markdown)
        if 'table' in lanes and rows:
            self.instance.writeTable(markdown)
        if 'answers' in lanes:
            answer = Answer()
            answer.setAnswer(markdown)
            self.instance.writeAnswers(answer)

    def writeAnswers(self, answer: Answer) -> None:
        """Answers lane: load structured rows into the configured table.

        Note this does NOT generate INSERT statements the way the SQL database
        nodes do - Hotdata rejects INSERT and CREATE TABLE outright. Rows are
        serialized, uploaded, and loaded through the REST load API instead.

        This lane is how a pipeline publishes *structurally*: wiring an agent's
        answers here writes the row because the graph says so. Telling the agent
        to call ``load_data`` on a shared database instead is a coin flip -
        measured at roughly one in four across two model families, the agent
        reasons correctly, reports the right answer and never makes the call.
        """
        try:
            items = self._rows_from_answer(answer)
            if not items:
                debug('db_hotdata: no items to load')
                return
            self.load_data({'table': self.IGlobal.table, 'rows': items, 'mode': 'append'})
        except Exception as e:
            # Re-raise rather than only logging. The answers lane has no output
            # lane to emit to, so swallowing here would let the run report
            # success while the rows were never loaded - silent data loss. The
            # client already retries transient failures before we get here.
            error(f'db_hotdata: error in writeAnswers: {e}')
            raise

    def _rows_from_answer(self, answer: Answer) -> List[Dict[str, Any]]:
        """Rows to load from whatever an upstream node put on the lane.

        ``Answer.getJson`` is a bare ``json.loads``, and it raises rather than
        returning None when the text is not JSON. Upstream agents write their
        final answer as free text, so a fenced or prose-prefixed object is the
        common case, not the exception - failing it would make structural
        publishing no more reliable than asking the agent to call load_data.
        Anything that genuinely carries no rows raises with the text quoted, so
        the pipeline author can see what actually arrived rather than an
        unexplained empty table.
        """
        try:
            payload = answer.getJson()
        except (ValueError, TypeError):
            payload = None

        if payload is not None:
            rows = _rows_from_payload(payload)
            if not rows and payload not in (None, [], {}, ''):
                raise ValueError(
                    f'db_hotdata: the answers lane needs an object or a list of objects, got {type(payload).__name__}'
                )
            return rows

        text = str(answer.getText() if hasattr(answer, 'getText') else '')
        if not text.strip():
            return []

        # Keep the first candidate that actually yields rows. The first decodable
        # value in the text is often not the row: "Scores: [1, 2, 3]. Row: {...}"
        # decodes the scores first, and taking that would discard the answer.
        last_error: Exception | None = None
        for candidate in _json_from_text(text):
            try:
                rows = _rows_from_payload(candidate)
            except ValueError as e:
                last_error = e
                continue
            if rows:
                return rows
        if last_error is not None:
            raise last_error
        raise ValueError(
            'db_hotdata: the answers lane loads rows and needs JSON - an object, or a list of '
            f'objects - but got text: {text[:200]!r}. Instruct the upstream node to reply '
            'with only the row(s) as JSON.'
        )

    def _emitError(self, message: str, lanes) -> None:
        """Emit a failure to the wired lanes, structurally distinguishable from prose."""
        if 'text' in lanes:
            self.instance.writeText(message)
        if 'answers' in lanes:
            answer = Answer()
            answer.setAnswer(json.dumps({'error': message}))
            self.instance.writeAnswers(answer)

    # ------------------------------------------------------------------
    # Natural language to SQL
    # ------------------------------------------------------------------

    def _schema_context(self) -> str:
        """Live schema as prompt text, best-effort.

        A schema lookup failure must not sink the whole question - the LLM can
        still produce something reasonable, and the execute step surfaces any
        real problem with a server error the retry loop can act on.
        """
        try:
            database = self.IGlobal.get_database()
            connection_id = database.get('default_connection_id')
            if connection_id:
                payload = self.IGlobal.client.information_schema(
                    connection_id=connection_id,
                    include_columns=True,
                )
                tables = payload.get('tables') or payload.get('data') or []
            else:
                tables = self._schema_via_sql()
            return format_schema_for_prompt(tables)
        except Exception as e:
            warning(f'db_hotdata: could not read schema for the prompt: {e}')
            return 'Schema could not be read; rely on information_schema queries.'

    def _generate_sql(
        self,
        question_text: str,
        limit: int,
        previous_sql: str = '',
        previous_error: str = '',
    ) -> str:
        """Translate a question to SQL with the bound LLM."""
        glb = self.IGlobal

        q = Question(role='You are a Hotdata SQL query generator.')
        q.addInstruction(
            'Output format',
            'Output ONLY the raw SQL query -- no markdown fences, no explanation, no preamble.',
        )
        q.addInstruction('SQL dialect', get_dialect_prompt_text())
        q.addInstruction(
            'Row limit',
            f'Always add LIMIT {limit} unless the question asks for a specific different limit.',
        )
        q.addContext(self._schema_context())

        db_desc = (getattr(glb, 'db_description', '') or '').strip()
        if db_desc:
            q.addContext(f'Data context: {db_desc}')

        q.addExample(
            'Which products sold the most units?',
            f'SELECT product, SUM(units) AS "units" FROM sales GROUP BY product ORDER BY "units" DESC LIMIT {limit}',
        )
        q.addExample(
            'Find support tickets that mention a refund',
            f"SELECT * FROM bm25_search('default.main.tickets', 'body', 'refund') LIMIT {limit}",
        )

        if previous_sql and previous_error:
            q.addContext(
                f'Your previous SQL was rejected with this error:\n\n{previous_error}\n\n'
                f'Failed SQL:\n{previous_sql}\n\n'
                f'Fix the query and try again.'
            )

        q.addGoal('Generate one valid read-only SQL query that answers the question.')
        q.addQuestion(question_text)

        result = self.instance.invoke(IInvokeLLM.Ask(question=q))
        if not result or not getattr(result, 'answer', None):
            raise RuntimeError('db_hotdata: the connected LLM did not return a query')
        return strip_sql_fences(result.answer)

    def _validate_generated_sql(self, sql: str) -> Tuple[str, str]:
        """Return (cleaned_sql, error). Error is '' when the SQL is acceptable.

        The single place that decides whether generated SQL may leave the node.
        get_data retries on the error, get_sql refuses to hand it back; both ask
        the same question so the paths cannot drift apart.
        """
        cleaned, statement_count = _split_statements(sql)
        if statement_count > 1:
            return cleaned, 'Only one statement per request is allowed.'
        verb = _leading_verb(cleaned)
        if verb in _WRITE_VERBS:
            return cleaned, (
                f'"{verb}" is not permitted: the Hotdata SQL surface is read-only. '
                'Use SELECT, WITH, EXPLAIN, DESCRIBE or VALUES only.'
            )
        return cleaned, ''

    def _resolve_limit(self, raw_limit: Any) -> int:
        """Clamp a caller-supplied row limit, rejecting JSON booleans."""
        cap = self.IGlobal.max_execute_rows
        if isinstance(raw_limit, bool) or not isinstance(raw_limit, int):
            return min(250, cap)
        return max(1, min(raw_limit, cap))

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {
                'question': {'type': 'string', 'description': 'The question, in plain language.'},
                'limit': {'type': 'integer', 'description': 'Maximum rows to return.'},
            },
            'required': ['question'],
        },
        output_schema={
            'type': 'object',
            'properties': {
                'sql': {'type': 'string', 'description': 'The SQL that was generated.'},
            },
        },
        description=(
            "Translate a plain-language question into SQL for this run's Hotdata database "
            'WITHOUT running it. Use this when you want to inspect or explain the query first; '
            'use get_data when you want the answer.'
        ),
    )
    def get_sql(self, args: Any) -> Dict[str, Any]:
        args = normalize_tool_input(args, tool_name='get_sql')
        question_text = str(args.get('question') or '').strip()
        if not question_text:
            raise ValueError('db_hotdata: question is required')
        limit = self._resolve_limit(args.get('limit'))
        attempts = max(1, int(getattr(self.IGlobal, 'max_attempts', 3) or 3))

        previous_sql = ''
        last_error = ''
        for _ in range(attempts):
            sql = self._generate_sql(question_text, limit, previous_sql=previous_sql, previous_error=last_error)
            cleaned, invalid = self._validate_generated_sql(sql)
            if not invalid:
                return {'sql': cleaned, 'dialect': 'datafusion'}
            previous_sql, last_error = cleaned, invalid
            debug(f'db_hotdata: regenerating SQL, previous attempt rejected: {invalid}')

        # Handing back SQL the node's own execute would refuse is worse than
        # failing: the caller has no signal that it is unusable.
        raise RuntimeError(
            f'db_hotdata: could not generate acceptable SQL after {attempts} attempts. Last issue: {last_error}'
        )

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {
                'question': {'type': 'string', 'description': 'The question, in plain language.'},
                'limit': {'type': 'integer', 'description': 'Maximum rows to return.'},
            },
            'required': ['question'],
        },
        output_schema={
            'type': 'object',
            'properties': {
                'rows': {'type': 'array', 'description': 'Result rows.'},
                'sql': {'type': 'string', 'description': 'The SQL that produced them.'},
                'row_count': {'type': 'integer', 'description': 'Number of rows returned.'},
                'result_id': {
                    'type': 'string',
                    'description': 'Query result ID accepted by load_data.',
                },
            },
        },
        description=(
            "Answer a plain-language question about the data in this run's Hotdata database. "
            'The connected LLM writes the SQL, it runs, and the rows come back. '
            'Load data with load_data first - a fresh database is empty. '
            'If a generated query fails it is retried with the error fed back in. '
            'The returned result_id can be passed to load_data to materialise these rows into a table '
            'without re-uploading them.'
        ),
    )
    def get_data(self, args: Any) -> Dict[str, Any]:
        args = normalize_tool_input(args, tool_name='get_data')
        question_text = str(args.get('question') or '').strip()
        if not question_text:
            raise ValueError('db_hotdata: question is required')

        limit = self._resolve_limit(args.get('limit'))
        attempts = max(1, int(getattr(self.IGlobal, 'max_attempts', 3) or 3))

        previous_sql = ''
        last_error = ''
        for attempt in range(1, attempts + 1):
            sql = self._generate_sql(question_text, limit, previous_sql=previous_sql, previous_error=last_error)
            # Same read-only guard `execute` applies. The server rejects writes
            # anyway, but catching it here turns a wasted round trip into an
            # immediate corrective retry.
            cleaned, invalid = self._validate_generated_sql(sql)
            if invalid:
                previous_sql, last_error = cleaned, invalid
                debug(f'db_hotdata: rejected generated SQL before execution: {invalid}')
                continue
            try:
                result = self._run_sql(cleaned, limit)
                result['attempts'] = attempt
                return result
            except Exception as e:
                previous_sql, last_error = cleaned, str(e)
                debug(f'db_hotdata: attempt {attempt} failed: {last_error}')

        raise RuntimeError(f'db_hotdata: could not answer after {attempts} attempts. Last error: {last_error}')

    @tool_function(
        input_schema={'type': 'object', 'properties': {}},
        output_schema={
            'type': 'object',
            'properties': {
                'dialect': {'type': 'string', 'description': 'Dialect identifier.'},
                'briefing': {'type': 'string', 'description': 'How this SQL dialect differs from Postgres.'},
            },
        },
        description=(
            'Describe the SQL dialect of this database before you write SQL by hand. '
            'Hotdata is Apache DataFusion behind a PostgreSQL parser, so Postgres syntax is accepted '
            "but the function library and types are DataFusion's. Read this to avoid writing JSON "
            'operators, pg_catalog lookups or other Postgres-only constructs that do not exist here.'
        ),
    )
    def dialect(self, args: Any) -> Dict[str, Any]:
        normalize_tool_input(args, tool_name='dialect')
        return {'dialect': 'datafusion', 'briefing': get_dialect_prompt_text()}

    # ------------------------------------------------------------------
    # Loading and indexing
    # ------------------------------------------------------------------

    def _await_job(self, response: Dict[str, Any]) -> Dict[str, Any]:
        """Follow a 202 job to completion, or pass a synchronous result straight through."""
        # The polled status is lowercased below, so the envelope casing is not
        # guaranteed either. A 'Pending' envelope would otherwise be treated as
        # a finished job and the caller would keep a dedup reservation for rows
        # that never landed.
        envelope_status = str(response.get('status') or '').lower()
        job_id = response.get('id') if envelope_status in _JOB_PENDING else None
        if not job_id:
            return response

        glb = self.IGlobal
        deadline = time.monotonic() + glb.job_timeout_secs
        delay = _POLL_BASE_S
        while True:
            job = glb.client.get_job(job_id)
            status = str(job.get('status') or '').lower()
            if status in _JOB_BAD:
                message = job.get('error_message') or status
                raise RuntimeError(f'db_hotdata: job {job_id} failed: {message}')
            if status == 'partially_succeeded':
                warning(f'db_hotdata: job {job_id} only partially succeeded')
                # Flag it so load_data releases the dedup reservation: only some
                # rows landed, so a retry of the same payload must not be
                # skipped as a duplicate.
                job = dict(job)
                job['partial'] = True
                return job
            if status in _JOB_OK:
                return job
            if time.monotonic() + delay > deadline:
                raise RuntimeError(f'db_hotdata: job {job_id} did not finish within {glb.job_timeout_secs}s')
            time.sleep(delay)
            delay = min(delay * 2, _POLL_MAX_S)

    def _ensure_table(self, database_id: str, schema: str, table: str, key: Any) -> None:
        """Declare the table if it does not exist yet.

        CREATE TABLE is rejected by the SQL surface, so tables only come into
        existence over REST. An already-declared table returns a 409, which is
        success for our purposes.
        """
        try:
            self.IGlobal.client.create_table(
                database_id=database_id,
                schema=schema,
                name=table,
                key=key or None,
            )
        except Exception as e:
            # 409 CONFLICT means the table is already declared, which is success
            # here. Branch on the API's error code, not the bare status: 409 also
            # carries RESOURCE_LOCKED, which means a concurrent creator held the
            # lock for the whole retry budget. Treating that as "already exists"
            # would send us on to load into a table that may not be there, and
            # report a confusing "table not found" instead of the real contention.
            if getattr(e, 'status_code', None) == 409 and getattr(e, 'error_code', '') != 'RESOURCE_LOCKED':
                return
            raise

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {
                'table': {'type': 'string', 'description': 'Target table name.'},
                'rows': {'type': 'array', 'description': 'Rows to load, as a list of flat objects.'},
                'result_id': {'type': 'string', 'description': 'Load a previous query result instead of rows.'},
                'mode': {
                    'type': 'string',
                    'description': 'append (default) or upsert. replace, update and delete overwrite existing rows and require allow_destructive_load on the node.',
                },
                'key': {'type': 'array', 'description': 'Key columns, required for upsert/update/delete.'},
                'schema': {'type': 'string', 'description': 'Target schema. Defaults to the database default.'},
            },
            'required': ['table'],
        },
        output_schema={
            'type': 'object',
            'properties': {
                'table': {'type': 'string', 'description': 'Table that was loaded.'},
                'row_count': {'type': 'integer', 'description': 'Rows loaded, when the server reports it.'},
            },
        },
        description=(
            "Load data into a table in this run's Hotdata database, creating the table if needed. "
            'Pass rows as a list of flat objects, or result_id to load a previous query result without '
            're-uploading it. This is the ONLY way to get data in - the SQL surface is read-only, so '
            'INSERT does not work. Use mode=append to add, replace to overwrite, or upsert with key columns. '
            'Do not call this twice for the same data: append adds rows again rather than replacing them. '
            'An identical append repeated within one run is skipped and returns deduplicated=true. '
            'In the default ephemeral mode the data lives only for this pipeline run; when the node '
            'is attached to an existing database the data outlives the run.'
        ),
    )
    def load_data(self, args: Any) -> Dict[str, Any]:
        args = normalize_tool_input(args, tool_name='load_data')
        glb = self.IGlobal

        table = str(args.get('table') or '').strip()
        if not table:
            raise ValueError('db_hotdata: table is required')

        rows = args.get('rows')
        result_id = str(args.get('result_id') or '').strip()
        if not result_id and not isinstance(rows, list):
            raise ValueError('db_hotdata: provide either rows (a list of objects) or result_id')
        if result_id and isinstance(rows, list) and rows:
            raise ValueError('db_hotdata: provide rows or result_id, not both')

        mode = str(args.get('mode') or 'append').strip().lower()
        if mode not in _LOAD_MODES:
            raise ValueError(f'db_hotdata: mode must be one of {", ".join(sorted(_LOAD_MODES))}')
        if mode in _DESTRUCTIVE_MODES and not glb.allow_destructive_load:
            raise ValueError(
                f'db_hotdata: mode "{mode}" overwrites or removes existing rows and is disabled; '
                'enable allow_destructive_load on the node, or use append or upsert'
            )

        key = args.get('key')
        if key is not None and not isinstance(key, list):
            raise ValueError('db_hotdata: key must be a list of column names')
        if mode in _KEYED_MODES and not key:
            raise ValueError(f'db_hotdata: mode "{mode}" requires key columns')

        database = glb.get_database()
        database_id = database.get('id')
        schema = str(args.get('schema') or '').strip() or database.get('default_schema') or 'main'

        if not database_id:
            raise RuntimeError('db_hotdata: database was created without an id')
        self._ensure_table(database_id, schema, table, key)

        upload_id = ''
        data_format = ''
        # Bound on every path: the failure handler below releases it.
        fingerprint = None
        if result_id and mode == 'append':
            # The same reasoning as the rows path below. Appending a query result
            # is no more idempotent than appending rows, and this path is now
            # advertised to agents on execute and get_data ("the returned
            # result_id can be passed to load_data"), so a routine retry would
            # double the rows with nothing to stop it. The result id names a fixed
            # server-side result, which makes it the natural fingerprint.
            fingerprint = hashlib.sha256(
                f'{database_id}|{schema}.{table}|result:{result_id}'.encode('utf-8')
            ).hexdigest()
            prior = glb.seen_load(fingerprint)
            if prior is not None:
                out = {'table': table, 'schema': schema, 'mode': mode, 'result_id': result_id}
                if prior == 'pending':
                    out['in_progress'] = True
                    out['note'] = (
                        'A load of this same query result into this table is already running in this '
                        'pipeline. It was NOT sent again, because append is not idempotent. Query the '
                        'table to confirm what landed.'
                    )
                    warning(f'db_hotdata: identical result load into {schema}.{table} is already in flight')
                    return out
                out['deduplicated'] = True
                out['note'] = (
                    'This query result was already appended to this table during this run, so it was '
                    'not loaded again. The table already contains these rows.'
                )
                warning(f'db_hotdata: identical result load into {schema}.{table} already ran; skipping')
                return out
        if not result_id:
            if not rows:
                return {'table': table, 'row_count': 0, 'schema': schema}
            # Hotdata's `json` format is NDJSON - one object per line. A JSON
            # array is rejected with "Expected JSON record to be an object,
            # found Array", which only shows up against the live API.
            payload = _to_ndjson(rows)

            # Append is not idempotent server-side and Hotdata exposes no
            # idempotency key on loads, so an agent that re-calls load_data (a
            # routine retry) silently doubles the data. Verified against the
            # live API: an identical append took 2 rows to 4. Guard identical
            # appends within a single pipeline run and say so in the result
            # rather than duplicating business data.
            if mode == 'append':
                # Scoped to the database: a payload loaded into a previous database
                # says nothing about this one, and skipping the load would leave the
                # table missing entirely.
                fingerprint = hashlib.sha256(f'{database_id}|{schema}.{table}|'.encode('utf-8') + payload).hexdigest()
                prior = glb.seen_load(fingerprint)
                if prior is not None:
                    out = {'table': table, 'schema': schema, 'mode': mode}
                    if prior == 'pending':
                        # Another call is mid-flight with this exact payload. It
                        # may still fail and release the reservation, so claiming
                        # success here would report rows that never landed.
                        warning(f'db_hotdata: identical append to {schema}.{table} is already in flight')
                        out['in_progress'] = True
                        out['note'] = (
                            'An identical append to this table is already running in this pipeline. '
                            'It was NOT sent again, because append is not idempotent. Wait for that '
                            'load to finish and query the table to confirm what landed - this call '
                            'makes no claim about the rows being present.'
                        )
                        return out
                    warning(f'db_hotdata: identical append to {schema}.{table} already ran this session; skipping')
                    out['deduplicated'] = True
                    if prior == 'partial':
                        # The landed subset is unknown, so no row_count: reporting
                        # the full input size would overstate what is in the table.
                        out['partial'] = True
                        out['note'] = (
                            'This exact payload was already attempted during this run and only '
                            'partially succeeded: an unknown subset of the rows landed. It was NOT '
                            'loaded again, because append is not idempotent and a retry would '
                            'duplicate whatever did land. Query the table to see what is present '
                            'and load only what is missing.'
                        )
                    else:
                        out['row_count'] = len(rows)
                        out['note'] = (
                            'This exact payload was already appended to this table during this run, '
                            'so it was not loaded again. The table already contains these rows.'
                        )
                    return out

            upload_id = glb.client.upload_bytes(
                payload,
                filename=f'{table}.ndjson',
                content_type='application/x-ndjson',
            )
            data_format = 'json'

        # The dedup fingerprint above is a reservation. If anything from here on
        # fails, release it: otherwise the agent's retry is skipped as a
        # duplicate and the rows are silently never loaded.
        try:
            try:
                result = self._perform_load(
                    glb,
                    database_id=database_id,
                    schema=schema,
                    table=table,
                    mode=mode,
                    upload_id=upload_id,
                    result_id=result_id,
                    data_format=data_format,
                    key=key,
                    rows=rows,
                )
            except Exception as e:
                # Append only. Filling a column with null is additive for an
                # append and destructive for anything else: an upsert of
                # {"id": 7, "note": "x"} widened to {"id": 7, "balance": null,
                # "note": "x"} would wipe the stored balance. Those modes have to
                # fail and let the caller send a complete row.
                if not (upload_id and mode == 'append' and _is_missing_column(e)):
                    raise
                # Hotdata requires every write to carry the table's full column
                # set: a column left out of an append would be dropped from the
                # table, so it refuses rather than destroying it. Rows written by
                # different producers into one table therefore diverge in shape
                # and fail from the second producer on - which is exactly the
                # shared-evidence and telemetry pattern. Project onto the live
                # schema, filling the absent columns with null, and load again.
                # Done on failure rather than always so a well-shaped load pays
                # nothing for it.
                #
                # Safe to replay: the check is against the schema of the whole
                # uploaded file, not per record, and it runs before any of it is
                # ingested. Verified live - a 3-record upload whose third record
                # omits a column SUCCEEDS (the column is present in the batch),
                # and a load the server does refuse this way leaves the table's
                # row count unchanged. So there is no partial-commit state for
                # the retry to duplicate.
                # Re-read and re-project in a bounded loop rather than once. The
                # shape that makes this necessary is concurrent: another producer
                # can add a column between our schema read and our retry, so the
                # widened payload is stale on arrival and refused for a different
                # missing column. One attempt would surface that as a failure the
                # caller cannot act on.
                result = None
                for _attempt in range(_WIDEN_ATTEMPTS):
                    columns = self._table_columns(schema, table)
                    if not columns:
                        raise
                    projected = [{**{c: None for c in columns}, **row} for row in rows]
                    if projected == rows:
                        raise
                    # For the message: columns the caller never supplied at all.
                    missing = [c for c in columns if not any(c in row for row in rows)]
                    debug(f'db_hotdata: widening {len(rows)} row(s) to the {len(columns)} columns of {schema}.{table}')
                    # A fresh upload: the failed load has already consumed the old one.
                    upload_id = glb.client.upload_bytes(
                        _to_ndjson(projected),
                        filename=f'{table}.ndjson',
                        content_type='application/x-ndjson',
                    )
                    try:
                        result = self._perform_load(
                            glb,
                            database_id=database_id,
                            schema=schema,
                            table=table,
                            mode=mode,
                            upload_id=upload_id,
                            result_id=result_id,
                            data_format=data_format,
                            key=key,
                            rows=projected,
                        )
                        break
                    except Exception as widen_error:
                        if _is_missing_column(widen_error) and _attempt < _WIDEN_ATTEMPTS - 1:
                            # The table grew underneath us; read it again.
                            continue
                        if not _is_type_conflict(widen_error):
                            raise
                        # Filling a column with null works only while the column is
                        # textual. A numeric or temporal column that is null in every
                        # row of the batch is inferred as a string, and the server
                        # refuses to change the column's type. There is no payload
                        # that satisfies both rules, so say what the actual fix is
                        # instead of surfacing a bare CONFLICT.
                        raise ValueError(
                            f'db_hotdata: rows of this shape cannot be appended to {schema}.{table}. '
                            f'The table already has columns these rows do not set ({", ".join(missing)}), '
                            'and filling them with null re-types them as text, which the server rejects. '
                            'One table needs one row shape: give each kind of record its own table, or '
                            'have every producer emit every column. '
                            f'Server said: {widen_error}'
                        ) from widen_error
            if fingerprint:
                glb.record_load(fingerprint, 'partial' if result.get('partial') else 'complete')
            # A partial append deliberately KEEPS its reservation. Append is not
            # idempotent, so an unknown subset of the payload already landed and
            # a blind retry would duplicate exactly those rows. There is no safe
            # automatic action here: the caller has to reconcile. Releasing would
            # trade silent data loss for silent duplication.
            return result
        except Exception:
            if fingerprint:
                glb.release_load(fingerprint)
            raise

    def _perform_load(
        self,
        glb,
        *,
        database_id,
        schema,
        table,
        mode,
        upload_id,
        result_id,
        data_format,
        key,
        rows,
    ) -> Dict[str, Any]:
        """Issue the load and wait for it. Split out so load_data can release the
        dedup reservation on any failure below the upload.
        """
        response = glb.client.load_table(
            database_id=database_id,
            schema=schema,
            table=table,
            mode=mode,
            upload_id=upload_id,
            result_id=result_id,
            data_format=data_format,
            key=key,
            async_after_ms=glb.async_after_ms,
        )
        finished = self._await_job(response)
        row_count = finished.get('row_count')
        if row_count is None:
            row_count = (
                (finished.get('result') or {}).get('row_count') if isinstance(finished.get('result'), dict) else None
            )
        debug(f'db_hotdata: loaded into {schema}.{table} (mode {mode})')
        if row_count is None and rows:
            # Fall back only when we actually uploaded inline rows. A result_id
            # load has no local count, and reporting 0 there would claim an empty
            # load that may well have inserted rows.
            row_count = len(rows)
        out = {'table': table, 'schema': schema, 'mode': mode}
        if row_count is not None:
            # output_schema declares an integer, so omit the key rather than
            # reporting null for a result_id load the server gave no count for.
            out['row_count'] = row_count
        if finished.get('partial'):
            out['partial'] = True
            out['note'] = (
                'The load only partially succeeded: an unknown subset of the rows landed. '
                'Do NOT simply retry this payload - append is not idempotent, so a retry would '
                'duplicate the rows that did load. Query the table to see what is present and '
                'load only what is missing.'
            )
        return out

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {
                'table': {'type': 'string', 'description': 'Table holding the column to index.'},
                'column': {'type': 'string', 'description': 'Column to index.'},
                'index_type': {'type': 'string', 'description': 'bm25 (full text), vector (semantic) or sorted.'},
                'schema': {'type': 'string', 'description': 'Schema. Defaults to the database default.'},
                'index_name': {'type': 'string', 'description': 'Optional index name.'},
                'metric': {'type': 'string', 'description': 'Vector distance metric. Optional.'},
            },
            'required': ['table', 'column'],
        },
        output_schema={
            'type': 'object',
            'properties': {
                'index_name': {'type': 'string', 'description': 'Name of the index created.'},
                'status': {'type': 'string', 'description': 'Index status.'},
            },
        },
        description=(
            'Build an index on a column so it can be searched. '
            'index_type=bm25 enables full-text search via bm25_search(table, column, query); '
            'index_type=vector enables semantic search via vector_search(table, column, query) and '
            'vector_distance(column, query) for ORDER BY - the server embeds the query text itself using '
            'the workspace embedding provider. index_type=sorted speeds up range filters. '
            'Index first, then query with those functions in normal SQL.'
        ),
    )
    def build_index(self, args: Any) -> Dict[str, Any]:
        args = normalize_tool_input(args, tool_name='build_index')
        glb = self.IGlobal

        table = str(args.get('table') or '').strip()
        column = str(args.get('column') or '').strip()
        if not table or not column:
            raise ValueError('db_hotdata: table and column are required')

        index_type = str(args.get('index_type') or 'bm25').strip().lower()
        if index_type not in _INDEX_TYPES:
            raise ValueError(f'db_hotdata: index_type must be one of {", ".join(sorted(_INDEX_TYPES))}')

        database = glb.get_database()
        connection_id = database.get('default_connection_id')
        if not connection_id:
            # Two different causes, and guessing at the wrong one sends the caller
            # looking in the wrong place. Only an attached run is *expected* to
            # lack the id; a database we created ourselves and still has none is
            # an unexpected create response.
            if glb.attached:
                raise ValueError(
                    "db_hotdata: index creation needs the database's connection id, which a Database "
                    'API Token cannot read back for an attached database; build indexes in the run '
                    'that created the database'
                )
            raise RuntimeError('db_hotdata: database has no default_connection_id; cannot create an index')
        schema = str(args.get('schema') or '').strip() or database.get('default_schema') or 'main'
        index_name = str(args.get('index_name') or '').strip() or f'{table}_{column}_{index_type}'

        response = glb.client.create_index(
            connection_id=connection_id,
            schema=schema,
            table=table,
            index_name=index_name,
            columns=[column],
            index_type=index_type,
            metric=str(args.get('metric') or '').strip(),
            async_after_ms=glb.async_after_ms,
        )
        finished = self._await_job(response)
        debug(f'db_hotdata: built {index_type} index {index_name} on {schema}.{table}.{column}')
        return {
            'index_name': index_name,
            'index_type': index_type,
            'status': finished.get('status') or 'ready',
        }
