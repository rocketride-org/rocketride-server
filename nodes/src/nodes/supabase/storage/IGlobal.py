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
Supabase Storage: global settings.

Storage works with buckets and files through the Storage API
(``client.storage``), with the Project URL and secret key. The limits below
are read once at start-up (``LIMITS``, the same numbers as the
supabase_storage.* fields of services.storage.json).
"""

from __future__ import annotations

from typing import Any, Dict

from ..IGlobal import API, SupabaseGlobalBase


class IGlobal(SupabaseGlobalBase):
    """Access level, connection and limits for the Storage tools."""

    SERVICE = 'supabase_storage'
    PRODUCT = 'Supabase Storage'
    CONNECTION = API

    LIMITS = {
        # download_file returns content inline only up to this size: a large
        # file as base64 would be millions of tokens. Above it, a signed URL.
        'inlineLimitKb': ('inline_limit_kb', 256, 1, 4096),
        # upload_file refuses larger content before anything is sent.
        'uploadLimitMb': ('upload_limit_mb', 10, 1, 50),
        # The most entries one list_files / list_buckets call returns.
        'listLimit': ('list_limit', 100, 1, 1000),
        # Lifetime of the signed URL download_file hands out above the inline
        # limit, and the default (and range) of create_signed_url.expires_in.
        'signedUrlSeconds': ('signed_url_seconds', 3600, 60, 604800),
    }

    inline_limit_kb: int = LIMITS['inlineLimitKb'][1]
    upload_limit_mb: int = LIMITS['uploadLimitMb'][1]
    list_limit: int = LIMITS['listLimit'][1]
    signed_url_seconds: int = LIMITS['signedUrlSeconds'][1]
    inline_limit_bytes: int = inline_limit_kb * 1024
    upload_limit_bytes: int = upload_limit_mb * 1024 * 1024

    def _after_begin(self, cfg: Dict[str, Any]) -> None:
        self.inline_limit_bytes = self.inline_limit_kb * 1024
        self.upload_limit_bytes = self.upload_limit_mb * 1024 * 1024


# create_signed_url accepts the same range as the node setting.
SIGNED_URL_SECONDS_MIN = IGlobal.LIMITS['signedUrlSeconds'][2]
SIGNED_URL_SECONDS_MAX = IGlobal.LIMITS['signedUrlSeconds'][3]
