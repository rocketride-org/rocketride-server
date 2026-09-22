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


"""Configuration for media_speech."""

from rocketlib import IGlobalBase, OPEN_MODE
from ._support.config import load_node_config
from .media import clamp_piece_seconds

DEFAULTS = {
    'request': '{}',
    'event_type': 'media_speech',
    'chunk_kb': 1024,
    'max_input_mb': 16384,
    'piece_seconds': 45,
    'model': 'small',
    'language': 'en',
}


class IGlobal(IGlobalBase):
    """Node-wide configuration; input files live only in each instance."""

    def beginGlobal(self):
        """Initialize dependencies and profile configuration outside editor validation."""
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return
        from depends import load_depends

        load_depends(__file__)
        self.config = load_node_config(self, DEFAULTS, 'media_speech')
        self.config['max_input_mb'] = max(1, min(1048576, int(self.config['max_input_mb'])))
        self.config['max_input_bytes'] = self.config['max_input_mb'] * 1024 * 1024
        self.config['chunk_bytes'] = max(64, min(8192, int(self.config['chunk_kb']))) * 1024
        self.config['event_type'] = str(self.config['event_type'] or 'media_speech').strip() or 'media_speech'
        self.config['piece_seconds'] = clamp_piece_seconds(self.config['piece_seconds'])

    def endGlobal(self):
        """No persistent media or storage binding is retained by the global."""
        pass
