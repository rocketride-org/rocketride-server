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
PostgreSQL vector store save-time validation.

The engine imports this module alone in CONFIG mode: the schema check is the
resolver (``self.config``), and the semantic check is a fast, read-only probe
of the server: connect with a short timeout, ``SELECT 1`` and a pgvector type
check. psycopg2 is imported inside the probe so this module stays import-light.
"""

import os
import re
from typing import Mapping

from rocketlib import IValidatorBase, warning

from ai.common.config import warn_if_credential_unresolved

# Valid unquoted PostgreSQL identifier: letter/underscore start, alphanumeric/underscore body, max 63 chars
VALID_TABLE = re.compile(r'^[A-Za-z_][A-Za-z0-9_]{0,62}$')


def probe_connection(config: Mapping) -> None:
    """
    Validate the PostgreSQL vector store config with fast, read-only probes.

    - Enforce a safe unquoted identifier for the table (collection)
    - Connect with a short timeout; run SELECT 1
    - Verify pgvector availability via a ``NULL::vector`` cast
    - Surface raw provider errors without truncation

    Reports problems with ``warning()`` and never raises: the user is still
    editing the node.

    Args:
        config: The resolved node config (host, port, user, password, database, collection).
    """
    try:
        table = (config['collection'] or '').strip()
        if not VALID_TABLE.fullmatch(table):
            warning(
                'Table name must be <=63 chars; start with letter/underscore; only letters, digits, underscore; '
                'no spaces or special characters (- . / \\ \' " ` ( ) [ ] { } , ; : * + = | & # @ % ^ ! ? ~ $)'
            )
            return

        from depends import depends  # type: ignore

        depends(os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt')

        import psycopg2  # type: ignore

        conn = None
        try:
            # Connect quickly; surface auth/host/db errors
            conn = psycopg2.connect(
                dbname=(config['database'] or 'postgres').strip(),
                user=config['user'],
                password=config['password'],
                host=(config['host'] or '').strip(),
                port=config['port'],
                connect_timeout=3,
            )
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
    """Schema check through the resolver, then the connectivity probe."""

    def validateConfig(self, syntaxOnly: bool = False) -> None:
        """
        Validate the stored config and, unless ``syntaxOnly``, probe the server.

        Args:
            syntaxOnly (bool): True checks the shape only; no network.

        Raises:
            ConfigError: The stored configuration does not fit the schema.
        """
        config = self.config
        if syntaxOnly:
            return
        # An unfilled reference is reported as such; the probe must not send the placeholder as the password
        if warn_if_credential_unresolved(self.glb.logicalType, 'password', config['password']):
            return
        probe_connection(config)
