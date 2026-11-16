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
Supabase Auth: global settings.

Auth manages the project's users through the Auth admin API
(``client.auth.admin.*``), which needs the Project URL and secret key, and
checks a user's login token with ``client.auth.get_user(jwt)``. The only
service setting is the page size of ``list_users``; its default and bounds
also live in services.auth.json.
"""

from __future__ import annotations

from ..IGlobal import API, SupabaseGlobalBase


class IGlobal(SupabaseGlobalBase):
    """Access level, connection and limits for the Auth tools."""

    SERVICE = 'supabase_auth'
    PRODUCT = 'Supabase Auth'
    CONNECTION = API

    LIMITS = {
        # The most users one list_users call returns (also its default page size).
        'pageSize': ('page_size', 50, 1, 1000),
    }

    page_size: int = LIMITS['pageSize'][1]
