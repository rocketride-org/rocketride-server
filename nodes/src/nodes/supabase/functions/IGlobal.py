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
Supabase Edge Functions: global settings.

Edge Functions are called over HTTPS at ``<project url>/functions/v1/<name>``
with the Project URL and secret key. The limits below are read once here
(defaults and bounds also live in services.functions.json).
"""

from __future__ import annotations

from ..IGlobal import API, SupabaseGlobalBase


class IGlobal(SupabaseGlobalBase):
    """Access level, connection and limits for invoke_function."""

    SERVICE = 'supabase_functions'
    PRODUCT = 'Supabase Edge Functions'
    CONNECTION = API

    LIMITS = {
        'timeoutSeconds': ('timeout_seconds', 60, 1, 400),
        'maxResponseKb': ('max_response_kb', 256, 1, 10240),
        'maxRequestKb': ('max_request_kb', 1024, 1, 10240),
    }

    timeout_seconds: int = LIMITS['timeoutSeconds'][1]
    max_response_kb: int = LIMITS['maxResponseKb'][1]
    max_request_kb: int = LIMITS['maxRequestKb'][1]
