# =============================================================================
# MIT License
# Copyright (c) 2024 RocketRide Inc.
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

# ------------------------------------------------------------------------------
# This class controls the data shared between all threads for the task
# ------------------------------------------------------------------------------
from rocketlib import IGlobalBase, OPEN_MODE
from ai.common.config import Config


class IGlobal(IGlobalBase):
    """
    Global state manager for Local Text Output node.

    This class manages shared configuration and state across all processing threads,
    including output directory paths and exclusion patterns for file processing.
    """

    output_path: str | None = None
    exclude: str | None = None

    def beginGlobal(self):
        """
        Initialize global state and configuration.

        This method is called at the start of processing to set up the node's
        global configuration, including output paths and exclusion patterns.
        """
        # Are we in config mode or some other mode?
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            # We are going to get a call to configureService but
            # we don't actually need to load the driver for that
            pass
        else:
            # Get the config info
            config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

            # Get the output path from config - it's nested in parameters
            self.output_path = config.get('parameters', {}).get('storePath')
            self.exclude = config.get('parameters', {}).get('exclude')

    def validateConfig(self):
        """Linux and Mac have no special characters that are not allowed in paths.

        Technically the only special character is '/' but we have no way to determine if thats
        just the path name or a mis-input, that is up to the user.
        Windows has some special characters that are not allowed in paths
        We need to validate the path and raise an error if it contains any of these characters.
        """
        try:
            # Read the requirements file
            import os
            from depends import depends

            requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
            depends(requirements)

            from sys import platform

            config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

            storePath = config.get('parameters', {}).get('storePath')
            excludePath = config.get('parameters', {}).get('exclude')

            # Check if the path is valid
            if platform == 'win32':
                invalid_characters = ['<', '>', ':', '"', '/', '|', '?', '*']

                if any(char in storePath for char in invalid_characters):
                    raise Exception(f'Invalid output path: {storePath}')

                if excludePath != 'N/A' and any(char in excludePath for char in invalid_characters):
                    raise Exception(f'Invalid exclude path: {excludePath}')

        except Exception as e:
            raise Exception(f'Error validating config: {e}')

    def endGlobal(self) -> None:
        pass
