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


"""Configuration for media_inspect."""

from rocketlib import IGlobalBase


class IGlobal(IGlobalBase):
    """Node-wide configuration; input files live only in each instance.

    The leaves (request, event_type, thresholds, chunk and input sizes) are read
    from ``self.config``; the two byte counts derived from them are kept here.
    """

    chunk_bytes: int = 1024 * 1024
    max_input_bytes: int = 16384 * 1024 * 1024

    def beginGlobal(self):
        """Install the dependencies and derive the byte sizes from the resolved config."""
        from depends import load_depends

        load_depends(__file__)
        config = self.config
        self.chunk_bytes = config.chunk_kb * 1024
        self.max_input_bytes = config.max_input_mb * 1024 * 1024

    def endGlobal(self):
        """No persistent media or storage binding is retained by the global."""
        pass
