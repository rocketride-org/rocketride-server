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

"""
AI Global Configuration Module.

This module defines the IGlobal class which handles global configuration
for AI processing tasks including text summarization and entity extraction.
"""

from rocketlib import IGlobalBase
from ai.common.config import Config


class IGlobal(IGlobalBase):
    """
    Global configuration class for AI processing tasks.

    This class extends IGlobalBase and manages configuration parameters
    for text analysis operations including summarization, key point extraction,
    and entity recognition. It handles dynamic loading of dependencies and
    configuration retrieval from the node configuration system.

    Attributes:
        numberOfTokens (int): Maximum number of tokens per chunk.
    """

    # Default configuration values for AI processing
    numberOfTokens: int = 384  # Number of tokens per chunk

    def beginGlobal(self) -> None:
        """
        Initialize global configuration and dependencies.

        This method is called during the initialization phase to:
        1. Install required Python dependencies from requirements.txt
        2. Load node-specific configuration parameters
        3. Override default values with configured settings

        The method dynamically installs dependencies and retrieves configuration
        based on the logical type and node configuration from the global context.
        """
        # Install required Python packages dynamically
        import os
        from depends import depends  # type: ignore

        # Construct path to requirements file relative to this module
        requirements_path = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'

        # Install dependencies listed in requirements.txt
        depends(requirements_path)

        # Retrieve node-specific configuration from the global context
        # Uses the logical type and node config from the global object
        config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

        # Override default configuration values with node-specific settings
        # Uses .get() with defaults to ensure backwards compatibility
        self.numberOfTokens = config.get('numberOfTokens', 384)
