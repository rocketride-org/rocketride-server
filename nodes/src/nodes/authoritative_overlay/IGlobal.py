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
Global handler for the Authoritative Overlay node.

The regulator and the company CIK are per-call parameters the instance reads
from its settings. The control keeps only a bounded cache of SEC submission
metadata, one entry per CIK a call has asked about: fetching a company's
submission index is a network round trip, so calls for the same CIK reuse it.
"""

import threading
from collections import OrderedDict

from rocketlib import IGlobalBase

# ==== Constants ==================================================================

#: The most companies whose submission metadata one control keeps; the least recently used goes first.
MAX_COMPANIES = 8


class IGlobal(IGlobalBase):
    """IGlobal for the Authoritative Overlay node: the per-CIK submission metadata cache."""

    def beginGlobal(self):
        """Create the empty submission cache and its lock."""
        self._lock = threading.Lock()
        self._submissions = OrderedDict()

    def submission_cache_for(self, cik: str) -> dict:
        """
        The submission metadata cache of one company, created on first use.

        Args:
            cik: The company's zero-padded CIK.

        Returns:
            The dict ``query_sec`` fills with that company's submission index and shards.
        """
        with self._lock:
            cache = self._submissions.get(cik)
            if cache is not None:
                self._submissions.move_to_end(cik)
                return cache

            # A new company: keep its cache, dropping the least recently used past the bound
            cache = {}
            self._submissions[cik] = cache
            while len(self._submissions) > MAX_COMPANIES:
                self._submissions.popitem(last=False)
            return cache

    def endGlobal(self):
        """Drop every cached submission and the lock."""
        self._submissions = None
        self._lock = None
