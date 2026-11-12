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

import os

from rocketlib import IGlobalBase, debug


class IGlobal(IGlobalBase):
    """Global configuration for the Reducto node."""

    def __init__(self):
        """Declare instance attributes; heavy initialization happens in beginGlobal."""
        super().__init__()
        self.parser = None

    def beginGlobal(self):
        """Install the dependencies and create the parser from the resolved config."""
        debug('Reducto Global: Starting global initialization')

        self.ensureDependencies()

        # Import what we need
        debug('Reducto Global: Importing parser module')
        from .parser import Parser

        # Get our bag
        bag = self.IEndpoint.endpoint.bag
        debug('Reducto Global: Retrieved endpoint bag')

        # Initialize the parser with the resolved configuration
        debug('Reducto Global: Initializing parser')
        self.parser = Parser(self.glb.logicalType, self.config, bag)

    def ensureDependencies(self):
        """Ensure the dependencies are installed."""
        from depends import depends

        requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
        depends(requirements)

    def endGlobal(self):
        """Clean up resources when global configuration is being destroyed."""
        debug('Reducto Global: Starting global cleanup')
        # Clean up resources and keep bag in sync
        if hasattr(self.IEndpoint.endpoint, 'bag') and 'reducto' in self.IEndpoint.endpoint.bag:
            del self.IEndpoint.endpoint.bag['reducto']
        self.parser = None
        debug('Reducto Global: Cleanup completed')
