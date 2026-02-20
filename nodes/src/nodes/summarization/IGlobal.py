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

from rocketlib import IGlobalBase, OPEN_MODE
from ai.common.config import Config


class IGlobal(IGlobalBase):
    numberOfSummaries: int = 2
    numberOfSummaryWords: int = 1500
    numberOfKeyPointWords: int = 250
    numberOfEntities: int = 25

    def beginGlobal(self) -> None:
        # Are we in config mode or some other mode?
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            # We are going to get a call to configureService but
            # we don't actually need to load the driver for that
            pass
        else:
            # Install what we need
            import os
            from depends import depends  # type: ignore

            # Load the requirements
            requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
            depends(requirements)

            # Get our configuration
            config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

            # Get the parameters
            self.numberOfSummaries = config.get('numberOfSummaries', 2)
            self.numberOfSummaryWords = config.get('numberOfSummaryWords', 1500)
            self.numberOfKeyPointWords = config.get('numberOfKeyPointWords', 250)
            self.numberOfEntities = config.get('numberOfEntities', 25)
