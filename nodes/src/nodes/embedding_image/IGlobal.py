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
from rocketlib import IGlobalBase
from ai.common.config import Config


class IGlobal(IGlobalBase):
    """
    IGlobal is a subclass of IGlobalBase that manages global lifecycle events for an AI node, such as initialization and cleanup of resources.

    It handles the setup of the AI embedding model and related configuration
    at the start of the node's global lifecycle and ensures proper cleanup
    when the lifecycle ends.
    """

    def beginGlobal(self):
        """
        Initialize resources needed for the node when the global lifecycle begins.

        This includes:
        - Importing the torch module to ensure PyTorch is available (side effects only).
        - Importing the Embedding class from the local embedding module.
        - Retrieving the "bag" from the current endpoint, which typically contains
          shared state or contextual data.
        - Loading node-specific configuration using the global logical type
          and connection configuration.
        - Instantiating the Embedding object with the logical type, loaded config,
          and bag for further embedding operations.

        Note:
            The import of torch is done here with a noqa directive to suppress
            lint warnings about unused imports. This is to ensure torch is
            loaded in the environment as a side effect.
        """
        from depends import depends

        requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
        depends(requirements)

        # Import torch to ensure the PyTorch framework is loaded.
        # Although not directly referenced, its import may trigger environment
        # setup or register necessary backend components.
        import ai.common.torch  # noqa: F401

        # Import Embedding class locally to avoid circular imports and delay
        # initialization until beginGlobal is called.
        from .embedding import Embedding

        # Access the 'bag' from the current endpoint.
        # The bag usually holds shared or session-specific data relevant to the
        # node instance.
        bag = self.IEndpoint.endpoint.bag

        # Retrieve node-specific configuration by using the logical type and
        # the connection configuration from the global context.
        # Config.getNodeConfig likely returns structured config data tailored
        # for this node instance.
        config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

        # Instantiate the Embedding object with the logical type, node config,
        # and the bag. This sets up the embedding system that will be used during
        # the node's operation.
        self.embedding = Embedding(self.glb.logicalType, config, bag)

    def endGlobal(self):
        """
        Clean up resources and references when the global lifecycle ends.

        This method currently clears the embedding reference to allow
        garbage collection and release of resources related to the embedding
        model or processor.
        """
        # Remove the embedding reference to release resources.
        # This helps ensure that any underlying model or processing resources
        # held by the embedding instance can be cleaned up.
        self.embedding = None
