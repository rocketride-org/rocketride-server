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
Supabase Cron: global settings.

Cron talks to the project's Postgres pooler (shared ``supabase.pooler.*``
fields, always over TLS) and calls the ``pg_cron`` extension's functions and
tables. The row cap is read once here (default and bounds also live in
services.cron.json).
"""

from __future__ import annotations

from ..IGlobal import POSTGRES, SupabaseGlobalBase
from ..supabase_client import ADMIN, READ


class IGlobal(SupabaseGlobalBase):
    """Access level, pooler connection and row cap for the Cron tools."""

    SERVICE = 'supabase_cron'
    PRODUCT = 'Supabase Cron'
    CONNECTION = POSTGRES

    # No Cron tool needs write, so the level is not offered (services.cron.json
    # narrows the supabase.access enum the same way). A stray "write" written
    # straight into a .pipe file stops start-up naming the two levels.
    ACCESS_LEVELS = (READ, ADMIN)

    # Seconds one Cron call's SQL may run (statement_timeout of its transaction).
    # Cron makes no HTTP calls, so the base's HTTP TIMEOUT does not apply.
    STATEMENT_TIMEOUT_SECONDS: int = 30

    LIMITS = {
        'maxRows': ('max_rows', 100, 1, 1000),
    }

    max_rows: int = LIMITS['maxRows'][1]
