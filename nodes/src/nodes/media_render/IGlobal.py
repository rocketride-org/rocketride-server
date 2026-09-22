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


"""Configuration for media_render."""

from rocketlib import IGlobalBase, OPEN_MODE
from ._support.config import load_node_config, parse_request

# The `default` profile of services.json, key for key (test_contract_fixes
# holds the two together): a 960-pixel preview, sidecars off.
DEFAULTS = {
    'request': '{}',
    'event_type': 'media_render',
    'chunk_kb': 1024,
    'max_input_mb': 16384,
    'long_edge': 960,
    'fps': 30,
    'crf': 28,
    'preset': 'ultrafast',
    'captions': True,
    'sidecars': False,
    'part_ms': 300000,
}


class IGlobal(IGlobalBase):
    """Node-wide configuration; input files live only in each instance."""

    request: dict = None  #: The static request, parsed once for every object.
    mode: str = None  #: Its operation.

    def beginGlobal(self):
        """Initialize dependencies and profile configuration outside editor validation."""
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return
        from depends import load_depends

        load_depends(__file__)
        self.config = load_node_config(self, DEFAULTS, 'media_render')
        self.config['max_input_mb'] = max(1, min(1048576, int(self.config['max_input_mb'])))
        self.config['max_input_bytes'] = self.config['max_input_mb'] * 1024 * 1024
        self.config['chunk_bytes'] = max(64, min(8192, int(self.config['chunk_kb']))) * 1024
        self.config['event_type'] = str(self.config['event_type'] or 'media_render').strip() or 'media_render'
        # A request that cannot run fails the pipeline here, before any object
        # is opened, rather than each object after its input was spooled.
        from .IInstance import MODES  # IInstance imports this module; resolved once both are loaded

        self.request, self.mode = parse_request(self.config.get('request'), MODES)

    def endGlobal(self):
        """No persistent media or storage binding is retained by the global."""
        pass
