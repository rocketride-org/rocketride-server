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
RocketRide cloud SQL save-time validation.

The engine imports this module alone in CONFIG mode: the schema check is the
resolver (``self.config``), and the semantic check is the scope / target
check and, inside a task, a fast ``SELECT 1`` against the delivered tenant
database. Outside a task no DSN is delivered (the server process has no run
identity), so only the static check runs and connectivity is checked when
the pipeline runs. psycopg2 is imported inside the probe so this module stays
import-light.
"""

from typing import Mapping

from rocketlib import IValidatorBase, warning

from ai.common.rocketride_db import DsnNotDelivered, db_target, resolve_rocketride_dsn


def probe_connection(config: Mapping) -> None:
    """
    Check scope / target and, inside a task, probe the delivered tenant database.

    Reports problems with ``warning()`` and never raises: the user is still
    editing the node.

    Args:
        config: The resolved node config (scope, target).
    """
    try:
        dsn = resolve_rocketride_dsn(*db_target(config))
    except DsnNotDelivered:
        return
    except ValueError as e:
        warning(str(e))
        return

    conn = None
    try:
        import psycopg2  # type: ignore

        conn = psycopg2.connect(dsn, connect_timeout=5)
        with conn.cursor() as cur:
            cur.execute('SELECT 1')
    except Exception as e:
        warning(str(e).strip().splitlines()[0] if str(e).strip() else repr(e))
    finally:
        try:
            if conn is not None:
                conn.close()
        except Exception:
            pass


class IValidator(IValidatorBase):
    """Schema check through the resolver, then the scope and connectivity probe."""

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
