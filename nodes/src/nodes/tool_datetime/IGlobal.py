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
Date and time tool node — global (shared) state.

Holds the default timezone, and nothing else. The arithmetic is in
``datetime_math`` and the tool surface is on ``IInstance``; there is no client
to build, no connection to hold and no credential to carry, because the answer
to every question this node is asked is already on the machine.
"""

from __future__ import annotations

from rocketlib import IGlobalBase

from .datetime_math import DEFAULT_ZONE


class IGlobal(IGlobalBase):
    """Global state for tool_datetime."""

    #: The zone used when a caller names none.
    #:
    #: A DEPLOYMENT-WIDE DEFAULT, not the caller's zone, and the difference is
    #: worth keeping in view. Whoever is actually asking may be anywhere; the
    #: only honest thing a shared default can do is be a zone the answer names
    #: out loud, so a caller reading `timezone: UTC` on a reply can see it was
    #: not their own and pass one next time.
    default_zone: str = DEFAULT_ZONE

    def beginGlobal(self) -> None:
        """Read the configured default zone, if the pipeline set one."""
        config = self.glb.connConfig or {}
        configured = str(config.get('defaultTimezone') or '').strip()
        if configured:
            self.default_zone = configured
