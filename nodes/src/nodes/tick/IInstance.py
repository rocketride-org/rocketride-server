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

from rocketlib import Entry, IInstanceBase


class IInstance(IInstanceBase):
    """Render the tick node's single entry as text."""

    def renderObject(self, object: Entry):
        """Deliver the one entry the tick reported.

        In the engine's DIRECT pipeline mode ``IEndpoint.scanObjects`` reports
        the entry through the scan callback and the engine calls back here with
        the target pipe already open. Delegates the write to
        ``IEndpoint.renderTick``, then prevents the C++ default render, which
        would try to stream the object through an endpoint read API this node
        does not implement. Tick has a single manifest, so ``IEndpoint`` always
        implements ``renderTick`` — no fallback guard needed.
        """
        self.IEndpoint.renderTick(object, self.instance)
        return self.preventDefault()
