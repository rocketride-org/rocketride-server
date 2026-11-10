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
RocketRide cloud vector store save-time validation.

The engine imports this module alone in CONFIG mode: the schema check is the
resolver (``self.config``), and the semantic check is the table name rule,
the scope / target check and, inside a task, a fast read-only probe of the
delivered tenant database. psycopg2 is imported inside the probe so this
module stays import-light.
"""

import os
import re
from typing import Mapping

from rocketlib import IValidatorBase, warning

from ai.common.rocketride_db import DsnNotDelivered, db_target, resolve_rocketride_dsn

# Valid unquoted PostgreSQL identifier: letter/underscore start, alphanumeric/underscore body, max 63 chars
VALID_TABLE = re.compile(r'^[A-Za-z_][A-Za-z0-9_]{0,62}$')


def probe_connection(config: Mapping) -> None:
    """
    Validate the RocketRide cloud vector store config with fast, read-only probes.

    - Enforce a safe unquoted identifier for the table (collection).
    - Check scope / target. Outside a task no DSN is delivered, so stop
      there: connectivity is checked when the pipeline runs.
    - Inside a task, connect with a short timeout, run SELECT 1 and verify
      pgvector through a ``NULL::vector`` cast.

    Reports problems with ``warning()`` and never raises: the user is still
    editing the node.

    Args:
        config: The resolved node config (collection, scope, target).
    """
    try:
        table = (config['collection'] or '').strip()
        if not VALID_TABLE.fullmatch(table):
            warning(
                'Table name must be <=63 chars; start with letter/underscore; only letters, digits, underscore; '
                'no spaces or special characters (- . / \\ \' " ` ( ) [ ] { } , ; : * + = | & # @ % ^ ! ? ~ $)'
            )
            return

        # No host/user/password fields: read the delivered DSN.
        try:
            dsn = resolve_rocketride_dsn(*db_target(config))
        except DsnNotDelivered:
            return

        from depends import depends  # type: ignore

        depends(os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt')

        import psycopg2  # type: ignore

        conn = None
        try:
            # Connect quickly; surface auth/host/db errors
            conn = psycopg2.connect(dsn, connect_timeout=3)
            with conn.cursor() as cur:
                cur.execute('SELECT 1')
                # Explicit type check - surfaces the provider error if pgvector is not installed
                cur.execute('SELECT NULL::vector')
                cur.fetchone()
        finally:
            try:
                if conn is not None:
                    conn.close()
            except Exception:
                pass
    except Exception as e:
        warning(_format_error(e))


def _format_error(e: Exception) -> str:
    """Concise error string for psycopg2 exceptions.

    psycopg2 errors carry SQL fragment + caret context on subsequent lines
    that are noisy in an LLM transcript, so we keep only the first line of
    the message. Anything else (including the case where ``psycopg2`` is
    not installed) falls back to ``str(e).strip()``.
    """
    try:
        from psycopg2 import OperationalError, ProgrammingError  # type: ignore
        import socket

        if isinstance(e, (OperationalError, ProgrammingError, socket.timeout)):
            msg = str(e).strip()
            return msg.splitlines()[0] if msg else msg
    except Exception:
        pass
    return str(e).strip()


class IValidator(IValidatorBase):
    """Schema check through the resolver, then the table, scope and connectivity probe."""

    def validateConfig(self, syntaxOnly: bool = False) -> None:
        """
        Validate the stored config and, unless ``syntaxOnly``, probe the tenant database.

        Args:
            syntaxOnly (bool): True checks the shape only; no network.

        Raises:
            ConfigError: The stored configuration does not fit the schema.
        """
        config = self.config
        if syntaxOnly:
            return
        probe_connection(config)
