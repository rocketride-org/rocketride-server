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
Supabase Cron tools: scheduled SQL jobs with the pg_cron extension.

Every call opens one pooler connection (TLS required) through the shared
base, checks that pg_cron is installed, sets a statement timeout for the
transaction and runs parameterised SQL only: names, schedules and commands
are always bound values, never formatted into the statement.

``schedule_job`` stores SQL written by the caller, which pg_cron later runs
as the database user (on Supabase, ``postgres``). That is why it and
``unschedule_job`` need the admin level, and the read tools only read
``cron.job`` and ``cron.job_run_details``.
"""

from __future__ import annotations

import contextlib
import re
from typing import Any, Dict, Iterator, List, Sequence

from ai.common.utils import int_arg, require_str
from rocketlib import tool_function

from .. import supabase_client as sc
from ..IInstance import ADMIN, READ, SupabaseInstanceBase, requires_access
from .IGlobal import IGlobal

PG_CRON_MISSING = (
    'The pg_cron extension is not enabled in this project. Turn it on in the Supabase dashboard '
    '(Integrations -> Cron, or Database -> Extensions -> pg_cron) and try again.'
)

DEFAULT_RUNS = 20
_MAX_NAME_LEN = 255
_MAX_SCHEDULE_LEN = 100

_JOB_COLUMNS = ('job_id', 'name', 'schedule', 'command', 'active', 'database', 'username')
_RUN_COLUMNS = ('run_id', 'status', 'return_message', 'start_time', 'end_time')

_SQL_EXTENSION = 'SELECT extversion FROM pg_extension WHERE extname = %s'
_SQL_TIMEOUT = "SELECT set_config('statement_timeout', %s, true)"
_SQL_LIST_JOBS = (
    'SELECT jobid, jobname, schedule, command, active, database, username FROM cron.job ORDER BY jobid LIMIT %s'
)
_SQL_FIND_JOB = 'SELECT jobid FROM cron.job WHERE jobname = %s'
_SQL_JOB_RUNS = (
    'SELECT runid, status, return_message, start_time, end_time FROM cron.job_run_details '
    'WHERE jobid = %s ORDER BY start_time DESC NULLS LAST, runid DESC LIMIT %s'
)
_SQL_SCHEDULE = 'SELECT cron.schedule(%s, %s, %s)'
_SQL_UNSCHEDULE = 'SELECT cron.unschedule(%s)'

_JOB_RECORD = {
    'type': 'object',
    'properties': {
        'job_id': {'type': 'integer'},
        'name': {'type': ['string', 'null']},
        'schedule': {'type': 'string', 'description': 'Cron expression, or "<n> seconds".'},
        'command': {
            'type': 'string',
            'description': (
                "The SQL the job runs. Below admin every string literal is '***'; at admin only embedded keys "
                'and tokens are replaced by ***.'
            ),
        },
        'active': {'type': 'boolean'},
        'database': {'type': 'string'},
        'username': {'type': 'string'},
    },
}
_RUN_RECORD = {
    'type': 'object',
    'properties': {
        'run_id': {'type': 'integer'},
        'status': {'type': 'string', 'description': 'starting, running, sending, connecting, succeeded or failed.'},
        'return_message': {
            'type': ['string', 'null'],
            'description': 'Result or error text of the run, with embedded keys and tokens replaced by ***.',
        },
        'start_time': {'type': ['string', 'null']},
        'end_time': {'type': ['string', 'null']},
    },
}
_NAME_PROPERTY = {'type': 'string', 'description': 'Job name (as shown by list_jobs).'}


def _rows(columns: Sequence[str], rows: List[Sequence[Any]]) -> List[Dict[str, Any]]:
    return [dict(zip(columns, row)) for row in rows]


# Start of a dollar-quoted string: $$ or $tag$ (a tag never starts with a digit, so $1 is not one).
_DOLLAR_TAG = re.compile(r'\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$')
LITERAL_MASK = '***'


def mask_sql_literals(sql: str) -> str:
    """Replace the content of every string literal in ``sql`` with ***.

    Keeps the statement's shape (function names, tables, casts) and hides
    every value: URLs, headers, tokens, conninfo strings. Handles '...'
    (with '' inside), E'...' (with backslash escapes), $$...$$ / $tag$...$tag$,
    double-quoted identifiers (left as they are) and -- / /* */ comments
    (masked: a comment can hold a pasted key too). An unterminated literal is
    masked to the end. Masking more than needed is the safe failure.
    """
    out: List[str] = []
    i, n = 0, len(sql)
    while i < n:
        ch = sql[i]
        if ch == '"':
            end = sql.find('"', i + 1)
            end = n if end < 0 else end + 1
            out.append(sql[i:end])
            i = end
        elif ch == "'":
            escapes = i > 0 and sql[i - 1] in 'Ee' and (i < 2 or not (sql[i - 2].isalnum() or sql[i - 2] == '_'))
            j = i + 1
            while j < n:
                if escapes and sql[j] == '\\':
                    j += 2
                elif sql[j] == "'":
                    if j + 1 < n and sql[j + 1] == "'":
                        j += 2
                    else:
                        break
                else:
                    j += 1
            out.append(f"'{LITERAL_MASK}'")
            i = j + 1
        elif ch == '$' and _DOLLAR_TAG.match(sql, i):
            tag = _DOLLAR_TAG.match(sql, i).group(0)
            end = sql.find(tag, i + len(tag))
            out.append(f'{tag}{LITERAL_MASK}{tag}')
            i = n if end < 0 else end + len(tag)
        elif sql.startswith('--', i):
            end = sql.find('\n', i)
            out.append(f'-- {LITERAL_MASK}')
            i = n if end < 0 else end
        elif sql.startswith('/*', i):
            end = sql.find('*/', i + 2)
            out.append(f'/* {LITERAL_MASK} */')
            i = n if end < 0 else end + 2
        else:
            out.append(ch)
            i += 1
    return ''.join(out)


class IInstance(SupabaseInstanceBase):
    """Agent tools for pg_cron jobs in a Supabase project."""

    IGlobal: IGlobal

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    @contextlib.contextmanager
    def _cron(self) -> Iterator[Any]:
        """Yield a cursor in one transaction, after checking pg_cron and setting a timeout."""
        with self._postgres() as conn:
            with conn.cursor() as cur:
                # Checked first so a missing extension gets an instruction, not
                # 'schema "cron" does not exist'.
                cur.execute(_SQL_EXTENSION, ('pg_cron',))
                if cur.fetchone() is None:
                    raise sc.SupabaseError(PG_CRON_MISSING)
                # Bound per transaction: a slow cron table must not hold the call forever.
                cur.execute(_SQL_TIMEOUT, (str(self.IGlobal.STATEMENT_TIMEOUT_SECONDS * 1000),))
                cur.fetchone()
                yield cur

    def _masked(self, row: Dict[str, Any], column: str, *, sql: bool = False) -> Dict[str, Any]:
        """Mask credentials inside job SQL or run output before the agent sees them.

        A job that calls an Edge Function or webhook through net.http_post
        usually stores a key in its command ("Authorization: Bearer <key>",
        '{"apikey": "<key>"}'). That key is often a secret or service_role key
        with far more power than this node's level. Masking by pattern can
        never know every shape of key, so below admin a command (``sql``) has
        every string literal replaced (``mask_sql_literals``); admin, which can
        schedule any SQL anyway, sees the command with the secret-shaped parts
        masked (sb_secret_ keys, JWTs, bearer tokens, credential-named headers,
        conninfo passwords, token query parameters). Run output is free text,
        so it gets the pattern masking at every level.
        """
        value = row.get(column)
        if isinstance(value, str):
            if sql and not sc.access_allows(self.IGlobal.access, ADMIN):
                value = mask_sql_literals(value)
            row[column] = self.IGlobal.redactor.redact(value)
        return row

    def _job_id(self, cur: Any, name: str) -> Any:
        """The job id for a name, or None."""
        cur.execute(_SQL_FIND_JOB, (name,))
        row = cur.fetchone()
        return row[0] if row else None

    def _missing_job(self, tool_name: str, name: str) -> ValueError:
        return ValueError(f'{tool_name}: no cron job named {name!r}. Call list_jobs to see the job names.')

    # ------------------------------------------------------------------
    # Read tools
    # ------------------------------------------------------------------

    @tool_function(
        input_schema={'type': 'object', 'properties': {}},
        output_schema={
            'type': 'object',
            'properties': {
                'jobs': {'type': 'array', 'items': _JOB_RECORD},
                'count': {'type': 'integer'},
                'truncated': {'type': 'boolean', 'description': 'True when more jobs exist than were returned.'},
            },
        },
        description=(
            'List the scheduled pg_cron jobs of the Supabase project. No arguments. Needs the read access level. '
            'Returns jobs (job_id, name, schedule, command, active, database, username) ordered by job_id, '
            'count, and truncated: at most "Max rows" jobs (node setting, default 100) are returned, and '
            'truncated is true when there are more. Below the admin access level every string literal in a '
            "command is shown as '***' (the SQL's shape stays, its values do not); at admin, keys and tokens "
            'inside a command (sb_secret_ keys, JWTs, bearer tokens, credential headers, passwords, token query '
            'parameters) are replaced by ***.'
        ),
    )
    @requires_access(READ)
    def list_jobs(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """List pg_cron jobs, up to the node's row cap."""
        cap = self.IGlobal.max_rows
        with self._cron() as cur:
            # One extra row tells whether the list was cut.
            cur.execute(_SQL_LIST_JOBS, (cap + 1,))
            rows = cur.fetchall()
        jobs = [self._masked(job, 'command', sql=True) for job in _rows(_JOB_COLUMNS, rows[:cap])]
        return self._output({'jobs': jobs, 'count': len(jobs), 'truncated': len(rows) > cap})

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['job_name'],
            'properties': {
                'job_name': _NAME_PROPERTY,
                'limit': {
                    'type': 'integer',
                    'minimum': 1,
                    'description': f'How many recent runs to return (default {DEFAULT_RUNS}, at most the node\'s "Max rows").',
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'job_name': {'type': 'string'},
                'job_id': {'type': 'integer'},
                'runs': {'type': 'array', 'items': _RUN_RECORD},
                'count': {'type': 'integer'},
                'truncated': {'type': 'boolean', 'description': 'True when older runs exist than were returned.'},
            },
        },
        description=(
            'Show the most recent runs of one pg_cron job, newest first. Arguments: job_name (required), '
            f'limit (optional, default {DEFAULT_RUNS}, capped at the node\'s "Max rows", default 100). '
            'Needs the read access level. Returns job_name, job_id, runs (run_id, status, return_message, '
            'start_time, end_time), count, and truncated (true when older runs were left out). Keys and tokens '
            'in return_message are replaced by ***. '
            'Fails when no job has that name.'
        ),
    )
    @requires_access(READ)
    def job_runs(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """Recent runs of a named job."""
        tool = self._tool('job_runs')
        name = self._bounded_str(args, 'job_name', tool_name=tool, max_len=_MAX_NAME_LEN)
        cap = self.IGlobal.max_rows
        limit = int_arg(args, 'limit', default=min(DEFAULT_RUNS, cap), lo=1, hi=cap, tool_name=tool)
        with self._cron() as cur:
            job_id = self._job_id(cur, name)
            if job_id is None:
                raise self._missing_job(tool, name)
            cur.execute(_SQL_JOB_RUNS, (job_id, limit + 1))
            rows = cur.fetchall()
        runs = [self._masked(run, 'return_message') for run in _rows(_RUN_COLUMNS, rows[:limit])]
        return self._output(
            {'job_name': name, 'job_id': job_id, 'runs': runs, 'count': len(runs), 'truncated': len(rows) > limit}
        )

    # ------------------------------------------------------------------
    # Admin tools
    # ------------------------------------------------------------------

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['name', 'schedule', 'sql'],
            'properties': {
                'name': {'type': 'string', 'description': 'Job name. Scheduling an existing name replaces that job.'},
                'schedule': {
                    'type': 'string',
                    'description': 'Standard cron syntax in UTC (for example "0 3 * * *" for 03:00 every day), '
                    'or "<1-59> seconds" (for example "30 seconds").',
                },
                'sql': {'type': 'string', 'description': 'The SQL the job runs, for example "CALL refresh_stats()".'},
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'job_id': {'type': 'integer'},
                'name': {'type': 'string'},
                'schedule': {'type': 'string'},
                'replaced': {
                    'type': 'boolean',
                    'description': 'True when a job with this name existed and was replaced.',
                },
            },
        },
        description=(
            'Create or replace a pg_cron job that runs SQL on a schedule in the Supabase database. '
            'Arguments: name, schedule (cron syntax in UTC, or "<1-59> seconds"), sql. The SQL runs as the '
            'database user later, without further checks, so this needs the admin access level. '
            'Scheduling a name that already exists replaces that job. Returns job_id, name, schedule and '
            "replaced. An invalid schedule fails with pg_cron's message."
        ),
    )
    @requires_access(ADMIN)
    def schedule_job(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """Create or replace a named job."""
        tool = self._tool('schedule_job')
        name = self._bounded_str(args, 'name', tool_name=tool, max_len=_MAX_NAME_LEN)
        schedule = self._bounded_str(args, 'schedule', tool_name=tool, max_len=_MAX_SCHEDULE_LEN)
        command = require_str(args, 'sql', tool_name=tool)
        with self._cron() as cur:
            replaced = self._job_id(cur, name) is not None
            # pg_cron validates the schedule; all three values are bound parameters.
            cur.execute(_SQL_SCHEDULE, (name, schedule, command))
            row = cur.fetchone()
        return {'job_id': row[0] if row else None, 'name': name, 'schedule': schedule, 'replaced': replaced}

    @tool_function(
        input_schema={'type': 'object', 'required': ['name'], 'properties': {'name': _NAME_PROPERTY}},
        output_schema={
            'type': 'object',
            'properties': {
                'name': {'type': 'string'},
                'job_id': {'type': 'integer'},
                'unscheduled': {'type': 'boolean'},
            },
        },
        description=(
            'Remove a pg_cron job by name so it no longer runs. Argument: name. Needs the admin access level. '
            'Returns name, job_id and unscheduled (true). Fails when no job has that name. Past run history '
            'stays in cron.job_run_details.'
        ),
    )
    @requires_access(ADMIN)
    def unschedule_job(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """Remove a named job."""
        tool = self._tool('unschedule_job')
        name = self._bounded_str(args, 'name', tool_name=tool, max_len=_MAX_NAME_LEN)
        with self._cron() as cur:
            job_id = self._job_id(cur, name)
            if job_id is None:
                raise self._missing_job(tool, name)
            cur.execute(_SQL_UNSCHEDULE, (name,))
            row = cur.fetchone()
        return {'name': name, 'job_id': job_id, 'unscheduled': bool(row and row[0])}
