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
Supabase Messaging: global settings.

Messaging talks to the project's API with the Project URL and secret key:
Realtime broadcast through the REST endpoint, and Queues through the
``pgmq_public`` functions exposed by PostgREST. The limits below are read
once here (defaults and bounds also live in services.messaging.json).
"""

from __future__ import annotations

from ..IGlobal import API, SupabaseGlobalBase


class IGlobal(SupabaseGlobalBase):
    """Access level, connection and limits for the Messaging tools."""

    SERVICE = 'supabase_messaging'
    PRODUCT = 'Supabase Messaging'
    CONNECTION = API

    LIMITS = {
        'maxReadCount': ('max_read_count', 100, 1, 1000),
        'maxVisibilitySeconds': ('max_visibility_seconds', 3600, 1, 86400),
        'maxDelaySeconds': ('max_delay_seconds', 3600, 1, 604800),
        'maxPayloadKb': ('max_payload_kb', 256, 1, 3072),
    }

    max_read_count: int = LIMITS['maxReadCount'][1]
    max_visibility_seconds: int = LIMITS['maxVisibilitySeconds'][1]
    max_delay_seconds: int = LIMITS['maxDelaySeconds'][1]
    max_payload_kb: int = LIMITS['maxPayloadKb'][1]
