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
Control-wide half of the Frame Grabber node: it keeps nothing.

Every key of the node is a per-call parameter, read by the instance from
``self.settings``, and the extractor is built per binding (one ffmpeg process
per video stream, started by the reader as the stream arrives), so there is
no client, model or pool for the IGlobal to cache. The module stays for
``load_depends``, which installs the node's requirements (Pillow, for the
watermark) before the instance imports them.
"""

from depends import load_depends

load_depends(__file__)

from rocketlib import IGlobalBase


class IGlobal(IGlobalBase):
    """The frame grabber's IGlobal: nothing is built from config, so nothing is held."""
