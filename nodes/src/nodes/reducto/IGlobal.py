# =============================================================================
# MIT License
# Copyright (c) 2026 RocketRide, Inc.
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
from ai.common.config import Config


class IGlobal(IGlobalBase):
    """Global configuration for the Reducto node."""

    def __init__(self):
        """Declare instance attributes; heavy initialization happens in beginGlobal."""
        super().__init__()
        self.parser = None

    def beginGlobal(self):
        """Initialize the global configuration."""
        debug('Reducto Global: Starting global initialization')

        self.ensureDependencies()

        # Import what we need
        debug('Reducto Global: Importing parser module')
        from .parser import Parser

        # Get our bag
        bag = self.IEndpoint.endpoint.bag
        debug('Reducto Global: Retrieved endpoint bag')

        # Get this node's config
        config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

        # Check if config has nested structure
        if 'default' in config:
            config = config.get('default', {})

        # Initialize the parser with the full configuration
        debug('Reducto Global: Initializing parser')
        self.parser = Parser(self.glb.logicalType, self.glb.connConfig, bag)

    def validateConfig(self):
        """Validate the Reducto node configuration."""
        import ast

        self.ensureDependencies()
        # Get the configuration parameters
        config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

        # Handle nested config structure (default profile)
        if 'default' in config:
            config = config.get('default', {})

        # Validate API key by performing a minimal upload
        try:
            from reducto import Reducto

            api_key = config.get('api_key')
            reducto = Reducto(api_key=api_key)
            # Minimal in-memory text; upload only (no parsing) to validate credentials
            _ = reducto.upload(file=('ping.txt', b'ping'))
            debug('Reducto Global: API key validation succeeded')

        except Exception as e:
            raise RuntimeError(f'Reducto API key validation failed: {str(e)}')

        # Advanced mode Python dict validation
        if config.get('parse_mode'):
            dict_fields = ['options', 'advanced_options', 'experimental_options']

            for field_name in dict_fields:
                field_value = config.get(field_name)

                # Skip empty/None values (they're optional)
                if not field_value or not field_value.strip():
                    continue

                # Validate Python dict syntax
                try:
                    parsed_dict = ast.literal_eval(field_value)

                    # Ensure it's actually a dictionary
                    if not isinstance(parsed_dict, dict):
                        raise ValueError(f'Reducto {field_name} must be a Python dictionary, got {type(parsed_dict).__name__}')

                except (ValueError, SyntaxError) as e:
                    raise ValueError(f'Reducto {field_name} contains invalid Python dictionary syntax: {str(e)}')

        debug('Reducto config validation completed successfully')

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
