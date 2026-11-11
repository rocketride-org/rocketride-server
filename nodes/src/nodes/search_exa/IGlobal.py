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

"""Exa search global state."""

from __future__ import annotations

import os

from rocketlib import IGlobalBase

from .exa_search import ExaSearch


class IGlobal(IGlobalBase):
    """Shared Exa backend for the node.

    Contract:
        - ``beginGlobal()`` runs when the node is opened for execution and
          creates the shared ``ExaSearch`` backend from the resolved config.
          The schema marks the key required, so a node without one never
          reaches here; the key arrives through the node config (a
          ${ROCKETRIDE_EXA_APIKEY} reference resolved per call).
        - ``endGlobal()`` runs during teardown and releases the shared state.
    """

    search: ExaSearch | None = None

    def beginGlobal(self) -> None:
        """Install the dependencies and create the shared Exa backend."""
        from depends import depends  # type: ignore

        requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
        depends(requirements)

        self.search = ExaSearch(self.glb.logicalType, self.config, self.IEndpoint.endpoint.bag)

    def endGlobal(self) -> None:
        """Release shared runtime state for this node instance."""
        self.IEndpoint.endpoint.bag.pop('search_exa', None)
        self.search = None
