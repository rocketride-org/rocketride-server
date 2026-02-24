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

from rocketlib import IGlobalBase, debug, OPEN_MODE
from ai.common.config import Config


class IGlobal(IGlobalBase):
    """
    Global context for NER node.
    
    Initializes the NER recognizer once per pipeline execution and shares
    it across all instances.
    """
    
    recognizer = None
    
    def beginGlobal(self):
        """Initialize the NER recognizer when the pipeline starts."""
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            # Configuration mode - no need to load the model
            pass
        else:
            # Import what we need
            from .ner_recognizer import NERRecognizer

            # Get our bag
            bag = self.IEndpoint.endpoint.bag

            # Get this node's config
            config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            
            # Initialize the NER recognizer
            debug(f'    Loading NER model: {config.get("model", "default")}')
            self.recognizer = NERRecognizer(self.glb.logicalType, config, bag)
            debug('    NER model loaded successfully')
    
    def endGlobal(self):
        """Clean up the NER recognizer when the pipeline ends."""
        self.recognizer = None

